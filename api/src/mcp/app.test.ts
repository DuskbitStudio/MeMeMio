import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { McpServer, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server'
import { createMcpApp, MCP_BODY_LIMIT_BYTES, type McpRateLimits } from './app.js'
import { TOOL_ORDER } from './tool-names.js'

/**
 * `/mcp` 子应用的 unit 测试（`agents/rules/mcp.md §9`）。
 *
 * **不连数据库、不读 .env**：`createMcpApp` 的两条业务接缝（`authenticate` / `buildServer`）
 * 在这里都是假的。这条测试的价值就在这一点——Docker 没起也能跑，而且断言的是
 * HTTP 层行为（401 / 403 / 413 / 429 / 405、JSON-RPC 形状、tools/list 顺序），
 * 不是「假实现互相配合」。
 *
 * 真实的令牌校验在 `tests/mcp-auth.test.ts`，工具行为在 `tests/mcp-tools.test.ts`（要 Postgres）。
 */

const VALID_TOKEN = 'Bearer mcp_ok'
const TOKEN_ID = 'token-1'

const fakeAuthInfo: AuthInfo = {
  token: 'mcp_ok',
  clientId: 'user-1',
  scopes: ['mememio:read'],
  extra: { userId: 'user-1', role: 'member', tokenId: TOKEN_ID },
}

/** 只认一个固定值，其余一律 null —— 401 分支就是「authenticate 返回 null」。 */
async function fakeAuthenticate(request: Request): Promise<AuthInfo | null> {
  return request.headers.get('authorization') === VALID_TOKEN ? fakeAuthInfo : null
}

/**
 * 假的服务端工厂：按传入顺序注册一组只回 text 的 echo 工具。
 *
 * 它们只用来验证两件事：`tools/list` 的顺序**就是注册顺序**（app 层不重排），
 * 以及带真 body 的 `tools/call` 能穿到 SDK。真实工具不在这里注册。
 */
function fakeServerFactory(order: readonly string[]) {
  return (_ctx: McpRequestContext): McpServer => {
    const server = new McpServer({ name: 'test-mcp', version: '0.0.0' })
    for (const name of order) {
      server.registerTool(
        name,
        {
          description: `echo ${name}`,
          inputSchema: z.object({ text: z.string().optional() }),
          annotations: { readOnlyHint: true },
        },
        async (args) => ({
          content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }],
        }),
      )
    }
    return server
  }
}

/** 每个用例一个 app：限流状态是 app 私有的，不靠用例执行顺序。 */
function makeApp(options: {
  order?: readonly string[]
  limits?: Partial<McpRateLimits>
} = {}) {
  const handlerErrors: Error[] = []
  const app = createMcpApp({
    authenticate: fakeAuthenticate,
    buildServer: fakeServerFactory(options.order ?? ['search_memes', 'list_vocab']),
    onHandlerError: (error) => handlerErrors.push(error),
    limits: options.limits,
  })
  return { app, handlerErrors }
}

/** 2025 代流量在无状态回退上按协议回「请求级 SSE」，所以响应体要从 data 行里取。 */
async function readRpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
  const json = dataLine === undefined ? text : dataLine.slice('data: '.length)
  return JSON.parse(json) as Record<string, unknown>
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: VALID_TOKEN,
}

async function postRpc(
  app: ReturnType<typeof makeApp>['app'],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request('/mcp', {
    method: 'POST',
    headers: { ...BASE_HEADERS, ...headers },
    body: JSON.stringify(body),
  })
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

describe('鉴权与 Origin', () => {
  it('没有 Authorization 是 401 + WWW-Authenticate，且不带 resource_metadata', async () => {
    const { app } = makeApp()

    const headers = { ...BASE_HEADERS }
    delete headers['authorization']
    const res = await app.request('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(TOOLS_LIST),
    })

    expect(res.status).toBe(401)
    // SPEC §10.3：realm 带、resource_metadata **不带**（带上会引导客户端去走不存在的 OAuth 发现）
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="mememio"')
    // 错误响应同样带 requestId，排障时能把响应和日志对上
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(await readRpcBody(res))).not.toContain('resource_metadata')
  })

  it('令牌校验不过（authenticate 返回 null）同样是 401，不是 403', async () => {
    const { app } = makeApp()
    const res = await postRpc(app, TOOLS_LIST, { authorization: 'Bearer mcp_wrong' })
    expect(res.status).toBe(401)
  })

  it('带 Origin 头一律 403 —— 即使令牌是有效的', async () => {
    const { app } = makeApp()
    const res = await postRpc(app, TOOLS_LIST, { origin: 'https://example.com' })
    expect(res.status).toBe(403)
  })
})

