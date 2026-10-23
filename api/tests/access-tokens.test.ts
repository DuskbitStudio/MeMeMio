import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 访问令牌管理端点（SPEC §6.8、§5.8）。**连真 Postgres**（`api/agents/rules/testing.md §1`）。
 *
 * 这一组盯的是「静默错误」那一类：
 *
 * - 完整令牌**只在创建响应出现一次**，列表里只剩 `prefix`；
 * - 撤销**幂等**、且不存在 / 不属于本人都是 404（区分了就是探测通道）；
 * - 上限只数**有效**令牌（撤销 / 过期的不算），满了不自动踢掉最旧的；
 * - 列表只回未撤销且未过期的，`created_at desc`。
 *
 * ⚠️ 本机没有 Docker/Postgres，这个文件**写了但没跑**（任务交接时如实说明）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由读的是默认连接，不改掉就会打到开发库
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { accessTokens } = await import('../src/data/schema.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { accessTokenRoutes } = await import('../src/routes/access-tokens.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

const testApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/access-tokens', accessTokenRoutes)
testApp.onError(onError)
testApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

type Actor = { id: string; cookie: string }

async function signIn(role: 'admin' | 'member' = 'member'): Promise<Actor> {
  const user = await createUser(db, { role })
  const session = await createSession(user.id, db)
  return { id: user.id, cookie: `sid=${session.id}` }
}

async function anon(path: string, init: RequestInit = {}): Promise<Response> {
  return await testApp.request(path, init)
}

async function as(actor: Actor, path: string, init: RequestInit = {}): Promise<Response> {
  return await testApp.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: actor.cookie },
  })
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } }
  return body.error.code
}

type CreatedToken = {
  id: string
  name: string
  prefix: string
  token: string
  createdAt: string
  expiresAt: string | null
}

async function createToken(
  actor: Actor,
  body: { name: string; expiresInDays?: number } = { name: '我的 Claude' },
): Promise<CreatedToken> {
  const res = await as(actor, '/api/v1/access-tokens', jsonRequest(body))
  expect(res.status).toBe(201)
  return (await res.json()) as CreatedToken
}

type TokenItem = {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

async function listTokens(actor: Actor): Promise<TokenItem[]> {
  const res = await as(actor, '/api/v1/access-tokens')
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: TokenItem[] }).items
}

async function tokenRow(id: string) {
  const rows = await db.select().from(accessTokens).where(eq(accessTokens.id, id))
  return rows[0]
}

const UNKNOWN_UUID = '2f4a1c9e-6b3d-4a17-9f0c-8c2b5d7e1a44'

describe('认证门槛（三个端点都要求 cookie 会话）', () => {
  it('未登录：POST / GET / DELETE 都是 401 UNAUTHENTICATED', async () => {
    const cases: [string, RequestInit][] = [
      ['/api/v1/access-tokens', jsonRequest({ name: 'x' })],
      ['/api/v1/access-tokens', { method: 'GET' }],
      [`/api/v1/access-tokens/${UNKNOWN_UUID}`, { method: 'DELETE' }],
    ]
    for (const [path, init] of cases) {
      const res = await anon(path, init)
      expect([path, init.method, res.status]).toEqual([path, init.method, 401])
      expect(await errorCode(res)).toBe('UNAUTHENTICATED')
    }
  })

  it('Bearer 不能当 cookie 用（SPEC §6.8：管理端点不接受 Bearer）', async () => {
    const alice = await signIn()
    const created = await createToken(alice)

    const res = await anon('/api/v1/access-tokens', {
      method: 'GET',
      headers: { authorization: `Bearer ${created.token}` },
    })
    expect(res.status).toBe(401)
    expect(await errorCode(res)).toBe('UNAUTHENTICATED')
  })
})

