import { McpServer, type McpRequestContext, type RegisteredTool } from '@modelcontextprotocol/server'
import type { Db } from '../data/db.js'
import type { NewMcpCallLog } from '../data/mcp-call-logs.js'
import { log } from '../logger.js'
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
 * 返回 id 的条数上限：单次工具返回本来就 ≤ 20（§10.4），超出说明上游行为变了。
 * 截断 + warn 比让一行日志无界增长好（§10.11）。
 */
const MAX_RESULT_MEME_IDS = 20

/** 从数组里挑出 `id` 是字符串的对象；形状不对就返回 null（交给调用方记空数组 + warn）。 */
function idsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const id = (item as Record<string, unknown>)['id']
    if (typeof id !== 'string') return null
    ids.push(id)
  }
  return ids
}

/**
 * 从工具结果的 `structuredContent` 抽「这次返回了哪些图」（§10.11）。
 *
 * **只读 `structuredContent`，不解析 text。** text 的 `detail` 有 compact / full 两档
 * （§10.4.6），按 text 取会在 compact 时静默少字段；`structuredContent` 永远完整。
 *
 * 返回 `null` 表示**形状不符合预期**（字段缺失、上游改了返回结构），由调用方记空数组并 warn；
 * 返回 `[]` 是「确实没有图」或「失败调用」——两者在日志里是同一条事实，不必区分。
 *
 * 各工具的取法不同，这正是不能写一个通用 `items[].id` 的原因：
 * - `search_memes` / `random_meme`：`items[].id`；
 * - `pick_meme_for_reply`：`chosen.id` + `alternatives[].id`（命中时 `chosen` 可为 `null`，
 *   那就只剩随机挑的那一张）；
 * - `get_meme_image`：**裸的一张图**，取顶层 `id`，不是 `items`；
 * - `list_vocab`：不返回图，恒空。
 *
 * 本函数**不抛异常**：抽取失败永远不能让工具调用失败（§10.11）。
 *
 * 导出是给测试的：`null` 那条分支在真工具上走不到（工具自己不会返回坏形状），
 * 只能直接喂形状不对的 `structuredContent` 验。
 */
export function resultMemeIdsOf(tool: string, result: unknown): string[] | null {
  if (tool === TOOL_NAMES.listVocab) return []

  const envelope = result as { isError?: unknown; structuredContent?: unknown } | null
  // 工具回 isError 时没有 structuredContent；记空数组，`outcome` 另算（§10.11）
  if (envelope?.isError === true) return []

  const structured = envelope?.structuredContent
  if (typeof structured !== 'object' || structured === null) return null
  const payload = structured as Record<string, unknown>

  let ids: string[] | null
  switch (tool) {
    case TOOL_NAMES.searchMemes:
    case TOOL_NAMES.randomMeme:
      ids = idsOf(payload['items'])
      break
    case TOOL_NAMES.pickMemeForReply: {
      const alternatives = idsOf(payload['alternatives'])
      const chosen = payload['chosen']
      if (alternatives === null) return null
      if (chosen === null) {
        ids = alternatives
        break
      }
      const chosenIds = idsOf([chosen])
      if (chosenIds === null) return null
      ids = [...chosenIds, ...alternatives]
      break
    }
    case TOOL_NAMES.getMemeImage: {
      const id = payload['id']
      if (typeof id !== 'string') return null
      ids = [id]
      break
    }
    default:
      // 工具名不在上面的全集里：说明注册了新工具却没定义抽取规则
      return null
  }
  if (ids === null) return null

  // 顺序照工具输出（相关性 / 抽取顺序本身是信息），去重但**不排序**
  return [...new Set(ids)].slice(0, MAX_RESULT_MEME_IDS)
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
 *
 * 导出是给测试的：用桩 `McpServer` 就能喂坏形状的 `structuredContent`，验「抽取失败记空数组
 * 且工具结果原样返回」——真工具自己不会返回坏形状，这条分支只能这么测。
 */
export function withAudit(
  server: McpServer,
  actor: { userId: string; tokenId: string; budgetKey: string },
  requestId: string,
  audit: McpAuditDeps,
): void {
  const register = server.registerTool.bind(server)
  type AnyTool = (...args: unknown[]) => Promise<unknown>

  /**
   * 写一行审计。`result` 只在工具正常返回时传入——抛异常的那条路径没有结果可抽。
   *
   * **抽取与写入都不会让工具调用失败**：抽取本身包在 try 里（形状不对只 warn），
   * 写库失败只上报。这是本函数唯一允许吞异常的地方（§10.11）。
   */
  const record = async (
    tool: string,
    args: unknown,
    outcome: 'ok' | 'error',
    result?: unknown,
  ): Promise<void> => {
    let resultMemeIds: string[] = []
    if (result !== undefined) {
      try {
        const extracted = resultMemeIdsOf(tool, result)
        if (extracted === null) {
          // ★ 有意降级：上游返回结构变了，记空数组并留下痕迹，不改变工具结果（§10.11）
          log.warn(
            { requestId, tokenId: actor.tokenId, tool },
            'mcp: 审计未能从 structuredContent 抽取 result_meme_ids，记空数组',
          )
        } else {
          resultMemeIds = extracted
        }
      } catch (error) {
        // 防御分支：抽取写坏了（例如 structuredContent 的 getter 抛），同样只 warn
        log.warn(
          { requestId, tokenId: actor.tokenId, tool, err: error },
          'mcp: 审计抽取 result_meme_ids 抛错，记空数组',
        )
      }
    }

    try {
      await audit.write({
        userId: actor.userId,
        tokenId: actor.tokenId,
        budgetKey: actor.budgetKey,
        tool,
        queryText: queryTextOf(tool, args),
        resultMemeIds,
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
        await record(name, args, isError ? 'error' : 'ok', result)
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