describe('请求体上限（SPEC §10.2：256 KiB → 413）', () => {
  it('Content-Length 超限直接 413，不读 body', async () => {
    const { app } = makeApp()
    const res = await postRpc(app, TOOLS_LIST, {
      'content-length': String(MCP_BODY_LIMIT_BYTES + 1),
    })
    expect(res.status).toBe(413)
    const body = await readRpcBody(res)
    // 与 SDK 自己的 413 同形：JSON-RPC error + id:null
    expect(body['jsonrpc']).toBe('2.0')
    expect(body['id']).toBeNull()
    expect((body['error'] as { message: string }).message).toContain('Payload Too Large')
  })

  it('没有 Content-Length（分块 / 流）也要挡在 413', async () => {
    const { app } = makeApp()
    const oversized = new TextEncoder().encode(`{"pad":"${'x'.repeat(MCP_BODY_LIMIT_BYTES)}"}`)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // 只发一块、远超上限：bodyLimit 边读边数，读到超限就返回 413
        controller.enqueue(oversized)
        controller.close()
      },
    })

    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: VALID_TOKEN,
      },
      body,
      duplex: 'half',
    })

    const res = await app.fetch(request)
    expect(res.status).toBe(413)
  })
})

describe('令牌级限流（SPEC §10.6：全量 120/min，检索类 30/min）', () => {
  it('全量桶：超过注入的阈值后 429 + Retry-After', async () => {
    const { app } = makeApp({ limits: { allPerMinute: 2 } })

    expect((await postRpc(app, TOOLS_LIST)).status).toBe(200)
    expect((await postRpc(app, { ...TOOLS_LIST, id: 2 })).status).toBe(200)

    const res = await postRpc(app, { ...TOOLS_LIST, id: 3 })
    expect(res.status).toBe(429)
    // 秒数形式（delta-seconds），且至少 1 秒——返回 0 会让客户端立刻重试又被打回
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('检索桶独立：检索类工具打满 429，tools/list 仍放行', async () => {
    const { app } = makeApp({
      order: ['search_memes', 'list_vocab'],
      limits: { allPerMinute: 100, searchPerMinute: 1 },
    })

    const search = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'search_memes', arguments: {} } }
    expect((await postRpc(app, search)).status).toBe(200)

    const limited = await postRpc(app, { ...search, id: 11 })
    expect(limited.status).toBe(429)

    // 非检索工具走的是另一个桶，不受影响
    expect((await postRpc(app, TOOLS_LIST)).status).toBe(200)
  })
})

describe('JSON-RPC 与 tools/list', () => {
  it('tools/list 顺序 = 注册顺序，响应是合法 JSON-RPC 2.0 结果', async () => {
    const order = ['list_vocab', 'search_memes', 'random_meme'] as const
    const { app } = makeApp({ order })

    const res = await postRpc(app, TOOLS_LIST)
    expect(res.status).toBe(200)
    // requestId 中间件在 `/mcp` 上也要生效（排障以它为准），响应头带 X-Request-Id
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)

    const body = await readRpcBody(res)
    expect(body['jsonrpc']).toBe('2.0')
    expect(body['id']).toBe(1)
    expect(body['error']).toBeUndefined()

    const tools = (body['result'] as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }).tools
    expect(tools.map((tool) => tool.name)).toEqual([...order])
    // 全部只读：这是 SPEC §10.4 对 5 个工具的共同要求
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
  })

  it('TOOL_ORDER 是 SPEC §10.4 定死的顺序（真实 server.ts 按它注册）', () => {
    // 改顺序 = 改契约：客户端缓存与模型提示词缓存都依赖它
    expect([...TOOL_ORDER]).toEqual([
      'search_memes',
      'pick_meme_for_reply',
      'get_meme_image',
      'random_meme',
      'list_vocab',
    ])
  })

  it('tools/call 能穿到工具并带回 text 结果', async () => {
    const { app } = makeApp({ order: ['list_vocab'] })
    const res = await postRpc(app, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'list_vocab', arguments: { text: 'hi' } },
    })

    const body = await readRpcBody(res)
    const result = body['result'] as { content: { type: string; text: string }[] }
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text).toContain('list_vocab')
  })

  it('未知工具走 JSON-RPC error，不是 HTTP 错误码', async () => {
    const { app } = makeApp()
    const res = await postRpc(app, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })

    // 协议错误在 JSON-RPC 层（HTTP 200），与「工具执行失败」是两种东西（SPEC §10.4.7）
    expect(res.status).toBe(200)
    const body = await readRpcBody(res)
    expect(body['error']).toBeDefined()
    expect(body['result']).toBeUndefined()
  })

  it('GET /mcp 交给 SDK 回 405（本服务没有会话）', async () => {
    const { app } = makeApp()
    const res = await app.request('/mcp', {
      method: 'GET',
      headers: { authorization: VALID_TOKEN, accept: 'application/json, text/event-stream' },
    })
    expect(res.status).toBe(405)
  })
})
