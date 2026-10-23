import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server'
import type { Db } from '../data/db.js'
import { mcpRequestIdOf } from './app.js'
import type { TtlCache } from './cache.js'
import type { SearchToolResult } from './search.js'
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
}

export function buildMcpServer(ctx: McpRequestContext, deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: MCP_INSTRUCTIONS },
  )

  // 工具日志里的 requestId 要和这次 HTTP 请求对得上：app.ts 在中间件里用 WeakMap
  // 把 `Request → requestId` 记下，工厂从 `ctx.requestInfo` 取回
  const requestId = mcpRequestIdOf(ctx.requestInfo)

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
