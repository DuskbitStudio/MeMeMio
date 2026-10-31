import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { AuthLayout } from '../features/auth/AuthLayout'
import { OAuthConsent } from '../features/oauth/OAuthConsent'
import { OAUTH_COPY, consentPath } from '../features/oauth/oauth-copy'
import { loginPath } from '../lib/api'

/**
 * MCP OAuth 同意页（SPEC §10.10.3 / §10.10.4）。路由只做编排，本体在 `features/oauth/`。
 *
 * ## 为什么挂在 `AppLayout` 外面、而且不在 `RequireAuth` 里
 *
 * 这一页是授权流程的**中转站**：客户端把浏览器送到 `/oauth/authorize`，api 302 到这里，
 * 人可能已经登录、也可能没有。挂上应用外壳（侧边栏、搜索框）会把一次「确认一下就走」
 * 变成让人以为进了产品主界面；而 `RequireAuth` 会在跳登录页时把当前地址再编码一层，
 * 与这里要的形状对不上。**和 `/login`、`/register` 同级**，用同一个 `AuthLayout`。
 *
 * ## 未登录：先回登录页，登录完回这里
 *
 * `next` 指的是**带 ticket 的完整同意页地址**（`consentPath`），已经过 `loginPath` 的
 * `encodeURIComponent`。登录页那侧只认站内相对路径（`lib/safe-next.ts`），
 * `?next=/oauth/consent?ticket=…` 正是它放行的形状。
 *
 * 这里**在发请求之前**就分支：未登录时 `GET /api/v1/oauth/authorize/{ticket}` 会回
 * `UNAUTHENTICATED`，`lib/api.ts` 的拦截器也会跳到同一个地方，但那条路要多一次请求、
 * 且会先闪一下加载态。两条路最终落到同一个地址，判据只有这一份。
 *
 * ## 没有 `?ticket=` 就是失效
 *
 * 用户手敲 `/oauth/consent`、或者链接被截断时，页面上没有任何可做的事（没有 ticket 就
 * 没有可提交的东西），直接按「失效」呈现，不发请求、不跳登录页——即便人没登录，
 * 登录完回来也还是这张空票。
 */
export function OAuthConsentPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const ticket = searchParams.get('ticket')?.trim() ?? ''

  if (!ticket) {
    return (
      <AuthLayout>
        <div className="grid gap-4">
          <h1 className="font-heading text-2xl font-medium">无法授权</h1>
          <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
            {OAUTH_COPY.consentExpired}
          </p>
        </div>
      </AuthLayout>
    )
  }

  if (!user) return <Navigate to={loginPath(consentPath(ticket))} replace />

  return (
    <AuthLayout>
      {/* key 用 ticket：同一标签页里换了另一个 ticket 时，加载态与提交态都要归零 */}
      <OAuthConsent key={ticket} ticket={ticket} />
    </AuthLayout>
  )
}
