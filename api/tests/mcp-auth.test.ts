import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `/mcp` 的鉴权集成测试（SPEC §10.3；`api/agents/rules/mcp.md §3`）。**连真 Postgres**。
 *
 * 覆盖：缺失 / 格式错 / 不存在 / 已撤销 / 已过期 → 全部 401（不区分原因），
 * 有效令牌能 `tools/list`（且顺序与 `TOOL_ORDER` 一致），`last_used_at` 写入有节流，
 * 日志里不出现令牌值，以及 429 的 `Retry-After`。
 *
 * 这里用**真实的** `authenticateMcpRequest` + `buildMcpServer`（不是桩）：
 * 令牌校验要测的正是「哈希查库 + 有效条件 + AuthInfo 构造」这一整段。
 *
 * ⚠️ 本机没有 Docker/Postgres，这个文件**写了但没跑**（任务交接时如实说明）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前：路由/数据层读的是默认连接
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
// 鉴权与 tools/list 不需要模型；显式清空部署方默认配置，保持降级态
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser } = await import('./helpers/factories.js')
const { createAccessToken, revokeAccessToken } = await import('../src/data/access-tokens.js')
const { accessTokens } = await import('../src/data/schema.js')
const { createSession } = await import('../src/data/auth.js')
const { generateToken, hashToken, prefixOf } = await import('../src/lib/token.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest, resetTokenTouchThrottle } = await import('../src/mcp/auth.js')
const { buildMcpServer } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { TOOL_ORDER } = await import('../src/mcp/tool-names.js')
const { log } = await import('../src/logger.js')
const { eq } = await import('drizzle-orm')

const { sql, db } = createTestDb()

beforeEach(async () => {
  await truncateAll(sql)
  // 节流表是进程级的：不重置的话上一个用例写过的 tokenId 会沿用（tokenId 是新的，实际不会串，
  // 但让每个用例从确定状态开始）
  resetTokenTouchThrottle()
})

afterAll(async () => {
  await sql.end()
})

/**
 * 按真实签发口径造一个令牌：**先有明文，再存哈希与前缀**（库里永远没有明文）。
 * 返回明文给请求用，返回 id 给「断言库里的行」用。
 */
async function issueToken(
  userId: string,
  options: { expiresAt?: Date; revoked?: boolean } = {},
): Promise<{ token: string; id: string }> {
  const token = generateToken()
  const row = await createAccessToken(
    {
      userId,
      name: '测试令牌',
      prefix: prefixOf(token),
      tokenHash: hashToken(token),
      expiresAt: options.expiresAt ?? null,
    },
    db,
  )
  if (options.revoked === true) await revokeAccessToken(row.id, userId, db)
  return { token, id: row.id }
}

async function tokenRow(id: string) {
  const rows = await db.select().from(accessTokens).where(eq(accessTokens.id, id))
  return rows[0]
}

function makeMcpApp(limits?: { allPerMinute?: number; searchPerMinute?: number }) {
  const handlerErrors: Error[] = []
  const app = createMcpApp({
    authenticate: authenticateMcpRequest,
    buildServer: (ctx) => buildMcpServer(ctx, { db, cache: createTtlCache() }),
    onHandlerError: (error) => handlerErrors.push(error),
    ...(limits !== undefined ? { limits } : {}),
  })
  return { app, handlerErrors }
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

async function rpc(
  app: ReturnType<typeof makeMcpApp>['app'],
  body: unknown,
  token?: string,
): Promise<Response> {
  return await app.request('/mcp', {
    method: 'POST',
    headers: {
      ...MCP_HEADERS,
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

/** 2025 代流量在无状态回退上按协议回「请求级 SSE」，从 data 行里取 JSON-RPC 响应。 */
async function readRpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const json = dataLine === undefined ? text : dataLine.slice('data: '.length)
  return JSON.parse(json) as Record<string, unknown>
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

describe('401：缺失 / 格式错 / 不存在 / 撤销 / 过期，一律同一个结果', () => {
  it('没有任何 Authorization 是 401，带 realm、不带 resource_metadata', async () => {
    const { app } = makeMcpApp()
    const res = await rpc(app, TOOLS_LIST)

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mememio"')
    const raw = JSON.stringify(await readRpcBody(res))
    expect(raw).not.toContain('resource_metadata')
  })

  it('不认 cookie：只有会话 cookie 的请求仍是 401', async () => {
    const alice = await createUser(db)
    const session = await createSession(alice.id, db)
    const { app } = makeMcpApp()

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, cookie: `sid=${session.id}` },
      body: JSON.stringify(TOOLS_LIST),
    })
    expect(res.status).toBe(401)
  })

  it('Authorization 不是 Bearer / 令牌形状不对 → 401，不查库也应该拒绝', async () => {
    const { app } = makeMcpApp()
    const headers = ['Basic abc', 'Bearer', 'Bearer ', 'Token abc', 'Bearer abc', `Bearer mcp_${'a'.repeat(42)}`]

    for (const authorization of headers) {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization },
        body: JSON.stringify(TOOLS_LIST),
      })
      expect([authorization, res.status]).toEqual([authorization, 401])
    }
  })

  it('形状对但库里没有 → 401', async () => {
    const { app } = makeMcpApp()
    const unknownToken = generateToken()
    const res = await rpc(app, TOOLS_LIST, unknownToken)
    expect(res.status).toBe(401)
  })

  it('已撤销 → 401（撤销立即生效）', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id, { revoked: true })
    const { app } = makeMcpApp()

    expect((await rpc(app, TOOLS_LIST, token)).status).toBe(401)
  })

  it('已过期 → 401', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id, { expiresAt: new Date(Date.now() - 60_000) })
    const { app } = makeMcpApp()

    expect((await rpc(app, TOOLS_LIST, token)).status).toBe(401)
  })

  it('「过期边界」由数据库时钟判：expires_at 在未来的 10 分钟内仍然有效', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id, { expiresAt: new Date(Date.now() + 10 * 60_000) })
    const { app } = makeMcpApp()

    expect((await rpc(app, TOOLS_LIST, token)).status).toBe(200)
  })
})

