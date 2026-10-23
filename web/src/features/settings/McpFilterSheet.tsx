import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDownIcon,
  LockIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
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
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet'
import {
  toStateError,
  updateMcpFilter,
  type ApiError,
  type McpFilterValues,
} from '../../lib/api'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import { VOCAB_DIMENSIONS, type VocabField } from '../../lib/vocab'
import { MCP_COPY } from './mcp-copy'

/**
 * MCP 排除过滤器选择器（SPEC §10.3.2；设计稿 `_design/mcp/filter-sheet-*.png`）。
 *
 * 交互约定：
 * - 只做**排除**：选中的标签不会出现在 MCP 结果里；没有白名单模式。
 * - 成人向固定红色、不可选；提示“此项需要单独设置”，引导到内容范围。
 * - 有未保存更改时关闭 / 取消 / 点遮罩都要二次确认（设计稿的未保存确认）。
 * - 搜索命中的维度强制展开；没搜索时按“有选中值的维度 + 内容分级”展开。
 */

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  values: McpFilterValues
  onSaved: (values: McpFilterValues) => void
}

function cloneFilter(values: McpFilterValues): McpFilterValues {
  return {
    expressions: [...values.expressions],
    emotions: [...values.emotions],
    tones: [...values.tones],
    purposes: [...values.purposes],
    scenes: [...values.scenes],
    tags: [...values.tags],
    ratings: [],
  }
}

function emptyFilter(): McpFilterValues {
  return {
    expressions: [],
    emotions: [],
    tones: [],
    purposes: [],
    scenes: [],
    tags: [],
    ratings: [],
  }
}

function filterKey(values: McpFilterValues): string {
  return JSON.stringify(VOCAB_DIMENSIONS.map(({ field }) => [field, values[field]]))
}

function countSelected(values: McpFilterValues): number {
  return VOCAB_DIMENSIONS.reduce((sum, { field }) => sum + values[field].length, 0)
}

function selectedTerms(values: McpFilterValues): string[] {
  return VOCAB_DIMENSIONS.flatMap(({ field, options }) =>
    options.filter((option) => values[field].includes(option)),
  )
}

function toggleTerm(
  values: McpFilterValues,
  field: VocabField,
  term: string,
  options: string[],
): McpFilterValues {
  const set = new Set(values[field])
  if (set.has(term)) set.delete(term)
  else set.add(term)

  // 按词表顺序排；词表外的旧值留在末尾（与 VocabPicker 同一口径）
  const next = options.filter((option) => set.has(option))
  for (const option of values[field]) {
    if (!options.includes(option) && set.has(option)) next.push(option)
  }
  return { ...values, [field]: next }
}

