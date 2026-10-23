import { eq, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import { userMcpSettings } from './schema.js'
import { normalizeMcpFilter, type McpFilterValues } from '../lib/mcp-filter.js'

/**
 * MCP 的用户级设置（SPEC §5.9 / §6.9）。
 *
 * **没有行 = 默认值**：`allowAdult = false`。读取不创建行，`PUT` 才 upsert 一行——
 * 绝大多数用户一辈子不会碰这个开关，不该为一次 GET 写库。
 *
 * 只影响 MCP 工具是否返回成人向图（§10.3.1）；Web 端的全库可读不变。
 */

export type McpSettings = { allowAdult: boolean }

/** 读当前设置；没有行时回默认 false，不返回 null。 */
export async function getMcpSettings(userId: string, db: Db = defaultDb): Promise<McpSettings> {
  const rows = await db
    .select({ allowAdult: userMcpSettings.allowAdult })
    .from(userMcpSettings)
    .where(eq(userMcpSettings.userId, userId))
    .limit(1)

  return { allowAdult: rows[0]?.allowAdult ?? false }
}

/** 写设置（upsert）。返回落库后的值，不信任调用方回显的输入。 */
export async function updateMcpSettings(
  userId: string,
  allowAdult: boolean,
  db: Db = defaultDb,
): Promise<McpSettings> {
  const rows = await db
    .insert(userMcpSettings)
    .values({ userId, allowAdult })
    .onConflictDoUpdate({
      target: userMcpSettings.userId,
      set: { allowAdult, updatedAt: sql`now()` },
    })
    .returning({ allowAdult: userMcpSettings.allowAdult })

  const row = rows[0]
  // 插入/更新都带 returning，拿不到只可能是驱动异常；显式抛，不返回一个假值
  if (row === undefined) throw new Error('写入 MCP 设置失败：没有返回行')
  return { allowAdult: row.allowAdult }
}

/**
 * 读过滤器（SPEC §5.9 / §10.3.2）。没有设置行或列里是 `{}` 都回空过滤器。
 *
 * 过滤器的值与 `allowAdult` 存在同一行，但读/写分开：改过滤器不该覆盖成人向开关，
 * 反之亦然。
 */
export async function getMcpFilter(userId: string, db: Db = defaultDb): Promise<McpFilterValues> {
  const rows = await db
    .select({ excluded: userMcpSettings.excluded })
    .from(userMcpSettings)
    .where(eq(userMcpSettings.userId, userId))
    .limit(1)

  return normalizeMcpFilter(rows[0]?.excluded)
}

/** 写过滤器（null 行时插入；已有行只更新 excluded，不动 allow_adult）。 */
export async function updateMcpFilter(
  userId: string,
  excluded: McpFilterValues,
  db: Db = defaultDb,
): Promise<McpFilterValues> {
  const rows = await db
    .insert(userMcpSettings)
    .values({ userId, excluded })
    .onConflictDoUpdate({
      target: userMcpSettings.userId,
      set: { excluded, updatedAt: sql`now()` },
    })
    .returning({ excluded: userMcpSettings.excluded })

  const row = rows[0]
  if (row === undefined) throw new Error('写入 MCP 过滤器失败：没有返回行')
  return normalizeMcpFilter(row.excluded)
}
