import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db as defaultDb, type Db } from './db.js'
import { accessTokens, mcpCallLogs } from './schema.js'
import { AppError } from '../lib/app-error.js'

/**
 * `mcp_call_logs` 的全部 SQL（SPEC §5.11 / §6.11 / §10.11）。**唯一入口**。
 *
 * 表里有三件事必须记住，它们都不在类型里：
 *
 * 1. **不存任何令牌值**，只存 `token_id`（§10.3 的同一条纪律）。写入口只接受
 *    id / 名字类字段，本文件永远碰不到明文令牌。
 * 2. **`query_text` 只有本人可见**，他人（含 `admin`）一律 `null`。这条规则**落在
 *    查询的投影里**——他人行的原文列压根不出库（`privacyQueryText`），不是在序列化
 *    时抹掉。抹掉那种做法一旦有人新加一条读路径就会漏，投影只有一处。
 * 3. **`budget_key` 是文本、没有外键**：PAT 是它自己那一行，OAuth 是 `grant_id`。
 *    令牌行被物理删除后 `token_id` 变 null，但 `budget_key` 字符串仍在（§5.11）。
 */

/** 一次工具调用的结局。工具返回 `isError` 也算 `'error'`（不是 HTTP 层的概念）。 */
export type McpCallOutcome = 'ok' | 'error'

/** 写一行审计。**这里没有、也不该有令牌值。** */
export type NewMcpCallLog = {
  userId: string
  /** 用哪个令牌调的；令牌行已被物理删除时为 null。 */
  tokenId: string | null
  /** 计日预算的键：PAT = `token_id`，OAuth = `grant_id`。 */
  budgetKey: string
  tool: string
  /** 检索原文；只有 `search_memes` / `pick_meme_for_reply` 有。 */
  queryText: string | null
  /**
   * 这次返回了哪些图（§10.11）：按工具输出的顺序、去重、最多 20 条。
   * 没有图 / 失败 / 抽取不出来都是 `[]`——**永远不是 `null`**，`null` 只属于读出口的他人行。
   */
  resultMemeIds: string[]
  outcome: McpCallOutcome
}

export type McpCallLogScope = 'mine' | 'all'

export type ListMcpCallLogsParams = {
  /**
   * `'mine'`：只看调用者自己的行。
   * `'all'`：全部行（只有 `admin` 能走到这里，权限判定在路由层）。
   *
   * ⚠️ **两种 scope 都不改变 `queryText` 的投影规则**：始终只有
   *    `user_id = callerId` 的行带原文。`scope=all` 不是「放开脱敏」。
   */
  scope: McpCallLogScope
  callerId: string
  tool?: string
  tokenId?: string
  /** `from` / `to` 是 UTC 日的零点，**含两端**（§6.11）；`to` 的排他上界由本文件加一天。 */
  from?: Date
  to?: Date
  limit: number
  cursor?: string
}

/** 列表项。`tokenName` / `tokenPrefix` 是展示身份，不是密钥（§6.11）。 */
export type McpCallLogItem = {
  /** `bigserial` 转成字符串：JS number 装不下 int8，客户端也不解析它。 */
  id: string
  /** `scope=all` 时按它对到用户列表，日志表不另存可变的用户资料（§6.11）。 */
  userId: string
  createdAt: Date
  tool: string
  tokenId: string | null
  tokenName: string | null
  tokenPrefix: string | null
  /** 他人的行恒为 null，管理员也不例外。 */
  queryText: string | null
  /**
   * 这次返回了几张图（§6.11）。由数组长度算出，**两种 `scope` 都返回**——
   * 数量不透露内容。恒等于本人行 `resultMemeIds` 的长度，但两者不能互相替代。
   */
  resultCount: number
  /** 他人的行恒为 null，管理员也不例外。 */
  resultMemeIds: string[] | null
  outcome: string
}

/** 审计保留期（§5.11）：90 天，由 `queue/cleanup.ts` 的周期扫描删除。 */
export const MCP_CALL_LOG_RETENTION_DAYS = 90

/**
 * 写一行。**调用方负责「失败只降级、不拦请求」**（§10.11）——这里让异常照常抛，
 * 因为吞掉异常的地方只能有一个：`mcp/server.ts` 的审计包装，它还要记 `requestId`。
 */
export async function insertMcpCallLog(
  entry: NewMcpCallLog,
  db: Db = defaultDb,
): Promise<void> {
  await db.insert(mcpCallLogs).values(entry)
}

