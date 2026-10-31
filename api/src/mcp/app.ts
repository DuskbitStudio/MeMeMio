import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  createMcpHandler,
  type AuthInfo,
  type McpRequestContext,
  type McpServer,
} from '@modelcontextprotocol/server'
import { requestId, type RequestIdVariables } from '../middleware/request-id.js'
import { createOriginResolver } from '../oauth/origin.js'
import { SEARCH_TOOL_NAMES, TOOL_NAMES } from './tool-names.js'

/**
 * `/mcp` 子应用（SPEC §10.2、§10.3、§10.6；实现约束 `agents/rules/mcp.md §1-§4`）。
 *
 * ## 为什么不挂在 `app.ts` 上
 *
 * `web` 消费 `AppType`，`app.ts` 的 import 图会整个进入 `web` 的 typecheck。MCP SDK 带 Node
 * 类型与自己的一套 wire 类型，塞进去只会让前端闸门变慢、变脆。所以这里**只依赖 `hono` 与
 * SDK 的类型**，不 import `env.ts` / `db.ts` / `data/*`——身份校验与服务端工厂从 `deps` 注入，
 * 这也让它能被 unit 测试直接构造（`src/mcp/app.test.ts`，不连数据库）。
 *
 * 真实组装在 `mcp/production.ts`，`src/server.ts` 按 pathname 把 `/mcp` 分流过来。
 *
 * ## 中间件顺序（有依赖关系，不要重排）
 *
 * 1. `requestId` —— 排障以它为准；响应头带 `X-Request-Id`
 * 2. 请求体上限 256 KiB —— **先挡住字节**，后面才敢 peek body 判工具名
 * 3. `Origin` 头一律 403 —— 本服务不支持浏览器内 MCP 客户端，也不提供 CORS
 * 4. Bearer 校验 —— 失败 401 + `WWW-Authenticate`，带 `resource_metadata` 与 `scope`
 *    （SPEC §10.3：只有一个 401 出口，PAT 与 OAuth 访问令牌走同一条校验链）
 * 5. 令牌级限流 —— 全量 120/min，检索类工具 30/min
 * 6. `handler.fetch` —— 协议头 / JSON-RPC 形状 / GET·DELETE 的 405 都交给 SDK
 */

/** 请求体上限：SPEC §10.2 的 256 KiB。 */
export const MCP_BODY_LIMIT_BYTES = 256 * 1024

/** 全量 MCP 请求的限流阈值（SPEC §10.6）。 */
const MCP_ALL_REQUESTS_PER_MINUTE = 120

/** 检索类工具（`search_memes` / `pick_meme_for_reply`）的限流阈值（SPEC §10.6）。 */
const MCP_SEARCH_REQUESTS_PER_MINUTE = 30

const RATE_WINDOW_MS = 60_000

/** 工具全集，供 peek 判名（`TOOL_NAMES` 是常量表，不是 Set）。 */
const TOOL_SET: ReadonlySet<string> = new Set(Object.values(TOOL_NAMES))

/**
 * 每个令牌每天的工具调用上限（SPEC §10.11）。**阈值是实现约束、可调**；
 * 「按令牌计数、UTC 自然日、超限 429 + Retry-After」才是契约。
 */
const MCP_DAILY_CALLS_PER_KEY = 2000

/**
 * 桶数上限。键是 `tokenId`，正常部署下到不了这个量级；到顶说明有人在大量签发/撤销令牌，
 * 那也不能让它把内存顶爆。与 `middleware/rate-limit.ts` 的 `MAX_BUCKETS` 同一个口径。
 */
const MAX_RATE_BUCKETS = 10_000

export type McpRateLimits = {
  allPerMinute: number
  searchPerMinute: number
  windowMs: number
  /** 每令牌每日工具调用上限（§10.11）。仅供测试调小；生产用默认值。 */
  dailyCallsPerKey: number
}

/** 一次请求里能拿到的日志上下文。 */
export type McpRequestMeta = { requestId: string }

