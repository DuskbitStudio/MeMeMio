import { db } from '../data/db.js'
import { log } from '../logger.js'
import { createMcpApp } from './app.js'
import { authenticateMcpRequest } from './auth.js'
import { createTtlCache } from './cache.js'
import type { SearchToolResult } from './search.js'
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

export const mcpApp = createMcpApp({
  authenticate: authenticateMcpRequest,
  buildServer: (ctx) => buildMcpServer(ctx, { db, cache: searchCache }),
  onHandlerError: (error, requestId) => {
    // SDK 的 onerror 回调没有请求作用域；协议级错误（解析失败、未知工具）可能发生在
    // 路由之前，所以这里允许 requestId 缺失。错误原文只进日志，不进响应
    log.error({ requestId: requestId ?? 'unknown', err: error }, 'mcp handler error')
  },
})
