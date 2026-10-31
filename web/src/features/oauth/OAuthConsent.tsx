import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LoaderCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  fetchOAuthAuthorization,
  submitOAuthDecision,
  toStateError,
  type ApiError,
  type OAuthAuthorization,
} from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { OAUTH_COPY } from './oauth-copy'

/**
 * OAuth 同意页的本体（SPEC §10.10.3 / §10.10.4，文案契约 §10.8）。
 *
 * ## 这一页只有**一个**出口：服务端给的 `redirectTo`
 *
 * 「允许」和「取消」都是 `POST` 同一个端点，区别只在 `decision`；服务端拼好完整回跳地址
 * （带 `code` / `state` / 带不带 `error=access_denied`），这里只做 `location.assign`。
 * **前端不拼任何参��、不读、不存、不打印授权码**——同意页是整个流程里唯一可能碰到
 * `code` 的地方，而它连形状都不需要知道。
 *
 * `location.assign` 而不是 `navigate()`：目标地址是**另一台主机**（客户端自己的
 * `redirect_uri`），客户端路由只认站内路径，跨源那一跳必须交给浏览器。
 *
 * ## 四种状态，各有一个出口
 *
 * | 状态 | 触发 | 用户看到 |
 * |---|---|---|
 * | 加载中 | 首次 `GET` 未回 | 转圈 |
 * | 可同意 | `GET` 200 | 应用名 / 回跳主机 / 只读说明 / 未验证 / 内容范围 / 取消·允许 |
 * | 已失效 | `GET` `NOT_FOUND`；提交时 ticket 已被用过 | §10.8「授权同意 · 失效」 |
 * | 打不开 | 断网、5xx | 可重试；**不复用「失效」文案**——ticket 没错，是没连上 |
 *
 * ## 未登录不在这一层处理
 *
 * `user === null` 时由路由（`routes/oauth-consent.tsx`）在**发请求之前**送回登录页，
 * 带 `next` 回到这里。这一层拿不到 `NOT_FOUND` 与 `UNAUTHENTICATED` 混在一起的机会——
 * 后者会被 `toApiError` 拦走（清 user → 跳登录页），前者的含义是 ticket 死了。
 *
 * ## 「已达上限」不是加载失败
 *
 * approve 被 20 个 grant 的限额挡下（`VALIDATION_FAILED` + `details.fields` 指
 * `grantLimit`）时，服务端没有生成任何授权，ticket **仍在**：用户可以在别的标签页撤销
 * 一个旧应用，回来再点一次「允许」。所以这一态保留按钮，只在上方加提示，不把页面换成失效。
 */
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; info: OAuthAuthorization }
  | { kind: 'expired' }
  | { kind: 'failed'; error: ApiError }

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'limit' }
  | { kind: 'failed'; error: ApiError }

