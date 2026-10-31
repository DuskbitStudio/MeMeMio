import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'

/**
 * MCP 调用审计与令牌日预算（SPEC §10.11 / §5.11 / §6.11）的真库集成测试。
 *
 * 覆盖任务 `2026-10-31-mcp-audit-result` 的 api 端清单：
 * 每次 `tools/call` 写一行；原文与返回的图 id 只对本人可见，管理员看得到别人的行但拿不到；
 * 返回条数两种 scope 都返回；五个工具各按 `structuredContent` 抽 id；抽取失败记空数组；
 * 非管理员 `scope=all` → 403；跨用户 `tokenId` → 404；超日预算 → 429 且次日恢复；
 * OAuth 刷新不重置预算；令牌值不进表；写日志失败不拦请求；清理只删 90 天前的行。
 *
 * 不依赖任何 AI 配置：`list_vocab` 不碰库，检索走 OCR/标签兜底（与 mcp-filter 同一条路径）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { installR2Memory } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { createAccessToken } = await import('../src/data/access-tokens.js')
const {
  countExpiredMcpCallLogs,
  countMcpCallsToday,
  deleteExpiredMcpCallLogs,
  listMcpCallLogs,
} = await import('../src/data/mcp-call-logs.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { mcpLogRoutes } = await import('../src/routes/mcp-logs.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest, resetTokenTouchThrottle } = await import('../src/mcp/auth.js')
const { buildMcpServer, resultMemeIdsOf, withAudit } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { generateToken, hashToken, prefixOf } = await import('../src/lib/token.js')
const { accessTokens, mcpCallLogs, oauthClients, oauthGrants } = await import('../src/data/schema.js')
const { eq } = await import('drizzle-orm')

type SearchToolResult = import('../src/mcp/search.js').SearchToolResult

const { sql, db } = createTestDb()

const logApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/mcp', mcpLogRoutes)
logApp.onError(onError)
logApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  resetTokenTouchThrottle()
})

afterAll(async () => {
  await sql.end()
})

// ── 环境搭建 ───────────────────────────────────────────────────────

type McpApp = ReturnType<typeof createMcpApp>

/**
 * 审计失败的记录。用例要么看它为空（正常路径），要么看它有一条（注入失败）。
 * 不打印：写失败在本文件里是被断言的对象，不是噪音。
 */
type AuditErrors = { error: unknown; meta: { requestId: string; tokenId: string } }[]

function makeMcpApp(
  options: { dailyCallsPerKey?: number; auditWrite?: () => Promise<void> } = {},
): { app: McpApp; auditErrors: AuditErrors } {
  const auditErrors: AuditErrors = []
  const app = createMcpApp({
    authenticate: authenticateMcpRequest,
    buildServer: (ctx) => buildMcpServer(ctx, {
      db,
      cache: createTtlCache<SearchToolResult>(),
      audit: {
        write: options.auditWrite
          ?? (async (entry) => { await db.insert(mcpCallLogs).values(entry) }),
        onError: (error, meta) => {
          auditErrors.push({ error, meta })
        },
      },
    }),
    onHandlerError: () => {},
    publicOrigin: null,
    countDailyCalls: (budgetKey) => countMcpCallsToday(budgetKey, db),
    ...(options.dailyCallsPerKey === undefined
      ? {}
      : { limits: { dailyCallsPerKey: options.dailyCallsPerKey } }),
  })
  return { app, auditErrors }
}

async function issueToken(
  userId: string,
  options: { name?: string; grantId?: string; kind?: 'pat' | 'oauth' } = {},
): Promise<{ token: string; tokenId: string }> {
  const token = generateToken()
  const row = await createAccessToken(
    {
      userId,
      name: options.name ?? '测试令牌',
      prefix: prefixOf(token),
      tokenHash: hashToken(token),
      expiresAt: null,
    },
    db,
  )
  // `createAccessToken` 不接 kind / grantId（那是给用户在设置页建 PAT 用的）；
  // OAuth 令牌的行由授权流程写，用例里直接补这两列
  if (options.grantId !== undefined || options.kind !== undefined) {
    await db
      .update(accessTokens)
      .set({
        ...(options.grantId === undefined ? {} : { grantId: options.grantId }),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
      })
      .where(eq(accessTokens.id, row.id))
  }
  return { token, tokenId: row.id }
}

