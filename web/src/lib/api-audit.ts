/**
 * MCP 调用审计（`GET /api/v1/mcp/logs`，SPEC §6.11）的请求。
 *
 * 响应类型由 `AppType` 推出来（`web/AGENTS.md` §4：类型从 api 来，没有生成步骤、不手写）；
 * 请求仍然走 `fetch` 而不是 `api.api.v1.mcp.logs.$get()`，理由同 `api.ts` / `api-config.ts`：
 * RPC 客户端把非 2xx 直接当异常抛，拿不到 SPEC §2.1 的错误信封，而 `code` 与
 * `requestId` 是必须展示的。
 */

import type { InferResponseType } from 'hono/client'
import { api, toApiError } from './api'

// ---------------------------------------------------------------------------
// 响应类型
// ---------------------------------------------------------------------------

/**
 * `GET /mcp/logs` 的响应。
 *
 * `nextCursor === null` 是**唯一**的到头判据（SPEC §1.3），不认「这一页不满 40 条」。
 * 游标是不透明串，原样回传、不解析、不进 URL。
 */
export type AuditLogsResponse = InferResponseType<typeof api.api.v1.mcp.logs.$get>

/**
 * 一行调用记录。
 *
 * `queryText` 的三种 `null` 成因**在这里分不出来**，要结合 `scope` 与 `userId` 判：
 *   - 这个工具本来就没有检索原文（`get_meme_image` / `random_meme` / `list_vocab`）；
 *   - 是别人的行，隐私规则把原文抹成 `null`（SPEC §6.11）；
 *   - 本次检索没有传查询词。
 *
 * 客户端**不得从别的字段反推**原文（§6.11 明写），只能按「是不是自己的行」决定显示原文
 * 还是「仅本人可见」。判定规则见 `features/audit/audit-copy.ts` 的 `readQueryText`。
 *
 * `resultMemeIds` 同理是隐私字段（他人行 `null`），而 `resultCount` **不是**——
 * 数量两种 `scope` 都给，判定规则见 `readReturnText`。
 *
 * 形状完全来自 RPC（`web/AGENTS.md` §4），本文件不补字段：api 加了 `resultCount` /
 * `resultMemeIds` 之后这里自动跟着变，web 侧没有第二个形状。
 */
export type AuditLogItem = AuditLogsResponse['items'][number]

/** 可以按它筛的工具名（SPEC §10.4 的五件套，`docs/mcp.md` §4 有一份人话说明）。 */
export const AUDIT_TOOLS = [
  'search_memes',
  'pick_meme_for_reply',
  'get_meme_image',
  'random_meme',
  'list_vocab',
] as const

export type AuditTool = (typeof AUDIT_TOOLS)[number]

/** 查询参数。**可选键不传就是「不过滤」**，不要传空串（服务端对空串按非法处理）。 */
export type FetchMcpLogsParams = {
  scope?: 'mine' | 'all'
  tool?: string
  tokenId?: string
  /** `YYYY-MM-DD`，UTC 日，含两端（SPEC §6.11）。 */
  from?: string
  to?: string
  limit?: number
  cursor?: string
}

// ---------------------------------------------------------------------------

/**
 * 拉一页调用记录（SPEC §6.11）。
 *
 * 只有 cookie 会话能用，**不带 `Authorization`**——这个端点是给人在浏览器里看的，
 * MCP 客户端不读它。`scope=all` 仅管理员，非管理员传了回 `FORBIDDEN`。
 *
 * 错误码：`UNAUTHENTICATED` / `FORBIDDEN` / `VALIDATION_FAILED` / `NOT_FOUND`
 * （后者只在 `scope=mine` 下筛了别人的 `tokenId` 时出现）。界面按 `code` 分支，
 * 不解析 `message`（`http.md`）。
 */
export async function fetchMcpLogs(params: FetchMcpLogsParams = {}): Promise<AuditLogsResponse> {
  const qs = new URLSearchParams()
  // 只写真正的值：空串会让服务端按 VALIDATION_FAILED 处理（例如 `tokenId=` 不是 UUID）。
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value))
  }
  const query = qs.toString()
  const res = await fetch(`/api/v1/mcp/logs${query === '' ? '' : `?${query}`}`)
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as AuditLogsResponse
}