export function OAuthConsent({ ticket }: { ticket: string }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoad({ kind: 'loading' })
    fetchOAuthAuthorization(ticket)
      .then((info) => {
        if (!cancelled) setLoad({ kind: 'ready', info })
      })
      .catch((err) => {
        if (cancelled) return
        const apiErr = toStateError(err)
        setLoad(apiErr.code === 'NOT_FOUND' ? { kind: 'expired' } : { kind: 'failed', error: apiErr })
      })
    return () => {
      cancelled = true
    }
  }, [ticket, attempt])

  async function decide(decision: 'approve' | 'deny') {
    setSubmit({ kind: 'submitting' })
    try {
      const { redirectTo } = await submitOAuthDecision(ticket, decision)
      // 服务端拼好的完整地址，前端不解析、不改写。跨源，必须交给浏览器。
      window.location.assign(redirectTo)
    } catch (err) {
      const apiErr = toStateError(err)
      // ticket 单次使用：提交过一次后再点，服务端不区分「过期 / 已用 / 不属于本人」，统一失效
      if (apiErr.code === 'NOT_FOUND') {
        setLoad({ kind: 'expired' })
        setSubmit({ kind: 'idle' })
        return
      }
      if (apiErr.code === 'VALIDATION_FAILED' && apiErr.details?.fields === 'grantLimit') {
        setSubmit({ kind: 'limit' })
        return
      }
      setSubmit({ kind: 'failed', error: apiErr })
    }
  }

  if (load.kind === 'loading') {
    return (
      <div className="flex items-center justify-center py-12" role="status">
        <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">正在加载授权信息…</span>
      </div>
    )
  }

  if (load.kind === 'expired') {
    return <ConsentBlocked message={OAUTH_COPY.consentExpired} />
  }

  if (load.kind === 'failed') {
    return (
      <div className="grid gap-4">
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>{OAUTH_COPY.consentLoadError}</AlertTitle>
          <AlertDescription>
            <p>
              {load.error.message}
              <span className="mt-1 block font-mono text-xs">requestId: {load.error.requestId}</span>
            </p>
          </AlertDescription>
        </Alert>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className={cn(TOUCH, 'w-full')}
          onClick={() => setAttempt((n) => n + 1)}
        >
          {OAUTH_COPY.consentRetry}
        </Button>
      </div>
    )
  }

  const { info } = load
  const busy = submit.kind === 'submitting'

  return (
    <div className="grid gap-5">
      <h1 className="font-heading text-2xl font-medium">{OAUTH_COPY.consentTitle(info.clientName)}</h1>

      <div className="grid gap-2 text-sm">
        <p className="text-muted-foreground">{OAUTH_COPY.consentBody(info.clientName)}</p>
        <p className="text-muted-foreground">{OAUTH_COPY.consentReadOnly}</p>
      </div>

      {/* 主机名是服务端算好的 `redirectHost`（只给主机，不给完整 URL）：这里原样展示 */}
      <p className="text-sm">
        {OAUTH_COPY.consentRedirect(info.redirectHost)}
      </p>

      {/* DCR 注册的应用一律未验证（§10.10.2），所以这条是定值，不按信息分支 */}
      <div className="flex items-start gap-2.5 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0">{OAUTH_COPY.consentUnverified}</p>
      </div>

      <p className="text-sm text-muted-foreground">{OAUTH_COPY.consentContentScope}</p>

      {submit.kind === 'limit' && (
        <Alert>
          <ShieldAlert />
          <AlertTitle>{OAUTH_COPY.consentLimit}</AlertTitle>
          <AlertDescription>
            <Link to="/settings#mcp" className="text-foreground underline underline-offset-4">
              {OAUTH_COPY.consentManage}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {submit.kind === 'failed' && (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>提交失败</AlertTitle>
          <AlertDescription>
            <p>
              {submit.error.message}
              <span className="mt-1 block font-mono text-xs">
                requestId: {submit.error.requestId}
              </span>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          size="lg"
          variant="outline"
          className={cn(TOUCH, 'w-full')}
          disabled={busy}
          onClick={() => void decide('deny')}
        >
          {OAUTH_COPY.consentCancel}
        </Button>
        <Button
          type="button"
          size="lg"
          className={cn(TOUCH, 'w-full')}
          disabled={busy}
          onClick={() => void decide('approve')}
        >
          {/* 转圈与文案二选一（同登录页）：慢网络下按钮看着像没反应 */}
          {busy && <LoaderCircle className="animate-spin" />}
          {busy ? OAUTH_COPY.consentSubmitting : OAUTH_COPY.consentApprove}
        </Button>
      </div>
    </div>
  )
}

/**
 * 失效态。**不给操作按钮**：这一页没有能做的事——ticket 死了，要么回客户端重新发起，
 * 要么去设置页看已有的授权。带一个「重试」按钮是在骗人（同一个 ticket 不会复活）。
 */
function ConsentBlocked({ message }: { message: string }) {
  return (
    <div className="grid gap-4">
      <h1 className="font-heading text-2xl font-medium">无法授权</h1>
      <div className="flex items-start gap-2.5 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0">{message}</p>
      </div>
    </div>
  )
}
