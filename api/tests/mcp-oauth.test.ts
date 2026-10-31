import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'

/**
 * OAuth 2.1 授权服务器的集成测试（SPEC §10.10；任务
 * `joint-tasks/2026-10-31-mcp-oauth.md`）。**连真 Postgres**。
 *
 * 覆盖任务要求的最小集合：DCR 校验、两种 well-known 形态、401 的 `resource_metadata`、
 * 授权码完整流程、错 verifier、码重放撤 grant、刷新旋转与复用检测、20 条 grant 上限、
 * 撤销幂等、PAT 完全不回归。
 *
 * ## 两个实例，各测各的
 *
 * - `oauthApp`：**固定 origin** 的授权服务器（`https://meme.test`）。协议端点的每个
 *   绝对 URL 都要能一眼断言，跟着请求 Host 走会让断言变成环境探针。
 * - `app`：真实的 `src/app.js`，用来测 `/api/v1/oauth/*` 那四个 cookie 端点。
 *   它的 origin 来自 `PUBLIC_ORIGIN`——本文件在 import 之前把它设好，顺带覆盖了
 *   「配了就固定用」这条。
 */

const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 授权端点与同意端点都要拼绝对 URL；固定下来，断言里就不用管 localhost
process.env['PUBLIC_ORIGIN'] = 'https://meme.test'
// 鉴权与授权流程不碰模型
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { app } = await import('../src/app.js')
const { createOAuthApp } = await import('../src/oauth/app.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest } = await import('../src/mcp/auth.js')
const { buildMcpServer } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { resetRateLimits } = await import('../src/middleware/rate-limit.js')
const { resetTokenTouchThrottle } = await import('../src/mcp/auth.js')
const { accessTokens, oauthGrants } = await import('../src/data/schema.js')
const { approveAuthorization, findGrant } = await import('../src/data/oauth.js')
const { listActiveTokens } = await import('../src/data/access-tokens.js')
const { hashSecret, generateClientId, buildRedirectUrl } = await import('../src/lib/oauth.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const ORIGIN = 'https://meme.test'
const CALLBACK = 'https://client.example/callback'

const oauthApp = createOAuthApp({
  db,
  origin: () => ORIGIN,
  // 未登录分支单独测（见「授权端点」那一组），这里一律当作已登录
  sessionUserId: async () => '00000000-0000-4000-8000-000000000000',
})

beforeEach(async () => {
  await truncateAll(sql)
  resetRateLimits()
  resetTokenTouchThrottle()
})

afterAll(async () => {
  await sql.end()
})

// ── 工具 ────────────────────────────────────────────────────────────

type Registered = { clientId: string; clientSecret: unknown }

/** 注册一个公户端。`body` 允许覆盖任何字段，畸形用例从这里构造。 */
async function register(body: Record<string, unknown> = {}): Promise<Response> {
  return await oauthApp.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CALLBACK], ...body }),
  })
}

async function registerOk(): Promise<Registered> {
  const response = await register()
  expect(response.status).toBe(201)
  const body = (await response.json()) as Record<string, unknown>
  return { clientId: body['client_id'] as string, clientSecret: body['client_secret'] }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function authorizeQuery(
  clientId: string,
  challenge: string,
  overrides: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    ...overrides,
  })
  return params.toString()
}

/** 从 302 的 Location 里取 ticket（同意页路径）。 */
function ticketOf(response: Response): string {
  const location = new URL(response.headers.get('location') ?? '')
  const ticket = location.searchParams.get('ticket')
  if (ticket === null) throw new Error(`Location 里没有 ticket：${location.toString()}`)
  return ticket
}

