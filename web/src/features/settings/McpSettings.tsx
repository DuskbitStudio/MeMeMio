import { type ReactNode, useCallback, useEffect, useState } from 'react'
import {
  BookOpenIcon,
  CopyIcon,
  FilterIcon,
  InfoIcon,
  KeyRoundIcon,
  PlusIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import {
  fetchAccessTokens,
  fetchMcpFilter,
  fetchMcpSettings,
  toStateError,
  updateMcpSettings,
  type AccessTokenItem,
  type ApiError,
  type CreatedAccessToken,
  type McpFilterValues,
  type McpSettingsState,
} from '../../lib/api'
import { formatDateOnly, formatRelativeTime } from '../../lib/format'
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
import { Separator } from '../../components/ui/separator'
import { Switch } from '../../components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table'
import { McpGuideSheet } from './McpGuideSheet'
import { McpFilterSheet, mcpFilterCount, mcpFilterPreview } from './McpFilterSheet'
import { McpTokenCreateDialog } from './McpTokenCreateDialog'
import { McpTokenCreatedDialog } from './McpTokenCreatedDialog'
import { McpTokenRevokeDialog } from './McpTokenRevokeDialog'
import { SettingsCard } from './SettingsCard'
import {
  MCP_COPY,
  MCP_ENDPOINT_HINT_PARTS,
  MCP_INLINE_CODE,
  MCP_NOTICE,
  mcpEndpoint,
} from './mcp-copy'
import { COPY_FAILED_TEXT, useCopyText } from './use-copy-text'

/**
 * 设置页 · MCP 接入（SPEC §10；文案契约见 §10.8）。
 *
 * ## 这一段是「只读的外部接口」在界面上的唯一入口
 *
 * 它同时装三样东西：接入地址（复制）、个人访问令牌（增 / 列 / 撤）、一页接入口袋指南。
 * **MCP 本身不是 REST**，`web` 也不消费 `/mcp`——这里管的是令牌的 REST 管理端点
 * （§6.8），浏览器 cookie 会话。所以本卡片与视觉 / Embedding 那种「配置存储」不一样：
 * 没有表单要保存，只有列表与一次性的创建结果。
 *
 * ## 几个不能顺手改的取舍
 *
 * 1. **完整令牌只在 `created` 这一个 state 里**，弹窗一关就置空（见
 *    `McpTokenCreatedDialog` 文件头）。列表接口本来也只回 `prefix`。
 * 2. **空态不重复放第二个「创建令牌」按钮**：那枚按钮就在标题行上，离空面板几像素，
 *    再放一个是在教用户「这里也有一个」。
 * 3. **撤销成功不弹 toast**：行从列表里消失就是反馈（feedback.md 判据 1）。
 *    失败留在撤销确认框里，带 `requestId`。
 * 4. **窄屏不用表格**：五列的表格在 390px 上必然横向滚；`md` 以下改成「标签 / 值」
 *    堆叠的卡片列表，两种形态共用同一份数据与同一个撤销入口。
 */

/** 「怎么接」三步。第 3 步里的工具名是 SPEC §10.4 的固定工具名。 */
function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground"
      >
        {number}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  )
}

