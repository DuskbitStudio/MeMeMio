import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { accessTokens, userMcpSettings, users } from './schema.js'
import { AppError } from '../lib/app-error.js'
import { normalizeMcpFilter, type McpFilterValues } from '../lib/mcp-filter.js'

/**
 * 访问令牌的全部 SQL（SPEC §5.8、§6.8、§10.3）。**唯一入口**。
 *
 * 这里不生成令牌、不哈希明文——那是 `lib/token.ts` 的纯函数。本文件拿到的
 * 已经是 `token_hash` / `prefix`，永远看不到、也存不下完整令牌。
 *
 * ## 两条「有效」口径必须一致
 *
 * `revoked_at is null` 且（`expires_at is null` 或 `expires_at > now()`）。
 * 它同时出现在三个地方：校验（`findActiveByHash`）、列表（`listActiveTokens`）、
 * 数量上限（`createAccessToken`）。**任何一处漏掉都是静默的**：撤销了的令牌还能用、
 * 或者用户明明只有 9 个却被告知满 10 个。所以三者共用同一个 `activeConditions`。
 */

export type AccessTokenRow = typeof accessTokens.$inferSelect

/** 列表项（SPEC §6.8）：**只有这些字段**，不含 `tokenHash` / `userId`。 */
export type AccessTokenListItem = {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}

/** 校验通过后交给鉴权层的身份。`role` 来自 join `users`，不是令牌上的字段。 */
export type ActiveAccessToken = {
  id: string
  userId: string
  role: string
  name: string
  prefix: string
  expiresAt: Date | null
  /** 用户级 MCP 设置（§5.9）；没有设置行时为 false。MCP 的成人向双闸门用（§10.3.1）。 */
  allowAdult: boolean
  /** 用户级 MCP 排除过滤器（§10.3.2）；没有设置行时为空过滤器。 */
  excluded: McpFilterValues
}

/** 每用户最多 10 个**有效**令牌（SPEC §10.3 / §6.8）。超了报 `VALIDATION_FAILED`。 */
export const MAX_ACTIVE_ACCESS_TOKENS = 10

/**
 * 「这个令牌现在有效」的唯一 SQL 源。
 *
 * ⚠️ 过期判定用**数据库时钟**（`now()`），不是先读出来再和 JS 的 `Date` 比：
 *    读的那一刻没过期、写下去时过期了，就是同一个竞态。与 `findValidSession` 同口径。
 */
function activeConditions(userId?: string) {
  const conditions = [
    isNull(accessTokens.revokedAt),
    sql`(${accessTokens.expiresAt} is null or ${accessTokens.expiresAt} > now())`,
  ]
  if (userId !== undefined) conditions.push(eq(accessTokens.userId, userId))
  return conditions
}

/**
 * 建一个令牌。**返回的是数据库行，完整令牌不在这里**（它只在创建响应出现一次）。
 *
 * 上限判定与插入放在同一个事务里，并用 `for update` 锁住用户行：两个并发的创建
 * 请求都读到 9 的话会各自插入、变成 11 个。锁一行用户就够了——本表所有的数量
 * 上限都是「每用户」，没有跨用户的不变量。
 *
 * 满额时**不自动撤销最旧的**：那会让一台正在用的客户端突然 `401`，而用户不知道为什么
 * （SPEC §6.8 明写）。这里只报错，让用户自己决定撤哪一个。
 */