/** 直接插一行 grant（不跑完整的授权流程）：预算用例只关心 `grant_id` 这个键。 */
async function createGrant(userId: string, clientId: string): Promise<string> {
  const rows = await db
    .insert(oauthGrants)
    .values({
      userId,
      clientId,
      scope: 'mememio:read',
      resource: 'https://example.test/mcp',
      redirectUri: 'https://example.test/callback',
    })
    .returning({ id: oauthGrants.id })
  const id = rows[0]?.id
  if (id === undefined) throw new Error('建 grant 失败')
  return id
}

async function createClient(): Promise<string> {
  const clientId = `mmc_${randomSuffix()}`
  await db.insert(oauthClients).values({
    clientId,
    clientName: '测试应用',
    redirectUris: ['https://example.test/callback'],
  })
  return clientId
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12)
}

async function sessionCookie(userId: string): Promise<string> {
  const session = await createSession(userId, db)
  return `sid=${session.id}`
}

type ToolResult = {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
}

async function readRpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const json = dataLine === undefined ? text : dataLine.slice('data: '.length)
  return JSON.parse(json) as Record<string, unknown>
}

async function callTool(
  app: McpApp,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result: ToolResult | undefined; body: Record<string, unknown> }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await readRpcBody(res)
  return { status: res.status, result: body['result'] as ToolResult | undefined, body }
}

async function getLogs(
  cookie: string,
  query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await logApp.request(`/api/v1/mcp/logs${query === '' ? '' : `?${query}`}`, {
    headers: { cookie },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

type LogItem = {
  id: string
  userId: string
  createdAt: string
  tool: string
  tokenId: string | null
  tokenName: string | null
  tokenPrefix: string | null
  queryText: string | null
  /** 恒有：两种 `scope` 都给（§6.11）。 */
  resultCount: number
  /** 他人的行恒为 null。 */
  resultMemeIds: string[] | null
  outcome: string
}

function itemsOf(body: Record<string, unknown>): LogItem[] {
  return body['items'] as LogItem[]
}

// ── 写路径 ─────────────────────────────────────────────────────────

describe('审计写路径', () => {
  it('每次 tools/call 写一行，`query_text` 只对 search_memes / pick_meme_for_reply 有值', async () => {
    const user = await createUser(db)
    const { token, tokenId } = await issueToken(user.id, { name: '我的 Claude' })
    const { app } = makeMcpApp()

    await makeMeme(db, { uploaderId: user.id })

    const vocab = await callTool(app, token, 'list_vocab')
    expect(vocab.status).toBe(200)
    expect(vocab.result?.isError).not.toBe(true)

    const searched = await callTool(app, token, 'search_memes', { query: '想找一个笑的表情' })
    expect(searched.status).toBe(200)

    const rows = await db.select().from(mcpCallLogs).orderBy(mcpCallLogs.id)
    expect(rows).toHaveLength(2)

    // 最新一行是 search_memes（id 自增，所以按插入顺序）
    expect(rows[1]).toMatchObject({
      userId: user.id,
      tokenId,
      budgetKey: tokenId,
      tool: 'search_memes',
      queryText: '想找一个笑的表情',
      outcome: 'ok',
    })
    // list_vocab 没有原文参数，必须是 null，不能是空串或 `{}` 的字符串
    expect(rows[0]).toMatchObject({ tool: 'list_vocab', queryText: null, outcome: 'ok' })
  })

  it('工具返回 isError 时记为 error，仍然只写一行', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    // 不存在的 memeId：get_meme_image 走 NOT_FOUND 分支，返回 isError
    const failed = await callTool(app, token, 'get_meme_image', {
      memeId: '00000000-0000-4000-8000-000000000000',
    })
    expect(failed.result?.isError).toBe(true)

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'get_meme_image', outcome: 'error', queryText: null })
  })

  it('写日志失败只降级：工具结果照常返回，失败进上报（带 requestId / tokenId）', async () => {
    const user = await createUser(db)
    const { token, tokenId } = await issueToken(user.id)
    const boom = new Error('模拟写库失败')
    const { app, auditErrors } = makeMcpApp({
      auditWrite: async () => { throw boom },
    })

    const response = await callTool(app, token, 'list_vocab')

    // ★ 这样用例的核心：审计挂了，检索不能说挂就挂
    expect(response.status).toBe(200)
    expect(response.result?.isError).not.toBe(true)

    expect(auditErrors).toHaveLength(1)
    expect(auditErrors[0]?.error).toBe(boom)
    expect(auditErrors[0]?.meta.tokenId).toBe(tokenId)
    // requestId 不是 `unknown` 之外的空：中间件一定登记过
    expect(typeof auditErrors[0]?.meta.requestId).toBe('string')

    // 什么都没写进去——降级不等于写了一半
    expect(await db.select().from(mcpCallLogs)).toHaveLength(0)
  })

  it('令牌值不进表：所有列都搜不到明文令牌', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    await callTool(app, token, 'list_vocab')

    // 把整行拼成一坨文本再找：逐个列检查会在加列时漏掉新的一列
    const leaked = await sql`
      select count(*)::int as n from mcp_call_logs
      where (select row_to_json(l)::text from mcp_call_logs l where l.id = mcp_call_logs.id) like ${`%${token}%`}
    `
    expect(leaked[0]?.n).toBe(0)
  })
})

