import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import {
  getMcpFilter,
  getMcpSettings,
  updateMcpFilter,
  updateMcpSettings,
  type McpSettings,
} from '../data/mcp-settings.js'
import {
  parseMcpFilterPayload,
  type McpFilterValues,
} from '../lib/mcp-filter.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { asJsonObject, jsonBody } from '../middleware/json-body.js'

/**
 * `/api/v1/mcp/settings` 与 `/api/v1/mcp/filter` —— MCP 的用户级设置（SPEC §6.9）。
 *
 * **只认 cookie 会话**：MCP 端点本身只读，不能改自己的设置；这些开关必须由用户在
 * 浏览器里点。也没有管理员视图——每个人只能改自己的。
 *
 * 响应固定形状：设置 `{ allowAdult: boolean }`、过滤器 `{ excluded: 七维数组 }`；
 * 没有行时回默认值（§5.9）。
 */

export type McpSettingsResponse = McpSettings
export type McpFilterResponse = { excluded: McpFilterValues }

/** `PUT` 请求体恰好一个布尔字段；未知字段与错误类型都是 `VALIDATION_FAILED`（§0.4）。 */
function parseSettingsBody(raw: unknown): McpSettingsResponse {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'allowAdult') throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
  }

  const allowAdult = body['allowAdult']
  if (typeof allowAdult !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', 'allowAdult 必须是布尔值')
  }

  return { allowAdult }
}

/** 过滤器的形状/词表校验在 `lib/mcp-filter.ts`；这里只包成响应形状。 */
function parseFilterBody(raw: unknown): McpFilterResponse {
  return { excluded: parseMcpFilterPayload(raw) }
}

export const mcpSettingsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)
  .get('/settings', async (c) => {
    const settings = await getMcpSettings(c.get('currentUser').id)
    return c.json(settings)
  })
  .put('/settings', jsonBody<McpSettingsResponse>(parseSettingsBody), async (c) => {
    const settings = await updateMcpSettings(
      c.get('currentUser').id,
      c.req.valid('json').allowAdult,
    )
    return c.json(settings)
  })
  .get('/filter', async (c) => {
    const excluded = await getMcpFilter(c.get('currentUser').id)
    return c.json({ excluded } satisfies McpFilterResponse)
  })
  .put('/filter', jsonBody<McpFilterResponse>(parseFilterBody), async (c) => {
    const excluded = await updateMcpFilter(
      c.get('currentUser').id,
      c.req.valid('json').excluded,
    )
    return c.json({ excluded } satisfies McpFilterResponse)
  })
