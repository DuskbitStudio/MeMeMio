import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'

/**
 * MCP 内容范围（成人向双闸门）+ text 压缩 + `pick.inline` + 长句兜底
 * （SPEC §10.3.1 / §10.4.6 / §10.4.2 / §9.36）。
 *
 * 与 `mcp-tools.test.ts` 同一套真实 Postgres + R2 内存替身；不配任何默认模型，
 * 检索只走 OCR + 标签两路，结果确定且不联网。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme } = await import('./helpers/factories.js')
const { createSession } = await import('../src/data/auth.js')
const { createAccessToken } = await import('../src/data/access-tokens.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { mcpSettingsRoutes } = await import('../src/routes/mcp-settings.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest } = await import('../src/mcp/auth.js')
const { buildMcpServer } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { UNTRUSTED_DATA_NOTICE } = await import('../src/mcp/format.js')
const { generateToken, hashToken, prefixOf } = await import('../src/lib/token.js')
const { thumbKeyFor } = await import('../src/storage/r2.js')

type SearchToolResult = import('../src/mcp/search.js').SearchToolResult

const { sql, db } = createTestDb()

const restApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/mcp', mcpSettingsRoutes)
restApp.onError(onError)
restApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
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
  args: Record<string, unknown>,
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

async function putSettings(cookie: string, allowAdult: boolean): Promise<Response> {
  return restApp.request('/api/v1/mcp/settings', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ allowAdult }),
  })
}

/** 标记为成人向的图（ratings 是词表第七维，值只有「成人向」）。 */
async function makeAdultMeme(userId: string) {
  return makeMeme(db, {
    uploaderId: userId,
    ocrText: '这是一张成人向测试图',
    ratings: ['成人向'],
  })
}

async function makeNormalMeme(userId: string) {
  return makeMeme(db, { uploaderId: userId, ocrText: '这是一张普通测试图' })
}

function idsOf(result: ToolResult): string[] {
  return ((result.structuredContent?.['items'] ?? []) as { id: string }[]).map((item) => item.id)
}

// ── 设置端点 ───────────────────────────────────────────────────────

describe('MCP 设置端点（SPEC §6.9）', () => {
  it('默认 false；PUT 后可读回 true；未知字段 / 非布尔 → VALIDATION_FAILED', async () => {
    const alice = await createUser(db)
    const cookie = await sessionCookie(alice.id)

    const initial = await restApp.request('/api/v1/mcp/settings', { headers: { cookie } })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ allowAdult: false })

    const updated = await putSettings(cookie, true)
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ allowAdult: true })

    const again = await restApp.request('/api/v1/mcp/settings', { headers: { cookie } })
    expect(await again.json()).toEqual({ allowAdult: true })

    const unknown = await restApp.request('/api/v1/mcp/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ allowAdult: true, extra: 1 }),
    })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')

    const wrongType = await restApp.request('/api/v1/mcp/settings', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ allowAdult: 'yes' }),
    })
    expect(wrongType.status).toBe(400)
  })

  it('未登录 401；不同用户各自独立', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const aliceCookie = await sessionCookie(alice.id)
    const bobCookie = await sessionCookie(bob.id)

    const anonymous = await restApp.request('/api/v1/mcp/settings')
    expect(anonymous.status).toBe(401)

    expect(await putSettings(aliceCookie, true)).toHaveProperty('status', 200)
    const bobSettings = await restApp.request('/api/v1/mcp/settings', { headers: { cookie: bobCookie } })
    expect(await bobSettings.json()).toEqual({ allowAdult: false })
  })
})

// ── 成人向双闸门 ───────────────────────────────────────────────────

describe('成人向双闸门（SPEC §10.3.1）', () => {
  it('默认搜索 / 随机 / 单条都不返回成人向', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const adult = await makeAdultMeme(alice.id)
    const normal = await makeNormalMeme(alice.id)
    const app = makeMcpApp()

    const search = await callTool(app, token, 'search_memes', { query: '测试图', limit: 20 })
    expect(idsOf(search)).toContain(normal.id)
    expect(idsOf(search)).not.toContain(adult.id)

    const random = await callTool(app, token, 'random_meme', { limit: 10 })
    expect(idsOf(random)).not.toContain(adult.id)

    const single = await callTool(app, token, 'get_meme_image', { memeId: adult.id, inline: false })
    expect(single.isError).toBe(true)
    expect(single.content[0]?.text).toContain('成人向')
  })

  it('设置开启但本次未传 allowAdult → 仍不返回；开启 + 传 true → 返回', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const cookie = await sessionCookie(alice.id)
    const adult = await makeAdultMeme(alice.id)
    const app = makeMcpApp()

    expect(await putSettings(cookie, true)).toHaveProperty('status', 200)

    // 只开设置、不传参数：仍按不允许处理（§10.3.1 两层闸门）
    const withoutFlag = await callTool(app, token, 'search_memes', { query: '测试图', limit: 20 })
    expect(idsOf(withoutFlag)).not.toContain(adult.id)

    const withFlag = await callTool(app, token, 'search_memes', {
      query: '测试图',
      limit: 20,
      allowAdult: true,
    })
    expect(idsOf(withFlag)).toContain(adult.id)

    const single = await callTool(app, token, 'get_meme_image', {
      memeId: adult.id,
      inline: false,
      allowAdult: true,
    })
    expect(single.isError).toBeUndefined()
    expect((single.structuredContent as { id: string }).id).toBe(adult.id)
  })

  it('设置关闭时传 allowAdult: true → 工具错误（不是静默忽略）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const result = await callTool(app, token, 'search_memes', {
      query: '测试图',
      allowAdult: true,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('未开启成人向')
  })

  it('list_vocab 的 allowAdult 跟随设置（模型据此决定要不要传）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const cookie = await sessionCookie(alice.id)
    const app = makeMcpApp()

    const before = await callTool(app, token, 'list_vocab', {})
    expect(before.structuredContent?.['allowAdult']).toBe(false)

    expect(await putSettings(cookie, true)).toHaveProperty('status', 200)

    const after = await callTool(app, token, 'list_vocab', {})
    expect(after.structuredContent?.['allowAdult']).toBe(true)
  })
})

