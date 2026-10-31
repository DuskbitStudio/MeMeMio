import { useCallback, useEffect, useState } from 'react'
import { PlugIcon } from 'lucide-react'
import {
  fetchOAuthGrants,
  revokeOAuthGrant,
  toStateError,
  type ApiError,
  type OAuthGrant,
} from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { grantLine, OAUTH_COPY } from '../oauth/oauth-copy'
import { Tip } from './Tip'

/**
 * 设置页 · 已连接应用（SPEC §6.10 的 `/oauth/grants`，文案与渲染规则 §10.8）。
 *
 * ## 这一列表的每一行都只有「应用名 + 回跳主机」
 *
 * 服务端**不返回任何令牌值或前缀**（§6.10「API Key 不出响应」在这里更严：连前缀都不给），
 * 所以这里没有任何可拼的令牌串，也不该去找——用户按应用名与回跳主机识别一行，
 * 与当初同意页上看到的是同一个 `redirectHost`。
 *
 * ## 「从未使用」是整行换文案，不是往模板里塞占位
 *
 * `lastUsedAt === null` 是正常初始状态（刚批准 / 客户端还没发过请求）。规则放在
 * `oauth-copy.ts` 的 `grantLine()` 里，这个组件只负责调它——组件里出现第二条规则的话，
 * 同意页与设置页迟早对不上。
 *
 * ## 撤销 204 是幂等的，重复点击不算错
 *
 * `revokeOAuthGrant` 已经把 `NOT_FOUND` 当成功（另一个标签页撤过 / 本地列表过期），
 * 所以这里不需要为「再删一次」做任何特殊分支：成功就是让这一行消失。
 * **行消失就是反馈，不弹 toast**（feedback.md 判据 1）；失败留在确认框里带 `requestId`。
 */

/** 服务端的上限（SPEC §10.8「已连接应用 · 数量上限」）。只用来决定什么时候提示。 */
const GRANT_LIMIT = 20

export function McpGrants() {
  const [grants, setGrants] = useState<OAuthGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  const [revoking, setRevoking] = useState<OAuthGrant | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchOAuthGrants()
      .then(setGrants)
      .catch((err) => setError(toStateError(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleRevoked(id: string) {
    setGrants((prev) => prev.filter((grant) => grant.id !== id))
    setRevoking(null)
  }

  return (
    <div id="mcp-grants" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <h3 className="mr-auto text-base font-medium">{OAUTH_COPY.grantsTitle}</h3>
        {!loading && !error && grants.length > 0 && (
          <Badge variant="secondary">{grants.length} 个</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{OAUTH_COPY.grantsDescription}</p>

      {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>
            <p>{error.message}</p>
            <p className="font-mono text-xs">requestId：{error.requestId}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(TOUCH, 'mt-2')}
              onClick={load}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !error && grants.length === 0 && <EmptyGrants />}

      {!loading && !error && grants.length > 0 && (
        <ul className="flex flex-col divide-y">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              {/* 一行的全部信息就是这一句（§10.8 列项 / 列项（从未使用）） */}
              <p className="min-w-0 text-sm wrap-anywhere">{grantLine(grant)}</p>
              <div className="flex shrink-0 justify-end sm:justify-start">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(TOUCH, 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
                  aria-label={`撤销授权 ${grant.clientName}`}
                  onClick={() => setRevoking(grant)}
                >
                  撤销
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 到上限才提示：没满的时候它只会让人以为「快满了」 */}
      {!loading && !error && grants.length >= GRANT_LIMIT && (
        <Tip tone="warning" title={OAUTH_COPY.grantsLimit} />
      )}

      {revoking && (
        <GrantRevokeDialog
          grant={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={handleRevoked}
        />
      )}
    </div>
  )
}

/** 空态：一行说明，不给多余按钮——接入入口在同意流程那边，设置页没有「新建授权」。 */
function EmptyGrants() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-dashed p-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground"
      >
        <PlugIcon className="size-4" />
      </div>
      <p className="min-w-0 text-sm text-muted-foreground">{OAUTH_COPY.grantsEmpty}</p>
    </div>
  )
}

/**
 * 撤销确认。形状与 `McpTokenRevokeDialog` 一致：受控、默认焦点在「取消」上、失败留在框里。
 *
 * 与令牌那份的唯一差别是**不把「重复删除」当错误**：`revokeOAuthGrant` 把 `NOT_FOUND`
 * 折成成功，所以 204 与 404 走到同一个 `onRevoked`。
 */
function GrantRevokeDialog({
  grant,
  onClose,
  onRevoked,
}: {
  grant: OAuthGrant
  onClose: () => void
  onRevoked: (id: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      await revokeOAuthGrant(grant.id)
      onRevoked(grant.id)
    } catch (err) {
      setError(toStateError(err))
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open
      // 请求在途时不许关：关了之后失败原因就没有落点了
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>撤销这个授权？</AlertDialogTitle>
          <AlertDialogDescription>
            {OAUTH_COPY.grantsRevokeConfirm(grant.clientName)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.message}</AlertTitle>
            <AlertDescription>requestId：{error.requestId}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel className={TOUCH} disabled={pending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className={TOUCH}
            disabled={pending}
            onClick={(e) => {
              // 先挡住默认关闭，保住「撤销中…」这段反馈
              e.preventDefault()
              void handleConfirm()
            }}
          >
            {pending ? '撤销中…' : '确定撤销'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
