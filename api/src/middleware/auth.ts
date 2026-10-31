import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { AppError } from '../lib/app-error.js'
import { findValidSession, findUserById } from '../data/auth.js'
import type { RequestIdVariables } from './request-id.js'

export const SESSION_COOKIE = 'sid'

export type AuthUser = {
  id: string
  name: string
  role: string
  storageQuotaBytes: bigint
  createdAt: Date
}

export type AuthVariables = RequestIdVariables & {
  currentUser: AuthUser
}

async function resolveUser(c: { req: { raw: Request } }): Promise<AuthUser | null> {
  const sessionId = getCookie(c as never, SESSION_COOKIE)
  if (!sessionId) return null

  const session = await findValidSession(sessionId)
  if (!session) return null

  const user = await findUserById(session.userId)
  if (!user) return null

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    storageQuotaBytes: user.storageQuotaBytes,
    createdAt: user.createdAt,
  }
}

/**
 * 从一个裸 `Request` 读 cookie 会话，返回用户 id；未登录返回 null。
 *
 * **唯一的调用方是 OAuth 的 `/oauth/authorize`**（`oauth/app.ts` 的依赖注入）：
 * 那个端点在 `server.ts` 里分流、不在 `app.ts` 的中间件栈里，拿不到 `c`，
 * 但它需要知道「现在是谁」才能签发同意 ticket。
 *
 * 返回 `string | null` 而不是 `AuthUser`：授权端点只用来**绑定 `user_id`**，
 * 不做任何权限判断，也就不该拿到角色/配额。用户对象由 `/api/v1/oauth/*` 的
 * `requireAuth` 各自取。
 *
 * ⚠️ 它**不是 `optionalAuth`**。下面那段警告依然成立：这里没有「登录与否都放行」
 *    的语义，调用方必须显式分支（未登录 → 302 去登录页），不存在 `?? 匿名` 的写法。
 */
export async function resolveSessionUserId(request: Request): Promise<string | null> {
  const sessionId = getCookie({ req: { raw: request } } as never, SESSION_COOKIE)
  if (!sessionId) return null

  const session = await findValidSession(sessionId)
  if (!session) return null

  const user = await findUserById(session.userId)
  return user?.id ?? null
}

/**
 * 要求已登录，未登录抛 UNAUTHENTICATED。
 *
 * ⚠️ **这个文件里没有 `optionalAuth`，是刻意删掉的。** 读路径（浏览、搜索）曾经挂它，
 *    效果是「未登录也能用」——而 SPEC §3.3 给的是「所有登录用户」，没给过匿名。
 *    真有端点需要「登录与否都行」时，那是 SPEC 要先改的事，不是把这一份加回来：
 *    加回来的那一天，调用方会顺手写一个 `currentUser ?? 匿名` 的分支，
 *    而那个分支就是全库内容对公网敞开的地方。
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const user = await resolveUser(c)
  if (!user) throw new AppError('UNAUTHENTICATED', '请先登录')
  c.set('currentUser', user)
  await next()
}

/** 要求已登录且 role === 'admin'，否则抛 FORBIDDEN。 */
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const user = await resolveUser(c)
  if (!user) throw new AppError('UNAUTHENTICATED', '请先登录')
  if (user.role !== 'admin') throw new AppError('FORBIDDEN', '仅管理员可操作')
  c.set('currentUser', user)
  await next()
}