// ── 结果侧：返回了哪些图 ──────────────────────────────────────────

describe('结果侧：result_meme_ids', () => {
  it('search_memes / random_meme 记 items[].id；顺序照输出、去重、截断在 20', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    const first = await makeMeme(db, { uploaderId: user.id, ocrText: '猫在键盘上睡觉' })
    const second = await makeMeme(db, { uploaderId: user.id, description: '猫在键盘上睡觉的连拍' })
    await makeMeme(db, { uploaderId: user.id, ocrText: '一只狗在草地上奔跑' })

    const searched = await callTool(app, token, 'search_memes', { query: '猫在键盘上睡觉' })
    const structuredItems = (searched.result?.structuredContent as { items: { id: string }[] }).items
    expect(structuredItems.length).toBeGreaterThanOrEqual(2)

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    // 与工具响应里的 items 一一对上——不是「有几条」而已
    expect(rows[0]?.resultMemeIds).toEqual(structuredItems.map((item) => item.id))
    expect(rows[0]!.resultMemeIds).toHaveLength(structuredItems.length)
    expect(rows[0]?.resultMemeIds).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('get_meme_image 记 1 张（裸图取顶层 id）；list_vocab 恒空', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    const meme = await makeMeme(db, { uploaderId: user.id })
    const image = await callTool(app, token, 'get_meme_image', { memeId: meme.id })
    expect(image.result?.isError).not.toBe(true)

    const vocab = await callTool(app, token, 'list_vocab')
    expect(vocab.result?.isError).not.toBe(true)

    const rows = await db.select().from(mcpCallLogs).orderBy(mcpCallLogs.id)
    expect(rows[0]).toMatchObject({ tool: 'get_meme_image', outcome: 'ok', resultMemeIds: [meme.id] })
    expect(rows[1]).toMatchObject({ tool: 'list_vocab', outcome: 'ok', resultMemeIds: [] })
  })

  it('pick_meme_for_reply 记 chosen + alternatives；chosen 为 null 时记空数组', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    // 空库：命中为空、随机兜底也挑不到，结果就是 chosen = null
    const picked = await callTool(app, token, 'pick_meme_for_reply', { message: '被夸了有点得意' })
    expect(picked.result?.isError).not.toBe(true)
    expect((picked.result?.structuredContent as { chosen: unknown }).chosen).toBeNull()

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'pick_meme_for_reply', outcome: 'ok', resultMemeIds: [] })
  })

  it('失败调用记空数组，`outcome` 是 error', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    const failed = await callTool(app, token, 'get_meme_image', {
      memeId: '00000000-0000-4000-8000-000000000000',
    })
    expect(failed.result?.isError).toBe(true)

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: 'get_meme_image', outcome: 'error', resultMemeIds: [] })
  })

  it('抽取按工具分派：裸图 / items / chosen + alternatives / 空 / 形状不对', () => {
    const a = '11111111-1111-4111-8111-111111111111'
    const b = '22222222-2222-4222-8222-222222222222'

    // search_memes / random_meme：items[].id
    expect(resultMemeIdsOf('search_memes', { structuredContent: { items: [{ id: a }, { id: b }] } })).toEqual([a, b])
    expect(resultMemeIdsOf('random_meme', { structuredContent: { items: [{ id: a }] } })).toEqual([a])

    // get_meme_image：裸的一张图，取顶层 id，不是 items
    expect(resultMemeIdsOf('get_meme_image', { structuredContent: { id: a } })).toEqual([a])
    expect(resultMemeIdsOf('get_meme_image', { structuredContent: { items: [{ id: a }] } })).toBeNull()

    // pick：chosen + alternatives；chosen=null 只剩 alternatives
    expect(resultMemeIdsOf('pick_meme_for_reply', {
      structuredContent: { chosen: { id: a }, alternatives: [{ id: b }] },
    })).toEqual([a, b])
    expect(resultMemeIdsOf('pick_meme_for_reply', {
      structuredContent: { chosen: null, alternatives: [{ id: b }] },
    })).toEqual([b])

    // list_vocab：不返回图，恒空——连 structuredContent 都不看
    expect(resultMemeIdsOf('list_vocab', { structuredContent: { dimensions: {} } })).toEqual([])
    expect(resultMemeIdsOf('list_vocab', undefined)).toEqual([])

    // isError：没有 structuredContent，记空数组，不是「抽取失败」
    expect(resultMemeIdsOf('get_meme_image', { isError: true })).toEqual([])

    // 形状不对 → null（调用方记空数组 + warn）
    expect(resultMemeIdsOf('search_memes', { structuredContent: { items: '不是数组' } })).toBeNull()
    expect(resultMemeIdsOf('search_memes', { structuredContent: { items: [{ id: 42 }] } })).toBeNull()
    expect(resultMemeIdsOf('search_memes', {})).toBeNull()
    expect(resultMemeIdsOf('search_memes', undefined)).toBeNull()

    // 顺序照输出、去重不排序、截断在 20
    expect(resultMemeIdsOf('search_memes', { structuredContent: { items: [{ id: b }, { id: a }, { id: b }] } }))
      .toEqual([b, a])
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    expect(resultMemeIdsOf('search_memes', { structuredContent: { items: many } })).toHaveLength(20)
  })

  it('抽取失败不影响工具返回：记空数组，结果原样交给客户端', async () => {
    const written: { tool: string; resultMemeIds: string[] }[] = []
    // 桩 McpServer：只留 `registerTool`，把包装后的回调捞出来直接调
    const registered: { name: string; callback: (...args: unknown[]) => Promise<unknown> }[] = []
    const stub = {
      registerTool: (name: string, _config: unknown, cb: (...args: unknown[]) => Promise<unknown>) => {
        registered.push({ name, callback: cb })
        return { name }
      },
    }

    withAudit(
      stub as unknown as Parameters<typeof withAudit>[0],
      { userId: 'user-1', tokenId: 'token-1', budgetKey: 'token-1' },
      'request-1',
      {
        write: async (entry) => { written.push({ tool: entry.tool, resultMemeIds: entry.resultMemeIds }) },
        onError: () => {},
      },
    )

    stub.registerTool('search_memes', {}, async () => '不是对象')
    const broken = { content: [{ type: 'text', text: 'x' }], structuredContent: { items: [{ noId: true }] } }
    stub.registerTool('search_memes', {}, async () => broken)
    stub.registerTool('get_meme_image', {}, async () => { throw new Error('工具炸了') })

    expect(registered).toHaveLength(3)

    // ① 返回值不是对象 → 抽取失败，记空数组，结果原样返回
    const plain = await registered[0]!.callback({ query: 'x', limit: 3 })
    expect(plain).toBe('不是对象')

    // ② structuredContent 形状不对 → 同上
    const withBadShape = await registered[1]!.callback({ query: 'x', limit: 3 })
    expect(withBadShape).toBe(broken)

    // ③ 工具抛异常：仍然记一条 error，空数组，异常照样上抛
    await expect(registered[2]!.callback({ memeId: 'x' })).rejects.toThrow('工具炸了')

    expect(written).toEqual([
      { tool: 'search_memes', resultMemeIds: [] },
      { tool: 'search_memes', resultMemeIds: [] },
      { tool: 'get_meme_image', resultMemeIds: [] },
    ])
  })
})