/** 走完「授权 → 同意 → 换码」，返回明文访问令牌与刷新令牌。 */
async function fullFlow(options: {
  userId: string
  ticketOverride?: string
  sessionUserId?: string
}): Promise<{
  accessToken: string
  refreshToken: string
  ticket: string
  clientId: string
  grantId: string
}> {
  const { clientId } = await registerOk()
  const { verifier, challenge } = pkce()

  const session = await createSession(options.userId, db)
  const cookie = `sid=${session.id}`

  // 授权端点：一个已经登录的浏览器
  const authApp = createOAuthApp({
    db,
    origin: () => ORIGIN,
    sessionUserId: async () => options.sessionUserId ?? options.userId,
  })
  const authorized = await authApp.request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`, {
    headers: { cookie },
  })
  expect(authorized.status).toBe(302)
  const ticket = ticketOf(authorized)

  // 同意页：POST 同意
  const consent = await app.request(`/api/v1/oauth/authorize/${options.ticketOverride ?? ticket}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ decision: 'approve' }),
  })
  expect(consent.status).toBe(200)
  const { redirectTo } = (await consent.json()) as { redirectTo: string }
  const code = new URL(redirectTo).searchParams.get('code')
  if (code === null) throw new Error(`redirectTo 里没有 code：${redirectTo}`)

  // 令牌端点：换码
  const exchanged = await oauthApp.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  })
  expect(exchanged.status).toBe(200)
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }

  const grants = await db.select().from(oauthGrants).where(eq(oauthGrants.userId, options.userId))
  const grantId = grants[0]?.id
  if (grantId === undefined) throw new Error('没有建出 grant')

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    ticket,
    clientId,
    grantId,
  }
}

function mcpApp() {
  return createMcpApp({
    authenticate: authenticateMcpRequest,
    buildServer: (ctx) => buildMcpServer(ctx, { db, cache: createTtlCache() }),
    onHandlerError: () => {},
    publicOrigin: ORIGIN,
  })
}

