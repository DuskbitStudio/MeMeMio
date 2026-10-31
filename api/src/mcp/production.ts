import { db } from '../data/db.js'
import { countMcpCallsToday, insertMcpCallLog } from '../data/mcp-call-logs.js'
import { env } from '../env.js'
import { log } from '../logger.js'
import { createMcpApp } from './app.js'
import { authenticateMcpRequest } from './auth.js'
import { createTtlCache } from './cache.js'
import type { SearchToolResult } from './search.js'
import type { McpAuditDeps } from './server.js'
import { buildMcpServer } from './server.js'

/**
 * `/mcp` 的**真实组装**（`agents/rules/mcp.md §1`）：
 * 数据库、令牌校验、工具工厂在这里接起来，`src/server.ts` 只需要 import 这个 `mcpApp`。
 *
 * `src/mcp/app.ts` 保持可注入依赖（单测不连库），凡是「认识 env / db / 业务」的东西都放这里。
 */

/**
 * 检索结果缓存是**进程级**的：它不是某个请求的中间状态，所以不能放在 `buildMcpServer`
 * 里（那样每个请求一个新的空缓存，命中率恒为 0——不报错，只是每次都在付费调 AI）。
 */
const searchCache = createTtlCache<SearchToolResult>()

/**
 * 调用审计的真实实现（§10.11）。**这里只接数据库，降级逻辑在 `mcp/server.ts`**：
 * 写失败由那边捕获并调 `onError`，所以这里让异常照常抛。
 *
 * 日志只带 `requestId` / `tokenId`——令牌值不进表、不进日志（§10.3）。
 */
const audit: McpAuditDeps = {
  write: (entry) => insertMcpCallLog(entry, db),
  onError: (error, meta) => {
    log.warn({ requestId: meta.requestId, tokenId: meta.tokenId, err: error }, 'mcp: 审计写入失败，本次调用继续')
  },
}

export const mcpApp = createMcpApp({
  authenticate: authenticateMcpRequest,
  buildServer: (ctx) => buildMcpServer(ctx, { db, cache: searchCache, audit }),
  // 日预算按库里的审计行数算（§10.11）。多副本同读一张表，计数天然全局一致
  countDailyCalls: (budgetKey) => countMcpCallsToday(budgetKey, db),
  onDailyCountError: (error, meta) => {
    // 查不到就按未超限放行，但要在日志里留下痕迹——否则预算口径坏了没人知道
    log.warn({ requestId: meta.requestId, tokenId: meta.tokenId, err: error }, 'mcp: 日预算计数失败，按未超限放行')
  },
  // 401 里的 `resource_metadata` 从它与授权服务器的 issuer 同源派生（SPEC §10.10.1）
  publicOrigin: env.publicOrigin,
  onHandlerError: (error, requestId) => {
    // SDK 的 onerror 回调没有请求作用域；协议级错误（解析失败、未知工具）可能发生在
    // 路由之前，所以这里允许 requestId 缺失。错误原文只进日志，不进响应
    log.error({ requestId: requestId ?? 'unknown', err: error }, 'mcp handler error')
  },
})
