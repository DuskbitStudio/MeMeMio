import type { ReactNode } from 'react'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'

/**
 * 设置页每一段的壳：一张 `Card`，标题、一句话说明、右上角一个状态位。
 *
 * 每一段的每张卡都用它，所以标题里的结构只写一遍。
 *
 * **它不带 `id`、不带 `scroll-mt`**（2026-10-25 起）：分区地址 `#invites` 这类由
 * `routes/settings.tsx` 算出该显示哪一段（段上也不挂 `id`，理由在那里的 `Section`），一次只显示一段，
 * 切段是「换一段 + 回顶」，不再 `scrollIntoView` 到某张卡。此前 `id` 挂在卡上、
 * `scroll-mt` 按「谁在滚」分两档（手机档要加顶栏那 56px，md 档只要 16px），
 * 都是给长页锚点用的，随长页一起撤了。将来段里再有「滚到某张卡」的需求，
 * 那两档的账要重新算（styling.md「页面滚什么」那张表）。
 *
 * ```tsx
 * <CardTitle><h2>{title}</h2></CardTitle>
 * ```
 * 多这一层 `<h2>` 是因为 `CardTitle` 渲染的是 `<div>`，整页的标题大纲会断在 `<h1>` 上。
 * Tailwind 的 preflight 把标题的 font-size / font-weight 都归成 inherit，
 * 所以套一层不影响 `CardTitle` 的观感，只补回语义。
 */
export function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  /** 右上角的状态位（当前生效的是哪一套、有几个、跑没跑着）。 */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  )
}
