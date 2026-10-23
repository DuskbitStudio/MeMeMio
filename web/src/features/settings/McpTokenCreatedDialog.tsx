import { useState } from 'react'
import { CheckIcon, TriangleAlertIcon } from 'lucide-react'
import type { CreatedAccessToken } from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
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
import { bearerHeader, claudeDesktopConfig, MCP_COPY, MCP_NOTICE } from './mcp-copy'
import { COPY_FAILED_TEXT, useCopyText } from './use-copy-text'

/**
 * 「令牌已创建」弹窗——**完整令牌在整个产品里唯一可见的地方**（SPEC §10.3 / §6.8）。
 *
 * 生命周期的硬约束：这个组件只在父组件的 `created` state 非空时挂载，关闭时父组件
 * 立刻把它置空。也就是说**令牌只存在这个弹窗的 props 与几个复制按钮的临时反馈里**，
 * 不写 localStorage / sessionStorage / URL，关闭后没有任何 state 能把它恢复出来。
 * 别为了「关掉再打开还能复制」加缓存——「只显示一次」是契约，不是提示语。
 *
 * 关闭路径（X / Esc / 点遮罩）都要过 `AlertDialog` 二次确认：误关的代价是重新建一个
 * 令牌并把所有客户端改一遍。**「我已保存」是唯一不确认的关闭方式**。
 */
export function McpTokenCreatedDialog({
  created,
  origin,
  onClose,
}: {
  created: CreatedAccessToken
  /** 部署 origin：配置片段里的接入地址要用用户当前访问的这个地址。 */
  origin: string
  /** 关闭（父组件在这里清掉 `created`）。 */
  onClose: () => void
}) {
  /** 二次确认框。`true` 时主弹窗仍然开着——取消之后还能接着复制。 */
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { target, state, copy } = useCopyText()

  const configSnippet = claudeDesktopConfig(origin, created.token)
  const header = bearerHeader(created.token)

  /** 这个文本是不是「刚复制成功」的那一个（同一个 hook 管三个复制按钮）。 */
  const copied = (text: string) => target === text && state === 'copied'

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // 受控：主弹窗不在这里关。要关先过二次确认，确认后由 `onClose` 卸载整棵树。
        if (!next) setConfirmOpen(true)
      }}
    >
      {/*
        `max-h` 用 `svh`（移动端浏览器 UI 收起时 `vh` 会把底部推出屏幕）；
        内容比一屏高时让弹窗自己滚，标题与按钮不被挤出视野。
      */}
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            {/* 成功态的图标只是强化，不是唯一的信号——标题与描述已经把结果说清了 */}
            <span
              aria-hidden="true"
              className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground"
            >
              <CheckIcon className="size-4" />
            </span>
            令牌已创建
          </DialogTitle>
          <DialogDescription>
            「{created.name}」已生效。把下面这串填进客户端的{' '}
            <code className="font-mono text-xs">Authorization</code> 请求头。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* 一次性提醒（SPEC §10.8）。NOTICE 配方，不是 Alert——它是说明不是警报 */}
          <div className={cn(MCP_NOTICE, 'flex items-start gap-2.5')}>
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p>{MCP_COPY.oneTimeNotice}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">访问令牌</p>
            <div className="flex items-start gap-2 rounded-2xl border bg-input/50 px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">
                {created.token}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH}
                onClick={() => copy(created.token)}
                aria-label="复制完整令牌"
              >
                {copied(created.token) ? '已复制' : '复制'}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">请求头</p>
            <div className="flex items-start gap-2 rounded-2xl border bg-input/50 px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{header}</code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={TOUCH}
                onClick={() => copy(header)}
                aria-label="复制请求头"
              >
                {copied(header) ? '已复制' : '复制请求头'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              点「复制请求头」会把完整的{' '}
              <code className="font-mono text-xs">Authorization: Bearer …</code>{' '}
              一起写进剪贴板。
            </p>
          </div>

          {state === 'failed' && (
            <p role="alert" className="text-xs text-destructive">
              {COPY_FAILED_TEXT}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className={TOUCH}
            onClick={() => copy(configSnippet)}
          >
            {copied(configSnippet) ? '已复制' : '复制配置片段'}
          </Button>
          <Button type="button" className={TOUCH} onClick={onClose}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>

      {/*
        二次确认。默认焦点在「取消」上（AlertDialogContent 自带）：误触回车不该把
        唯一一份令牌丢掉。确认按钮是 destructive——它扔掉的东西收不回来。
      */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>令牌还没保存，确定关闭？</AlertDialogTitle>
            <AlertDialogDescription>
              关掉之后这串令牌就看不到了，只能重新创建。请先复制或保存到密码管理器。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={TOUCH}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className={TOUCH}
              onClick={() => {
                setConfirmOpen(false)
                onClose()
              }}
            >
              确定关闭
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
