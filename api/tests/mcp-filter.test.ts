import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'

/**
 * MCP 排除过滤器（SPEC §5.9 / §6.9 / §10.3.2）的真库集成测试。
 *
 * 覆盖：设置端点默认值/校验；filter 生效于 search/pick/random/get；Web 端不受影响；
 * 改过滤器后同 query 不能命中旧缓存。不依赖任何 AI 配置（只走 OCR/标签两路）。
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
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { mcpSettingsRoutes } = await import('../src/routes/mcp-settings.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest } = await import('../src/mcp/auth.js')
const { buildMcpServer } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { generateToken, hashToken, prefixOf } = await import('../src/lib/token.js')

type SearchToolResult = import('../src/mcp/search.js').SearchToolResult

const { sql, db } = createTestDb()

const settingsApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/mcp', mcpSettingsRoutes)
settingsApp.onError(onError)
settingsApp.notFound(onNotFound)

const memesApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/memes', memesRoutes)
memesApp.onError(onError)
memesApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
})

afterAll(async () => {
  await sql.end()
})

function makeMcpApp(): ReturnType<typeof createMcpApp> {
  return createMcpApp({
    authenticate: authenticateMcpRequest,
    buildServer: (ctx) => buildMcpServer(ctx, { db, cache: createTtlCache<SearchToolResult>() }),
    onHandlerError: () => {},
  })
}

async function issueToken(userId: string): Promise<string> {
  const token = generateToken()
  await createAccessToken(
    { userId, name: '测试令牌', prefix: prefixOf(token), tokenHash: hashToken(token), expiresAt: null },
    db,
  )
  return token
}

async function sessionCookie(userId: string): Promise<string> {
  const session = await createSession(userId, db)
  return `sid=${session.id}`
}

type ToolResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

async function readRpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const json = dataLine === undefined ? text : dataLine.slice('data: '.length)
  return JSON.parse(json) as Record<string, unknown>
}

async function callTool(
  app: ReturnType<typeof createMcpApp>,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
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
  return body['result'] as ToolResult
}

async function getFilter(cookie: string): Promise<Response> {
  return settingsApp.request('/api/v1/mcp/filter', { headers: { cookie } })
}

async function putFilter(cookie: string, excluded: unknown): Promise<Response> {
  return settingsApp.request('/api/v1/mcp/filter', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ excluded }),
  })
}

function idsOf(result: ToolResult): string[] {
  return ((result.structuredContent?.['items'] ?? []) as { id: string }[]).map((item) => item.id)
}

describe('GET/PUT /mcp/filter（SPEC §6.9）', () => {
  it('默认七个维度全空；PUT 合法值后可读回；未知维度/词表外/ratings 非空 → VALIDATION_FAILED', async () => {
    const user = await createUser(db)
    const cookie = await sessionCookie(user.id)

    const initial = await getFilter(cookie)
    expect(initial.status).toBe(200)
    const initialBody = (await initial.json()) as { excluded: Record<string, string[]> }
    expect(initialBody.excluded).toEqual({
      expressions: [], emotions: [], tones: [], purposes: [], scenes: [], tags: [], ratings: [],
    })

    const updated = await putFilter(cookie, { emotions: ['开心'], tags: ['猫'] })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      excluded: { emotions: ['开心'], tags: ['猫'], ratings: [] },
    })

    const again = await getFilter(cookie)
    expect(await again.json()).toMatchObject({ excluded: { emotions: ['开心'], tags: ['猫'] } })

    for (const body of [
      { moods: ['开心'] },
      { emotions: ['不存在的情绪'] },
      { ratings: ['成人向'] },
    ]) {
      const res = await putFilter(cookie, body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('未登录 401；不同用户过滤器互相独立', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const aliceCookie = await sessionCookie(alice.id)
    const bobCookie = await sessionCookie(bob.id)

    expect((await getFilter('')).status).toBe(401)
    expect((await putFilter(aliceCookie, { emotions: ['开心'] })).status).toBe(200)

    const bobFilter = await getFilter(bobCookie)
    expect((await bobFilter.json()) as { excluded: { emotions: string[] } }).toMatchObject({
      excluded: { emotions: [] },
    })
  })
})

describe('过滤器在 MCP 工具里生效（SPEC §10.3.2）', () => {
  it('search / random / get / pick 都不返回被排除的图；Web 端不受影响', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const cookie = await sessionCookie(alice.id)

    const excited = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '过滤器测试 开心',
      emotions: ['开心'],
    })
    const cat = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '过滤器测试 猫',
      tags: ['猫'],
    })
    const plain = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '过滤器测试 普通',
    })

    expect((await putFilter(cookie, { emotions: ['开心'], tags: ['猫'] })).status).toBe(200)

    const app = makeMcpApp()
    const search = await callTool(app, token, 'search_memes', { query: '过滤器测试', limit: 10 })
    const searchIds = idsOf(search)
    expect(searchIds).toContain(plain.id)
    expect(searchIds).not.toContain(excited.id)
    expect(searchIds).not.toContain(cat.id)

    const random = await callTool(app, token, 'random_meme', { limit: 10 })
    expect(idsOf(random)).not.toContain(excited.id)
    expect(idsOf(random)).not.toContain(cat.id)

    const single = await callTool(app, token, 'get_meme_image', { memeId: excited.id, inline: false })
    expect(single.isError).toBe(true)
    expect(single.content[0]?.text).toContain('过滤器')

    const picked = await callTool(app, token, 'pick_meme_for_reply', {
      message: '过滤器测试',
      inline: false,
      limit: 10,
    })
    const chosen = picked.structuredContent?.['chosen'] as { id?: string } | null
    expect(chosen?.id).toBe(plain.id)

    // Web 端不受 MCP 过滤器影响：同 query 仍能搜到被排除的图
    const webRes = await memesApp.request('/api/v1/memes?q=%E8%BF%87%E6%BB%A4%E5%99%A8%E6%B5%8B%E8%AF%95&limit=20', {
      headers: { cookie },
    })
    expect(webRes.status).toBe(200)
    const webIds = ((await webRes.json()) as { items: { id: string }[] }).items.map((item) => item.id)
    expect(webIds).toContain(excited.id)
  })

  it('改过滤器后同一 query 不会命中旧缓存（缓存 key 含过滤器）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const cookie = await sessionCookie(alice.id)
    const app = makeMcpApp()

    const target = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '缓存测试 开心',
      emotions: ['开心'],
    })
    const other = await makeMeme(db, { uploaderId: alice.id, ocrText: '缓存测试 普通' })

    // 先在没有过滤器时查一次，结果进缓存
    const before = await callTool(app, token, 'search_memes', { query: '缓存测试', limit: 10 })
    expect(idsOf(before)).toContain(target.id)

    expect((await putFilter(cookie, { emotions: ['开心'] })).status).toBe(200)

    // 同一个 app / token / query：必须按新过滤器重新查，不能返回旧缓存
    const after = await callTool(app, token, 'search_memes', { query: '缓存测试', limit: 10 })
    expect(idsOf(after)).toContain(other.id)
    expect(idsOf(after)).not.toContain(target.id)
  })
})