/**
 * 这个预算键**今天**（UTC 自然日）已经用了几次（§10.11）。
 *
 * 「今天」用**数据库时钟**算，不用 JS 的 `Date`：应用进程与数据库的时区/时钟不一致时，
 * JS 算出来的 0 点会和 `created_at` 的写入时点错开，表现为「刚过 0 点就超限」或
 * 「过了 0 点还拦着」。`at time zone 'utc'` 两段是刻意的——先取 UTC 的墙上时间再截日，
 * 再按 UTC 解释回时间戳，结果与会话时区无关。
 *
 * 这一条查询是日预算唯一的热路径，走 `mcp_call_logs_budget_time_idx`。
 */
export async function countMcpCallsToday(
  budgetKey: string,
  db: Db = defaultDb,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpCallLogs)
    .where(and(
      eq(mcpCallLogs.budgetKey, budgetKey),
      sql`${mcpCallLogs.createdAt} >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')`,
    ))
  return rows[0]?.count ?? 0
}

/**
 * 隐私投影（§6.11）：**他人行在 SQL 里就不选原文列。**
 *
 * 这是整个文件里最不能「顺手简化」的一行。写成 `select: { queryText: mcpCallLogs.queryText }`
 * 再在路由里按 `userId` 抹成 null，功能上看起来一样，实际上把「不返回」变成了
 * 「返回了但不显示」——多一条读路径、多一次序列化改造、多一个会漏的地方。
 *
 * `result_meme_ids` 与它共用这一条规则、也共用这一个表达式（`ownerOnly`）：返回的 id
 * 等于「这个人当时拿到了哪些图」，泄露的是检索意图本身，比原文更直接。**条数不在此列**
 * ——`resultCount` 用另一条独立表达式恒返回，两者不能互相替代。
 */
function ownerOnly<T>(callerId: string, column: AnyPgColumn): SQL<T> {
  return sql<T>`case when ${mcpCallLogs.userId} = ${callerId}::uuid then ${column} end`
}

const CURSOR_VERSION = 1

type CursorPayload = {
  v: number
  /** 筛选条件签名：换了筛选还拿旧游标 → VALIDATION_FAILED（§1.3 / §6.11）。 */
  s: string
  /** `created_at` 的**文本**形式（微秒精度）：JS `Date` 只有毫秒，往返会丢精度。 */
  t: string
  /** `id` 的文本形式（int8）。 */
  i: string
}

/**
 * 筛选签名。**必须覆盖所有会改变结果集的参数**——漏一个，客户端换了筛选还能用旧游标，
 * 翻出来的页就是另一个查询的续页，不报错。
 *
 * 日期用 ISO 字符串而不是 `Date`：路由层已经把 `YYYY-MM-DD` 归一成 UTC 零点，
 * 两侧序列化稳定。
 */
function filterSignature(params: ListMcpCallLogsParams): string {
  return JSON.stringify([
    params.scope,
    params.tool ?? null,
    params.tokenId ?? null,
    params.from?.toISOString() ?? null,
    params.to?.toISOString() ?? null,
  ])
}

function invalidCursor(): never {
  throw new AppError('VALIDATION_FAILED', '游标无效，请从第一页重新开始')
}

function decodeCursor(cursor: string, signature: string): { createdAt: string; id: string } {
  let payload: CursorPayload
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload
  } catch {
    invalidCursor()
  }

  if (
    typeof payload !== 'object' || payload === null
    || payload.v !== CURSOR_VERSION
    || typeof payload.t !== 'string'
    || typeof payload.i !== 'string'
    || !/^\d+$/.test(payload.i)
    || Number.isNaN(Date.parse(payload.t))
  ) {
    invalidCursor()
  }

  // 换了筛选还拿旧游标：与「解不出来」同一个动作，客户端丢弃游标回第一页（SPEC §1.3）
  if (payload.s !== signature) invalidCursor()

  return { createdAt: payload.t, id: payload.i }
}

function encodeCursor(createdAtText: string, id: string, signature: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, s: signature, t: createdAtText, i: id }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