// ── 读路径 ─────────────────────────────────────────────────────────

describe('GET /api/v1/mcp/logs', () => {
  it('本人看到自己的原文；别人的行 `queryText` 为 null（管理员看全部时也一样）', async () => {
    const alice = await createUser(db)
    const admin = await createUser(db, { role: 'admin' })
    const aliceToken = await issueToken(alice.id)
    const adminToken = await issueToken(admin.id)
    const { app } = makeMcpApp()

    await makeMeme(db, { uploaderId: alice.id, ocrText: 'Alice 的私房话' })
    await callTool(app, aliceToken.token, 'search_memes', { query: 'Alice 的私房话' })
    await callTool(app, adminToken.token, 'search_memes', { query: '管理员自己的查询' })

    const aliceCookie = await sessionCookie(alice.id)
    const mine = await getLogs(aliceCookie)
    expect(mine.status).toBe(200)
    expect(mine.body['scope']).toBe('mine')
    const aliceItems = itemsOf(mine.body)
    expect(aliceItems).toHaveLength(1)
    expect(aliceItems[0]).toMatchObject({ userId: alice.id, queryText: 'Alice 的私房话' })

    // 管理员：两条都看得到，但只有自己的那条带原文
    const adminCookie = await sessionCookie(admin.id)
    const all = await getLogs(adminCookie, 'scope=all')
    expect(all.status).toBe(200)
    const allItems = itemsOf(all.body)
    expect(allItems).toHaveLength(2)

    const aliceRow = allItems.find((row) => row.userId === alice.id)
    const adminRow = allItems.find((row) => row.userId === admin.id)
    expect(aliceRow?.queryText).toBeNull()
    expect(adminRow?.queryText).toBe('管理员自己的查询')

    // 返回的图 id 跟原文同一条规则；**条数不跟**——他人行有数无 id（§6.11）
    expect(aliceRow?.resultMemeIds).toBeNull()
    expect(adminRow?.resultMemeIds).not.toBeNull()
    expect(aliceRow?.resultCount).toBeGreaterThan(0)
    expect(adminRow?.resultCount).toBe(adminRow?.resultMemeIds?.length)

    // 本人的行两者都有，长度一致
    expect(aliceItems[0]?.resultCount).toBe(aliceItems[0]?.resultMemeIds?.length)
    expect(aliceItems[0]?.resultMemeIds).not.toBeNull()
  })

  it('非管理员 `scope=all` → FORBIDDEN；`scope=foo` → VALIDATION_FAILED', async () => {
    const user = await createUser(db)
    const cookie = await sessionCookie(user.id)

    const forbidden = await getLogs(cookie, 'scope=all')
    expect(forbidden.status).toBe(403)
    expect((forbidden.body['error'] as { code: string }).code).toBe('FORBIDDEN')

    const invalid = await getLogs(cookie, 'scope=foo')
    expect(invalid.status).toBe(400)
    expect((invalid.body['error'] as { code: string }).code).toBe('VALIDATION_FAILED')
  })

  it('`scope=mine` 筛别人的 tokenId → NOT_FOUND；筛自己的能看到', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const bobToken = await issueToken(bob.id, { name: 'Bob 的令牌' })
    const { app } = makeMcpApp()

    await callTool(app, bobToken.token, 'list_vocab')

    const aliceCookie = await sessionCookie(alice.id)
    const foreign = await getLogs(aliceCookie, `tokenId=${bobToken.tokenId}`)
    expect(foreign.status).toBe(404)
    expect((foreign.body['error'] as { code: string }).code).toBe('NOT_FOUND')

    // 形状不对的 uuid 是校验失败，不是 404
    const malformed = await getLogs(aliceCookie, 'tokenId=abc')
    expect(malformed.status).toBe(400)

    const bobCookie = await sessionCookie(bob.id)
    const own = await getLogs(bobCookie, `tokenId=${bobToken.tokenId}`)
    expect(own.status).toBe(200)
    expect(itemsOf(own.body)).toHaveLength(1)
    // 展示身份是名字与前缀，不是密钥
    expect(itemsOf(own.body)[0]).toMatchObject({
      tokenId: bobToken.tokenId,
      tokenName: 'Bob 的令牌',
      tokenPrefix: prefixOf(bobToken.token),
    })
  })

  it('`tool` 白名单、日期区间、游标与筛选签名', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()
    const cookie = await sessionCookie(user.id)

    for (let i = 0; i < 3; i += 1) await callTool(app, token, 'list_vocab')

    const unknownTool = await getLogs(cookie, 'tool=not_a_tool')
    expect(unknownTool.status).toBe(400)

    const knownTool = await getLogs(cookie, 'tool=list_vocab')
    expect(knownTool.status).toBe(200)
    expect(itemsOf(knownTool.body)).toHaveLength(3)

    const reversed = await getLogs(cookie, 'from=2026-10-31&to=2026-10-01')
    expect(reversed.status).toBe(400)

    // 2026-02-31 不存在，不能被 Date 悄悄滚成 3 月
    const impossible = await getLogs(cookie, 'from=2026-02-31')
    expect(impossible.status).toBe(400)

    // 游标：limit=1 连翻三页，三页不重复
    const first = await getLogs(cookie, 'limit=1')
    const firstItems = itemsOf(first.body)
    expect(firstItems).toHaveLength(1)
    const cursor = first.body['nextCursor']
    expect(typeof cursor).toBe('string')

    const second = await getLogs(cookie, `limit=1&cursor=${String(cursor)}`)
    expect(itemsOf(second.body)).toHaveLength(1)
    expect(itemsOf(second.body)[0]?.id).not.toBe(firstItems[0]?.id)

    // 只改 limit 不算换筛选：分页大小不是筛选条件，滚动中调条数必须还能翻
    const resized = await getLogs(cookie, `limit=2&cursor=${String(cursor)}`)
    expect(resized.status).toBe(200)

    // 换了**筛选**还拿旧游标 → VALIDATION_FAILED（§1.3 / §6.11）
    const mismatched = await getLogs(cookie, `tool=list_vocab&cursor=${String(cursor)}`)
    expect(mismatched.status).toBe(400)
    expect((mismatched.body['error'] as { code: string }).code).toBe('VALIDATION_FAILED')
  })

  it('令牌行被物理删除后 tokenId / tokenName / tokenPrefix 为 null，行还在', async () => {
    const user = await createUser(db)
    const { token, tokenId } = await issueToken(user.id, { name: '要删的令牌' })
    const { app } = makeMcpApp()

    await callTool(app, token, 'list_vocab')
    await sql`delete from access_tokens where id = ${tokenId}::uuid`

    const cookie = await sessionCookie(user.id)
    const logs = await getLogs(cookie)
    expect(logs.status).toBe(200)
    const items = itemsOf(logs.body)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ tokenId: null, tokenName: null, tokenPrefix: null })
  })
})