describe('有效令牌', () => {
  it('tools/list 列出 5 个只读工具，顺序与 TOOL_ORDER 一致', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id)
    const { app } = makeMcpApp()

    const res = await rpc(app, TOOLS_LIST, token)
    expect(res.status).toBe(200)

    const body = await readRpcBody(res)
    expect(body['jsonrpc']).toBe('2.0')
    const tools = (body['result'] as {
      tools: { name: string; annotations?: { readOnlyHint?: boolean } }[]
    }).tools

    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_ORDER])
    // 只读是 5 个工具的共同契约（SPEC §10.4 开头）
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
  })

  it('同一条令牌可以反复调用（无状态、不签发会话）', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id)
    const { app } = makeMcpApp()

    for (let i = 0; i < 3; i += 1) {
      const res = await rpc(app, { ...TOOLS_LIST, id: i + 1 }, token)
      expect(res.status).toBe(200)
      // 不签发 Mcp-Session-Id（SPEC §10.2：本服务没有会话）
      expect(res.headers.get('mcp-session-id')).toBeNull()
    }
  })

  it('last_used_at 在第一次成功调用后写入，且 5 分钟内不重复写（节流）', async () => {
    const alice = await createUser(db)
    const { token, id } = await issueToken(alice.id)
    const { app } = makeMcpApp()

    expect((await tokenRow(id))?.lastUsedAt).toBeNull()

    expect((await rpc(app, TOOLS_LIST, token)).status).toBe(200)
    const firstUsedAt = (await tokenRow(id))?.lastUsedAt
    expect(firstUsedAt).not.toBeNull()

    expect((await rpc(app, { ...TOOLS_LIST, id: 2 }, token)).status).toBe(200)
    const secondUsedAt = (await tokenRow(id))?.lastUsedAt
    // 节流窗口内不重写：时间戳完全相同（毫秒级）
    expect(secondUsedAt?.getTime()).toBe(firstUsedAt?.getTime())
  })

  it('GET /mcp 用有效令牌也是 405（这个端点没有会话/长流）', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id)
    const { app } = makeMcpApp()

    const res = await app.request('/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    })
    expect(res.status).toBe(405)
  })
})

describe('令牌值不进日志（SPEC §10.3）', () => {
  it('鉴权失败的日志只有 requestId 与原因，不含令牌', async () => {
    const warn = vi.spyOn(log, 'warn')
    const { app } = makeMcpApp()
    const unknownToken = generateToken()

    try {
      expect((await rpc(app, TOOLS_LIST, unknownToken)).status).toBe(401)

      const rejections = warn.mock.calls.filter((call) => call[1] === 'mcp auth rejected')
      expect(rejections.length).toBeGreaterThan(0)

      for (const call of rejections) {
        const meta = call[0] as Record<string, unknown>
        // 每条错误日志必须带 requestId（agents/rules/code-style.md）
        expect(typeof meta['requestId']).toBe('string')
        expect(JSON.stringify(call)).not.toContain(unknownToken)
        // 连前缀（可被关联到具体令牌）都不该出现
        expect(JSON.stringify(call)).not.toContain(unknownToken.slice(0, 12))
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('限流（SPEC §10.6：429 + Retry-After）', () => {
  it('超过注入的全量阈值 → 429 且 Retry-After ≥ 1 秒', async () => {
    const alice = await createUser(db)
    const { token } = await issueToken(alice.id)
    const { app } = makeMcpApp({ allPerMinute: 2 })

    expect((await rpc(app, TOOLS_LIST, token)).status).toBe(200)
    expect((await rpc(app, { ...TOOLS_LIST, id: 2 }, token)).status).toBe(200)

    const limited = await rpc(app, { ...TOOLS_LIST, id: 3 }, token)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('限流按令牌分桶：另一个用户的令牌不受影响', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const aliceToken = await issueToken(alice.id)
    const bobToken = await issueToken(bob.id)
    const { app } = makeMcpApp({ allPerMinute: 1 })

    expect((await rpc(app, TOOLS_LIST, aliceToken.token)).status).toBe(200)
    expect((await rpc(app, { ...TOOLS_LIST, id: 2 }, aliceToken.token)).status).toBe(429)

    // 另一个令牌自成一个桶
    expect((await rpc(app, { ...TOOLS_LIST, id: 3 }, bobToken.token)).status).toBe(200)
  })
})