/**
 * 可注入的依赖。
 *
 * `authenticate` 与 `buildServer` 是仅有的两个业务接缝：前者在 production 里查库校验令牌，
 * 后者把 5 个工具注册进一个新的 `McpServer`（**每个请求一个实例**，无状态）。
 * unit 测试注入假的实现，就完全不碰数据库与 env。
 */
export type McpAppDeps = {
  authenticate(request: Request, meta: McpRequestMeta): Promise<AuthInfo | null>
  buildServer(ctx: McpRequestContext): McpServer
  /**
   * SDK 的带外错误（协议错误、被拒绝的请求）。**只用于上报，不改变响应**。
   * `requestId` 可能缺失：SDK 的 onerror 回调里没有请求作用域（协议错误发生在路由之前）。
   */
  onHandlerError(error: Error, requestId?: string): void
  /** 仅供测试：把阈值调小来验 429，生产不要传。 */
  limits?: Partial<McpRateLimits>
  /**
   * 这个预算键今天（UTC）已经用掉的工具调用次数（§10.11）。
   *
   * 生产注入 `data/mcp-call-logs.countMcpCallsToday`；本文件不 import `data/*`（文件头）。
   * **抛异常 = 未超限**：查库失败不该让整个服务不可用（§10.11 的降级优先级）。
   */
  countDailyCalls(budgetKey: string): Promise<number>
  /** 日预算查询降级时的上报（可选；`app.ts` 自己不 import logger）。 */
  onDailyCountError?(error: unknown, meta: { requestId: string; tokenId: string }): void
  /**
   * 公开 origin（SPEC §10.10.1），只用来拼 401 里的 `resource_metadata`。
   *
   * 由组装处注入而不是在这里读 env：本文件不 import `env.ts`（见文件头），
   * 这样 unit 测试构造它时不依赖任何环境变量。`null` = 按请求推导，只适合本地。
   */
  publicOrigin: string | null
}

type McpVariables = RequestIdVariables & { mcpAuth: AuthInfo }

type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/**
 * 进程内滑动窗口，两个桶（SPEC §10.6 + `agents/rules/mcp.md §4`）。
 *
 * **键是 `tokenId` 而不是 user id**：同一用户可能有多台设备/多个客户端，其中一个失控
 * 不该把其余的连坐；反过来，令牌是撤销与审计的单位，限流也该按它。
 *
 * 计数只在进程内存里，多副本各限各的（与 `middleware/rate-limit.ts` 同一口径）：
 * 要精确到全站得引入共享存储，那与「不引入 Redis」（SPEC §9.11）冲突。
 */
function createRateLimiter(limits: McpRateLimits) {
  const hits = new Map<string, number[]>()

  function decide(key: string, limit: number, now: number): RateDecision {
    const cutoff = now - limits.windowMs
    const recent = (hits.get(key) ?? []).filter((at) => at > cutoff)

    if (recent.length >= limit) {
      // 裁剪后的数组要写回，否则下一次命中会从一个空窗口重新数起
      hits.set(key, recent)
      const oldest = recent[0] ?? now
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((oldest + limits.windowMs - now) / 1000),
      }
    }

    recent.push(now)
    hits.set(key, recent)
    if (hits.size > MAX_RATE_BUCKETS) {
      for (const [bucket, times] of hits) {
        if (times.every((at) => at <= cutoff)) hits.delete(bucket)
      }
      if (hits.size > MAX_RATE_BUCKETS) hits.clear()
    }
    return { allowed: true }
  }

  return {
    take(tokenId: string, isSearchTool: boolean, now: number = Date.now()): RateDecision {
      const all = decide(`all:${tokenId}`, limits.allPerMinute, now)
      if (!all.allowed) return all
      if (!isSearchTool) return { allowed: true }
      return decide(`search:${tokenId}`, limits.searchPerMinute, now)
    },
  }
}

/**
 * 工具里拿不到 Hono 的 `requestId`，但拿得到原始 `Request`（`ctx.http?.req`）。
 * 用 WeakMap 把它带过去：`src/mcp/server.ts` 的工厂按 `ctx.requestInfo` 取回，
 * 工具日志里的 `requestId` 才和这一次 HTTP 请求对得上。键是同一个 Request 对象，
 * 所以不会串；请求结束后对象被回收，表也不会涨。
 */