// ── 日预算 ─────────────────────────────────────────────────────────

describe('令牌日预算', () => {
  it('超过每日上限 → 429 + Retry-After 到下一个 UTC 0 点；被拦的请求不写审计', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp({ dailyCallsPerKey: 1 })

    const first = await callTool(app, token, 'list_vocab')
    expect(first.status).toBe(200)

    const second = await callTool(app, token, 'list_vocab')
    expect(second.status).toBe(429)
    expect(second.body['error']).toMatchObject({ code: -32000 })

    // Retry-After 是纯秒数，落在 (0, 86400]
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_vocab', arguments: {} } }),
    })
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(86_400)

    // 只有第一次执行过：闸门拦下的请求根本不进工具回调
    expect(await db.select().from(mcpCallLogs)).toHaveLength(1)

    // 次日恢复：把审计行挪到昨天，今日计数归零
    await sql`update mcp_call_logs set created_at = created_at - interval '1 day'`
    expect(await countMcpCallsToday(await budgetKeyOfToken(token))).toBe(0)

    const tomorrow = await makeMcpApp({ dailyCallsPerKey: 1 })
    expect((await callTool(tomorrow.app, token, 'list_vocab')).status).toBe(200)
  })

  it('日预算只管 tools/call：超限后 tools/list 仍然可用', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp({ dailyCallsPerKey: 1 })

    await callTool(app, token, 'list_vocab')
    expect((await callTool(app, token, 'list_vocab')).status).toBe(429)

    const listed = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })
    expect(listed.status).toBe(200)
  })

  it('OAuth 令牌刷新（换行）不重置预算：按 grant 计数', async () => {
    const user = await createUser(db)
    const clientId = await createClient()
    const grantId = await createGrant(user.id, clientId)

    // 同一个 grant 下的两行访问令牌 = 刷新前 / 刷新后
    const first = await issueToken(user.id, { grantId, kind: 'oauth' })
    const refreshed = await issueToken(user.id, { grantId, kind: 'oauth' })
    expect(first.tokenId).not.toBe(refreshed.tokenId)

    const { app } = makeMcpApp({ dailyCallsPerKey: 1 })

    expect((await callTool(app, first.token, 'list_vocab')).status).toBe(200)

    // 换成刷新后的令牌：预算键仍是 grant，所以照样被拦
    expect((await callTool(app, refreshed.token, 'list_vocab')).status).toBe(429)

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.budgetKey).toBe(grantId)
    // 审计行记的是**这次**用的令牌行，不是 grant
    expect(rows[0]?.tokenId).toBe(first.tokenId)
  })

  it('计数查询失败按未超限放行（fail-open）', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    let reported = 0

    const app = createMcpApp({
      authenticate: authenticateMcpRequest,
      buildServer: (ctx) => buildMcpServer(ctx, {
        db,
        cache: createTtlCache<SearchToolResult>(),
        audit: { write: async (entry) => { await db.insert(mcpCallLogs).values(entry) }, onError: () => {} },
      }),
      onHandlerError: () => {},
      publicOrigin: null,
      countDailyCalls: async () => { throw new Error('模拟计数查询失败') },
      onDailyCountError: () => { reported += 1 },
      limits: { dailyCallsPerKey: 1 },
    })

    const result = await callTool(app, token, 'list_vocab')
    expect(result.status).toBe(200)
    expect(reported).toBe(1)
  })
})