export async function createAccessToken(
  input: {
    userId: string
    name: string
    prefix: string
    tokenHash: string
    expiresAt: Date | null
  },
  db: Db = defaultDb,
): Promise<AccessTokenRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${users} where ${users.id} = ${input.userId} for update`)

    const counted = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(accessTokens)
      .where(and(...activeConditions(input.userId)))
    if ((counted[0]?.count ?? 0) >= MAX_ACTIVE_ACCESS_TOKENS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `每用户最多 ${MAX_ACTIVE_ACCESS_TOKENS} 个有效令牌，请先撤销不再使用的`,
      )
    }

    const rows = await tx.insert(accessTokens).values(input).returning()
    const row = rows[0]
    if (row === undefined) throw new AppError('INTERNAL', '写入访问令牌失败')
    return row
  })
}

/**
 * 列表：**只返回未撤销且未过期的**，按 `createdAt desc`（SPEC §6.8）。
 *
 * 过期 / 撤销的行保留在库里做审计，但不出现在列表里——客户端看不到「已失效」的条目，
 * 那正是契约要的：列表代表「现在还能用哪些」。
 */
export async function listActiveTokens(
  userId: string,
  db: Db = defaultDb,
): Promise<AccessTokenListItem[]> {
  return db
    .select({
      id: accessTokens.id,
      name: accessTokens.name,
      prefix: accessTokens.prefix,
      createdAt: accessTokens.createdAt,
      lastUsedAt: accessTokens.lastUsedAt,
      expiresAt: accessTokens.expiresAt,
    })
    .from(accessTokens)
    .where(and(...activeConditions(userId)))
    .orderBy(desc(accessTokens.createdAt))
}

/**
 * 按哈希查一个**此刻有效**的令牌，并带上令牌所属用户的角色。
 *
 * 角色从 `users` join，不从令牌上冗余存：角色可以被管理员改，存一份就会在改角色后
 * 一直用旧值（而 MCP 只读工具目前不按角色分支，这份角色是给「将来按角色收紧」留的）。
 *
 * 查不到**不区分原因**：不存在 / 已撤销 / 已过期在鉴权层都只该变成 401。
 */
export async function findActiveByHash(
  tokenHash: string,
  db: Db = defaultDb,
): Promise<ActiveAccessToken | null> {
  const rows = await db
    .select({
      id: accessTokens.id,
      userId: accessTokens.userId,
      role: users.role,
      name: accessTokens.name,
      prefix: accessTokens.prefix,
      expiresAt: accessTokens.expiresAt,
      // 没有设置行时 coalesce 成 false（§5.9：空表是正常状态）
      allowAdult: sql<boolean>`coalesce(${userMcpSettings.allowAdult}, false)`,
      excluded: sql<unknown>`coalesce(${userMcpSettings.excluded}, '{}'::jsonb)`,
    })
    .from(accessTokens)
    .innerJoin(users, eq(users.id, accessTokens.userId))
    .leftJoin(userMcpSettings, eq(userMcpSettings.userId, accessTokens.userId))
    .where(and(eq(accessTokens.tokenHash, tokenHash), ...activeConditions()))
    .limit(1)

  const row = rows[0]
  if (row === undefined) return null
  return { ...row, excluded: normalizeMcpFilter(row.excluded) }
}

/**
 * 撤销。**幂等**：已撤销的再调一次不报错（SPEC §6.8）。
 *
 * 「不存在」与「不属于调用者」报同一个 `NOT_FOUND`，不区分——区分了就是一条
 * 「这个 id 存在，但不是你的」的探测通道（§6.8 明写）。
 *
 * 只写 `revoked_at`，不物理删除：行要留着回答「这个令牌什么时候没的」。
 */
export async function revokeAccessToken(
  id: string,
  userId: string,
  db: Db = defaultDb,
): Promise<void> {
  const revoked = await db
    .update(accessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
    .returning({ id: accessTokens.id })

  if (revoked.length > 0) return

  // 影响 0 行：要么这个 id 不存在 / 不是你本人的，要么已经撤销过了。
  // 后一种是幂等成功，前一种是 NOT_FOUND —— 只读一次来区分，它不承担判定责任
  const existing = await db
    .select({ id: accessTokens.id })
    .from(accessTokens)
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId)))
    .limit(1)

  if (existing.length === 0) throw new AppError('NOT_FOUND', '令牌不存在')
}

/**
 * 更新 `last_used_at`。**调用方必须节流**——MCP 每个请求都可能命中一次校验，
 * 逐请求 UPDATE 是写放大（SPEC §5.8 的实现约束，节流在 `mcp/auth.ts`）。
 *
 * 只写这一列：撤销 / 过期判定不在这里，也不该被这里顺手再做一遍。
 */
export async function touchLastUsed(tokenId: string, db: Db = defaultDb): Promise<void> {
  await db.update(accessTokens).set({ lastUsedAt: sql`now()` }).where(eq(accessTokens.id, tokenId))
}