const requestIds = new WeakMap<Request, string>()

/** 取这次 MCP 请求的 requestId；拿不到时返回 `'unknown'`（宁可缺字段，也不要编一个）。 */
export function mcpRequestIdOf(request: Request | undefined): string {
  if (request === undefined) return 'unknown'
  return requestIds.get(request) ?? 'unknown'
}

/**
 * `/mcp` 的错误响应：JSON-RPC error + `id: null`。**不套 `/api/v1` 的错误信封**
 * （SPEC §10.2：这个端点说 JSON-RPC，鉴权与限流仍用 HTTP 状态码）。
 *
 * ⚠️ `X-Request-Id` 在这里**手工补上**。`middleware/request-id.ts` 的 `c.header()` 写的是
 * Hono 的「prepared headers」，只有在 handler 用 `c.json()` 之类构造响应时才会被合并；
 * `/mcp` 最终返回的是 SDK / 本文件构造的原生 `Response`，prepared headers 会被丢掉。
 * 排障要靠它把响应和日志对上，所以每条出口都显式带上。
 */
function jsonRpcError(
  status: number,
  message: string,
  requestId: string,
  headers?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
    {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': requestId, ...headers },
    },
  )
}

/** 给 SDK 返回的 `Response` 补 `X-Request-Id`（重建响应，不改原对象）。 */
function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Request-Id', requestId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * 401 挑战（SPEC §10.3）：`realm` + `resource_metadata` + `scope`。
 *
 * `resource_metadata` 指向**按路径插入**的那个发现文档
 * （`/.well-known/oauth-protected-resource/mcp`），客户端由它找到授权服务器并
 * 自己发起 OAuth。**所有 401 都带它**——无令牌与令牌无效是同一个出口，不按前缀分流：
 * 一个「有时带、有时不带」的挑战头会让客户端在不同时刻走进两条不同的路径。
 *
 * 已经配好 PAT 的客户端不解析这个头，行为与加它之前逐字一致。
 */
function unauthorized(requestId: string, resourceMetadataUrl: string): Response {
  return jsonRpcError(401, 'Unauthorized', requestId, {
    'www-authenticate':
      `Bearer realm="mememio", resource_metadata="${resourceMetadataUrl}", scope="mememio:read"`,
  })
}

function originNotAllowed(requestId: string): Response {
  return jsonRpcError(403, 'Origin header is not allowed', requestId)
}

function payloadTooLarge(requestId: string): Response {
  return jsonRpcError(
    413,
    `Payload Too Large: Request body must not exceed ${MCP_BODY_LIMIT_BYTES} bytes`,
    requestId,
  )
}

function tooManyRequests(requestId: string, retryAfterSeconds: number): Response {
  return jsonRpcError(429, 'Too Many Requests', requestId, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  })
}

type JsonRpcPeek = {
  isSearchToolCall: boolean
  /**
   * `tools/call` 且工具名在全集里时是它的名字，否则 null。
   *
   * 日预算只数**真正会执行的**工具调用（§10.11）：未知工具名由 SDK 回 JSON-RPC error，
   * 不执行、不写审计，也就不该占预算。名字取自我们自己解析的 body，写库前仍要再按
   * `TOOL_NAMES` 校验一次。
   */
  toolName: string | null
}

/**
 * 只 peek 出「这是不是一个检索类 tools/call」（限流要按工具名分桶）与工具名（日预算要它）。
 *
 * 用 `clone()` 读，**不消费原流**——真正的 body 留给 SDK 自己读（`agents/rules/mcp.md §2`：
 * 不传 `parsedBody`）。解析失败**不拦**：交给 SDK 回 JSON-RPC parse error，
 * 且这一次仍然计入全量桶、不计检索桶。
 */