/** 桌面端表格（md 以上）。 */
function TokenTable({
  tokens,
  onRevoke,
}: {
  tokens: readonly AccessTokenItem[]
  onRevoke: (token: AccessTokenItem) => void
}) {
  return (
    <div className="hidden md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>前缀</TableHead>
            <TableHead>最后使用</TableHead>
            <TableHead>过期</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              <TableCell className="font-medium whitespace-normal wrap-anywhere">
                {token.name}
              </TableCell>
              {/* 列表只回前缀（SPEC §6.8）；末尾的省略号是在提示「这不是完整令牌」 */}
              <TableCell className="font-mono text-xs text-muted-foreground">
                {token.prefix}…
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(token.lastUsedAt)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {token.expiresAt ? formatDateOnly(token.expiresAt) : '永久'}
              </TableCell>
              <TableCell className="text-right">
                <RevokeButton token={token} onRevoke={onRevoke} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 窄屏卡片列表（md 以下）：逐条「标签 / 值」堆叠，不横向溢出。 */
function TokenCards({
  tokens,
  onRevoke,
}: {
  tokens: readonly AccessTokenItem[]
  onRevoke: (token: AccessTokenItem) => void
}) {
  return (
    <ul className="flex flex-col divide-y md:hidden">
      {tokens.map((token) => (
        <li key={token.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">名称</dt>
            <dd className="text-right font-medium wrap-anywhere">{token.name}</dd>
            <dt className="text-muted-foreground">前缀</dt>
            <dd className="text-right font-mono text-xs wrap-anywhere">{token.prefix}…</dd>
            <dt className="text-muted-foreground">最后使用</dt>
            <dd className="text-right">{formatRelativeTime(token.lastUsedAt)}</dd>
            <dt className="text-muted-foreground">过期</dt>
            <dd className="text-right">{token.expiresAt ? formatDateOnly(token.expiresAt) : '永久'}</dd>
          </dl>
          <div className="flex justify-end">
            <RevokeButton token={token} onRevoke={onRevoke} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * 「撤销」是真按钮（不是红字链接）：手机上要按得到，键盘要 Tab 得到。
 * 颜色只借 `text-destructive`，底色在 hover 时才出现——它不是破坏性弹窗里的主按钮。
 */
function RevokeButton({
  token,
  onRevoke,
}: {
  token: AccessTokenItem
  onRevoke: (token: AccessTokenItem) => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(TOUCH, 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
      aria-label={`撤销令牌 ${token.name}`}
      onClick={() => onRevoke(token)}
    >
      撤销
    </Button>
  )
}

/** 空态：虚线面板 + 一句「怎么开始」。**不放第二个创建按钮**（那一枚在标题行上）。 */
function EmptyTokens() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-dashed p-4">
      <div
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground"
      >
        <KeyRoundIcon className="size-4" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">还没有访问令牌</p>
        <p className="text-sm text-muted-foreground">
          创建一个，把它填进客户端的 Authorization 请求头。创建后只显示一次。
        </p>
      </div>
    </div>
  )
}

export function McpSettings() {
  const [tokens, setTokens] = useState<AccessTokenItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)

  /** 内容范围设置（SPEC §6.9）。与令牌列表分开加载：一个失败不该把另一个也藏掉。 */
  const [settings, setSettings] = useState<McpSettingsState | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<ApiError | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [confirmAdultOpen, setConfirmAdultOpen] = useState(false)

  /** 排除过滤器（SPEC §10.3.2）。与内容范围分开加载：一个失败不该把另一个也藏掉。 */
  const [filter, setFilter] = useState<McpFilterValues | null>(null)
  const [filterLoading, setFilterLoading] = useState(true)
  const [filterError, setFilterError] = useState<ApiError | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  /** 完整令牌只活在这里；关掉「令牌已创建」弹窗就置空（见文件头第 1 条）。 */
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [revoking, setRevoking] = useState<AccessTokenItem | null>(null)

  // 接入地址用运行时 origin：用户复制的必须是「他现在访问的这个域名」。
  const origin = window.location.origin
  const endpoint = mcpEndpoint(origin)

  const { target, state: copyState, copy } = useCopyText()

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchAccessTokens()
      .then(setTokens)
      .catch((err) => setError(toStateError(err)))
      .finally(() => setLoading(false))
  }, [])

  const loadSettings = useCallback(() => {
    setSettingsLoading(true)
    setSettingsError(null)
    fetchMcpSettings()
      .then(setSettings)
      .catch((err) => setSettingsError(toStateError(err)))
      .finally(() => setSettingsLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const loadFilter = useCallback(() => {
    setFilterLoading(true)
    setFilterError(null)
    fetchMcpFilter()
      .then(setFilter)
      .catch((err) => setFilterError(toStateError(err)))
      .finally(() => setFilterLoading(false))
  }, [])

  useEffect(() => {
    loadFilter()
  }, [loadFilter])

  /** 写设置。开启要先过确认框；关闭直接写。 */
  async function applyAdult(next: boolean) {
    setSavingSettings(true)
    setSettingsError(null)
    try {
      setSettings(await updateMcpSettings(next))
    } catch (err) {
      setSettingsError(toStateError(err))
    } finally {
      setSavingSettings(false)
      setConfirmAdultOpen(false)
    }
  }

  function handleAdultChange(next: boolean) {
    if (next) setConfirmAdultOpen(true)
    else void applyAdult(false)
  }

  function handleCreated(next: CreatedAccessToken) {
    // 先关创建弹窗、再切到「已创建」：同一时刻只有一个弹窗（嵌套模态留给关闭确认）
    setCreateOpen(false)
    setCreated(next)
    // 列表等弹窗关掉再刷（`closeCreated`）：创建结果这一刻是模态的，用户看不到背后的列表
  }

  function closeCreated() {
    setCreated(null)
    load()
  }

  function handleRevoked(id: string) {
    setTokens((prev) => prev.filter((token) => token.id !== id))
    setRevoking(null)
  }

  const addressCopied = target === endpoint && copyState === 'copied'
  const addressCopyFailed = target === endpoint && copyState === 'failed'

  return (
    <SettingsCard
      id="mcp"
      title="MCP 接入"
      description={MCP_COPY.cardDescription}
      action={<Badge variant="outline">只读</Badge>}
    >
      {/* 接入地址 */}
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">接入地址</p>
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-input/50 px-3 py-2">
          {/* 手机上小一号：完整地址 + 复制按钮要挤在一行里；`sm` 以上回到 `text-sm` */}
          <code className="min-w-0 flex-1 font-mono text-xs wrap-anywhere sm:text-sm">{endpoint}</code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={TOUCH}
            onClick={() => copy(endpoint)}
            aria-label="复制接入地址"
          >
            <CopyIcon aria-hidden="true" data-icon="inline-start" />
            {addressCopied ? '已复制' : '复制'}
          </Button>
        </div>
        {addressCopyFailed && (
          // 复制反馈在按钮旁边就地出现：`role="alert"` 保证读屏立刻念（clipboard-share.md §4.1）
          <p role="alert" className="text-xs text-destructive">
            {COPY_FAILED_TEXT}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {MCP_ENDPOINT_HINT_PARTS.map((part) =>
            part.code ? (
              <code key={part.text} className={MCP_INLINE_CODE}>
                {part.text}
              </code>
            ) : (
              part.text
            ),
          )}
        </p>
      </div>

      <Separator />

      {/* 访问令牌 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <h3 className="mr-auto text-base font-medium">访问令牌</h3>
          {!loading && !error && <Badge variant="secondary">{tokens.length} 个</Badge>}
          <Button
            type="button"
            className={cn(TOUCH, 'w-full sm:w-auto')}
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            创建令牌
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{MCP_COPY.tokenHint}</p>

        {loading && <p className="text-sm text-muted-foreground">加载中…</p>}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>加载失败</AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
              {/* requestId 必须露出：报问题时它是唯一能对上服务端日志的东西（http.md §3） */}
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

        {!loading && !error && tokens.length === 0 && <EmptyTokens />}

        {!loading && !error && tokens.length > 0 && (
          <>
            <TokenTable tokens={tokens} onRevoke={setRevoking} />
            <TokenCards tokens={tokens} onRevoke={setRevoking} />
          </>
        )}
      </div>

      <Separator />

      {/* 内容范围（成人向）：用户级设置，默认关闭；开启要确认（SPEC §10.3.1 / §10.8） */}
      <div id="mcp-content-scope" className="flex flex-col gap-3">
        <h3 className="text-base font-medium">内容范围</h3>
        {/* 开关和「允许成人向内容 + 说明」同一行：它属于这一项，不属于标题行 */}
        <div className="flex items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{MCP_COPY.contentScopeTitle}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {MCP_COPY.contentScopeDescription}
            </p>
            {settings?.allowAdult === true && (
              <p className="mt-1 text-sm text-muted-foreground">
                {MCP_COPY.contentScopeEnabledHint}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant={settings?.allowAdult === true ? 'default' : 'secondary'}>
              {settings?.allowAdult === true ? MCP_COPY.contentScopeOn : MCP_COPY.contentScopeOff}
            </Badge>
            <Switch
              checked={settings?.allowAdult ?? false}
              onCheckedChange={handleAdultChange}
              disabled={settingsLoading || savingSettings || settingsError !== null}
              aria-label={MCP_COPY.contentScopeTitle}
            />
          </div>
        </div>

        {settingsLoading && <p className="text-sm text-muted-foreground">加载中…</p>}

        {settingsError && (
          <Alert variant="destructive">
            <AlertTitle>内容范围设置加载失败</AlertTitle>
            <AlertDescription>
              <p>{settingsError.message}</p>
              <p className="font-mono text-xs">requestId：{settingsError.requestId}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(TOUCH, 'mt-2')}
                onClick={loadSettings}
              >
                重试
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Separator />

      {/* 过滤器（排除标签）：用户级设置，只影响 MCP（SPEC §10.3.2 / §10.8） */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h3 className="text-base font-medium">{MCP_COPY.filterTitle}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {MCP_COPY.filterEntryDescription}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">
              {filterLoading
                ? '加载中…'
                : filter !== null && mcpFilterCount(filter) > 0
                  ? MCP_COPY.filterExcluded(mcpFilterCount(filter))
                  : MCP_COPY.filterUnset}
            </Badge>
            <Button
              type="button"
              variant="outline"
              className={TOUCH}
              onClick={() => setFilterOpen(true)}
              disabled={filterLoading || filterError !== null || filter === null}
            >
              <FilterIcon aria-hidden="true" />
              配置过滤器
            </Button>
          </div>
        </div>

        {filter !== null && mcpFilterCount(filter) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {mcpFilterPreview(filter).map((term) => (
              <Badge key={term} variant="secondary">
                {term}
              </Badge>
            ))}
            {mcpFilterCount(filter) > 3 && (
              <Badge variant="outline">+{mcpFilterCount(filter) - 3}</Badge>
            )}
          </div>
        )}

        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{MCP_COPY.filterAdultNote}</span>
        </p>

        {filterError && (
          <Alert variant="destructive">
            <AlertTitle>{MCP_COPY.filterLoadError}</AlertTitle>
            <AlertDescription>
              <p>{filterError.message}</p>
              <p className="font-mono text-xs">requestId：{filterError.requestId}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(TOUCH, 'mt-2')}
                onClick={loadFilter}
              >
                重试
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Separator />

      {/* 怎么接 */}
      {/*
        桌面：标题在左、「查看完整接入指南」在右，三步在下面；
        手机（设计稿）：标题 → 三步 → 整宽按钮。按钮只渲染一份，靠 `order-*` 换位置——
        再放一份「移动端按钮」就是同一个动作两个落点，迟早各自改文案。
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h3 className="text-base font-medium">怎么接</h3>
        {/* 抽屉自己管开合（`SheetTrigger`），关的时候焦点会还给这枚按钮 */}
        <McpGuideSheet
          origin={origin}
          trigger={
            <Button
              type="button"
              variant="outline"
              className={cn(TOUCH, 'order-3 w-full sm:order-2 sm:w-auto')}
            >
              <BookOpenIcon aria-hidden="true" data-icon="inline-start" />
              查看完整接入指南
            </Button>
          }
        />

        <ol className="order-2 flex flex-col gap-3 sm:order-3 sm:basis-full">
          <Step number={1}>复制上面的地址，创建一个访问令牌。</Step>
          <Step number={2}>
            在 MCP 客户端里添加一个 HTTP 服务器：地址填上面的地址，请求头加{' '}
            <code className={MCP_INLINE_CODE}>Authorization: Bearer &lt;令牌&gt;</code>。
          </Step>
          <Step number={3}>
            对话时直接说「找一张阴阳怪气的表情包」，模型会自己调用{' '}
            <code className={MCP_INLINE_CODE}>search_memes</code> 或{' '}
            <code className={MCP_INLINE_CODE}>pick_meme_for_reply</code>。
          </Step>
        </ol>
      </div>

      {/* 安全提示（SPEC §10.8）。NOTICE 配方、不是 Alert——它是说明不是警报 */}
      <div className={cn(MCP_NOTICE, 'flex items-start gap-2.5')}>
        <ShieldCheckIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <p>{MCP_COPY.securityNotice}</p>
      </div>

      {/* 边界脚注（SPEC §10.8） */}
      <p className="flex items-start gap-2.5 text-sm text-muted-foreground">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">{MCP_COPY.boundaryFootnote}</span>
      </p>

      <McpTokenCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      {/* 只在有完整令牌时挂载：关闭即卸载，令牌随 state 一起消失 */}
      {created && (
        <McpTokenCreatedDialog created={created} origin={origin} onClose={closeCreated} />
      )}

      {revoking && (
        <McpTokenRevokeDialog
          token={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={handleRevoked}
        />
      )}

      {filter !== null && (
        <McpFilterSheet
          open={filterOpen}
          onOpenChange={setFilterOpen}
          values={filter}
          onSaved={setFilter}
        />
      )}

      {/* 开启成人向要先确认（SPEC §10.8）：这是一次有风险的默认值变更 */}
      <AlertDialog open={confirmAdultOpen} onOpenChange={setConfirmAdultOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{MCP_COPY.adultConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{MCP_COPY.adultConfirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={TOUCH}>取消</AlertDialogCancel>
            <AlertDialogAction
              className={TOUCH}
              disabled={savingSettings}
              onClick={() => void applyAdult(true)}
            >
              {savingSettings ? '保存中…' : MCP_COPY.adultConfirmAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
