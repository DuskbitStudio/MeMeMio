import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'

/**
 * MCP 五个工具的集成测试（SPEC §10.4–§10.6）。**连真 Postgres + R2 内存替身**。
 *
 * 这一组用**真实的** `createMcpApp` + `authenticateMcpRequest` + `buildMcpServer`，
 * 只有 R2 的 `send` 换成了内存实现（与 `tests/helpers/r2-memory.ts` 的既有做法一致：
 * 保留键的拼法与 head→get 的顺序，只砍掉网络）。
 *
 * 覆盖任务点名的那几条：搜索 id 序列与 `GET /memes?q=` 一致、软删不出现、
 * `favorited` 按令牌用户、输出不含内部字段、图片内联上限与回退。
 *
 * 刻意**不给** DEFAULT_*_* 配置：没有 embedding 就只剩 OCR + 标签两路，结果确定、
 * 也不会在测试里发网络请求（与 `tests/search-paths.test.ts` 同一个口径）。
 *
 * ⚠️ 本机没有 Docker/Postgres，这个文件**写了但没跑**（任务交接时如实说明）。
 */
const { requireDatabaseUrl, testDatabaseUrl } = await import('./helpers/db-url.js')

// ⚠️ 必须在 import 任何 src 模块之前
process.env['DATABASE_URL'] = testDatabaseUrl(requireDatabaseUrl())
process.env['DEFAULT_VISION_BASE_URL'] = ''
process.env['DEFAULT_VISION_API_KEY'] = ''
process.env['DEFAULT_VISION_MODEL'] = ''
process.env['DEFAULT_EMBED_BASE_URL'] = ''
process.env['DEFAULT_EMBED_API_KEY'] = ''
process.env['DEFAULT_EMBED_MODEL'] = ''

// R2 内存替身要在 import storage/r2.js 之前装好（预签名与网络那两层都换掉）
const { installR2Memory, resetR2, seedObject } = await import('./helpers/r2-memory.js')
installR2Memory()

const { createTestDb, truncateAll } = await import('./helpers/test-db.js')
const { createUser, makeMeme, favoriteMeme } = await import('./helpers/factories.js')
const { softDeleteMeme } = await import('../src/data/memes.js')
const { createSession } = await import('../src/data/auth.js')
const { createAccessToken } = await import('../src/data/access-tokens.js')
const { onError, onNotFound } = await import('../src/middleware/error.js')
const { requestId } = await import('../src/middleware/request-id.js')
const { memesRoutes } = await import('../src/routes/memes.js')
const { createMcpApp } = await import('../src/mcp/app.js')
const { authenticateMcpRequest } = await import('../src/mcp/auth.js')
const { buildMcpServer } = await import('../src/mcp/server.js')
const { createTtlCache } = await import('../src/mcp/cache.js')
const { UNTRUSTED_DATA_NOTICE } = await import('../src/mcp/format.js')
const { ORIGINAL_INLINE_MAX_BYTES, THUMB_INLINE_MAX_BYTES } = await import('../src/mcp/image.js')
const { generateToken, hashToken, prefixOf } = await import('../src/lib/token.js')
const { thumbKeyFor } = await import('../src/storage/r2.js')
const { vocabulary } = await import('../src/vocab.js')

type SearchToolResult = import('../src/mcp/search.js').SearchToolResult

const { sql, db } = createTestDb()

// `GET /memes?q=` 一侧：与 MCP 工具共用同一份召回/融合实现，这里只加一个登录中间件
const restApp = new Hono()
  .use('*', requestId)
  .route('/api/v1/memes', memesRoutes)
restApp.onError(onError)
restApp.notFound(onNotFound)

beforeEach(async () => {
  await truncateAll(sql)
  resetR2()
})

afterAll(async () => {
  await sql.end()
})

// ── 环境搭建 ───────────────────────────────────────────────────────

type McpToolsApp = ReturnType<typeof createMcpApp>