async function peekJsonRpcCall(request: Request): Promise<JsonRpcPeek> {
  if (request.method !== 'POST') return { isSearchToolCall: false, toolName: null }

  try {
    const raw: unknown = JSON.parse(await request.clone().text())
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { isSearchToolCall: false, toolName: null }
    }

    const message = raw as { method?: unknown; params?: unknown }
    if (message.method !== 'tools/call') return { isSearchToolCall: false, toolName: null }
    if (typeof message.params !== 'object' || message.params === null) {
      return { isSearchToolCall: false, toolName: null }
    }

    const name = (message.params as { name?: unknown }).name
    if (typeof name !== 'string' || !TOOL_SET.has(name)) {
      return { isSearchToolCall: false, toolName: null }
    }
    return { isSearchToolCall: SEARCH_TOOL_NAMES.has(name), toolName: name }
  } catch {
    // ★ 这是**有意的降级**，不是吞错误：body 不是合法 JSON 时 JSON-RPC 层会给客户端
    //   一个 parse error，那是它该干的事；这里只需要「不计检索桶、不计预算」这个保守结论。
    return { isSearchToolCall: false, toolName: null }
  }
}

/**
 * 到下一个 UTC 0 点还有几秒（§10.11 的 `Retry-After`）。
 *
 * 至少 1 秒：返回 0 会让客户端立刻重试、再被打回，形成一小段忙等。
 */
export function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const date = new Date(now)
  const next = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0, 0, 0, 0,
  )
  return Math.max(1, Math.ceil((next - now) / 1000))
}

/** 日预算键（§10.11）：鉴权层算好的 `budgetKey`；旧 AuthInfo 没有时退回 tokenId。 */
function budgetKeyOf(authInfo: AuthInfo): string {
  const budgetKey = authInfo.extra?.['budgetKey']
  if (typeof budgetKey === 'string') return budgetKey
  return rateLimitKeyOf(authInfo)
}

/** 限流键：生产里 `extra.tokenId` 一定在（`authenticateMcpRequest` 构造的）；兜底用 clientId。 */
function rateLimitKeyOf(authInfo: AuthInfo): string {
  const tokenId = authInfo.extra?.['tokenId']
  return typeof tokenId === 'string' ? tokenId : authInfo.clientId
}

/**
 * 构造 `/mcp` 子应用。
 *
 * 路径不做 `basePath`：`src/server.ts` 只在 `pathname === '/mcp'` 时分流过来，
 * 这里用 `'*'` 接住（unit 测试直接 `app.request('/mcp', ...)` 也一样能命中）。
 */
