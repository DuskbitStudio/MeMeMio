import type { AuthInfo } from '@modelcontextprotocol/server'
import { findActiveByHash, touchLastUsed } from '../data/access-tokens.js'
import { hashToken, isTokenShaped } from '../lib/token.js'
import { normalizeMcpFilter, type McpFilterValues } from '../lib/mcp-filter.js'
import { log } from '../logger.js'

/**
 * `/mcp` 的 Bearer 鉴权（SPEC §10.3、`agents/rules/mcp.md §3`）。
 *
 * 与 cookie 会话**互不通用**：这条路径只认 `Authorization: Bearer <token>`，不读 cookie；
 * 反过来 `/api/v1` 的任何接口都不接受 Bearer（SPEC §3.1）。两种凭证不互通。
 *
 * 失败一律 `null`（由 `mcp/app.ts` 转成 401 + `WWW-Authenticate`），**不区分**
 * 「没带 / 格式错 / 不存在 / 已撤销 / 已过期」：区分了就是一条探测通道，而且客户端对
 * 这几种情况的动作完全相同（换令牌或重建）。
 *
 * **令牌值永远不进日志**：日志只记 `requestId` / `tokenId` / `userId`（SPEC §10.3）。
 */

/** 工具里可用的调用身份。从 `AuthInfo.extra` 取——那是我们自己构造的，客户端碰不到。 */
export type McpActor = {
  userId: string
  role: string
  tokenId: string
  /** 用户级 MCP 设置（§5.9）：是否允许请求成人向。**不是**本次是否允许，见 §10.3.1 */
  allowAdult: boolean
  /** 用户级 MCP 排除过滤器（§10.3.2）。工具被动应用，调用方不能覆盖。 */
  excluded: McpFilterValues
}

/** 令牌前缀之后的部分是 base64url，`Bearer` 之后的 token 里不能再有空白。 */
const BEARER_RE = /^Bearer\s+(\S+)$/i

/**
 * `last_used_at` 的写入节流（SPEC §5.8 的实现约束）。
 *
 * MCP **每个请求**都可能命中一次令牌校验，逐请求 UPDATE 是写放大。5 分钟内同一令牌
 * 只写一次；代价是 `lastUsedAt` 最多晚 5 分钟，而它只是给用户看「这台设备最近用过」。
 */
const TOUCH_INTERVAL_MS = 5 * 60_000

/** tokenId → 上次写入时刻（毫秒）。进程内，多副本各写各的（不是审计数据，不需要全局一致）。 */
const lastTouchedAt = new Map<string, number>()

/**
 * 这张表的键只会随「签发过的令牌数」增长，理论上与用户数 × 10 同量级。
 * 到顶说明有人大量签发又撤销，此时清掉最早的一批即可——最坏是重新写一次 `last_used_at`。
 */
const TOUCH_MAP_MAX = 5_000

/** 仅供测试：每个用例自己清节流状态，不靠用例之间的执行顺序（`agents/rules/testing.md §2`）。 */
export function resetTokenTouchThrottle(): void {
  lastTouchedAt.clear()
}

function readBearerToken(header: string | null): string | null {
  if (header === null) return null
  const match = BEARER_RE.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * 节流后的 `last_used_at` 写入。**失败只降级、不拦请求**：
 * 一行时间戳写不进去，不该让整个 MCP 调用 401。
 */
async function touchLastUsedThrottled(tokenId: string, requestId: string): Promise<void> {
  const now = Date.now()
  const last = lastTouchedAt.get(tokenId)
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return

  // 先记时刻再写：写失败时不能每来一个请求就重试一次（那正是要避免的写放大）
  lastTouchedAt.set(tokenId, now)
  if (lastTouchedAt.size > TOUCH_MAP_MAX) {
    for (const [key, at] of lastTouchedAt) {
      if (at <= now - TOUCH_INTERVAL_MS) lastTouchedAt.delete(key)
    }
    if (lastTouchedAt.size > TOUCH_MAP_MAX) lastTouchedAt.clear()
  }

  try {
    await touchLastUsed(tokenId)
  } catch (error) {
    log.warn({ requestId, tokenId, err: error }, 'mcp: last_used_at 写入失败，本次请求继续')
  }
}

/**
 * 校验一次 MCP 请求的 Bearer 令牌。
 *
 * **顺序**：读头 → 形状校验（省一次数据库查询）→ sha256 → 按哈希查有效令牌。
 * 形状不对的输入连库都不用碰；形状对但查不到，与「已撤销 / 已过期」是同一个结果。
 */
export async function authenticateMcpRequest(
  request: Request,
  meta: { requestId: string },
): Promise<AuthInfo | null> {
  const token = readBearerToken(request.headers.get('authorization'))
  if (token === null) return null

  if (!isTokenShaped(token)) {
    log.warn({ requestId: meta.requestId, reason: 'malformed' }, 'mcp auth rejected')
    return null
  }

  const row = await findActiveByHash(hashToken(token))
  if (row === null) {
    // 不区分不存在 / 已撤销 / 已过期——它们对调用方是同一件事
    log.warn({ requestId: meta.requestId, reason: 'invalid' }, 'mcp auth rejected')
    return null
  }

  await touchLastUsedThrottled(row.id, meta.requestId)

  return {
    token,
    clientId: row.userId,
    scopes: ['mememio:read'],
    // SPEC 要求秒（epoch seconds），数据库给的是 Date
    expiresAt: row.expiresAt === null
      ? undefined
      : Math.floor(row.expiresAt.getTime() / 1000),
    extra: {
      userId: row.userId,
      role: row.role,
      tokenId: row.id,
      allowAdult: row.allowAdult,
      excluded: row.excluded,
    },
  }
}

/**
 * 从鉴权结果里取调用身份。工具里用它拿 `actorId`（`extra` 是我们构造的，不会来自客户端）。
 *
 * 返回 `null` 只可能出现在「这个工具被没有鉴权的路径调用」——正常链路上
 * `authenticateMcpRequest` 已经拦掉，这里是防御分支，不是业务判断。
 */
export function actorOf(authInfo: AuthInfo | undefined): McpActor | null {
  const extra = authInfo?.extra
  if (extra === undefined) return null

  const userId = extra['userId']
  const role = extra['role']
  const tokenId = extra['tokenId']
  if (typeof userId !== 'string' || typeof role !== 'string' || typeof tokenId !== 'string') {
    return null
  }
  return {
    userId,
    role,
    tokenId,
    // 旧进程/旧 AuthInfo 里可能没有这个键：缺省 false 是安全的（§10.3.1）
    allowAdult: extra['allowAdult'] === true,
    // 缺省空过滤器 = 不过滤；永远归一化，避免把未校验的 JSON 直接用于查询
    excluded: normalizeMcpFilter(extra['excluded']),
  }
}