async function mcpToolsList(token: string): Promise<Response> {
  return await mcpApp().request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

async function tokenRowOf(token: string) {
  const rows = await db.select().from(accessTokens).where(eq(accessTokens.tokenHash, hashSecret(token)))
  return rows[0]
}

// ── 发现文档 ────────────────────────────────────────────────────────

describe('发现文档（§10.10.7）', () => {
  it('根形式与按路径插入形式返回同一份资源元数据', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await oauthApp.request(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')

      const body = (await response.json()) as Record<string, unknown>
      expect(body['resource']).toBe(`${ORIGIN}/mcp`)
      expect(body['authorization_servers']).toEqual([ORIGIN])
      expect(body['scopes_supported']).toEqual(['mememio:read'])
      expect(body['bearer_methods_supported']).toEqual(['header'])
    }
  })

  it('授权服务器元数据带 S256 与公户端声明', async () => {
    const response = await oauthApp.request('/.well-known/oauth-authorization-server')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>

    expect(body['issuer']).toBe(ORIGIN)
    expect(body['authorization_endpoint']).toBe(`${ORIGIN}/oauth/authorize`)
    expect(body['token_endpoint']).toBe(`${ORIGIN}/oauth/token`)
    expect(body['registration_endpoint']).toBe(`${ORIGIN}/oauth/register`)
    expect(body['revocation_endpoint']).toBe(`${ORIGIN}/oauth/revoke`)
    // 缺了这一条，合规客户端会直接拒绝发起授权
    expect(body['code_challenge_methods_supported']).toEqual(['S256'])
    expect(body['token_endpoint_auth_methods_supported']).toEqual(['none'])
    expect(body['authorization_response_iss_parameter_supported']).toBe(true)
  })

  it('未知的 /.well-known/* 回 404 JSON，不回 SPA', async () => {
    const response = await oauthApp.request('/.well-known/oauth-whatever')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

// ── DCR ─────────────────────────────────────────────────────────────

describe('动态客户端注册（§10.10.2）', () => {
  it('下发 client_id 与回显的元数据，**永不下发 client_secret**', async () => {
    const response = await register()
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')

    const body = (await response.json()) as Record<string, unknown>
    expect(body['client_id']).toMatch(/^mmc_[A-Za-z0-9_-]{43}$/)
    expect(body['token_endpoint_auth_method']).toBe('none')
    expect(body['grant_types']).toEqual(['authorization_code', 'refresh_token'])
    expect(body['response_types']).toEqual(['code'])
    expect(body['redirect_uris']).toEqual([CALLBACK])
    expect(body).not.toHaveProperty('client_secret')
  })

  it('redirect_uri 带 fragment 被拒', async () => {
    const response = await register({ redirect_uris: ['https://client.example/cb#frag'] })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid_client_metadata')
  })

  it('非 https 且非回环的 redirect_uri 被拒', async () => {
    const response = await register({ redirect_uris: ['http://evil.example/cb'] })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client_metadata')
  })

  it('http://localhost 豁免', async () => {
    const response = await register({ redirect_uris: ['http://localhost:33418/cb'] })
    expect(response.status).toBe(201)
  })

  it('超过 10 个 redirect_uri 被拒', async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://client.example/cb${i}`)
    const response = await register({ redirect_uris: uris })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client_metadata')
  })

  it('只接受 token_endpoint_auth_method = none', async () => {
    const response = await register({ token_endpoint_auth_method: 'client_secret_basic' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client_metadata')
  })

  it('全站客户端数到顶时 429 temporarily_unavailable', async () => {
    const capped = createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => null,
      maxClients: 1,
    })
    const body = JSON.stringify({ client_name: 'A', redirect_uris: [CALLBACK] })
    const first = await capped.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(first.status).toBe(201)

    const second = await capped.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(second.status).toBe(429)
    expect(((await second.json()) as { error: string }).error).toBe('temporarily_unavailable')
  })
})

// ── 授权端点 ────────────────────────────────────────────────────────

describe('授权请求（§10.10.3）', () => {
  it('未注册的 client_id 回 400 JSON，不重定向', async () => {
    const { challenge } = pkce()
    const response = await oauthApp.request(
      `/oauth/authorize?${authorizeQuery('mmc_notregistered', challenge)}`,
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request')
  })

  it('未注册的 redirect_uri 回 400 JSON，绝不进 Location', async () => {
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const response = await oauthApp.request(
      `/oauth/authorize?${authorizeQuery(clientId, challenge, {
        redirect_uri: 'https://attacker.example/cb',
      })}`,
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('response_type 不是 code 时 302 带 error + state + iss', async () => {
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const response = await oauthApp.request(
      `/oauth/authorize?${authorizeQuery(clientId, challenge, { response_type: 'token' })}`,
    )
    expect(response.status).toBe(302)

    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(CALLBACK)
    expect(location.searchParams.get('error')).toBe('unsupported_response_type')
    expect(location.searchParams.get('state')).toBe('st-123')
    expect(location.searchParams.get('iss')).toBe(ORIGIN)
  })

  it('code_challenge_method 只接受 S256（plain 与缺省都拒）', async () => {
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    for (const overrides of [{ code_challenge_method: 'plain' }, { code_challenge_method: '' }]) {
      const response = await oauthApp.request(
        `/oauth/authorize?${authorizeQuery(clientId, challenge, overrides)}`,
      )
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get('location') ?? '')
      expect(location.searchParams.get('error')).toBe('invalid_request')
    }
  })

  it('未登录时 302 去登录页，next 指回授权端点', async () => {
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const anonymous = createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => null,
    })
    const response = await anonymous.request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toContain('/oauth/authorize?')
    // 未登录不签发 ticket：ticket 行必须绑定 user_id（§5.10）
    expect(location.searchParams.get('next')).not.toContain('ticket=')
  })

  it('已登录时 302 去同意页并带 ticket', async () => {
    const user = await createUser(db)
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const session = await createSession(user.id, db)

    const logged = createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    })
    const response = await logged.request(
      `/oauth/authorize?${authorizeQuery(clientId, challenge)}`,
      { headers: { cookie: `sid=${session.id}` } },
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin).toBe(ORIGIN)
    expect(location.pathname).toBe('/oauth/consent')
    expect(ticketOf(response)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

// ── 同意端点（cookie 侧） ───────────────────────────────────────────

describe('同意端点（§6.10）', () => {
  it('GET 返回同意页信息，只给回跳主机名', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)

    const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      headers: { cookie: `sid=${session.id}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['clientName']).toBe('ChatGPT')
    expect(body['clientId']).toBe(clientId)
    expect(body['redirectHost']).toBe('client.example')
    expect(body['scope']).toBe('mememio:read')
  })

  it('ticket 属于别人 → NOT_FOUND', async () => {
    const owner = await createUser(db)
    const other = await createUser(db)
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => owner.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)

    const otherSession = await createSession(other.id, db)
    const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      headers: { cookie: `sid=${otherSession.id}` },
    })
    expect(response.status).toBe(404)
  })

  it('decision 只能是 approve / deny，多一个字段也拒', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { ticket } = await fullFlow({ userId: user.id })

    for (const body of [{ decision: 'maybe' }, { decision: 'approve', extra: 1 }, {}]) {
      const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
        method: 'POST',
        headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
  })

  it('跨站提交（Origin 不同源）→ FORBIDDEN', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)

    const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: {
        cookie: `sid=${session.id}`,
        'content-type': 'application/json',
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(response.status).toBe(403)
  })

  it('ticket 单次使用：重复提交 → NOT_FOUND', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { ticket } = await fullFlow({ userId: user.id })

    const replay = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(replay.status).toBe(404)
  })

  it('deny 回 access_denied 且不建 grant', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { clientId } = await registerOk()
    const { challenge } = pkce()
    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)

    const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'deny' }),
    })
    expect(response.status).toBe(200)
    const { redirectTo } = (await response.json()) as { redirectTo: string }
    const location = new URL(redirectTo)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('iss')).toBe(ORIGIN)

    expect(await db.select().from(oauthGrants)).toHaveLength(0)
  })

  it('活跃 grant 到 20 条 → VALIDATION_FAILED 且 details.fields.grantLimit', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const { clientId } = await registerOk()

    // 直接铺满 20 条活跃 grant（走 HTTP 铺满太慢，且不测的是这一步）
    for (let i = 0; i < 20; i += 1) {
      await approveAuthorization({
        clientId,
        userId: user.id,
        redirectUri: CALLBACK,
        codeChallenge: 'x'.repeat(43),
        resource: `${ORIGIN}/mcp`,
        scope: 'mememio:read',
        codeHash: randomBytes(32).toString('hex'),
        codeExpiresAt: new Date(Date.now() + 60_000),
      })
    }

    const { challenge } = pkce()
    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)

    const response = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(response.status).toBe(400)

    const body = (await response.json()) as {
      error: { code: string; details?: { fields?: Record<string, unknown> } }
    }
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.fields).toMatchObject({ grantLimit: true })
  })
})

// ── 令牌端点 ────────────────────────────────────────────────────────

describe('令牌端点（§10.10.5）', () => {
  it('授权码完整流程：换出的访问令牌在 /mcp 上与 PAT 等价', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })

    expect(flow.accessToken).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/)
    expect(flow.refreshToken).toMatch(/^mmr_[A-Za-z0-9_-]{43}$/)

    // 库里有哈希、没有明文
    const row = await tokenRowOf(flow.accessToken)
    expect(row?.kind).toBe('oauth')
    expect(row?.grantId).toBe(flow.grantId)

    const response = await mcpToolsList(flow.accessToken)
    expect(response.status).toBe(200)
  })

  it('令牌响应带 no-store / Pragma', async () => {
    const user = await createUser(db)
    const { clientId } = await registerOk()
    const { verifier, challenge } = pkce()

    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)
    const session = await createSession(user.id, db)
    const consent = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const { redirectTo } = (await consent.json()) as { redirectTo: string }
    const code = new URL(redirectTo).searchParams.get('code') ?? ''

    const response = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')

    const body = (await response.json()) as Record<string, unknown>
    expect(body['token_type']).toBe('Bearer')
    expect(body['expires_in']).toBe(3600)
    expect(body['scope']).toBe('mememio:read')
  })

  it('不支持的 grant_type → unsupported_grant_type', async () => {
    const { clientId } = await registerOk()
    const response = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId }).toString(),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('unsupported_grant_type')
  })

  it('未注册的 client_id → invalid_client', async () => {
    const response = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'mmc_nope' }).toString(),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_client')
  })

  it('错的 code_verifier → invalid_grant，**且不烧掉授权码**', async () => {
    const user = await createUser(db)
    const { clientId } = await registerOk()
    const { verifier, challenge } = pkce()
    const session = await createSession(user.id, db)

    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)
    const consent = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const { redirectTo } = (await consent.json()) as { redirectTo: string }
    const code = new URL(redirectTo).searchParams.get('code') ?? ''

    const body = (v: string) => new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: v,
    }).toString()

    const bad = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body(randomBytes(32).toString('base64url')),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant')

    // 码没被烧掉：拿正确的 verifier 还能换
    const good = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body(verifier),
    })
    expect(good.status).toBe(200)
  })

  it('授权码重放 → invalid_grant，并撤销整条 grant', async () => {
    const user = await createUser(db)
    const { clientId } = await registerOk()
    const { verifier, challenge } = pkce()
    const session = await createSession(user.id, db)

    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`)
    const ticket = ticketOf(authorized)
    const consent = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const { redirectTo } = (await consent.json()) as { redirectTo: string }
    const code = new URL(redirectTo).searchParams.get('code') ?? ''

    const exchange = () => oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })

    const first = await exchange()
    expect(first.status).toBe(200)
    const { access_token: accessToken } = (await first.json()) as { access_token: string }

    const replay = await exchange()
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant')

    // 码被重放 → grant 被撤，第一次换出的访问令牌立刻失效
    const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.userId, user.id))
    expect(grant?.revokedAt).not.toBeNull()
    expect((await mcpToolsList(accessToken)).status).toBe(401)
  })

  it('刷新旋转：旧刷新令牌作废，新的一对可用', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })

    const refreshed = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: flow.refreshToken,
        client_id: flow.clientId,
      }).toString(),
    })
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(next.refresh_token).not.toBe(flow.refreshToken)
    expect((await mcpToolsList(next.access_token)).status).toBe(200)
  })

  it('刷新令牌复用 → invalid_grant，并撤销整条 grant', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })

    const rotate = (token: string) => oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: flow.clientId,
      }).toString(),
    })

    const first = await rotate(flow.refreshToken)
    expect(first.status).toBe(200)
    const next = (await first.json()) as { access_token: string; refresh_token: string }

    // 旧令牌第二次使用 = 复用
    const reuse = await rotate(flow.refreshToken)
    expect(reuse.status).toBe(400)
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant')

    // grant 被撤：新令牌也刷不动，已签出的访问令牌也失效
    expect((await rotate(next.refresh_token)).status).toBe(400)
    const grant = await findGrant(flow.grantId, db)
    expect(grant?.revokedAt).not.toBeNull()
    expect((await mcpToolsList(flow.accessToken)).status).toBe(401)
    expect((await mcpToolsList(next.access_token)).status).toBe(401)
  })

  it('拿别人的 client_id 刷新 → invalid_grant，且不触发复用检测', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })
    const other = await registerOk()

    const response = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: flow.refreshToken,
        client_id: other.clientId,
      }).toString(),
    })
    expect(response.status).toBe(400)

    // grant 没被误杀：本来的客户端还能正常刷
    const grant = await findGrant(flow.grantId, db)
    expect(grant?.revokedAt).toBeNull()
  })

  it('未知刷新令牌 → invalid_grant', async () => {
    const { clientId } = await registerOk()
    const response = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'mmr_' + 'a'.repeat(43),
        client_id: clientId,
      }).toString(),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_grant')
  })
})

