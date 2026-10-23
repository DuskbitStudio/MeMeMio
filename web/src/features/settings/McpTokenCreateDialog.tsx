import { type FormEvent, useEffect, useState } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import {
  createAccessToken,
  toStateError,
  type ApiError,
  type CreatedAccessToken,
} from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { MCP_COPY, MCP_NOTICE } from './mcp-copy'

/**
 * 创建令牌的弹窗（SPEC §6.8）。
 *
 * 两件事不在类型里、要在这里挡：
 * - `name` 去首尾空白后 1–64 字（服务端按**码点**数，所以本地也用 `[...name].length`）；
 * - `expiresInDays` 不传 = 永不过期，所以「永久」那一档**不传字段**，不是传 0。
 *
 * ⚠️ **不自动聚焦名称输入。** 手机上一弹键盘就把弹窗下半截盖住，而这里并没有
 * 「打开就要打字」的刚需（styling.md「自动聚焦：只在精确指针设备上做」）。
 * 桌面端也不做：这个弹窗一屏就能看完，少一个会自动跳出输入法的状态更稳。
 */

/** 有效期选项。`never` = 不传 `expiresInDays`（SPEC §6.8）。 */
const EXPIRY_OPTIONS = [
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '365 天' },
  { value: 'never', label: '永久' },
] as const

type ExpiryValue = (typeof EXPIRY_OPTIONS)[number]['value']

/** 默认 90 天（设计稿）。**不默认「永久」**：一次性令牌不该默认永不过期。 */
const DEFAULT_EXPIRY: ExpiryValue = '90'

/** 与服务端同一个上限（SPEC §6.8）。按码点数，不是 UTF-16 单元。 */
const NAME_MAX_LENGTH = 64

export function McpTokenCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 创建成功：父组件切到「令牌已创建」弹窗（完整令牌只在那一刻存在）。 */
  onCreated: (created: CreatedAccessToken) => void
}) {
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<ExpiryValue>(DEFAULT_EXPIRY)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  /** 本地校验（必填 / 字数）与服务端错误分开放：前者贴输入框，后者是请求结果。 */
  const [fieldError, setFieldError] = useState<string | null>(null)

  /*
    关掉就把草稿收掉。Radix 关闭时只是把内容隐藏，组件自己的 state 不会跟着没——
    不重置的话，下次打开会看到上一次填了一半的名字，甚至上一次的报错。
  */
  useEffect(() => {
    if (open) return
    setName('')
    setExpiry(DEFAULT_EXPIRY)
    setSubmitting(false)
    setError(null)
    setFieldError(null)
  }, [open])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()

    const trimmed = name.trim()
    setFieldError(null)
    setError(null)

    if (trimmed === '') {
      setFieldError('给令牌起个名字')
      return
    }
    if ([...trimmed].length > NAME_MAX_LENGTH) {
      setFieldError(`名称最多 ${NAME_MAX_LENGTH} 个字`)
      return
    }

    setSubmitting(true)
    try {
      const created = await createAccessToken(
        expiry === 'never' ? { name: trimmed } : { name: trimmed, expiresInDays: Number(expiry) },
      )
      onCreated(created)
    } catch (err) {
      setError(toStateError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 提交中不许关：关掉之后成功 / 失败都没有落点，而请求已经出去了
        if (!next && submitting) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建访问令牌</DialogTitle>
          <DialogDescription>
            给令牌起个名字，方便以后认出来是哪台设备在用。创建后完整令牌只显示一次。
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-token-name">
              名称
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="mcp-token-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (fieldError) setFieldError(null)
              }}
              placeholder="例如：我的 Claude / QQ 机器人"
              className={TOUCH}
              disabled={submitting}
              aria-required="true"
              aria-invalid={fieldError !== null || undefined}
              aria-describedby="mcp-token-name-hint"
            />
            {fieldError ? (
              <p id="mcp-token-name-hint" role="alert" className="text-xs text-destructive">
                {fieldError}
              </p>
            ) : (
              <p id="mcp-token-name-hint" className="text-xs text-muted-foreground">
                {/* 没有重命名接口（SPEC §6.8 只有建 / 列 / 撤），所以不写设计稿那句「可以随时改」。
                    名字不要求唯一：两台设备同名是正常的。 */}
                只是给你自己看的；两台设备起同一个名字也没关系。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-token-expiry">有效期</Label>
            <Select
              value={expiry}
              onValueChange={(v) => setExpiry(v as ExpiryValue)}
              disabled={submitting}
            >
              {/* 触发器默认 `w-fit`；这一格要和上面的名称框同宽 */}
              <SelectTrigger id="mcp-token-expiry" className={cn(TOUCH, 'w-full')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} className={TOUCH}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              到期后令牌自动失效，正在使用的客户端会收到 401。
            </p>
          </div>

          {/* 一次性提醒（SPEC §10.8）：建之前就说清，别等创建完才讲 */}
          <div className={cn(MCP_NOTICE, 'flex items-start gap-2.5')}>
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p>{MCP_COPY.oneTimeNotice}</p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error.message}</AlertTitle>
              <AlertDescription>requestId：{error.requestId}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className={TOUCH}
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" className={TOUCH} disabled={submitting}>
              {submitting ? '创建中…' : '创建令牌'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