/**
 * 列表，`createdAt desc, id desc` 游标分页（§6.11 / §1.3）。
 *
 * 游标比较用行构造 `(created_at, id) < (...)` 而不是手写
 * 「`created_at < t` or (`created_at = t` and `id < i`)」：同一个事务里写入的多行
 * `created_at` 完全相同，单比时间会漏行。
 *
 * 排序键与游标用的都是 `::text` 出来的 `created_at`（微秒精度），与 `(created_at, id)`
 * 的行比较同一套值，不会出现「游标拿毫秒、比较用微秒」的错位。
 */
export async function listMcpCallLogs(
  params: ListMcpCallLogsParams,
  db: Db = defaultDb,
): Promise<{ items: McpCallLogItem[]; nextCursor: string | null }> {
  const signature = filterSignature(params)
  const conditions = []

  if (params.scope === 'mine') conditions.push(eq(mcpCallLogs.userId, params.callerId))
  if (params.tool !== undefined) conditions.push(eq(mcpCallLogs.tool, params.tool))
  if (params.tokenId !== undefined) conditions.push(eq(mcpCallLogs.tokenId, params.tokenId))
  if (params.from !== undefined) {
    conditions.push(sql`${mcpCallLogs.createdAt} >= ${params.from.toISOString()}::timestamptz`)
  }
  if (params.to !== undefined) {
    // `to` 含当天：排他上界 = 次日 0 点（UTC）。加在 SQL 这边，避免路由层改日期的含义
    const exclusive = new Date(params.to.getTime() + 24 * 60 * 60 * 1000)
    conditions.push(sql`${mcpCallLogs.createdAt} < ${exclusive.toISOString()}::timestamptz`)
  }

  if (params.cursor !== undefined) {
    const decoded = decodeCursor(params.cursor, signature)
    conditions.push(
      sql`(${mcpCallLogs.createdAt}, ${mcpCallLogs.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::bigint)`,
    )
  }

  const rows = await db
    .select({
      id: sql<string>`${mcpCallLogs.id}::text`,
      createdAtText: sql<string>`${mcpCallLogs.createdAt}::text`,
      createdAt: mcpCallLogs.createdAt,
      userId: mcpCallLogs.userId,
      tool: mcpCallLogs.tool,
      tokenId: mcpCallLogs.tokenId,
      // §6.11：令牌行已物理删除时 token_id 为 null，名字与前缀跟着为 null
      tokenName: accessTokens.name,
      tokenPrefix: accessTokens.prefix,
      queryText: ownerOnly<string | null>(params.callerId, mcpCallLogs.queryText),
      // §6.11：条数恒返回（数量不透露内容），由数组长度算——不另存一列
      resultCount: sql<number>`coalesce(cardinality(${mcpCallLogs.resultMemeIds}), 0)::int`,
      // §6.11：id 只对本人可见，与原文同一个 case
      resultMemeIds: ownerOnly<string[] | null>(params.callerId, mcpCallLogs.resultMemeIds),
      outcome: mcpCallLogs.outcome,
    })
    .from(mcpCallLogs)
    // left join：令牌物理删除后日志行仍在，名字回 null，客户端显示「已删除的令牌」
    .leftJoin(accessTokens, eq(accessTokens.id, mcpCallLogs.tokenId))
    .where(and(...conditions))
    .orderBy(desc(mcpCallLogs.createdAt), desc(mcpCallLogs.id))
    .limit(params.limit + 1)

  const hasMore = rows.length > params.limit
  const page = hasMore ? rows.slice(0, params.limit) : rows
  const last = page.at(-1)
  const nextCursor = hasMore && last !== undefined
    ? encodeCursor(last.createdAtText, last.id, signature)
    : null

  return {
    items: page.map((row) => ({
      id: row.id,
      userId: row.userId,
      createdAt: row.createdAt,
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
}

/** 90 天前的行数（dry-run，先数再删；`queue.md §6`）。 */
export async function countExpiredMcpCallLogs(db: Db = defaultDb): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpCallLogs)
    .where(sql`${mcpCallLogs.createdAt} < now() - ${sql.raw(`interval '${MCP_CALL_LOG_RETENTION_DAYS} days'`)}`)
  return rows[0]?.count ?? 0
}

/** 删除 90 天前的行（§5.11）。**不是撤销**：审计只有保留期，没有软删。 */
export async function deleteExpiredMcpCallLogs(db: Db = defaultDb): Promise<void> {
  await db
    .delete(mcpCallLogs)
    .where(sql`${mcpCallLogs.createdAt} < now() - ${sql.raw(`interval '${MCP_CALL_LOG_RETENTION_DAYS} days'`)}`)
}
