/**
 * `/audit`：MCP 调用记录（SPEC §6.11 / §10.11）。
 *
 * 从设置页「MCP 接入」链过来（[SPEC §10.11](../spec/10-mcp.md) 的「页面是独立的一页」）。
 * 只做布局与三段状态的编排；筛选在 `features/audit/use-audit-filters`，取数与分页在
 * `use-audit-log`，呈现规则在 `audit-copy` 与 `AuditList`。
 *
 * ## 管理员那条「全部 / 只看我的」
 *
 * 开关只在 `role === 'admin'` 时渲染。**普通成员拿不到这个开关，也拿不到 `scope=all` 的
 * 效果**：`use-audit-filters` 会把非管理员地址里的 `scope=all` 读回 `mine`，服务端还会
 * 再拒一次（`FORBIDDEN`）。两道都在，因为权限不在界面上——界面只是不给一个注定失败的按钮。
 *
 * ## 状态是怎么分的
 *
 * - **第一页还没回来** → 骨架；回来是空 → 空态，分「一条都没有」与「被筛选筛没了」两种说法
 *   （同浏览页 `EmptyNotice` 的判据：后者换条件就有，前者换什么都不会有）；
 * - **失败** → `Alert`（带 `requestId` 与重试），**不冒充空态**（http.md §3）；
 * - **翻页失败** → 列表留着，错误块挂在列表下面，重试重拉那一页（`use-audit-log`）。
 *
 * 日预算那句说明放在顶部、不放进 429 错误里：被拦的请求根本不写审计（SPEC §10.11），
 * 所以这一页永远不会因为超限而回 429——它只能是说明，不是错误态。
 */

import { useAuth } from '../contexts/auth'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { Notice } from '../components/Notice'
import { AuditFilters } from '../features/audit/AuditFilters'
import { AuditList } from '../features/audit/AuditList'
import { AUDIT_COPY } from '../features/audit/audit-copy'
import { useAuditFilters } from '../features/audit/use-audit-filters'
import { useAuditLog } from '../features/audit/use-audit-log'
import { TOUCH } from '../lib/touch'
import { cn } from '../lib/utils'

export function AuditPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const filterState = useAuditFilters(isAdmin)
  const { filters, activeCount, setScope } = filterState
  const log = useAuditLog(filterState.params)

  // `RequireAuth` 已经在路由上挡了一道，这里只是让类型窄下来；真走到这一支说明外壳坏了
  if (!user) return null

  const loadingFirstPage = log.loading && !log.initialDone
  const showEmpty = log.initialDone && !log.loading && log.error === null && log.items.length === 0

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{AUDIT_COPY.title}</h1>
        <p className="text-sm text-muted-foreground">{AUDIT_COPY.description}</p>
      </div>

      <Notice muted>
        <p className="text-sm">
          {AUDIT_COPY.privacyHint}
          <span className="mx-1.5 text-border" aria-hidden="true">
            ·
          </span>
          {AUDIT_COPY.budgetHint}
        </p>
      </Notice>

      {/* 管理员的范围切换。放 URL（`?scope=all`），和筛选同一个真源。 */}
      {isAdmin && (
        <div
          role="group"
          aria-label="记录范围"
          className="flex w-fit items-center gap-1 rounded-full border bg-card p-1"
        >
          {(['mine', 'all'] as const).map((scope) => (
            <Button
              key={scope}
              type="button"
              size="sm"
              variant={filters.scope === scope ? 'default' : 'ghost'}
              aria-pressed={filters.scope === scope}
              className={TOUCH}
              onClick={() => setScope(scope)}
            >
              {scope === 'mine' ? AUDIT_COPY.scopeMine : AUDIT_COPY.scopeAll}
            </Button>
          ))}
        </div>
      )}

      <AuditFilters state={filterState} />

      {/* 第一页不回来：骨架。数几行就够，不需要按 limit 画满 40 行。 */}
      {loadingFirstPage && (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl" />
          ))}
        </div>
      )}

      {/* 第一页失败：整块错误态。列表本来就没有内容，重试从第一页开始。 */}
      {log.error !== null && log.items.length === 0 && (
        <Alert variant="destructive">
          <AlertTitle>{AUDIT_COPY.errorTitle}</AlertTitle>
          <AlertDescription>
            <p>{log.error.message}</p>
            {/* requestId 必须露出（http.md §3） */}
            <p className="font-mono text-xs">requestId：{log.error.requestId}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(TOUCH, 'mt-2')}
              onClick={log.retry}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 空态：两种说法见文件头 */}
      {showEmpty && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border bg-card px-6 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {activeCount > 0 || filters.scope === 'all'
              ? AUDIT_COPY.emptyFiltered
              : AUDIT_COPY.emptyNone}
          </p>
        </div>
      )}

      {log.items.length > 0 && <AuditList items={log.items} meId={user.id} scope={filters.scope} />}

      {/* 翻页失败：列表留着，错误挂在下面——已经看到的那部分不该因为下一页失败而消失。 */}
      {log.error !== null && log.items.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{AUDIT_COPY.errorTitle}</AlertTitle>
          <AlertDescription>
            <p>{log.error.message}</p>
            <p className="font-mono text-xs">requestId：{log.error.requestId}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(TOUCH, 'mt-2')}
              onClick={log.retry}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 翻页：「加载更多」只在 `nextCursor !== null` 时出现；到底了说一句，
          让用户知道「看不到更多」是因为到底了，不是因为没加载出来。 */}
      {log.items.length > 0 && log.error === null && (
        <div className="flex justify-center py-2">
          {log.hasMore ? (
            <Button
              type="button"
              variant="outline"
              className={TOUCH}
              disabled={log.loading}
              onClick={log.loadMore}
            >
              {log.loading ? AUDIT_COPY.loadingMore : AUDIT_COPY.loadMore}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{AUDIT_COPY.endOfList}</p>
          )}
        </div>
      )}
    </div>
  )
}
