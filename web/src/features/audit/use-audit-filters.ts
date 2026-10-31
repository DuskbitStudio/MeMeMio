/**
 * 审计页的筛选条件：**URL 是唯一真源**（[state-navigation.md](../rules/state-navigation.md) §1）。
 *
 * 放 URL 的五个键：`scope` / `tool` / `tokenId` / `from` / `to`。理由与浏览页那套一样——
 * 「某个令牌今天调了什么」是一个可以被分享、被刷新的状态，放组件 state 里就没了。
 *
 * **游标不进 URL。** 它是分页位置，不是筛选条件（SPEC §1.3「游标不进 URL」），
 * 由 `use-audit-log` 自己在内存里管。
 *
 * ⚠️ **`scope=all` 只在管理员那里认。** 普通成员带着 `?scope=all` 的地址进来时
 * 那一键直接落回 `mine`（服务端会回 `FORBIDDEN`，没必要让界面先发出一个注定失败的请求）；
 * 地址栏里那个 `scope=all` 原样留着不删——它不影响任何请求，删它只会让用户 Share 出去的
 * 链接在两个人手里长得不一样。真正拦是服务端的事，这里只是不把注定失败的那一次发出去。
 *
 * 写操作**全部 `{ replace: true }`**：改筛选是「把当前这一屏看得更细」，不该占历史
 * （同浏览页）。
 */

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { FetchMcpLogsParams } from '../../lib/api-audit'

export type AuditScope = 'mine' | 'all'

export type AuditFilters = {
  scope: AuditScope
  tool: string | null
  tokenId: string | null
  from: string | null
  to: string | null
}

/** `YYYY-MM-DD`。不校验「是不是真实日期」——服务端对非法值回 `VALIDATION_FAILED`，界面照常显示。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 把地址栏读成筛选条件。**认不出的值当作没传**，不让一个手打错的链接变成一屏报错。 */
export function readAuditFilters(sp: URLSearchParams, canSeeAll: boolean): AuditFilters {
  const scope = sp.get('scope') === 'all' && canSeeAll ? 'all' : 'mine'
  const from = sp.get('from')
  const to = sp.get('to')
  return {
    scope,
    tool: sp.get('tool') || null,
    tokenId: sp.get('tokenId') || null,
    from: from !== null && DATE_RE.test(from) ? from : null,
    to: to !== null && DATE_RE.test(to) ? to : null,
  }
}

/**
 * 筛选条件 → 接口参数。
 *
 * 只写有值的键：`tool=` 这种空串服务端按非法处理，而「没筛」在接口上就是**不传**。
 * `scope` 总是带上——缺省是 `mine`，但显式带上让请求日志能直接看出这一次看的是谁的范围。
 */
export function buildAuditParams(f: AuditFilters): FetchMcpLogsParams {
  const p: FetchMcpLogsParams = { scope: f.scope }
  if (f.tool !== null) p.tool = f.tool
  if (f.tokenId !== null) p.tokenId = f.tokenId
  if (f.from !== null) p.from = f.from
  if (f.to !== null) p.to = f.to
  return p
}

/** 有几个筛选项生效（不含 `scope`——它是「看谁的范围」，不是「把列表筛窄」）。 */
export function countAuditFilters(f: AuditFilters): number {
  return [f.tool, f.tokenId, f.from, f.to].filter((v) => v !== null).length
}

export function useAuditFilters(canSeeAll: boolean) {
  const [sp, setSearchParams] = useSearchParams()

  /*
   * `filtersKey` 是**字符串**，`filters` / `params` 都从它 memo 出来，所以「条件没变就不换引用」。
   * 直接把 `sp` 当 memo 依赖不行：它每次渲染都是新对象，取数 effect 会每帧重跑。
   */
  const filtersKey = sp.toString()
  const filters = useMemo(
    () => readAuditFilters(new URLSearchParams(filtersKey), canSeeAll),
    [filtersKey, canSeeAll],
  )
  const params = useMemo(() => buildAuditParams(filters), [filters])

  /** 只动一个键。`value` 为空即删键（与接口的「不传 = 不过滤」对齐）。 */
  function setKey(key: keyof AuditFilters, value: string | null) {
    const next = new URLSearchParams(sp)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  /** 清空四个筛选项，`scope` 留着——「回到全部范围」和「把范围里的条件清掉」是两件事。 */
  function clearFilters() {
    const next = new URLSearchParams(sp)
    for (const key of ['tool', 'tokenId', 'from', 'to']) next.delete(key)
    setSearchParams(next, { replace: true })
  }

  return {
    filters,
    params,
    filtersKey,
    activeCount: countAuditFilters(filters),
    setTool: (v: string | null) => setKey('tool', v),
    setTokenId: (v: string | null) => setKey('tokenId', v),
    setFrom: (v: string | null) => setKey('from', v),
    setTo: (v: string | null) => setKey('to', v),
    setScope: (v: AuditScope) => setKey('scope', v),
    clearFilters,
  }
}

export type AuditFiltersState = ReturnType<typeof useAuditFilters>
