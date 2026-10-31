import type { NavigateFunction } from 'react-router-dom'
import { safeNext } from './safe-next'

/**
 * 登录之后「怎么去 `?next=`」的**唯一出口**。和 `safe-next.ts` 分工：那边判「能不能去」，
 * 这边判「用什么方式去」。
 *
 * ## 为什么不能一律 `navigate()`
 *
 * `navigate()` 是客户端路由跳转——**不发请求**。这只对 SPA 自己声明的路由成立。
 * `/oauth/authorize` 不是：它是 api 的协议端点（SPEC §10.10.3），未登录时回
 * `302 /login?next=<它自己>`，登录后浏览器**必须真的再打一次这个地址**，服务端才会
 * 重新校验并签出 ticket、再 `302 /oauth/consent?ticket=…`。
 *
 * 软跳的后果不是报错，是静默落进 `*` 的 NotFoundPage：URL 停在 `/oauth/authorize?...`，
 * 数据没变、按钮没变，客户端在等一个永远不会来的 `code`。2026-10-31 这条链之前一次都没
 * 走通过，原因就在这里。
 *
 * ## 判据是路径，不是前缀字符串
 *
 * 先把 `?` / `#` 切掉再比，否则 `/oauth/authorize?next=/oauth/consent` 这类带查询串的
 * 地址会被整串当成路径。用整段相等而不是 `startsWith('/oauth/authorize')`：
 * 后者会把 `/oauth/authorizee` 这种无关路径也当协议端点（服务端未必拦得住，但那是另一件事）。
 *
 * 返回 `true` 的路径一律走整页导航；其余（`/settings#mcp`、`/oauth/consent?ticket=…`）
 * 仍走 SPA 路由，保住 hash 与不刷新的体验。
 */
export function needsDocumentLoad(target: string): boolean {
  const path = target.split(/[?#]/, 1)[0] ?? ''
  // 子路径留一个口子：将来协议端点多出一段（如 `/oauth/authorize/{ticket}` 的 GET 形态）
  // 时不必再回来改这里。
  return path === '/oauth/authorize' || path.startsWith('/oauth/authorize/')
}

/**
 * 登录成功后的跳转。**只接受 `?next=` 的原始值**，内部过一遍 `safeNext`——
 * 调用方拿不到「绕过白名单再跳」的口子。
 *
 * 整页导航用 `location.replace` 而不是 `assign`：它对应原来 `navigate(…, { replace: true })`
 * 的语义，登录页不留在历史里（否则从同意页按「后退」会退回到一个已经登进去的登录页）。
 */
export function goToNext(raw: string | null | undefined, navigate: NavigateFunction): void {
  const target = safeNext(raw)
  if (needsDocumentLoad(target)) {
    window.location.replace(target)
    return
  }
  navigate(target, { replace: true })
}
