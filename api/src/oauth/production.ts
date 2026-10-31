import { db } from '../data/db.js'
import { env } from '../env.js'
import { resolveSessionUserId } from '../middleware/auth.js'
import { createOAuthApp } from './app.js'
import { createOriginResolver } from './origin.js'

/**
 * 生产组装：把真实的库、env 与会话解析接进授权服务器（与 `mcp/production.ts` 同一种分工）。
 *
 * **`env` 只在这里被读。** `oauth/app.ts` 不认识 env，`oauth/origin.ts` 也只导出纯函数——
 * 这样那两个文件能被单测直接构造，`server.ts` 的 import 图也不必为此多拉一份校验。
 */

/** 配了就对所有响应固定用它（SPEC §10.10.1）；没配就按请求推导（只服务本机开发）。 */
export const publicOrigin: string | null = env.publicOrigin

/** 全套端点在 `server.ts` 按 pathname 分流过来的那个 Hono 实例。 */
export const oauthApp = createOAuthApp({
  db,
  origin: createOriginResolver(publicOrigin),
  sessionUserId: resolveSessionUserId,
})
