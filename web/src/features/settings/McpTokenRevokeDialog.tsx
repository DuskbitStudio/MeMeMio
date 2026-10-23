import { useState } from 'react'
import { revokeAccessToken, toStateError, type AccessTokenItem, type ApiError } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
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
import { MCP_COPY } from './mcp-copy'

/**
 * 撤销令牌的确认框（SPEC §6.8 / §10.8「撤销确认」）。
 *
 * 形状照 `EmbedSettings` / `RetagPanel` 那几个：**受控、不用 `AlertDialogTrigger`**。
 * 默认焦点落在「取消」上（`AlertDialogContent` 自带的 `onOpenAutoFocus`）——撤销立即生效
 * 且不可撤销，一次误触的回车不该把一台正在用的客户端踢下线。
 *
 * 失败留在框里（行内 `Alert` + `requestId`），**不关框**：关掉再让用户回列表里找原因，
 * 比让他对着这一个框重试麻烦得多。成功则由父组件把这一行摘掉——
 * **行移除本身就是反馈，不再弹 toast**（feedback.md 判据 1）。
 */
export function McpTokenRevokeDialog({
  token,
  onClose,
  onRevoked,
}: {
  token: AccessTokenItem
  /** 取消 / Esc 关框。 */
  onClose: () => void
  /** 撤销成功：父组件把这一行从列表里摘掉并关框。 */
  onRevoked: (id: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  async function handleConfirm() {
    setPending(true)
    setError(null)
    try {
      await revokeAccessToken(token.id)
      onRevoked(token.id)
    } catch (err) {
      setError(toStateError(err))
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open
      // 请求在途时不许关：关了之后失败原因就没有落点了（成功反正会由父组件摘行）
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>撤销这个令牌？</AlertDialogTitle>
          <AlertDialogDescription>{MCP_COPY.revokeConfirm(token.name)}</AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.message}</AlertTitle>
            <AlertDescription>requestId：{error.requestId}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          {/* 默认焦点在「取消」上（AlertDialogContent 自带）：不可逆的操作不该被一次回车触发 */}
          <AlertDialogCancel className={TOUCH} disabled={pending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className={TOUCH}
            disabled={pending}
            // AlertDialogAction 本身就是 DialogPrimitive.Close，点了会关；
            // 要保住「撤销中…」这段反馈（请求回来才知道成没成），先挡掉默认关闭。
            onClick={(e) => {
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
