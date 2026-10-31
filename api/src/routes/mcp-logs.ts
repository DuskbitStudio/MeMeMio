import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { isUuid } from '../lib/uuid.js'
import { findTokenOwner } from '../data/access-tokens.js'
import {
  listMcpCallLogs,
  type McpCallLogScope,
} from '../data/mcp-call-logs.js'
import { TOOL_NAMES } from '../mcp/tool-names.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { toIsoSeconds } from '../serialize/meme.js'

/**
 * `GET /api/v1/mcp/logs` —— MCP 调用审计的读取面（SPEC §6.11、§10.11）。
 *
 * **只认 cookie 会话，不接受 Bearer**：日志是给人在浏览器里看的，MCP 客户端不该能读
 * 自己的（或别人的）调用记录。这条与 `/mcp` 的凭证口径正好相反，别把两边的中间件混用。
 *
 * 本文件**只做参数校验与形状转换**，隐私与分页的规则都在 `data/mcp-call-logs.ts`：
 * `queryText` 的投影、游标签名、`(created_at, id)` 行比较都在那一层，因为那是 SQL 的性质，
 * 搬到路由里就只能靠「记得再抹一次」来维持——那种保证迟早会漏。
 *
 * ⚠️ 路由必须**链式**注册，断开链条 Hono RPC 就推不出类型，`web` 侧会安静地退化成 any。
 */

/** 分页口径与列表接口一致（SPEC §1.3）。 */
const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100

export type McpCallLogItemResponse = {
  id: string
  createdAt: string
  tool: string
  tokenId: string | null
  tokenName: string | null
  tokenPrefix: string | null
  /** 他人的行恒为 null，管理员也不例外（§6.11）。 */
  queryText: string | null
  /** 这次返回了几张图：**两种 `scope` 都返回**（§6.11）。 */
  resultCount: number
  /** 他人的行恒为 null，管理员也不例外（§6.11）。 */
  resultMemeIds: string[] | null
  outcome: string
}

/**
 * 列表响应。`userId` **只在 `scope=all` 的行上出现**吗？不是——SPEC §6.11 说
 * 「不返回 `userId` 之外的任何用户信息」，即 `userId` 可以出现；`scope=mine` 时它恒等于
 * 调用者自己，冗余但无害，故两种 scope 用同一个形状，客户端不用分支。
 */
export type McpCallLogListResponse = {
  scope: McpCallLogScope
  items: (McpCallLogItemResponse & { userId: string })[]
  nextCursor: string | null
}

const TOOL_SET: ReadonlySet<string> = new Set(Object.values(TOOL_NAMES))

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * `YYYY-MM-DD` → 那一天的 UTC 零点。
 *
 * 做**往返校验**（`2026-02-31` 会被 `Date` 悄悄滚成 3 月 3 日）：日期被「纠正」而不报错，
 * 用户看到的是一个自己没选过的区间。浏览器与服务器时区不同时，UTC 才是唯一口径。
 */
function parseUtcDay(name: string, raw: string): Date {
  const match = DATE_RE.exec(raw)
  if (match === null) throw new AppError('VALIDATION_FAILED', `${name} 必须是 YYYY-MM-DD`)

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new AppError('VALIDATION_FAILED', `${name} 不是有效日期`)
  }
  return date
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError('VALIDATION_FAILED', 'limit 必须是正整数')
  }
  return Math.min(limit, MAX_LIMIT)
}

function parseScope(raw: string | undefined): McpCallLogScope {
  if (raw === undefined) return 'mine'
  if (raw !== 'mine' && raw !== 'all') {
    throw new AppError('VALIDATION_FAILED', 'scope 只能是 mine 或 all')
  }
  return raw
}

function parseTool(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  // 不在全集里的名字直接拒：放过去只会查出空页，用户会以为是「没调用过」
  if (!TOOL_SET.has(raw)) throw new AppError('VALIDATION_FAILED', `未知的工具名：${raw}`)
  return raw
}

/**
 * `tokenId` 的两条口径（§6.11）：
 *
 * - 形状不对 → `VALIDATION_FAILED`（查询参数的口径，`lib/uuid.ts`）；
 * - 形状对但 `scope=mine` 下不是自己的 → `NOT_FOUND`，**与「不存在」同一个响应**：
 *   区分了就成了一条「这个 id 存在，但不是你的」的探测通道（同 `revokeAccessToken`）。
 */
async function parseTokenId(
  raw: string | undefined,
  scope: McpCallLogScope,
  callerId: string,
): Promise<string | undefined> {
  if (raw === undefined) return undefined
  if (!isUuid(raw)) throw new AppError('VALIDATION_FAILED', 'tokenId 必须是 UUID')

  // `scope=all` 不判归属：管理员本来就能看所有人的行
  if (scope === 'all') return raw

  const owner = await findTokenOwner(raw)
  if (owner !== callerId) throw new AppError('NOT_FOUND', '令牌不存在')
  return raw
}

export const mcpLogRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)
  .get('/logs', async (c) => {
    const actor = c.get('currentUser')

    // 取值校验必须在权限判断之前：`scope=foo` 掉进「不是 all」那一支等于给非管理员
    // 开了 all 的口子（routes/memes.ts `/tag-status` 同一条坑）
    const scope = parseScope(c.req.query('scope'))
    if (scope === 'all' && actor.role !== 'admin') {
      throw new AppError('FORBIDDEN', 'scope=all 仅管理员可用')
    }

    const tool = parseTool(c.req.query('tool'))
    const tokenId = await parseTokenId(c.req.query('tokenId'), scope, actor.id)

    const fromRaw = c.req.query('from')
    const toRaw = c.req.query('to')
    const from = fromRaw === undefined ? undefined : parseUtcDay('from', fromRaw)
    const to = toRaw === undefined ? undefined : parseUtcDay('to', toRaw)
    if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'from 不能晚于 to')
    }

    const { items, nextCursor } = await listMcpCallLogs({
      scope,
      callerId: actor.id,
      tool,
      tokenId,
      from,
      to,
      limit: parseLimit(c.req.query('limit')),
      cursor: c.req.query('cursor'),
    })

    const response: McpCallLogListResponse = {
      scope,
      items: items.map((row) => ({
        id: row.id,
        userId: row.userId,
        createdAt: toIsoSeconds(row.createdAt),
        tool: row.tool,
        tokenId: row.tokenId,
        tokenName: row.tokenName,
        tokenPrefix: row.tokenPrefix,
        queryText: row.queryText,
        resultCount: row.resultCount,
        resultMemeIds: row.resultMemeIds,
        outcome: row.outcome,
      })),
      nextCursor,
    }
    return c.json(response)
  })
