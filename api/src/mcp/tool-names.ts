/**
 * MCP 工具名。**全进程唯一一份清单**（SPEC §10.4：共 5 个工具，`tools/list` 顺序固定）。
 *
 * 它单独成文件是因为有两个消费方，而它们的依赖面完全不同：
 *
 * - `mcp/app.ts` 的限流中间件要认出「检索类工具」（要按名字判桶），而 app.ts
 *   **不能 import data/env**（这样它才能被 unit 测试直接构造，`agents/rules/mcp.md §1`）；
 * - `mcp/tools/*.ts` 注册时要用名字，`mcp/server.ts` 注册顺序也按这份清单。
 *
 * 本文件**零 import**：谁都可以安全地拿它，不会把依赖图带大。
 * 名字写错的表现不是报错，是「新工具永远不会被限流 / `tools/list` 顺序变了」——不报错。
 */

export const TOOL_NAMES = {
  searchMemes: 'search_memes',
  pickMemeForReply: 'pick_meme_for_reply',
  getMemeImage: 'get_meme_image',
  randomMeme: 'random_meme',
  listVocab: 'list_vocab',
} as const

/**
 * 检索类工具：**会产生 AI 调用**（HyDE + 查询 embedding），所以单独一个 30/分钟的桶
 * （SPEC §10.6）。`random_meme` / `list_vocab` 不调 AI，只计入全量桶。
 */
export const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.searchMemes,
  TOOL_NAMES.pickMemeForReply,
])

/** `tools/list` 的固定顺序（SPEC §10.4）：客户端可缓存，也利于模型提示词缓存。 */
export const TOOL_ORDER = [
  TOOL_NAMES.searchMemes,
  TOOL_NAMES.pickMemeForReply,
  TOOL_NAMES.getMemeImage,
  TOOL_NAMES.randomMeme,
  TOOL_NAMES.listVocab,
] as const