/** 每个用例一个 MCP app（缓存与限流状态都是 app 私有的，不靠用例之间的执行顺序）。 */
function makeMcpApp(): McpToolsApp {
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

type ToolContent = { type: string; text?: string; data?: string; mimeType?: string }
type ToolResult = {
  content: ToolContent[]
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
  app: McpToolsApp,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; result: ToolResult }> {
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
  return { status: res.status, body, result: body['result'] as ToolResult }
}

async function searchViaTool(
  app: McpToolsApp,
  token: string,
  query: string,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  const { status, result } = await callTool(app, token, 'search_memes', { query, ...extra })
  expect(status).toBe(200)
  return result
}

async function restSearch(cookie: string, query: string, limit = 8): Promise<{ id: string }[]> {
  const res = await restApp.request(
    `/api/v1/memes?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: { cookie } },
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: { id: string }[] }).items
}

function itemsOf(result: ToolResult): MemeSummaryLike[] {
  return (result.structuredContent?.['items'] ?? []) as MemeSummaryLike[]
}

/** `MemeSummary` 的对外形状（SPEC §10.4.6）。测试里用它断言「没有多余字段」。 */
type MemeSummaryLike = {
  id: string
  description: string | null
  ocrText: string | null
  expressions: string[]
  emotions: string[]
  tones: string[]
  purposes: string[]
  scenes: string[]
  tags: string[]
  ratings: string[]
  isAnimated: boolean
  mime: string
  width: number | null
  height: number | null
  sizeBytes: number
  url: string
  thumbUrl: string
}

const SUMMARY_KEYS = [
  'description',
  'emotions',
  'expressions',
  'height',
  'id',
  'isAnimated',
  'mime',
  'ocrText',
  'purposes',
  'ratings',
  'scenes',
  'sizeBytes',
  'tags',
  'thumbUrl',
  'tones',
  'url',
  'width',
]

/** SPEC §10.4.6 明列「不返回」的那些字段。 */
const INTERNAL_KEYS = [
  'storageKey',
  'contentHash',
  'phash',
  'embedding',
  'searchText',
  'embedModel',
  'deletedAt',
  'uploaderId',
  'uploaderName',
  'tagStatus',
  'visionModel',
  'favorited',
  'editedBy',
  'editedAt',
  'createdAt',
  'originalFilename',
]

// ── list_vocab ─────────────────────────────────────────────────────

describe('list_vocab', () => {
  it('返回词表版本与七个维度，文本以「不可信数据」声明开头', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'list_vocab', {})
    expect(result.isError).toBeUndefined()

    const payload = result.structuredContent as {
      version: string
      updatedAt: string
      dimensions: Record<string, string[]>
    }
    expect(payload.version).toBe(vocabulary.version)
    expect(payload.updatedAt).toBe(vocabulary.updatedAt)
    // 顺序与 VOCAB_FIELDS 一致（提示词与前端筛选区的展示顺序是同一份定义）
    expect(Object.keys(payload.dimensions)).toEqual([
      'expressions',
      'emotions',
      'tones',
      'purposes',
      'scenes',
      'tags',
      'ratings',
    ])
    expect(payload.dimensions['expressions']?.length).toBeGreaterThan(0)
    // tags 是 subject + style 的并集
    expect(payload.dimensions['tags']?.length).toBe(
      vocabulary.tags.subject.length + vocabulary.tags.style.length,
    )

    const text = result.content[0]?.text ?? ''
    expect(text.startsWith(UNTRUSTED_DATA_NOTICE)).toBe(true)
  })
})

// ── search_memes ───────────────────────────────────────────────────

describe('search_memes', () => {
  it('结果 id 序列与 GET /memes?q= 一致（同一次检索、同一份融合）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const cookie = await sessionCookie(alice.id)

    // 三条都会命中，相似度不同：比较的是**顺序**，不是集合
    const exact = await makeMeme(db, { uploaderId: alice.id, ocrText: '猫在键盘上睡觉' })
    const longer = await makeMeme(db, { uploaderId: alice.id, ocrText: '一只猫在键盘上睡觉，表情很困' })
    const partial = await makeMeme(db, { uploaderId: alice.id, description: '猫在键盘上睡觉的连拍' })
    await makeMeme(db, { uploaderId: alice.id, ocrText: '一只狗在草地上奔跑' })

    const app = makeMcpApp()
    const query = '猫在键盘上睡觉'
    const toolResult = await searchViaTool(app, token, query, { limit: 8 })
    const mcpIds = itemsOf(toolResult).map((item) => item.id)

    const restIds = (await restSearch(cookie, query, 8)).map((item) => item.id)

    expect(mcpIds).toEqual(restIds)
    // 断言这三条确实都在结果里 —— 否则「两边都是空」也会让上面的 toEqual 通过
    expect(mcpIds).toEqual(expect.arrayContaining([exact.id, longer.id, partial.id]))
  })

  it('软删的图不出现（搜索与单条都一样）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const alive = await makeMeme(db, { uploaderId: alice.id, ocrText: '这张猫还在键盘上睡觉' })
    const deleted = await makeMeme(db, { uploaderId: alice.id, ocrText: '这张猫还在键盘上睡觉' })
    await softDeleteMeme(deleted.id, { id: alice.id, role: 'member' }, db)

    const result = await searchViaTool(app, token, '这张猫还在键盘上睡觉')
    const ids = itemsOf(result).map((item) => item.id)
    expect(ids).toContain(alive.id)
    expect(ids).not.toContain(deleted.id)

    // 单条：已软删的 id 是**工具错误**，不是空结果（SPEC §10.4.3）
    const single = await callTool(app, token, 'get_meme_image', { memeId: deleted.id })
    expect(single.result.isError).toBe(true)
    expect(single.result.content[0]?.text).toContain('这张表情不存在')
  })

  it('favorited 按令牌用户算：A 的收藏不会出现在 B 的结果里', async () => {
    const alice = await createUser(db)
    const bob = await createUser(db)
    const aliceToken = await issueToken(alice.id)
    const bobToken = await issueToken(bob.id)
    const cookieAlice = await sessionCookie(alice.id)

    const meme = await makeMeme(db, { uploaderId: alice.id, ocrText: '无语猫猫看着你' })
    // 只让 alice 收藏
    await favoriteMeme(db, alice.id, meme.id)

    const app = makeMcpApp()
    const query = '无语猫猫看着你'

    // 不带 favorited：全库可读，两个人都看得到（SPEC §3.3）
    expect(itemsOf(await searchViaTool(app, aliceToken, query)).map((item) => item.id)).toContain(meme.id)
    expect(itemsOf(await searchViaTool(app, bobToken, query)).map((item) => item.id)).toContain(meme.id)

    // favorited=true：只看**令牌用户**的收藏
    expect(itemsOf(await searchViaTool(app, aliceToken, query, { favorited: true })).map((item) => item.id))
      .toEqual([meme.id])
    expect(itemsOf(await searchViaTool(app, bobToken, query, { favorited: true }))).toEqual([])

    // REST 侧同一个用户的口径一致（同一条 EXISTS 条件）
    const restFavorited = await restApp.request(
      `/api/v1/memes?q=${encodeURIComponent(query)}&favorited=true`,
      { headers: { cookie: cookieAlice } },
    )
    const restBody = (await restFavorited.json()) as { items: { id: string }[] }
    expect(restBody.items.map((item) => item.id)).toEqual(
      itemsOf(await searchViaTool(app, aliceToken, query, { favorited: true })).map((item) => item.id),
    )
  })

  it('输出是 MemeSummary：字段严格按 §10.4.6，内部字段一个都不出现', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: '猫在键盘上睡觉',
      tags: ['猫'],
      expressions: ['微笑'],
      isAnimated: false,
    })
    const app = makeMcpApp()

    const result = await searchViaTool(app, token, '猫在键盘上睡觉')
    const item = itemsOf(result).find((entry) => entry.id === meme.id)
    expect(item).toBeDefined()

    expect(Object.keys(item ?? {}).sort()).toEqual([...SUMMARY_KEYS].sort())
    for (const key of INTERNAL_KEYS) {
      expect([key, key in (item ?? {})]).toEqual([key, false])
    }
    // sizeBytes 是 number（≤20 MiB，安全），不是 bigint 序列化后的字符串
    expect(typeof item?.sizeBytes).toBe('number')
    // 地址由 storageKey 派生，但**字段**本身不出现（§5.2.6 / §10.4.6）。
    // 这里断言的是「没有这个字段」，不是「响应里不含那串字符」——url 里当然带着键的路径。
    // 用 `meme.storageKey` 而不是写死 `memes/`：测试工厂的键是 `test/...`（不依赖 R2 前缀约定）
    expect(item?.url).toContain(meme.storageKey)
    expect(item?.thumbUrl).toContain('thumbs/')
  })

  it('ocrText / description 截断到 120 字且去掉控制字符（SPEC §10.4.7）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    // 控制字符用 BEL（0x07），**不能用 NUL（0x00）**：Postgres 的 text 不接受 0x00，
    // 这个用例会在 INSERT 阶段就报 invalid byte sequence，测不到截断逻辑。
    const longOcr = `猫在键盘上睡觉\n${'很'.repeat(200)}`
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      ocrText: longOcr,
      description: `描述里有制表符\t和控制字符\u0007，还有很长${'长'.repeat(200)}`,
    })
    const app = makeMcpApp()

    const result = await searchViaTool(app, token, '猫在键盘上睡觉')
    const item = itemsOf(result).find((entry) => entry.id === meme.id)
    expect(item).toBeDefined()

    const ocr = item?.ocrText ?? ''
    expect(ocr).not.toContain('\n')
    expect(ocr).not.toContain('\t')
    expect([...ocr].length).toBeLessThanOrEqual(120)

    const description = item?.description ?? ''
    expect(description).not.toContain('\t')
    expect(description).not.toContain('\u0007')
    expect([...description].length).toBeLessThanOrEqual(120)

    // 默认 compact：text 是压缩形态（id/描述/合并标签/URL），structuredContent 才是完整字段
    const text = result.content[0]?.text ?? ''
    expect(text.startsWith(UNTRUSTED_DATA_NOTICE)).toBe(true)
    const json = text.slice(UNTRUSTED_DATA_NOTICE.length).trimStart()
    const compact = JSON.parse(json) as { items: Record<string, unknown>[] }
    expect(compact.items[0]).toMatchObject({ id: meme.id })
    expect(compact.items[0]).toHaveProperty('labels')
    expect(compact.items[0]).not.toHaveProperty('expressions')
  })

  it('query 为空 / 超 200 字 / limit 越界是工具错误（isError），不是 JSON-RPC error', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const cases: Record<string, unknown>[] = [
      { query: '   ' },
      { query: '猫'.repeat(201) },
      { query: '猫在键盘上睡觉', limit: 0 },
      { query: '猫在键盘上睡觉', limit: 21 },
    ]
    for (const args of cases) {
      const { status, body, result } = await callTool(app, token, 'search_memes', args)
      expect(status).toBe(200)
      expect(body['error']).toBeUndefined()
      expect(result.isError).toBe(true)
      expect(result.content[0]?.type).toBe('text')
    }
  })

  it('词表外的筛选值不报错，只返回空结果（与浏览一致）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    await makeMeme(db, { uploaderId: alice.id, ocrText: '猫在键盘上睡觉', emotions: ['无语'] })
    const app = makeMcpApp()

    const result = await searchViaTool(app, token, '猫在键盘上睡觉', { emotions: ['不存在的情绪'] })
    expect(result.isError).toBeUndefined()
    expect(itemsOf(result)).toEqual([])
  })
})

// ── pick_meme_for_reply ────────────────────────────────────────────

describe('pick_meme_for_reply', () => {
  it('给出 chosen + 最多 5 条 alternatives，并内联 chosen 的缩略图', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    for (let i = 0; i < 8; i += 1) {
      const meme = await makeMeme(db, {
        uploaderId: alice.id,
        ocrText: `猫在键盘上睡觉，第 ${i} 张`,
        storageKey: `memes/${crypto.randomUUID()}.png`,
      })
      // 缩略图是恒定的 WebP（§10.5），内联走 head → get
      seedObject(thumbKeyFor(meme.storageKey), Buffer.alloc(64, i + 1))
    }

    const { result } = await callTool(app, token, 'pick_meme_for_reply', {
      message: '猫在键盘上睡觉',
      limit: 8,
    })
    expect(result.isError).toBeUndefined()

    const chosen = result.structuredContent?.['chosen'] as MemeSummaryLike | null
    const alternatives = result.structuredContent?.['alternatives'] as MemeSummaryLike[]
    expect(chosen).not.toBeNull()
    expect(alternatives.length).toBeLessThanOrEqual(5)

    // chosen 就是融合序第一张（与 search_memes 同一份检索）
    const searched = await searchViaTool(app, token, '猫在键盘上睡觉', { limit: 8 })
    expect(chosen?.id).toBe(itemsOf(searched)[0]?.id)

    // 内联了图片字节，且是 WebP
    const image = result.content.find((block) => block.type === 'image')
    expect(image).toBeDefined()
    expect(image?.mimeType).toBe('image/webp')
    expect(typeof image?.data).toBe('string')
    expect((image?.data ?? '').length).toBeGreaterThan(0)
    // data 是 base64 的图片字节，不是被误塞进来的 URL
    expect(image?.data).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(image?.data).not.toContain('://')
  })

  it('没有结果时 chosen 为 null、alternatives 为空，不是错误', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'pick_meme_for_reply', {
      message: '完全没有出现过的句子xyzzy',
    })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.['chosen']).toBeNull()
    expect(result.structuredContent?.['alternatives']).toEqual([])
    expect(result.content.some((block) => block.type === 'image')).toBe(false)
  })
})

// ── random_meme ────────────────────────────────────────────────────

describe('random_meme', () => {
  it('返回 limit 条 MemeSummary，且只含契约字段', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    for (let i = 0; i < 4; i += 1) {
      await makeMeme(db, { uploaderId: alice.id, ocrText: `随机图 ${i}` })
    }
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'random_meme', { limit: 2 })
    expect(result.isError).toBeUndefined()
    const items = itemsOf(result)
    expect(items).toHaveLength(2)
    for (const item of items) expect(Object.keys(item).sort()).toEqual([...SUMMARY_KEYS].sort())

    // 文本也有固定声明
    expect((result.content[0]?.text ?? '').startsWith(UNTRUSTED_DATA_NOTICE)).toBe(true)
  })

  it('isAnimated 过滤生效', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    await makeMeme(db, { uploaderId: alice.id, isAnimated: true, mime: 'image/gif' })
    await makeMeme(db, { uploaderId: alice.id, isAnimated: false, mime: 'image/png' })
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'random_meme', { limit: 10, isAnimated: true })
    const items = itemsOf(result)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item.isAnimated).toBe(true)
  })
})

// ── get_meme_image ─────────────────────────────────────────────────

describe('get_meme_image', () => {
  async function seedImageMeme(options: {
    mime?: string
    isAnimated?: boolean
    thumbBytes?: Buffer
    originalBytes?: Buffer
  } = {}) {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const storageKey = `memes/${crypto.randomUUID()}.${options.mime === 'image/gif' ? 'gif' : 'png'}`
    const meme = await makeMeme(db, {
      uploaderId: alice.id,
      storageKey,
      mime: options.mime ?? 'image/png',
      isAnimated: options.isAnimated ?? false,
      sizeBytes: BigInt(options.originalBytes?.byteLength ?? 1024),
    })
    seedObject(thumbKeyFor(storageKey), options.thumbBytes ?? Buffer.alloc(128, 7))
    seedObject(storageKey, options.originalBytes ?? Buffer.alloc(1024, 9))
    return { alice, token, meme, storageKey }
  }

  it('默认内联缩略图（image/webp），同时给出 url / thumbUrl', async () => {
    const { token, meme } = await seedImageMeme()
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'get_meme_image', { memeId: meme.id })
    expect(result.isError).toBeUndefined()

    const summary = result.structuredContent as unknown as MemeSummaryLike
    expect(summary.id).toBe(meme.id)
    expect(summary.url).toContain('memes/')
    expect(summary.thumbUrl).toContain('thumbs/')
    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_KEYS].sort())

    const image = result.content.find((block) => block.type === 'image')
    expect(image?.mimeType).toBe('image/webp')
    expect(Buffer.from(image?.data ?? '', 'base64')).toHaveLength(128)
  })

  it('缩略图超过 512 KiB → 不内联，只说明并给链接（不是错误）', async () => {
    const { token, meme } = await seedImageMeme({
      thumbBytes: Buffer.alloc(THUMB_INLINE_MAX_BYTES + 1, 1),
    })
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'get_meme_image', { memeId: meme.id })
    expect(result.isError).toBeUndefined()
    expect(result.content.some((block) => block.type === 'image')).toBe(false)
    expect(result.content[0]?.text).toContain('缩略图过大')
    expect((result.structuredContent as unknown as MemeSummaryLike).url).toContain('memes/')
  })

  it('variant=original：静图且 ≤2 MiB 时按真实 mime 内联', async () => {
    const { token, meme } = await seedImageMeme({ originalBytes: Buffer.alloc(2048, 3) })
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'get_meme_image', {
      memeId: meme.id,
      variant: 'original',
    })
    const image = result.content.find((block) => block.type === 'image')
    expect(image?.mimeType).toBe('image/png')
    expect(Buffer.from(image?.data ?? '', 'base64')).toHaveLength(2048)
  })

  it('原图超过 2 MiB → 不内联，文本说明「图片过大，已改为链接」', async () => {
    const { token, meme } = await seedImageMeme({
      originalBytes: Buffer.alloc(ORIGINAL_INLINE_MAX_BYTES + 1, 2),
    })
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'get_meme_image', {
      memeId: meme.id,
      variant: 'original',
    })
    expect(result.isError).toBeUndefined()
    expect(result.content.some((block) => block.type === 'image')).toBe(false)
    expect(result.content[0]?.text).toContain('图片过大')
  })

  it('动图一律不内联字节（thumb 是静态 WebP，仍然可以内联）', async () => {
    const { token, meme } = await seedImageMeme({ mime: 'image/gif', isAnimated: true })
    const app = makeMcpApp()

    const original = await callTool(app, token, 'get_meme_image', {
      memeId: meme.id,
      variant: 'original',
    })
    expect(original.result.content.some((block) => block.type === 'image')).toBe(false)
    expect(original.result.content[0]?.text).toContain('动图')

    const thumb = await callTool(app, token, 'get_meme_image', { memeId: meme.id, variant: 'thumb' })
    expect(thumb.result.content.find((block) => block.type === 'image')?.mimeType).toBe('image/webp')
  })

  it('inline=false 只回元数据与 URL，不读图片字节', async () => {
    const { token, meme } = await seedImageMeme()
    const app = makeMcpApp()

    const { result } = await callTool(app, token, 'get_meme_image', {
      memeId: meme.id,
      inline: false,
    })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe('text')
    expect((result.structuredContent as unknown as MemeSummaryLike).thumbUrl).toContain('thumbs/')
  })

  it('不存在 / 已软删的 id 是工具错误（一句可自纠的中文）', async () => {
    const alice = await createUser(db)
    const token = await issueToken(alice.id)
    const app = makeMcpApp()

    const missing = await callTool(app, token, 'get_meme_image', {
      memeId: '2f4a1c9e-6b3d-4a17-9f0c-8c2b5d7e1a44',
    })
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content[0]?.text).toContain('这张表情不存在')

    // memeId 不是 uuid：zod 校验失败，同样是 isError（不是 JSON-RPC error）
    const malformed = await callTool(app, token, 'get_meme_image', { memeId: 'abc' })
    expect(malformed.body['error']).toBeUndefined()
    expect(malformed.result.isError).toBe(true)
  })
})