// ── 结果压缩 / pick.inline / 兜底 ──────────────────────────────────

describe('结果压缩与 pick.inline（SPEC §10.4.6 / §10.4.2）', () => {
  it('search 默认 compact text；detail=full 时 text 与 structuredContent 同形', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    await makeMeme(db, { uploaderId: alice.id, ocrText: '猫在键盘上睡觉', tags: ['猫'], emotions: ['疲惫'] })
    const app = makeMcpApp()

    const compact = await callTool(app, token, 'search_memes', { query: '猫在键盘上睡觉' })
    const compactText = compact.content[0]?.text ?? ''
    expect(compactText.startsWith(UNTRUSTED_DATA_NOTICE)).toBe(true)
    const compactJson = JSON.parse(compactText.slice(UNTRUSTED_DATA_NOTICE.length).trimStart()) as {
      items: Record<string, unknown>[]
    }
    expect(compactJson.items[0]).toHaveProperty('labels')
    expect(compactJson.items[0]).not.toHaveProperty('expressions')
    // structuredContent 仍是完整 MemeSummary
    const fullItem = ((compact.structuredContent?.['items'] ?? []) as Record<string, unknown>[])[0]
    expect(fullItem).toHaveProperty('expressions')
    expect(fullItem).toHaveProperty('sizeBytes')

    const full = await callTool(app, token, 'search_memes', { query: '猫在键盘上睡觉', detail: 'full' })
    const fullText = full.content[0]?.text ?? ''
    const fullJson = JSON.parse(fullText.slice(UNTRUSTED_DATA_NOTICE.length).trimStart())
    expect(fullJson).toEqual(full.structuredContent)
  })

  it('pick.inline=false 不返回图片字节；默认 true 返回', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const meme = await makeMeme(db, { uploaderId: alice.id, ocrText: '猫在键盘上睡觉' })
    seedObject(thumbKeyFor(meme.storageKey), Buffer.alloc(64, 1))
    const app = makeMcpApp()

    const withoutImage = await callTool(app, token, 'pick_meme_for_reply', {
      message: '猫在键盘上睡觉',
      inline: false,
    })
    expect(withoutImage.isError).toBeUndefined()
    expect(withoutImage.content.some((block) => block.type === 'image')).toBe(false)
    const chosen = withoutImage.structuredContent?.['chosen'] as { url?: string } | null
    // 工厂的 storageKey 是 reviews-test/...，不写死 memes/；断言 URL 由它派生
    expect(chosen?.url).toContain(meme.storageKey)

    const withImage = await callTool(app, token, 'pick_meme_for_reply', {
      message: '猫在键盘上睡觉',
    })
    expect(withImage.content.some((block) => block.type === 'image')).toBe(true)
  })

  it('长句没有直接命中时按词表关键词兜底（§9.36）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    // 只打标签、不写 OCR/描述：整句检索不会命中，词表关键词「得意」才会
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      emotions: ['得意'],
      tones: ['卖萌'],
    })
    const app = makeMcpApp()

    const result = await callTool(app, token, 'search_memes', {
      query: '被夸会选表情包，有点不好意思又有点得意，嘿嘿',
    })
    expect(result.isError).toBeUndefined()
    expect(idsOf(result)).toContain(meme.id)

    const picked = await callTool(app, token, 'pick_meme_for_reply', {
      message: '被夸会选表情包，有点不好意思又有点得意，嘿嘿',
      inline: false,
    })
    const chosen = picked.structuredContent?.['chosen'] as { id?: string } | null
    expect(chosen?.id).toBe(meme.id)
  })

  it('pick 精确检索为空、库非空时走安全随机兜底（不返回 null）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    await makeMeme(db, { uploaderId: alice.id, ocrText: '一张完全无关的图' })
    const app = makeMcpApp()

    const result = await callTool(app, token, 'pick_meme_for_reply', {
      message: 'zzzzzz 不存在的句子',
      inline: false,
    })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.['chosen']).not.toBeNull()
    expect(result.content[0]?.text).toContain('随机挑一张')
  })
})
