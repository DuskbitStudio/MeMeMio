/**
 * 审计页的筛选条：工具 / 令牌 / 日期范围（SPEC §6.11）。
 *
 * **值全在 URL 里**（`use-audit-filters`），这个组件只负责把它们画出来、把点击写回去。
 *
 * ## 手机档折叠
 *
 * 四个控件竖着排会占掉手机一整屏，而列表才是这一页的主体。所以窄屏下面只露一个
 * 「筛选」按钮（带生效条数角标），点开才展开；`md` 以上始终展开、按钮不出现。
 * 折叠是**纯呈现**，不碰 URL——展开与否不是可分享的状态（state-navigation.md §3）。
 *
 * ## 令牌选项从哪来
 *
 * 用上设置页同一份 `GET /access-tokens`（只回**未撤销未过期**的令牌）。历史记录里可能
 * 出现已撤销 / 已删除的令牌，它们不在这个列表里——用 URL 带着这样的 `tokenId` 进来时
 * 下拉会显示一个「已撤销或已删除的令牌」的临时选项，而不是空着（空触发器看起来像坏了）。
 * **不为它新开接口**：那是 §6.11 没有的端点，而这里少的是标签、不是数据。
 */

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { type AccessTokenItem, fetchAccessTokens } from '../../lib/api'
import { AUDIT_TOOLS } from '../../lib/api-audit'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { AUDIT_COPY, TOOL_LABELS } from './audit-copy'
import type { AuditFiltersState } from './use-audit-filters'

/** Radix 的 `SelectItem` 不接受空串做值，所以「全部」用一个哨兵值。 */
const ALL = '__all__'

export function AuditFilters({ state }: { state: AuditFiltersState }) {
  const { filters, activeCount, setTool, setTokenId, setFrom, setTo, clearFilters } = state
  const [tokens, setTokens] = useState<AccessTokenItem[]>([])
  const [open, setOpen] = useState(false)

  // 令牌列表拿不到就只是少了几个选项，不挡列表本身——所以这里吞掉错误，不给错误态。
  useEffect(() => {
    let alive = true
    fetchAccessTokens()
      .then((items) => {
        if (alive) setTokens(items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  /** URL 里的 tokenId 不在当前列表里（已撤销 / 已过期）→ 给它一个临时选项。 */
  const orphanTokenId =
    filters.tokenId !== null && !tokens.some((t) => t.id === filters.tokenId)
      ? filters.tokenId
      : null

  return (
    <div className="flex flex-col gap-3">
      {/* 窄屏的展开开关。`md:` 以上不出现——那时候四个控件本来就都在。 */}
      <div className="flex items-center gap-2 md:hidden">
        <Button
          type="button"
          variant="outline"
          className={cn(TOUCH, 'gap-1.5')}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="audit-filters"
        >
          {AUDIT_COPY.filterToggle}
          {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
          <ChevronDown
            className={cn('size-4 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
        {activeCount > 0 && (
          <Button type="button" variant="ghost" className={TOUCH} onClick={clearFilters}>
            {AUDIT_COPY.filterClear}
          </Button>
        )}
      </div>

      <div
        id="audit-filters"
        className={cn(
          'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4',
          // 窄屏没展开就整块收起。`hidden` 同时移出 Tab 顺序与无障碍树。
          !open && 'hidden md:grid',
        )}
      >
        {/* 工具 */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-tool">{AUDIT_COPY.filterTool}</Label>
          <Select
            value={filters.tool ?? ALL}
            onValueChange={(v) => setTool(v === ALL ? null : v)}
          >
            <SelectTrigger id="audit-tool" className={cn(TOUCH, 'w-full')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className={TOUCH}>
                {AUDIT_COPY.filterAllTools}
              </SelectItem>
              {AUDIT_TOOLS.map((tool) => (
                <SelectItem key={tool} value={tool} className={TOUCH}>
                  {TOOL_LABELS[tool] ?? tool}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 令牌 */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-token">{AUDIT_COPY.filterToken}</Label>
          <Select
            value={filters.tokenId ?? ALL}
            onValueChange={(v) => setTokenId(v === ALL ? null : v)}
          >
            <SelectTrigger id="audit-token" className={cn(TOUCH, 'w-full')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className={TOUCH}>
                {AUDIT_COPY.filterAllTokens}
              </SelectItem>
              {orphanTokenId !== null && (
                <SelectItem value={orphanTokenId} className={TOUCH}>
                  已撤销或已删除的令牌
                </SelectItem>
              )}
              {tokens.map((t) => (
                <SelectItem key={t.id} value={t.id} className={TOUCH}>
                  {t.name} · {t.prefix}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 日期范围。值是 `YYYY-MM-DD`，正好就是接口要的形状（UTC 日，含两端）——
            原生 date 控件的取值不做任何转换，避免本地时区把「10-31」挪成「10-30」。 */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">{AUDIT_COPY.filterFrom}</Label>
          <Input
            id="audit-from"
            type="date"
            className={TOUCH}
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(e) => setFrom(e.target.value || null)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">{AUDIT_COPY.filterTo}</Label>
          <Input
            id="audit-to"
            type="date"
            className={TOUCH}
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            onChange={(e) => setTo(e.target.value || null)}
          />
        </div>

        {/* 桌面档的「清除」跟着四个控件走；手机档那一枚在上面，展开时它还在视野里。 */}
        {activeCount > 0 && (
          <div className="hidden md:col-span-4 md:block">
            <Button type="button" variant="ghost" className={TOUCH} onClick={clearFilters}>
              {AUDIT_COPY.filterClear}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