export function McpFilterSheet({ open, onOpenChange, values, onSaved }: Props) {
  const [draft, setDraft] = useState<McpFilterValues>(() => cloneFilter(values))
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<VocabField>>(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  /** 确认放弃更改后要做什么：关闭面板，或滚到内容范围。 */
  const [discardIntent, setDiscardIntent] = useState<'close' | 'content'>('close')

  // 每次打开都从服务端当前值重新起草，避免上次未保存的残留
  useEffect(() => {
    if (!open) return
    setDraft(cloneFilter(values))
    setSearch('')
    setError(null)
    setSaving(false)
    setExpanded(
      new Set<VocabField>(
        (() => {
          const firstSelected = VOCAB_DIMENSIONS.find(({ field }) => values[field].length > 0)
          // 单开下拉：打开时有选中值就展开第一个有值的维度，否则展开内容分级看成人向提示
          return [firstSelected?.field ?? 'ratings']
        })(),
      ),
    )
  }, [open, values])

  const dirty = useMemo(() => filterKey(draft) !== filterKey(values), [draft, values])
  const selectedCount = countSelected(draft)

  const trimmedSearch = search.trim()
  const groups = VOCAB_DIMENSIONS.map((dimension) => ({
    ...dimension,
    options: trimmedSearch === ''
      ? dimension.options
      : dimension.options.filter((option) => option.includes(trimmedSearch)),
    selectedCount: draft[dimension.field].length,
  })).filter((group) =>
    trimmedSearch === ''
      || group.options.length > 0
      || (group.field === 'ratings' && '成人向'.includes(trimmedSearch)),
  )

  function requestClose() {
    if (saving) return
    if (dirty) {
      setDiscardIntent('close')
      setDiscardOpen(true)
      return
    }
    onOpenChange(false)
  }

  function handleOpenChange(next: boolean) {
    if (next) onOpenChange(true)
    else requestClose()
  }

  function confirmDiscard() {
    setDiscardOpen(false)
    if (discardIntent === 'content') {
      onOpenChange(false)
      // 让 Sheet 先收起再滚，否则焦点/滚动会被遮罩抢走
      window.setTimeout(() => {
        document.getElementById('mcp-content-scope')?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
      }, 180)
    } else {
      onOpenChange(false)
    }
  }

  function handleContentScope() {
    if (dirty) {
      setDiscardIntent('content')
      setDiscardOpen(true)
      return
    }
    onOpenChange(false)
    window.setTimeout(() => {
      document.getElementById('mcp-content-scope')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }, 180)
  }

  function toggle(field: VocabField, term: string, options: string[]) {
    setDraft((current) => toggleTerm(current, field, term, options))
  }

  function toggleExpanded(field: VocabField) {
    if (trimmedSearch !== '') return
    // 单开：展开一个维度时收起其他维度，避免多个长列表同时撑高面板；
    // 选中值不丢，仍以标题右侧的计数 Badge 表示。
    setExpanded((current) => (current.has(field) ? new Set() : new Set([field])))
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const saved = await updateMcpFilter(draft)
      onSaved(saved)
      onOpenChange(false)
    } catch (caught) {
      setError(toStateError(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[580px]"
        >
          <SheetHeader className="flex shrink-0 flex-row items-start justify-between gap-4 border-b p-6">
            <div className="flex min-w-0 flex-col gap-1.5">
              <SheetTitle>{MCP_COPY.filterTitle}</SheetTitle>
              <SheetDescription>{MCP_COPY.filterPanelDescription}</SheetDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={TOUCH}
              onClick={requestClose}
              aria-label="关闭过滤器"
            >
              <XIcon className="size-4" />
            </Button>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-6 py-4">
            <div className="relative shrink-0">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={MCP_COPY.filterSearchPlaceholder}
                className="pl-9"
                aria-label="搜索标签"
              />
            </div>

            {selectedCount === 0 && (
              <p className="shrink-0 text-xs text-muted-foreground">{MCP_COPY.filterEmpty}</p>
            )}

            {error && (
              <Alert variant="destructive" className="shrink-0">
                <AlertTitle>{MCP_COPY.filterSaveError}</AlertTitle>
                <AlertDescription>
                  <p>{error.message}</p>
                  <p className="font-mono text-xs">requestId：{error.requestId}</p>
                </AlertDescription>
              </Alert>
            )}

            {groups.length === 0 && (
              <p className="shrink-0 py-6 text-center text-sm text-muted-foreground">
                {MCP_COPY.filterNoMatch}
              </p>
            )}

            {/*
              分组必须 shrink-0：面板 body 是 flex 列，默认 flex-shrink:1。多个维度展开后
              内容超过可用高度，浏览器会把每个分组压扁、overflow-hidden 把标题裁成细条
              （2026-10-23 暗色实测）。这里不收缩，height 由内容决定，滚动交给外层 body。
            */}
            <div className="flex shrink-0 flex-col gap-3">
              {groups.map((group) => {
                const isRatings = group.field === 'ratings'
                const isOpenNow = trimmedSearch !== '' || expanded.has(group.field)
                return (
                  <div
                    key={group.field}
                    className="shrink-0 overflow-hidden rounded-2xl border"
                  >
                    <button
                      type="button"
                      className={cn(
                        TOUCH,
                        'flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-sm font-medium',
                        !isOpenNow && 'rounded-2xl',
                      )}
                      onClick={() => toggleExpanded(group.field)}
                      aria-expanded={isOpenNow}
                      disabled={trimmedSearch !== ''}
                    >
                      <span>{group.label}</span>
                      {group.selectedCount > 0 && (
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-[11px] text-secondary-foreground">
                          {group.selectedCount}
                        </span>
                      )}
                      <ChevronDownIcon
                        aria-hidden="true"
                        className={cn(
                          'ml-auto size-4 text-muted-foreground transition-transform',
                          !isOpenNow && '-rotate-90',
                        )}
                      />
                    </button>

                    {isOpenNow && (
                      <div className="flex flex-col gap-2 px-3 pt-3 pb-3">
                        {isRatings ? (
                          <>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                disabled
                                aria-disabled="true"
                                className="inline-flex h-8 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/5 px-3 text-xs text-destructive disabled:cursor-not-allowed"
                              >
                                <LockIcon aria-hidden="true" className="size-3" />
                                成人向
                              </button>
                            </div>
                            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-destructive">
                              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                              <span>
                                {MCP_COPY.filterAdultHint}{' '}
                                <button
                                  type="button"
                                  className="underline underline-offset-2 hover:no-underline"
                                  onClick={handleContentScope}
                                >
                                  {MCP_COPY.filterGoContentScope}
                                </button>
                              </span>
                            </p>
                          </>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {group.options.map((option) => {
                              const active = draft[group.field].includes(option)
                              return (
                                <Button
                                  key={option}
                                  type="button"
                                  variant={active ? 'secondary' : 'outline'}
                                  size="sm"
                                  aria-pressed={active}
                                  className={cn(TOUCH, 'cursor-pointer rounded-full px-3')}
                                  onClick={() => toggle(group.field, option, group.options)}
                                >
                                  {option}
                                </Button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <SheetFooter className="flex shrink-0 flex-row items-center justify-between gap-2 border-t px-6 py-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-muted-foreground">
                {selectedCount === 0
                  ? MCP_COPY.filterNoSelection
                  : MCP_COPY.filterExcluded(selectedCount)}
              </span>
              {selectedCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={TOUCH}
                  disabled={saving}
                  onClick={() => setDraft(emptyFilter())}
                >
                  {MCP_COPY.filterClear}
                </Button>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className={TOUCH}
                disabled={saving}
                onClick={requestClose}
              >
                {MCP_COPY.filterCancel}
              </Button>
              <Button
                type="button"
                className={TOUCH}
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? MCP_COPY.filterSaving : MCP_COPY.filterSave}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* 未保存更改的放弃确认；不是删除，所以动作是「放弃更改」而不是 destructive 红按钮 */}
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{MCP_COPY.filterDiscardTitle}</AlertDialogTitle>
            <AlertDialogDescription>{MCP_COPY.filterDiscardDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={TOUCH}>{MCP_COPY.filterCancel}</AlertDialogCancel>
            <AlertDialogAction className={TOUCH} onClick={confirmDiscard}>
              {MCP_COPY.filterDiscardAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** 供入口行复用：按词表顺序列出已选值（最多 n 个）。 */
export function mcpFilterPreview(values: McpFilterValues, limit = 3): string[] {
  return selectedTerms(values).slice(0, limit)
}

export function mcpFilterCount(values: McpFilterValues): number {
  return countSelected(values)
}
