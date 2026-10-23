import type { Db } from '../data/db.js'
import { listMemes, type MemeFilter, type MemeView } from '../data/memes.js'
import { fetchHits, runSearch, type SearchHit } from '../services/search.js'
import { isExcludedByFilter, type McpFilterValues } from '../lib/mcp-filter.js'
import { searchCacheKey, type TtlCache } from './cache.js'
import { isAdultRatings, toMemeSummary, type MemeSummary } from './format.js'

/**
 * 两个检索类工具（`search_memes` / `pick_meme_for_reply`）共用的**执行**（SPEC §10.4.1、§10.4.2、§10.6）。
 *
 * 输入形状与「工具输入 → `MemeFilter`」的映射在 `mcp/filter.ts`（那部分不依赖数据库，
 * 可以单独单测）；本文件才 import 检索服务与数据层。
 *
 * ## 检索走 `runSearch` + `fetchHits`，不走 `searchMemes`
 *
 * `searchMemes` 的注释写明「新端点不要用它」——它是给测试用的那一层。MCP 不需要快照、
 * 不需要分页（SPEC §10.4.7：v1 只取前 N 条），所以直接组合召回与取数这两步，
 * **与 `GET /memes?q=` 共用同一份召回与融合实现**，结果序列自然一致。
 */

export type SearchToolDeps = {
  db: Db
  requestId: string
  cache: TtlCache<SearchToolResult>
}

/**
 * 一次检索的工具侧结果。
 *
 * `rows` 留在这个结构里是**故意**的：`get_meme_image` / `pick_meme_for_reply` 要拿
 * `storageKey` 去读缩略图，而 `MemeSummary` 按契约不返回它（SPEC §10.4.6）。
 * 这份行只在进程内、只在工具之间流转，不出现在任何响应里。
 */
export type SearchToolResult = {
  query: string
  rewritten: string | null
  degraded: boolean
  rows: SearchHit[]
  items: MemeSummary[]
}

/**
 * 带进程内缓存的检索（SPEC §10.6：同一用户、同一查询、同一筛选、同一 limit、同一成人向许可，60 秒）。
 *
 * **命中不重复调用 AI**：缓存的是检索结果，所以命中时既不走 HyDE 也不走查询 embedding。
 * 缓存 key 含 `userId`（`favorited` 按用户算）与 `allowAdult`（成人向过滤改变结果集）。
 *
 * ## 成人向过滤在工具层做（§10.3.1）
 *
 * 不在 SQL 里加 `ratings <> '成人向'`：`data/search.ts` 的三路查询是 Web 与 MCP 共用的，
 * 为 MCP 的默认值改共享 SQL 会让 Web 的语义跟着变。这里**多取几条再过滤**，代价是一次
 * 稍大的 `fetchHits`，换来「Web 与 MCP 的过滤各自收口」。
 */
export async function runToolSearch(params: {
  deps: SearchToolDeps
  actorId: string
  query: string
  filter: MemeFilter
  limit: number
  /** 本次调用是否允许成人向（两层闸门的结果，见 `resolveAdultAccess`）。 */
  allowAdult: boolean
  /** 用户级排除过滤器（§10.3.2）。 */
  excluded: McpFilterValues
}): Promise<SearchToolResult> {
  const key = searchCacheKey({
    userId: params.actorId,
    query: params.query,
    filter: params.filter,
    limit: params.limit,
    allowAdult: params.allowAdult,
    excluded: params.excluded,
  })

  const cached = params.deps.cache.get(key)
  if (cached !== undefined) return cached

  const run = await runSearch({
    query: params.query,
    filter: params.filter,
    actorId: params.actorId,
    requestId: params.deps.requestId,
    db: params.deps.db,
  })

  // 成人向 + 用户过滤器都会吃掉候选，所以多取一些；上限按融合池本身兜底。
  const candidateLimit = Math.min(params.limit * 6 + 20, 120, run.fused.length)
  const rawRows = await fetchHits(run.fused.slice(0, candidateLimit), params.actorId, params.deps.db)
  const rows = rawRows.filter(
    (row) =>
      (params.allowAdult || !isAdultRatings(row.ratings))
      && !isExcludedByFilter(row, params.excluded),
  )

  const limitedRows = rows.slice(0, params.limit)

  const result: SearchToolResult = {
    query: params.query,
    rewritten: run.rewritten,
    degraded: run.degraded,
    rows: limitedRows,
    items: limitedRows.map(toMemeSummary),
  }

  params.deps.cache.set(key, result)
  return result
}

/**
 * `random_meme` / `pick` 兜底用的安全随机（SPEC §10.4.2 / §10.4.4）。
 *
 * 多取一些再过滤成人向与用户排除标签，最后截到 limit；随机路径不走 AI、也不走缓存。
 */
export async function randomToolRows(params: {
  db: Db
  actorId: string
  limit: number
  isAnimated?: boolean
  allowAdult: boolean
  excluded: McpFilterValues
}): Promise<MemeView[]> {
  const { items } = await listMemes(
    {
      random: true,
      limit: Math.min(params.limit + 40, 100),
      ...(params.isAnimated !== undefined ? { isAnimated: params.isAnimated } : {}),
    },
    params.actorId,
    params.db,
  )

  const safe = items.filter(
    (item) =>
      (params.allowAdult || !isAdultRatings(item.ratings))
      && !isExcludedByFilter(item, params.excluded),
  )
  return safe.slice(0, params.limit)
}