describe('POST /access-tokens：完整令牌只出现一次', () => {
  it('201 + no-store；令牌是 mcp_ + 43 个 base64url；prefix 是前 12 字符', async () => {
    const alice = await signIn()
    const res = await as(
      alice,
      '/api/v1/access-tokens',
      jsonRequest({ name: '  我的 Claude  ' }),
    )
    expect(res.status).toBe(201)
    // 缓存整份响应 = 缓存了一个凭证
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as CreatedToken
    expect(body.token).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/)
    expect(body.prefix).toBe(body.token.slice(0, 12))
    expect(body.name).toBe('我的 Claude')
    expect(body.expiresAt).toBeNull()
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    // 库里只有哈希与前缀，不含明文
    const row = await tokenRow(body.id)
    expect(row).toBeDefined()
    expect(row?.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'))
    expect(row?.prefix).toBe(body.prefix)
    expect(row?.revokedAt).toBeNull()
    expect(row?.lastUsedAt).toBeNull()
  })

  it('expiresInDays 换算成 ISO 时间；不传 = null（永不过期）', async () => {
    const alice = await signIn()

    const permanent = await createToken(alice, { name: '永久' })
    expect(permanent.expiresAt).toBeNull()

    const before = Date.now()
    const expiring = await createToken(alice, { name: '90 天', expiresInDays: 90 })
    expect(expiring.expiresAt).not.toBeNull()
    const expiresAt = Date.parse(expiring.expiresAt ?? '')
    const expected = before + 90 * 24 * 60 * 60 * 1000
    // 允许几秒的执行误差；换算单位错了会差 24 倍以上
    expect(Math.abs(expiresAt - expected)).toBeLessThan(60_000)
  })

  it('列表里**再也拿不到**完整令牌，只有 prefix', async () => {
    const alice = await signIn()
    const created = await createToken(alice)

    const items = await listTokens(alice)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(created.id)
    expect(items[0]?.prefix).toBe(created.prefix)

    // 整个响应体里不能出现完整令牌（连子串都不能有）
    const raw = JSON.stringify(items)
    expect(raw).not.toContain(created.token)
    expect(raw).not.toContain(created.token.slice(4))
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix'].sort(),
    )
  })

  it('name / expiresInDays 的边界：1–64 字、1–3650 天', async () => {
    const alice = await signIn()

    const bad: Record<string, unknown>[] = [
      {},
      { name: '' },
      { name: '   ' },
      { name: '名'.repeat(65) },
      { name: 123 },
      { name: 'ok', expiresInDays: 0 },
      { name: 'ok', expiresInDays: 3651 },
      { name: 'ok', expiresInDays: 1.5 },
      { name: 'ok', expiresInDays: '90' },
      { name: 'ok', expiresInDays: null },
      { name: 'ok', extra: true },
    ]
    for (const body of bad) {
      const res = await as(alice, '/api/v1/access-tokens', jsonRequest(body))
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400])
      expect(await errorCode(res)).toBe('VALIDATION_FAILED')
    }

    // 合法边界：1 字 / 64 字 / 1 天 / 3650 天
    for (const body of [
      { name: 'a' },
      { name: '名'.repeat(64) },
      { name: 'ok', expiresInDays: 1 },
      { name: 'ok', expiresInDays: 3650 },
    ]) {
      const res = await as(alice, '/api/v1/access-tokens', jsonRequest(body))
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 201])
    }
  })

  it('请求体不是合法 JSON 是 400，不是 500', async () => {
    const alice = await signIn()
    const res = await as(alice, '/api/v1/access-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')
  })
})

describe('GET /access-tokens：只回有效令牌', () => {
  it('按 createdAt desc 排序（显式拉开时间，不依赖同秒插入的时序）', async () => {
    const alice = await signIn()
    const first = await createToken(alice, { name: '第一台' })
    // now() 在同一微秒内可能相同，显式把它挪到一小时前，断言才是确定的
    await sql`update access_tokens set created_at = now() - interval '1 hour' where id = ${first.id}`

    const second = await createToken(alice, { name: '第二台' })

    const items = await listTokens(alice)
    expect(items.map((item) => item.id)).toEqual([second.id, first.id])
  })

  it('已撤销 / 已过期的从列表消失，行仍保留（审计）', async () => {
    const alice = await signIn()
    const active = await createToken(alice, { name: '有效' })
    const revoked = await createToken(alice, { name: '撤销的' })
    const expired = await createToken(alice, { name: '过期的' })

    await as(alice, `/api/v1/access-tokens/${revoked.id}`, { method: 'DELETE' })
    await sql`update access_tokens set expires_at = now() - interval '1 day' where id = ${expired.id}`

    const items = await listTokens(alice)
    expect(items.map((item) => item.id)).toEqual([active.id])

    // 行没被物理删除，审计还在
    expect(await tokenRow(revoked.id)).toBeDefined()
    expect(await tokenRow(expired.id)).toBeDefined()
  })

  it('只看到自己的令牌（没有管理员视图）', async () => {
    const alice = await signIn()
    const bob = await signIn('admin')
    const aliceToken = await createToken(alice)

    expect((await listTokens(alice)).map((item) => item.id)).toEqual([aliceToken.id])
    expect(await listTokens(bob)).toEqual([])
  })
})

