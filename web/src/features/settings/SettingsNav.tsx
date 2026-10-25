import { Fragment, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { ScrollArea } from '../../components/ui/scroll-area'
import { Separator } from '../../components/ui/separator'
import { cn } from '../../lib/utils'
import { SETTINGS_GROUP_LABEL, type SettingsGroup, type SettingsSection, type SettingsSectionId } from './settings-sections'
import { TOUCH } from './settings-ui'

/**
 * 设置页的分区导航：宽的时候是左栏（带「我的」「全站管理」组标题），窄的时候是段上方
 * 一行横滑标签（任务 2026-10-25-设置页分区导航 §4.1）。
 *
 * **每一项都是链接，不是页签控件**：`<Link to="#id">` 渲染成 `<a href>`、写进历史，
 * 后退回到上一段，地址能复制、能直达。用 `Link` 而不是裸 `<a>`：走路由的 `pushState`，
 * `useLocation` 立刻拿到新 hash，浏览器也不会插手做原生的锚点滚动（页面上本来就没有
 * 同名 `id`，见 `routes/settings.tsx` 的 `Section`）。点当前项不会多占一条历史
 * （与原生链接同一个行为）。
 *
 * **宽窄按容器分，不按视口**（styling.md「响应式：按容器分档」）：侧栏展开与否差 200px，
 * 1024 视口展开侧栏时内容区只剩 720，那一档按视口算会被当成「够宽」而挤成两条窄列。
 * 容器那一层是 `routes/settings.tsx` 的根节点（`@container`），档位 `@3xl` = 48rem。
 *
 * 窄档那条**不吸顶**：它吸住就得给段里每个 `scrollIntoView` 落点补它的高度
 * （`McpFilterSheet` 滚到 `#mcp-content-scope` 那条），漏了不报错、只是落点被它盖住
 * （以前设置页长页锚点的 `scroll-mt` 要分两档，是同一课，见 `SettingsCard` 注释）。切段时页面本来就回顶，
 * 回顶之后它就在眼前。宽档的左栏吸顶，它在段的旁边、不压在段上面。
 *
 * 宽档吸顶的 `top-6` 不减顶栏高度：容器 ≥48rem 意味着视口 ≥ md，那一档滚的是外壳的
 * `ScrollArea`，顶栏是它的兄弟、不盖在它上面（styling.md「页面滚什么」）。
 * 6 是外壳 `p-6` 那 24px，吸住之后与页面顶边的距离和没滚时一样。
 */
export function SettingsNav({
  sections,
  active,
}: {
  sections: readonly SettingsSection[]
  active: SettingsSectionId
}) {
  const groups = (['mine', 'admin'] as const satisfies readonly SettingsGroup[])
    .map((group) => ({ group, items: sections.filter((s) => s.group === group) }))
    .filter((g) => g.items.length > 0)

  const activeRef = useRef<HTMLAnchorElement>(null)

  /*
   * 窄档：直达 `#users` 时那一项可能在横条右边看不见的地方，把它挪进来。
   * 手算 `scrollLeft` 而不是 `scrollIntoView`——后者会顺带滚动所有祖先，
   * 包括页面那层（同 `LightboxViewer` 缩略图轨道的理由）。宽档横条不溢出，这里是空操作。
   */
  useEffect(() => {
    const link = activeRef.current
    const strip = link?.closest<HTMLElement>('[data-slot=scroll-area-viewport]')
    if (!link || !strip) return
    const s = strip.getBoundingClientRect()
    const l = link.getBoundingClientRect()
    if (l.left < s.left) strip.scrollLeft += l.left - s.left - 16
    else if (l.right > s.right) strip.scrollLeft += l.right - s.right + 16
  }, [active])

  return (
    <nav aria-label="设置分区" className="min-w-0 @3xl:sticky @3xl:top-6 @3xl:w-44 @3xl:shrink-0">
      {/*
        横条的几件事照 `MemeRail` 的 `RailScroller`：`pb-3` 给浮层滚动条留货道、
        `p-1`（内）与 `-mx-1`（外）给聚焦环留 4px（viewport 是裁剪盒）、
        `overscroll-x-contain` 挂在 viewport 上。宽档不溢出，Radix 连条都不挂。
      */}
      <ScrollArea
        orientation="horizontal"
        className="-mx-1 pb-3 @3xl:pb-0 [&>[data-slot=scroll-area-viewport]]:overscroll-x-contain"
      >
        <div className="flex w-max items-center gap-2 p-1 @3xl:w-auto @3xl:flex-col @3xl:items-stretch @3xl:gap-5">
          {groups.map(({ group, items }, i) => (
            <Fragment key={group}>
              {/* 窄档没有地方放组标题（它是读屏用的 sr-only），组与组之间用一根竖线分开 */}
              {i > 0 && <Separator orientation="vertical" className="h-6 @3xl:hidden" />}
              <div className="flex flex-col gap-1">
                <p
                  id={`settings-nav-${group}`}
                  className="sr-only px-3 text-xs font-medium text-muted-foreground @3xl:not-sr-only"
                >
                  {SETTINGS_GROUP_LABEL[group]}
                </p>
                <ul aria-labelledby={`settings-nav-${group}`} className="flex gap-1 @3xl:flex-col">
                  {items.map((s) => {
                    const current = s.id === active
                    return (
                      <li key={s.id}>
                        <Button
                          variant={current ? 'secondary' : 'ghost'}
                          size="sm"
                          className={cn(TOUCH, 'w-full justify-start')}
                          asChild
                        >
                          <Link
                            ref={current ? activeRef : undefined}
                            to={`#${s.id}`}
                            aria-current={current ? 'true' : undefined}
                          >
                            {s.label}
                          </Link>
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </Fragment>
          ))}
        </div>
      </ScrollArea>
    </nav>
  )
}