export function createMcpApp(deps: McpAppDeps): Hono<{ Variables: McpVariables }> {
  const limits: McpRateLimits = {
    allPerMinute: deps.limits?.allPerMinute ?? MCP_ALL_REQUESTS_PER_MINUTE,
    searchPerMinute: deps.limits?.searchPerMinute ?? MCP_SEARCH_REQUESTS_PER_MINUTE,
    windowMs: deps.limits?.windowMs ?? RATE_WINDOW_MS,
    dailyCallsPerKey: deps.limits?.dailyCallsPerKey ?? MCP_DAILY_CALLS_PER_KEY,
  }
  // 日预算不进 `createRateLimiter`：它是查库计数，不是进程内的滑动窗口
  const dailyLimit = limits.dailyCallsPerKey
  const limiter = createRateLimiter(limits)
  // 与 `oauth/app.ts` 同一个解析器：401 里的 `resource_metadata` 与 issuer 必须指同一个 origin
  const resolveOrigin = createOriginResolver(deps.publicOrigin)

  const handler = createMcpHandler((ctx) => deps.buildServer(ctx), {
    // 2026-07-28 + 2025 代全程无状态（SPEC §10.2）
    legacy: 'stateless',
    // 不显式设 responseMode：默认 auto 在现代请求没有中途通知时就是单个 JSON
    // （我们的工具不发 progress / logging）。设成 'json' 会让 SDK 每次启动打一条
    // 「json 会丢通知」的警告，那条警告在本服务里永远不成立，只会污染启动日志。
    maxRequestBodySize: MCP_BODY_LIMIT_BYTES,
    onerror: (error) => deps.onHandlerError(error),
  })

  const app = new Hono<{ Variables: McpVariables }>()
    .use('*', requestId)

    /*
     * 请求体上限。`hono/body-limit` 两条路都挡：有 `Content-Length` 时先看头；
     * 分块传输时边读边数，超了立刻 413 并把已读的块原样接回去（不会把整个大 body
     * 读进内存）。**必须在 peek body 之前**，否则限流那一步会先读一份不受限的字节。
     *
     * 413 的形状对齐 SDK 自己的 413（JSON-RPC error + id: null）：同一个端点不该因为
     * 「哪一层先发现超限」而给出两种错误形状。
     */
    .use('*', bodyLimit({
      maxSize: MCP_BODY_LIMIT_BYTES,
      onError: (c) => payloadTooLarge(c.get('requestId')),
    }))

    // bodyLimit 在分块传输时会换掉 `c.req.raw`，所以 requestId 的登记必须排在它后面
    .use('*', async (c, next) => {
      requestIds.set(c.req.raw, c.get('requestId'))
      await next()
    })

    // 带 Origin 一律 403：本服务不支持浏览器内 MCP 客户端，也不提供 CORS（SPEC §10.2）
    .use('*', async (c, next) => {
      if (c.req.header('origin') !== undefined) return originNotAllowed(c.get('requestId'))
      await next()
    })

    // Bearer 校验。**只认令牌、不认 cookie**（SPEC §10.3）；失败一律 401
    .use('*', async (c, next) => {
      const authInfo = await deps.authenticate(c.req.raw, { requestId: c.get('requestId') })
      if (authInfo === null) {
        const metadata = `${resolveOrigin(c.req.raw)}/.well-known/oauth-protected-resource/mcp`
        return unauthorized(c.get('requestId'), metadata)
      }
      c.set('mcpAuth', authInfo)
      await next()
    })

    // 令牌级限流：两道闸，先分钟桶、再日预算（§10.6 + §10.11）。
    // **顺序不能反**：分钟桶打回的请求连查询都不该发；两道闸任一拦下都不写审计
    // （`mcp/server.ts` 只包装工具执行，拦截分支根本走不到那里）
    .use('*', async (c, next) => {
      const peek = await peekJsonRpcCall(c.req.raw)
      const authInfo = c.get('mcpAuth')

      const decision = limiter.take(rateLimitKeyOf(authInfo), peek.isSearchToolCall)
      if (!decision.allowed) return tooManyRequests(c.get('requestId'), decision.retryAfterSeconds)

      // 只数真正的工具调用：握手、tools/list、未知工具都不占预算（§10.11）
      if (peek.toolName !== null) {
        let used: number
        try {
          used = await deps.countDailyCalls(budgetKeyOf(authInfo))
        } catch (error) {
          // ★ **降级优先**（§10.11）：查库失败按未超限放行。一行审计写不进去或
          //   一次计数失败，都不该让整个 MCP 服务不可用。上报由组装处决定记到哪
          deps.onDailyCountError?.(error, {
            requestId: c.get('requestId'),
            tokenId: rateLimitKeyOf(authInfo),
          })
          used = 0
        }
        if (used >= dailyLimit) {
          return tooManyRequests(c.get('requestId'), secondsUntilUtcMidnight())
        }
      }

      await next()
    })

    // GET / DELETE 的 405、协议头不匹配的 400、JSON-RPC error 全部由 SDK 按规范产出
    .all('*', async (c) => withRequestId(
      await handler.fetch(c.req.raw, { authInfo: c.get('mcpAuth') }),
      c.get('requestId'),
    ))

  /*
   * 未捕获异常不套 `/api/v1` 的错误信封：`/mcp` 说 JSON-RPC，不说 SPEC §2 的
   * `{ error: { code } }`。原始错误只进日志，响应里只有一个通用错误。
   */
  app.onError((error, c) => {
    deps.onHandlerError(error, c.get('requestId'))
    return jsonRpcError(500, 'Internal error', c.get('requestId'))
  })

  return app
}