// ── 撤销 ────────────────────────────────────────────────────────────

describe('撤销（§6.10 / §10.10.6）', () => {
  it('DELETE 幂等：204、204，之后访问令牌 401', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const flow = await fullFlow({ userId: user.id })

    const remove = () => app.request(`/api/v1/oauth/grants/${flow.grantId}`, {
      method: 'DELETE',
      headers: { cookie: `sid=${session.id}` },
    })

    expect((await remove()).status).toBe(204)
    expect((await remove()).status).toBe(204)
    expect((await mcpToolsList(flow.accessToken)).status).toBe(401)
  })

  it('别人的 grant → NOT_FOUND；非法 uuid → NOT_FOUND（不是 500）', async () => {
    const owner = await createUser(db)
    const other = await createUser(db)
    const flow = await fullFlow({ userId: owner.id })
    const otherSession = await createSession(other.id, db)

    const response = await app.request(`/api/v1/oauth/grants/${flow.grantId}`, {
      method: 'DELETE',
      headers: { cookie: `sid=${otherSession.id}` },
    })
    expect(response.status).toBe(404)

    const malformed = await app.request('/api/v1/oauth/grants/not-a-uuid', {
      method: 'DELETE',
      headers: { cookie: `sid=${otherSession.id}` },
    })
    expect(malformed.status).toBe(404)
  })

  it('GET /grants 只列未撤销的，且不返回任何令牌字段', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const flow = await fullFlow({ userId: user.id })

    const before = await app.request('/api/v1/oauth/grants', { headers: { cookie: `sid=${session.id}` } })
    expect(before.status).toBe(200)
    const listed = (await before.json()) as { items: Array<Record<string, unknown>> }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({
      id: flow.grantId,
      clientName: 'ChatGPT',
      clientId: flow.clientId,
    })
    // 「API Key 不出响应」在这里是连前缀都不给
    const serialized = JSON.stringify(listed)
    expect(serialized).not.toContain(flow.accessToken)
    expect(serialized).not.toContain(flow.refreshToken)
    expect(listed.items[0]).not.toHaveProperty('prefix')

    await app.request(`/api/v1/oauth/grants/${flow.grantId}`, {
      method: 'DELETE',
      headers: { cookie: `sid=${session.id}` },
    })
    const after = await app.request('/api/v1/oauth/grants', { headers: { cookie: `sid=${session.id}` } })
    expect(((await after.json()) as { items: unknown[] }).items).toHaveLength(0)
  })

  it('GET /grants 的 redirectHost 等于同意页显示的值：取批准的那条，不取 redirect_uris[0]', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)
    const cookie = `sid=${session.id}`

    // 多回跳客户端，第一条是用户并没有批准的那个
    const registered = await register({ redirect_uris: ['https://other.example/callback', CALLBACK] })
    expect(registered.status).toBe(201)
    const clientId = ((await registered.json()) as { client_id: string }).client_id
    const { verifier, challenge } = pkce()

    const authorized = await createOAuthApp({
      db,
      origin: () => ORIGIN,
      sessionUserId: async () => user.id,
    }).request(`/oauth/authorize?${authorizeQuery(clientId, challenge)}`, { headers: { cookie } })
    const ticket = ticketOf(authorized)

    const view = await app.request(`/api/v1/oauth/authorize/${ticket}`, { headers: { cookie } })
    expect(view.status).toBe(200)
    const shown = ((await view.json()) as { redirectHost: string }).redirectHost
    expect(shown).toBe('client.example')

    // 批准后走完换码，令牌字段才能参与「不出响应」的断言
    const consent = await app.request(`/api/v1/oauth/authorize/${ticket}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ decision: 'approve' }),
    })
    const { redirectTo } = (await consent.json()) as { redirectTo: string }
    const code = new URL(redirectTo).searchParams.get('code') ?? ''
    const exchanged = await oauthApp.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    expect(exchanged.status).toBe(200)
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }

    const list = await app.request('/api/v1/oauth/grants', { headers: { cookie } })
    expect(list.status).toBe(200)
    const items = ((await list.json()) as { items: Array<Record<string, unknown>> }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.['redirectHost']).toBe(shown)
    expect(items[0]?.['redirectHost']).not.toBe('other.example')
    // 只回主机名，不回完整 URI
    expect(items[0]).not.toHaveProperty('redirectUri')
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain('/callback')
    expect(serialized).not.toContain(tokens.access_token)
    expect(serialized).not.toContain(tokens.refresh_token)
  })

  it('RFC 7009：未知令牌也回 200（防探测）', async () => {
    const { clientId } = await registerOk()
    const response = await oauthApp.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'mcp_' + 'z'.repeat(43), client_id: clientId }).toString(),
    })
    expect(response.status).toBe(200)
  })

  it('RFC 7009：撤销刷新令牌 → 访问令牌也立刻 401', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })

    const response = await oauthApp.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: flow.refreshToken, client_id: flow.clientId }).toString(),
    })
    expect(response.status).toBe(200)
    expect((await mcpToolsList(flow.accessToken)).status).toBe(401)
  })
})

// ── 与 PAT 的关系（§10.10.8 / §10.10.10） ──────────────────────────

describe('PAT 完全不回归', () => {
  it('OAuth 授权不占 PAT 的 10 个名额，也不出现在 PAT 列表里', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)

    // 先走一条完整的 OAuth 流程，库里多出一个 kind='oauth' 的访问令牌
    await fullFlow({ userId: user.id })
    expect(await listActiveTokens(user.id, db)).toHaveLength(0)

    // 10 个 PAT 仍然建得出来
    for (let i = 0; i < 10; i += 1) {
      const response = await app.request('/api/v1/access-tokens', {
        method: 'POST',
        headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `令牌 ${i}` }),
      })
      expect(response.status).toBe(201)
    }
    expect(await listActiveTokens(user.id, db)).toHaveLength(10)

    // 第 11 个才是上限
    const eleventh = await app.request('/api/v1/access-tokens', {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '第十一个' }),
    })
    expect(eleventh.status).toBe(400)
  })

  it('PAT 在 /mcp 上照常可用；OAuth 令牌在 /api/v1 上不可用', async () => {
    const user = await createUser(db)
    const session = await createSession(user.id, db)

    const created = await app.request('/api/v1/access-tokens', {
      method: 'POST',
      headers: { cookie: `sid=${session.id}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PAT' }),
    })
    const { token: pat } = (await created.json()) as { token: string }

    // PAT 在 /mcp 上有效
    expect((await mcpToolsList(pat)).status).toBe(200)
    // 但 PAT（cookie 以外的任何 Bearer）在 /api/v1 上无效
    const withBearer = await app.request('/api/v1/access-tokens', {
      headers: { authorization: `Bearer ${pat}` },
    })
    expect(withBearer.status).toBe(401)

    // OAuth 访问令牌同理：/mcp 行，/api/v1 不行
    const flow = await fullFlow({ userId: user.id })
    expect((await mcpToolsList(flow.accessToken)).status).toBe(200)
    const oauthBearer = await app.request('/api/v1/access-tokens', {
      headers: { authorization: `Bearer ${flow.accessToken}` },
    })
    expect(oauthBearer.status).toBe(401)
  })

  it('/api/v1/oauth/* 不认 Bearer，只认 cookie', async () => {
    const user = await createUser(db)
    const flow = await fullFlow({ userId: user.id })

    const response = await app.request('/api/v1/oauth/grants', {
      headers: { authorization: `Bearer ${flow.accessToken}` },
    })
    expect(response.status).toBe(401)
  })
})