describe('DELETE /access-tokens/{id}：幂等、本人、404 不区分原因', () => {
  it('204 立即生效；再调一次仍是 204（幂等）；只写 revoked_at 不物理删除', async () => {
    const alice = await signIn()
    const created = await createToken(alice)

    const first = await as(alice, `/api/v1/access-tokens/${created.id}`, { method: 'DELETE' })
    expect(first.status).toBe(204)

    const row = await tokenRow(created.id)
    expect(row?.revokedAt).not.toBeNull()
    expect(await listTokens(alice)).toEqual([])

    const second = await as(alice, `/api/v1/access-tokens/${created.id}`, { method: 'DELETE' })
    expect(second.status).toBe(204)

    // 行还在（审计），token_hash 也没变
    expect((await tokenRow(created.id))?.tokenHash).toBe(row?.tokenHash)
  })

  it('不存在 / 不属于本人 / 形状不合法都是 404 NOT_FOUND（不区分两种）', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const bobsToken = await createToken(bob)

    for (const id of [UNKNOWN_UUID, bobsToken.id, 'abc']) {
      const res = await as(alice, `/api/v1/access-tokens/${id}`, { method: 'DELETE' })
      expect([id, res.status]).toEqual([id, 404])
      expect([id, await errorCode(res)]).toEqual([id, 'NOT_FOUND'])
    }

    // 别人的令牌**没有**被撤销
    expect((await tokenRow(bobsToken.id))?.revokedAt).toBeNull()
    expect((await listTokens(bob)).map((item) => item.id)).toEqual([bobsToken.id])
  })
})

describe('每用户最多 10 个有效令牌（SPEC §6.8）', () => {
  it('第 11 个是 VALIDATION_FAILED，且不自动撤销最旧的', async () => {
    const alice = await signIn()
    const created = []
    for (let i = 0; i < 10; i += 1) {
      created.push(await createToken(alice, { name: `设备 ${i}` }))
    }

    const res = await as(alice, '/api/v1/access-tokens', jsonRequest({ name: '第 11 个' }))
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('VALIDATION_FAILED')

    // 满额不该产生副作用：10 个都还在、都没有被偷偷撤销
    const items = await listTokens(alice)
    expect(items).toHaveLength(10)
    for (const item of items) expect((await tokenRow(item.id))?.revokedAt).toBeNull()
    expect(items.map((item) => item.id).sort()).toEqual(created.map((token) => token.id).sort())
  })

  it('撤销/过期的不计入上限 —— 它是「有效令牌」的上限，不是「创建过多少个」', async () => {
    const alice = await signIn()
    for (let i = 0; i < 10; i += 1) await createToken(alice, { name: `设备 ${i}` })

    // 满额
    expect((await as(alice, '/api/v1/access-tokens', jsonRequest({ name: 'x' }))).status).toBe(400)

    // 撤销一个 → 可以让新令牌进来
    const items = await listTokens(alice)
    const victim = items[0]
    expect(victim).toBeDefined()
    await as(alice, `/api/v1/access-tokens/${victim?.id}`, { method: 'DELETE' })
    expect((await as(alice, '/api/v1/access-tokens', jsonRequest({ name: '补位' }))).status).toBe(201)

    // 再满 10 个；把一个改成已过期，同样能再建一个
    const current = await listTokens(alice)
    expect(current).toHaveLength(10)
    const expiredId = current[0]?.id
    expect(expiredId).toBeDefined()
    await sql`update access_tokens set expires_at = now() - interval '1 day' where id = ${expiredId ?? ''}`
    expect((await as(alice, '/api/v1/access-tokens', jsonRequest({ name: '再过期补位' }))).status).toBe(201)
  })
})
