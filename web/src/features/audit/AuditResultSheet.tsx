/**
 * 审计详情抽屉：这次调用返回了哪些图（SPEC §10.8 的「详情抽屉」那一组）。
 *
 * ## 谁能打开
 *
 * **只对本人、且 `resultMemeIds` 非 `null` 且非空的行**。判定在 `audit-copy.ts` 的
 * `readResultMemeIds`，本组件不自己判——他人的行 `resultMemeIds` 是 `null`，这里就算
 * 误传进来也渲染不出东西，**绝不拿 `resultCount` 去凑列表**（§10.8 明写）。
 *
 * ## 空态文案为什么没在这里用
 *
 * 「这次调用没有返回图。」（`drawerEmpty`）**不打开就没有空态**：没有 id 的行压根没有
 * 入口（不是灰按钮，任务文件 §5）。这句话是给别处复用的同一个组件准备的，放在文案表里。
 *
 * ## 为什么内容只在有行时渲染
 *
 * Radix 关抽屉会卸载 portal 里的内容；这里再显式按 `ids !== null` 判一次，是为了让
 * 「关掉再打开另一行」时**每一格重新挂载、重新查一次**——图在两次打开之间被软删，
 * 重开就该显示「已删除或不可见」，而不是沿用上一次的缓存。
 */

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet'
import type { AuditLogItem } from '../../lib/api-audit'
import { AUDIT_COPY, readResultMemeIds } from './audit-copy'
import { AuditResultCell } from './AuditResultCell'

export function AuditResultSheet({
  item,
  meId,
  scope,
  onClose,
}: {
  /** 抽屉要展示的那一行；`null` = 关着。 */
  item: AuditLogItem | null
  meId: string
  scope: 'mine' | 'all'
  onClose: () => void
}) {
  const ids = item === null ? null : readResultMemeIds(item, { meId, scope })

  return (
    <Sheet
      open={ids !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      {ids !== null && (
        <SheetContent
          side="right"
          // 抽屉里只有标题和一组图，没有一段能当读屏描述的说明；不传这个会有一条
          // Radix 的开发期警告，也让读屏念一段它自己都念不出内容的 description。
          aria-describedby={undefined}
          // 注册表是 `w-3/4 sm:max-w-sm`（384）。桌面放宽到 `md`（448）让两列图不至于太挤；
          // 前缀要与注册表**同一个** `data-[side=right]:` 才盖得住（同 `McpGuideSheet`）。
          className="data-[side=right]:w-3/4 sm:data-[side=right]:max-w-md"
        >
          <SheetHeader className="shrink-0 border-b p-6">
            {/* 右上角是注册表自带的关闭按钮，标题别钻到它底下 */}
            <SheetTitle className="pr-10">{AUDIT_COPY.drawerTitle}</SheetTitle>
          </SheetHeader>

          {/* 只让中间这段滚（同 `McpGuideSheet` 的结构）；`min-w-0` 是给窄屏的图列兜底 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="grid min-w-0 grid-cols-2 gap-3">
              {ids.map((id) => (
                <AuditResultCell key={id} memeId={id} />
              ))}
            </div>
          </div>
        </SheetContent>
      )}
    </Sheet>
  )
}