// ── 401 挑战 ────────────────────────────────────────────────────────

describe('/mcp 的 401 挑战（§10.3）', () => {
  it('无令牌的 401 带 resource_metadata 与 scope', async () => {
    const response = await mcpApp().request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)

    const challenge = response.headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('realm="mememio"')
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    expect(challenge).toContain('scope="mememio:read"')
  })

  it('令牌无效的 401 与无令牌是**同一个**挑战形状', async () => {
    const response = await mcpApp().request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer mcp_${'a'.repeat(43)}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate') ?? '').toContain('resource_metadata=')
  })
})

// ── 回跳拼接工具（被上面几组间接依赖，单独钉一下） ─────────────────

describe('buildRedirectUrl', () => {
  it('保留注册时已有的查询串，不手拼 ?', async () => {
    const url = buildRedirectUrl('https://client.example/cb?tenant=abc', { code: 'x', state: 's' })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('tenant')).toBe('abc')
    expect(parsed.searchParams.get('code')).toBe('x')
    expect(parsed.searchParams.get('state')).toBe('s')
  })
})

// 让「clientId 生成器」这一条也被真的调用一次：DCR 回的是它生成的形状
it('client_id 由 generateClientId 生成且每次不同', () => {
  expect(generateClientId()).not.toBe(generateClientId())
})
