import { McpServer, type McpRequestContext, type RegisteredTool } from '@modelcontextprotocol/server'
import type { Db } from '../data/db.js'
import type { NewMcpCallLog } from '../data/mcp-call-logs.js'
import { mcpRequestIdOf } from './app.js'
import { actorOf } from './auth.js'
import type { TtlCache } from './cache.js'
import type { SearchToolResult } from './search.js'
import { TOOL_NAMES } from './tool-names.js'
import { registerGetMemeImage } from './tools/get-meme-image.js'
import { registerListVocab } from './tools/list-vocab.js'
import { registerPickMemeForReply } from './tools/pick-meme-for-reply.js'
import { registerRandomMeme } from './tools/random-meme.js'
import { registerSearchMemes } from './tools/search-memes.js'

/**
 * `McpServer` 的组装：**只负责注册工具与它们的顺序**（`agents/rules/mcp.md §6`）。
 *
 * 真实依赖由 `mcp/production.ts` 传进来（db、缓存），身份则来自每个请求的 `AuthInfo`。
 * 每个 HTTP 请求都会用同一个工厂新建一个 `McpServer` 实例——这是 SDK 的 stateless 形态，
 * 也意味着 **`McpServer` 里不能存跨请求状态**（缓存放在 deps 里，是进程级的）。
 */

/** `serverInfo`。客户端会在 initialize 结果里看到它。 */
export const MCP_SERVER_NAME = 'mememio'
export const MCP_SERVER_VERSION = '0.1.0'

/**
 * `initialize` 里的 server instructions（SDK 的 `McpServerOptions.instructions`）。
 *
 * 这段是**给模型的使用说明**，不是给用户看的文案。它解决的是「工具选错/一次发多张/
 * 拿长句硬查」——这些靠工具 description 也能讲，但 instructions 在会话开头就出现，
 * 对「模型第一次决定怎么用这个服务器」更有效。
 */
const MCP_INSTRUCTIONS = [
  '这是 MeMeMio 共享表情包库的只读检索服务。',
  '回复前先想清楚要表达什么，优先调用 pick_meme_for_reply；message 传 10–20 字的意图摘要，',
  '不要直接塞一整段对话（工具内部有词表关键词兜底，但摘要更准）。',
  '一次只发 1 张；除非用户明确要一组，否则不要把 search_memes 的多张结果全部贴出来。',
  '成人向内容默认不返回；只有用户明确要求、且 list_vocab 显示 allowAdult=true 时，才传 allowAdult: true。',
  '需要筛选条件时先调 list_vocab；已选定图后用 get_meme_image；random_meme 只在用户说“随便来一张”时用。',
].join('\n')

export type McpServerDeps = {
  db: Db
  /** 检索结果的进程内缓存（SPEC §10.6）。由 production 持有，跨请求存活。 */
  cache: TtlCache<SearchToolResult>
  /** 调用审计（SPEC §10.11）。**失败只降级**，绝不影响工具结果。 */
  audit: McpAuditDeps
}

/**
 * 审计接缝（§10.11）。生产注入 `data/mcp-call-logs.insertMcpCallLog`；
 * 测试注入会抛异常的写实现来验「写日志失败不拦请求」。
 */
export type McpAuditDeps = {
  write(entry: NewMcpCallLog): Promise<void>
  /** 写失败的上报。只记 `requestId` / `tokenId`——令牌值永远不进日志（§10.3）。 */
  onError(error: unknown, meta: { requestId: string; tokenId: string }): void
}

/** 检索原文只对这两个工具有意义（§5.11）；参数名分别是 `query` / `message`。 */
const QUERY_ARG: Readonly<Record<string, string>> = {
  [TOOL_NAMES.searchMemes]: 'query',
  [TOOL_NAMES.pickMemeForReply]: 'message',
}