/** 从审计行反查预算键：PAT 就是 token_id，但用例里不想再拼一遍 SQL。 */
async function budgetKeyOfToken(token: string): Promise<string> {
  const rows = await db
    .select({ id: accessTokens.id })
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, hashToken(token)))
    .limit(1)
  const id = rows[0]?.id
  if (id === undefined) throw new Error('找不到令牌行')
  return id
}

// ── 清理 ───────────────────────────────────────────────────────────

describe('审计清理', () => {
  it('只删 90 天前的行，新的保留', async () => {
    const user = await createUser(db)
    const { token } = await issueToken(user.id)
    const { app } = makeMcpApp()

    await callTool(app, token, 'list_vocab')
    await sql`insert into mcp_call_logs (user_id, token_id, budget_key, tool, outcome, created_at)
              values (${user.id}::uuid, null, 'old-key', 'list_vocab', 'ok', now() - interval '100 days')`

    expect(await countExpiredMcpCallLogs()).toBe(1)
    await deleteExpiredMcpCallLogs()

    const rows = await db.select().from(mcpCallLogs)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.budgetKey).not.toBe('old-key')
  })

  it('列表按 createdAt 倒序', async () => {
    const user = await createUser(db)
    await sql`insert into mcp_call_logs (user_id, token_id, budget_key, tool, outcome, created_at)
              values (${user.id}::uuid, null, 'k', 'list_vocab', 'ok', now() - interval '2 hours'),
                     (${user.id}::uuid, null, 'k', 'list_vocab', 'ok', now() - interval '1 hours')`

    const { items } = await listMcpCallLogs({ scope: 'mine', callerId: user.id, limit: 40 })
    expect(items.map((item) => item.tool)).toEqual(['list_vocab', 'list_vocab'])
    expect(items[0]!.createdAt.getTime()).toBeGreaterThan(items[1]!.createdAt.getTime())
  })
})
