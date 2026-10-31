/**
 * 审计列表：桌面一张表、手机一组卡（同一份 `items`，两种排布）。
 *
 * 列是任务 §3 web 第 1 行点名的五项：**时间、令牌名 + 前缀、工具、检索词、结果**。
 * 顺序照任务写，不另加列——`userId` 只在「全部」视图里对管理员有用，而那一列
 * 会把「是谁的」暴露成一行字母数字串；管理员按任务的原话是「知道谁在多频繁地取库」，
 * 这件事由令牌那一列已经说明白了。
 *
 * ⚠️ **「仅本人可见」由 `readQueryText` 统一给**，本组件不做判断（见 `audit-copy.ts`）。
 * 在这里再写一遍条件，就是第二个漏掉它的地方。
 *
 * ## 手机档为什么不做横向滚动的表
 *
 * 任务验收要求「390×844 下表格横向滚动、筛选折叠」，也就是说窄屏保留表格是允许的；
 * 但五列里「检索词」是长文本，塞进 390 宽的表里要么被 `whitespace-nowrap` 撑出屏幕、
 * 要么每行换三四行。设置页的令牌列表已经走过这条路（`TokenCards`），用的是同一套判据：
 * **一行里超过三个值就改成卡**。所以窄屏走卡，`md` 以上走表；表外面仍然是
 * `Table` 自带的那层 `overflow-x-auto`，在中等宽度（md–lg）下照样能横着滚。
 */

import { Badge } from '../../components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table'
import type { AuditLogItem } from '../../lib/api-audit'
import { formatDate } from '../../lib/format'
import { cn } from '../../lib/utils'
import { AUDIT_COPY, readQueryText, readTokenLabel } from './audit-copy'

function OutcomeBadge({ outcome }: { outcome: AuditLogItem['outcome'] }) {
  // 失败用 destructive 的 `outline` 边框而不是实心红：一行记录的结果是**状态**，
  // 不是警报（styling.md 的「状态的视觉表达」）。
  return outcome === 'ok' ? (
    <Badge variant="secondary">{AUDIT_COPY.outcomeOk}</Badge>
  ) : (
    <Badge variant="outline" className="text-destructive">
      {AUDIT_COPY.outcomeError}
    </Badge>
  )
}

/** 检索词那一格。别的内容用 `muted` 说明它不是原文，但也不弱到看不见。 */
function QueryText({ text }: { text: string }) {
  const hidden = text === AUDIT_COPY.queryHidden || text === AUDIT_COPY.queryEmpty
  return (
    <span className={cn('block max-w-[32rem] text-pretty', hidden && 'text-muted-foreground')}>
      {text}
    </span>
  )
}

export function AuditList({
  items,
  meId,
  scope,
}: {
  items: AuditLogItem[]
  meId: string
  scope: 'mine' | 'all'
}) {
  return (
    <>
      {/* 桌面：`md` 以上 */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">时间</TableHead>
              <TableHead>令牌</TableHead>
              <TableHead>工具</TableHead>
              <TableHead>检索词</TableHead>
              <TableHead className="w-20">结果</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatDate(item.createdAt)}
                </TableCell>
                <TableCell>{readTokenLabel(item)}</TableCell>
                <TableCell className="font-mono text-xs">{item.tool}</TableCell>
                <TableCell className="whitespace-normal">
                  <QueryText text={readQueryText(item, { meId, scope })} />
                </TableCell>
                <TableCell>
                  <OutcomeBadge outcome={item.outcome} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* 手机：一张卡一行记录，字段用「标签 — 值」两栏，长文本单独占一行 */}
      <ul className="flex flex-col gap-3 md:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 rounded-2xl border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{readTokenLabel(item)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatDate(item.createdAt)}
                </p>
              </div>
              <OutcomeBadge outcome={item.outcome} />
            </div>
            <p className="font-mono text-xs text-muted-foreground">{item.tool}</p>
            <p className="text-sm text-pretty">{readQueryText(item, { meId, scope })}</p>
          </li>
        ))}
      </ul>
    </>
  )
}
