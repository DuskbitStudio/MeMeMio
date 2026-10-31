import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from './db.js'
import {
  accessTokens,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthGrants,
  oauthRefreshTokens,
} from './schema.js'
import { AppError } from '../lib/app-error.js'
import { READ_SCOPE } from '../lib/oauth.js'

/**
 * OAuth 授权服务器的全部 SQL（SPEC §5.10、§6.10、§10.10）。**唯一入口。**
 *
 * 本文件不生成凭证、不哈希——`lib/oauth.ts` 的纯函数做那些；拿到的已经是
 * `sha256` 十六进制。协议流程（参数校验、302 形状、RFC 6749 错误体）在 `oauth/`，
 * 浏览器侧端点在 `routes/oauth.ts`。
 *
 * ## 三个不变量
 *
 * - **secret 类列只有哈希**：码、ticket、刷新令牌。返回值里也不带明文——明文由路由层
 *   在插入前算好，插入后只从入参里取。
 * - **单次使用靠原子的「删除/带条件的更新」**，不是「先查再改」：并发下后者会放行两次。
 * - **撤销是 grant 级的一个事务**：grant 置 `revoked_at`、访问令牌全撤、刷新令牌全删。
 *   任何一步单独失败都会留下「撤销了但还能刷新」的缝。
 */

/** 授权码 5 分钟（SPEC §10.10.4）。 */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000

/** 同意 ticket 10 分钟（SPEC §10.10.3）。 */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000

/** 访问令牌 1 小时（SPEC §10.10.5）。 */
export const ACCESS_TOKEN_TTL_SECONDS = 3600

/** 刷新令牌 30 天，滑动（SPEC §10.10.5）。 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 每用户最多 20 条**活跃** grant（SPEC §10.10.5）。与 PAT 的 10 个互不挤压。 */
export const MAX_ACTIVE_GRANTS = 20

// ── 客户端 ──────────────────────────────────────────────────────────

export type OAuthClientRow = typeof oauthClients.$inferSelect

/**
 * 注册一个客户端（DCR）。参数已在路由层校验完，这里只管写。
 *
 * 全站上限 5000 与插入之间用 advisory lock 串行化：并发注册时「先数再插」会多进去几个，
 * 而多出来的那几个永远不会被回收。
 */
export async function createOAuthClient(
  input: { clientId: string; clientName: string; redirectUris: string[] },
  maxClients: number,
  db: Db = defaultDb,
): Promise<OAuthClientRow> {
  return db.transaction(async (tx) => {
    // 固定键的 advisory lock：只串行化 DCR 这一条写路径，不锁别的表
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mememio:oauth_clients'))`)

    const counted = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthClients)
    if ((counted[0]?.count ?? 0) >= maxClients) {
      throw new AppError('RATE_LIMITED', '客户端注册已达上限')
    }

    const rows = await tx.insert(oauthClients).values(input).returning()
    const row = rows[0]
    if (row === undefined) throw new AppError('INTERNAL', '写入 OAuth 客户端失败')
    return row
  })
}

export async function findOAuthClient(
  clientId: string,
  db: Db = defaultDb,
): Promise<OAuthClientRow | null> {
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1)
  return rows[0] ?? null
}

// ── 待同意的 ticket ────────────────────────────────────────────────

export type AuthorizationRequestRow = typeof oauthAuthorizationRequests.$inferSelect

export async function createAuthorizationRequest(
  input: {
    ticketHash: string
    clientId: string
    userId: string
    redirectUri: string
    codeChallenge: string
    resource: string
    scope: string
    state: string | null
    expiresAt: Date
  },
  db: Db = defaultDb,
): Promise<void> {
  await db.insert(oauthAuthorizationRequests).values(input)
}