/** 从工具参数里取检索原文。取不到就 null，**不猜、不序列化整个参数**。 */
function queryTextOf(tool: string, args: unknown): string | null {
  const key = QUERY_ARG[tool]
  if (key === undefined || typeof args !== 'object' || args === null) return null
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/**
 * 给 `registerTool` 套一层审计：每完成一次 `tools/call` 写一行（§10.11）。
 *
 * 为什么包在这里而不是在 `app.ts` 解析响应：工具的**注册名**与 `isError` 只有这一层
 * 拿得到。`app.ts` 看到的是 JSON-RPC（2025 代客户端拿到的还是请求级 SSE 流），
 * 从响应体反推工具名与成败会随协议版本变化，而这里与协议无关。
 *
 * 三个必须保持的性质：
 * - **被拦下的请求永远不会到这里**：分钟桶与日预算都在 `app.ts` 的中间件里，
 *   走到工具执行就说明它已经通过了闸门；
 * - **失败只降级**：写不进去只上报，结果原样返回；工具自己抛的异常照样上抛，只是
 *   先记一行 `error`；
 * - **只记自己的事实**：身份取自 `AuthInfo.extra`（我们自己构造的），不读客户端参数。
 */
function withAudit(
  server: McpServer,
  actor: { userId: string; tokenId: string; budgetKey: string },
  requestId: string,
  audit: McpAuditDeps,
): void {
  const register = server.registerTool.bind(server)
  type AnyTool = (...args: unknown[]) => Promise<unknown>

  const record = async (tool: string, args: unknown, outcome: 'ok' | 'error'): Promise<void> => {
    try {
      await audit.write({
        userId: actor.userId,
        tokenId: actor.tokenId,
        budgetKey: actor.budgetKey,
        tool,
        queryText: queryTextOf(tool, args),
        outcome,
      })
    } catch (error) {
      // ★ 有意降级：一次成功的检索不该因为一棵审计行变成失败（§10.11）
      audit.onError(error, { requestId, tokenId: actor.tokenId })
    }
  }

  const patched = (name: string, config: unknown, callback: AnyTool): RegisteredTool => {
    const wrapped: AnyTool = async (...callArgs) => {
      // list_vocab 的签名是 `(ctx)`，其余是 `(args, ctx)`：参数恒为第一个
      const args = callArgs[0]
      try {
        const result = await callback(...callArgs)
        const isError = typeof result === 'object' && result !== null
          && (result as { isError?: unknown }).isError === true
        await record(name, args, isError ? 'error' : 'ok')
        return result
      } catch (error) {
        await record(name, args, 'error')
        throw error
      }
    }
    return (register as unknown as (n: string, c: unknown, cb: AnyTool) => RegisteredTool)(name, config, wrapped)
  }

  // 只替换实例上的这一处：5 个工具注册函数保持原样，不各写一遍包装
  ;(server as unknown as { registerTool: typeof patched }).registerTool = patched
}

export function buildMcpServer(ctx: McpRequestContext, deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  )

  // 工具日志里的 requestId 要和这次 HTTP 请求对得上：app.ts 在中间件里用 WeakMap
  // 把 `Request → requestId` 记下，工厂从 `ctx.requestInfo` 取回
  const requestId = mcpRequestIdOf(ctx.requestInfo)

  // 审计身份来自 `AuthInfo.extra`（`mcp/auth.ts` 构造）。`null` 只可能出现在没有鉴权的
  // 调用路径上；那种情况本来就不该有工具被执行，这里是防御分支
  const actor = actorOf(ctx.authInfo)
  if (actor !== null) withAudit(server, actor, requestId, deps.audit)

  // ⚠️ **注册顺序就是 `tools/list` 的顺序，不要按字母排。** SPEC §10.4 定死了
  //    `search_memes` → `pick_meme_for_reply` → `get_meme_image` → `random_meme` → `list_vocab`：
  //    客户端可缓存、有利于模型提示词缓存。`tool-names.ts` 的 `TOOL_ORDER` 是同一份清单
  registerSearchMemes(server, { db: deps.db, requestId, cache: deps.cache })
  registerPickMemeForReply(server, { db: deps.db, requestId, cache: deps.cache })
  registerGetMemeImage(server, { db: deps.db, requestId })
  registerRandomMeme(server, { db: deps.db, requestId })
  registerListVocab(server)

  return server
}