/**
 * 读一个**仍然有效**的 ticket（GET 同意页）。
 *
 * 不消费：打开页面就要能刷新。真正消费在 `consumeAuthorizationRequest`。
 * 过期、不存在、属于别人 → 同一个 `null`，由路由转成 `NOT_FOUND`。
 * 过期判定用数据库时钟，与 `findValidSession` 同口径。
 */
export async function findAuthorizationRequest(
  ticketHash: string,
  userId: string,
  db: Db = defaultDb,
): Promise<AuthorizationRequestRow | null> {
  const rows = await db
    .select()
    .from(oauthAuthorizationRequests)
    .where(
      and(
        eq(oauthAuthorizationRequests.ticketHash, ticketHash),
        eq(oauthAuthorizationRequests.userId, userId),
        sql`${oauthAuthorizationRequests.expiresAt} > now()`,
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

/**
 * 消费 ticket：**一条 delete 同时完成**「存在 / 未过期 / 属于本人 / 单次使用」。
 *
 * 先查再删会放行并发提交两次。删除返回的行就是提交所需的一切。
 */
export async function consumeAuthorizationRequest(
  ticketHash: string,
  userId: string,
  db: Db = defaultDb,
): Promise<AuthorizationRequestRow | null> {
  const rows = await db
    .delete(oauthAuthorizationRequests)
    .where(
      and(
        eq(oauthAuthorizationRequests.ticketHash, ticketHash),
        eq(oauthAuthorizationRequests.userId, userId),
        sql`${oauthAuthorizationRequests.expiresAt} > now()`,
      ),
    )
    .returning()
  return rows[0] ?? null
}

// ── 授权（grant）与授权码 ───────────────────────────────────────────

export type OAuthGrantRow = typeof oauthGrants.$inferSelect

/**
 * 读一条 grant。**不过滤 `revoked_at`**：调用方要能分辨「不存在」与「已撤销」。
 *
 * 刷新时用它校验 `client_id` 归属——拿别人的 client_id 来刷，不该触发旋转，
 * 更不该让复用检测替攻击者撤销受害者的 grant。
 */
export async function findGrant(grantId: string, db: Db = defaultDb): Promise<OAuthGrantRow | null> {
  const rows = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId)).limit(1)
  return rows[0] ?? null
}

/**
 * 同意「允许」：**一个事务里**数活跃 grant、建 grant、写授权码。
 *
 * 上限判定与插入同一事务，并用 `for update` 锁用户行——与 PAT 的 10 个同一模式
 * （`createAccessToken`）：两个并发的同意请求都读到 19 的话会变成 21 条。
 *
 * 返回 `grantId`；码的哈希由路由层算好传进来。
 */
export async function approveAuthorization(
  input: {
    clientId: string
    userId: string
    redirectUri: string
    codeChallenge: string
    resource: string
    scope: string
    codeHash: string
    codeExpiresAt: Date
  },
  db: Db = defaultDb,
): Promise<{ grantId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${input.userId} for update`)

    const counted = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.userId, input.userId), isNull(oauthGrants.revokedAt)))
    if ((counted[0]?.count ?? 0) >= MAX_ACTIVE_GRANTS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `每用户最多 ${MAX_ACTIVE_GRANTS} 条有效授权，请先撤销不再使用的`,
        { fields: { grantLimit: true } },
      )
    }

    const granted = await tx
      .insert(oauthGrants)
      .values({
        userId: input.userId,
        clientId: input.clientId,
        scope: input.scope,
        resource: input.resource,
        // 批准时那一条，不是 client 登记的第一条（§5.10）：列表要显示用户实际批过的地址
        redirectUri: input.redirectUri,
      })
      .returning({ id: oauthGrants.id })
    const grantId = granted[0]?.id
    if (grantId === undefined) throw new AppError('INTERNAL', '写入 OAuth 授权失败')

    await tx.insert(oauthAuthorizationCodes).values({
      codeHash: input.codeHash,
      clientId: input.clientId,
      userId: input.userId,
      grantId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      expiresAt: input.codeExpiresAt,
    })

    // 客户端最近一次被使用的时刻（展示用，不参与判定）
    await tx
      .update(oauthClients)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(oauthClients.clientId, input.clientId))

    return { grantId }
  })
}

export type AuthorizationCodeRow = typeof oauthAuthorizationCodes.$inferSelect

/** 换码前读一次（要从行里拿 `code_challenge` / `user_id` / `grant_id`）。 */
export async function findAuthorizationCode(
  codeHash: string,
  db: Db = defaultDb,
): Promise<AuthorizationCodeRow | null> {
  const rows = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
    .limit(1)
  return rows[0] ?? null
}

/**
 * 把码标记为已用。**带 `used_at is null` 条件**：并发兑换只有一个能改到行。
 * 返回 false 表示另一个请求先一步兑换了——那是重放。
 */
export async function markAuthorizationCodeUsed(
  codeHash: string,
  db: Db = defaultDb,
): Promise<boolean> {
  const rows = await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: sql`now()` })
    .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNull(oauthAuthorizationCodes.usedAt)))
    .returning({ codeHash: oauthAuthorizationCodes.codeHash })
  return rows.length > 0
}

/**
 * 换码成功后：写访问令牌 + 刷新令牌，并更新 grant 的 `last_used_at`。
 *
 * 访问令牌**写进 `access_tokens`**（`kind='oauth'`、带 `grant_id`）：与 PAT 同表、
 * 同校验链（SPEC §10.10.8）。`expiresAt` 由调用方按 1 小时算好。
 *
 * 写之前 `for update` 锁住 grant 再看 `revoked_at`：兑换与撤销并发时，撤销先赢
 * 就不能再签出新的令牌——否则用户点了「撤销」，一个正在换码的客户端还能拿到新令牌。
 * **返回 false = grant 已撤销**，调用方回 `invalid_grant`。
 */
export async function issueTokens(
  input: {
    userId: string
    name: string
    prefix: string
    tokenHash: string
    expiresAt: Date
    grantId: string
    refreshTokenHash: string
    refreshExpiresAt: Date
  },
  db: Db = defaultDb,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveGrant(tx, input.grantId))) return false

    await tx.insert(accessTokens).values({
      userId: input.userId,
      name: input.name,
      prefix: input.prefix,
      tokenHash: input.tokenHash,
      kind: 'oauth',
      grantId: input.grantId,
      expiresAt: input.expiresAt,
    })

    await tx.insert(oauthRefreshTokens).values({
      tokenHash: input.refreshTokenHash,
      grantId: input.grantId,
      expiresAt: input.refreshExpiresAt,
    })

    await tx
      .update(oauthGrants)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(oauthGrants.id, input.grantId))

    return true
  })
}

// ── 刷新 ────────────────────────────────────────────────────────────

export type RefreshTokenRow = typeof oauthRefreshTokens.$inferSelect

export async function findRefreshToken(
  tokenHash: string,
  db: Db = defaultDb,
): Promise<RefreshTokenRow | null> {
  const rows = await db
    .select()
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1)
  return rows[0] ?? null
}

/**
 * 旋转（或判定复用）。
 *
 * 返回三态：
 * - `rotated` —— 旧令牌已作废并指向新的；调用方继续签发访问令牌
 * - `reused` —— 这个令牌早就旋转过：**已在校内撤销整条 grant**，调用方回 `invalid_grant`
 * - `invalid` —— 不存在
 *
 * 「作废旧的」用带条件的 update（`rotated_at is null`）保证并发下只有一个赢家：
 * 竞争失败的那一个看到 `rotated_at` 已非空，走 `reused` 分支——这是正确结论，
 * 不是误杀，因为同一个刷新令牌确实被用了两次。
 *
 * 过期判定在这里做：过期**不**触发撤销整条 grant（那可能只是客户端很久没打开）。
 */
export async function rotateRefreshToken(
  input: { oldHash: string; newHash: string; expiresAt: Date },
  db: Db = defaultDb,
): Promise<
  | { status: 'rotated'; grantId: string }
  | { status: 'reused' }
  | { status: 'invalid' }
> {
  return db.transaction(async (tx) => {
    // 锁的顺序固定为 **grant → 刷新令牌行**，与 `revokeGrantIn` 一致。反过来先锁
    // 刷新令牌、再去锁 grant，会和「撤销 grant → 删刷新令牌」迎面撞成死锁
    const hint = await tx
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, input.oldHash))
      .limit(1)
    const found = hint[0]
    if (found === undefined) return { status: 'invalid' as const }

    const granted = await tx
      .select({ revokedAt: oauthGrants.revokedAt })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, found.grantId))
      .for('update')
      .limit(1)
    const grant = granted[0]
    if (grant === undefined) return { status: 'invalid' as const }

    const rows = await tx
      .select({
        rotatedAt: oauthRefreshTokens.rotatedAt,
        expired: sql<boolean>`${oauthRefreshTokens.expiresAt} <= now()`,
      })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, input.oldHash))
      .for('update')
      .limit(1)
    const row = rows[0]
    // 行不见了 = 刚被撤销删掉（`revokeGrantIn` 会删刷新令牌）
    if (row === undefined) return { status: 'invalid' as const }

    if (row.rotatedAt !== null) {
      await revokeGrantIn(tx, found.grantId)
      return { status: 'reused' as const }
    }

    // 过期不触发撤销（那可能只是客户端很久没打开）；已撤销的 grant 直接拒绝
    if (row.expired === true || grant.revokedAt !== null) return { status: 'invalid' as const }

    await tx
      .update(oauthRefreshTokens)
      .set({ rotatedAt: sql`now()`, replacedBy: input.newHash })
      .where(and(eq(oauthRefreshTokens.tokenHash, input.oldHash), isNull(oauthRefreshTokens.rotatedAt)))

    await tx.insert(oauthRefreshTokens).values({
      tokenHash: input.newHash,
      grantId: found.grantId,
      expiresAt: input.expiresAt,
    })

    return { status: 'rotated' as const, grantId: found.grantId }
  })
}

/** 刷新成功后签发新的访问令牌（同一事务外也行：它是可撤销的派生物）。 */
export async function issueRefreshedAccessToken(
  input: {
    userId: string
    name: string
    prefix: string
    tokenHash: string
    expiresAt: Date
    grantId: string
  },
  db: Db = defaultDb,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveGrant(tx, input.grantId))) return false

    await tx.insert(accessTokens).values({
      userId: input.userId,
      name: input.name,
      prefix: input.prefix,
      tokenHash: input.tokenHash,
      kind: 'oauth',
      grantId: input.grantId,
      expiresAt: input.expiresAt,
    })
    await tx
      .update(oauthGrants)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(oauthGrants.id, input.grantId))

    return true
  })
}

/**
 * 锁住 grant 并确认它没被撤销。返回 false = 已撤销或不存在。
 *
 * 锁的获取顺序（grant → 其下的行）与 `revokeGrantIn` 一致，两条路径不会互相
 * 制造死锁：撤销也是先写 grant 那一段。
 */
async function lockActiveGrant(tx: Tx, grantId: string): Promise<boolean> {
  const rows = await tx
    .select({ revokedAt: oauthGrants.revokedAt })
    .from(oauthGrants)
    .where(eq(oauthGrants.id, grantId))
    .for('update')
    .limit(1)
  const row = rows[0]
  return row !== undefined && row.revokedAt === null
}

// ── 撤销 ────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * 撤销的**唯一实现**：grant 置 `revoked_at`、其访问令牌全撤、刷新令牌与未兑换的码全删。
 *
 * 三个入口都落到这里：`DELETE /api/v1/oauth/grants/{id}`、`POST /oauth/revoke`
 * （刷新令牌）、刷新令牌复用检测（`rotateRefreshToken` 内部）。
 *
 * 幂等：已经撤销过的 grant 再撤一次不报错，也不报错地重复做那三件事（全是幂等写）。
 */
async function revokeGrantIn(tx: Tx, grantId: string): Promise<void> {
  await tx
    .update(oauthGrants)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))

  await tx
    .update(accessTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(accessTokens.grantId, grantId), isNull(accessTokens.revokedAt)))

  await tx.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.grantId, grantId))
  await tx.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.grantId, grantId))
}

/**
 * 浏览器侧撤销（SPEC §6.10）：已撤销的再调仍是成功；不存在 / 不属于本人 → `NOT_FOUND`。
 */
export async function revokeGrant(
  grantId: string,
  userId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: oauthGrants.id })
      .from(oauthGrants)
      .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
      .limit(1)
    if (rows[0] === undefined) throw new AppError('NOT_FOUND', '授权不存在')

    await revokeGrantIn(tx, grantId)
  })
}

/**
 * 令牌端点侧的撤销（RFC 7009）：**未知令牌一律当作成功**（防探测）。
 *
 * 访问令牌与刷新令牌都接受。撤销访问令牌只撤那一个；撤销刷新令牌撤整条 grant。
 * `client_id` 不属于该 grant 时同样静默——RFC 7009 §2.1 要求不泄漏令牌是否存在。
 */
export async function revokeToken(
  input: { accessTokenHash: string | null; refreshTokenHash: string | null; clientId: string | null },
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.accessTokenHash !== null) {
      const tokenRows = await tx
        .select({ id: accessTokens.id, grantId: accessTokens.grantId })
        .from(accessTokens)
        .where(eq(accessTokens.tokenHash, input.accessTokenHash))
        .limit(1)
      const token = tokenRows[0]
      if (token !== undefined) {
        const allowed = await grantBelongsToClient(tx, token.grantId, input.clientId)
        if (allowed) {
          await tx
            .update(accessTokens)
            .set({ revokedAt: sql`now()` })
            .where(and(eq(accessTokens.id, token.id), isNull(accessTokens.revokedAt)))
        }
        return
      }
      // hint 说是 access 但没找到，继续按刷新令牌找（RFC 7009：hint 只是提示）
    }

    if (input.refreshTokenHash !== null) {
      const refreshRows = await tx
        .select({ grantId: oauthRefreshTokens.grantId })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, input.refreshTokenHash))
        .limit(1)
      const refresh = refreshRows[0]
      if (refresh === undefined) return
      if (!(await grantBelongsToClient(tx, refresh.grantId, input.clientId))) return
      await revokeGrantIn(tx, refresh.grantId)
    }
  })
}

/** `clientId` 为 null（调用方没带）= 不校验；带了就必须是这条 grant 的客户端。 */
async function grantBelongsToClient(
  tx: Tx,
  grantId: string | null,
  clientId: string | null,
): Promise<boolean> {
  if (grantId === null) return false
  if (clientId === null) return true
  const rows = await tx
    .select({ id: oauthGrants.id })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.clientId, clientId)))
    .limit(1)
  return rows[0] !== undefined
}

// ── 列表 ────────────────────────────────────────────────────────────

export type GrantListItem = {
  id: string
  clientName: string
  clientId: string
  /** 批准时那一条回跳（§5.10）；主机名由序列化层派生，SQL 层不切字符串。 */
  redirectUri: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}

/**
 * 已连接应用（SPEC §6.10）：只返回未撤销的，`createdAt desc`。
 *
 * - `lastUsedAt` = 该 grant 下**访问令牌**最近一次使用（不是 grant 的签发时刻）
 * - `expiresAt` = 该 grant 下刷新令牌的最晚到期（30 天滑动）
 *
 * **不带任何令牌列**——连前缀都不给（「API Key 不出响应」在这里的落点）。
 */
export async function listGrants(userId: string, db: Db = defaultDb): Promise<GrantListItem[]> {
  return db
    .select({
      id: oauthGrants.id,
      clientName: oauthClients.clientName,
      clientId: oauthGrants.clientId,
      redirectUri: oauthGrants.redirectUri,
      createdAt: oauthGrants.createdAt,
      lastUsedAt: sql<Date | null>`max(${accessTokens.lastUsedAt})`,
      expiresAt: sql<Date | null>`max(${oauthRefreshTokens.expiresAt})`,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthGrants.clientId))
    .leftJoin(accessTokens, eq(accessTokens.grantId, oauthGrants.id))
    .leftJoin(oauthRefreshTokens, eq(oauthRefreshTokens.grantId, oauthGrants.id))
    .where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)))
    // 两个 left join 会让行数相乘，聚合按 grant 分组
    .groupBy(oauthGrants.id, oauthClients.clientName)
    .orderBy(desc(oauthGrants.createdAt))
    // 聚合列经驱动回来可能是 `Date` 也可能是字符串（列类型靠 select 里的表名推导，
    // 聚合表达式没有那张表），在数据层归一，序列化层只认 `Date`
    .then((rows) => rows.map((row) => ({
      ...row,
      lastUsedAt: toDateOrNull(row.lastUsedAt),
      expiresAt: toDateOrNull(row.expiresAt),
    })))
}

/**
 * 聚合出来的时间列交给驱动解析，可能给回 `Date` 也可能给回 Postgres 的文本表示
 * （`2026-10-30 21:46:05.587609+00`，Node 的 `new Date()` 认得这种格式）。
 * 交给序列化层之前一律变成 `Date`，否则 `toISOString` 会在运行时炸成 500。
 */
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null
  return value instanceof Date ? value : new Date(value)
}

// ── 清理（挂在 `queue/cleanup.ts` 的 sweep 上） ─────────────────────

/** 过期超 1 天才清（SPEC §5.10：给「刚过期」的请求留一次可解释的失败）。 */
const CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000

export async function countExpiredOAuthArtifacts(db: Db = defaultDb): Promise<number> {
  const cutoff = new Date(Date.now() - CLEANUP_GRACE_MS)

  // 三条计数各自走自己的索引；加总在 JS 里做。写成一条 `select (subquery) + (subquery)`
  // 也行，但那要构造一个没有表可 `from` 的查询，drizzle 的类型在这上面不老实
  const [requests, codes, refreshes] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthAuthorizationRequests)
      .where(lt(oauthAuthorizationRequests.expiresAt, cutoff)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthAuthorizationCodes)
      .where(lt(oauthAuthorizationCodes.expiresAt, cutoff)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthRefreshTokens)
      .where(lt(oauthRefreshTokens.expiresAt, cutoff)),
  ])

  return (requests[0]?.count ?? 0) + (codes[0]?.count ?? 0) + (refreshes[0]?.count ?? 0)
}

/**
 * 删过期超 1 天的 ticket / 码 / 刷新令牌。
 *
 * **不删 `oauth_grants`**：撤销的 grant 是审计记录，只随用户删除级联（SPEC §5.10）。
 */
export async function deleteExpiredOAuthArtifacts(db: Db = defaultDb): Promise<void> {
  const cutoff = new Date(Date.now() - CLEANUP_GRACE_MS)
  await db.delete(oauthAuthorizationRequests).where(sql`${oauthAuthorizationRequests.expiresAt} < ${cutoff}`)
  await db.delete(oauthAuthorizationCodes).where(sql`${oauthAuthorizationCodes.expiresAt} < ${cutoff}`)
  await db.delete(oauthRefreshTokens).where(sql`${oauthRefreshTokens.expiresAt} < ${cutoff}`)
}

/** 同意页展示用：scope 的固定值（防止某处硬编码了别的字符串）。 */
export const OAUTH_SCOPE = READ_SCOPE
