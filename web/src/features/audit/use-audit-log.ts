/**
 * 审计列表与分页（SPEC §6.11 / §1.3）。
 *
 * 分页是**「加载更多」按钮**，不是浏览页那种无限滚动：这是一张审计表，用户是在核对
 * 「某个令牌昨天调了什么」，滚到底想看的不是「下一篇」，而是「到这儿为止了吗」。
 * 一条明确的长列表让 40 / 80 / 120 的边界看得见（每页默认 40，§1.3）。
 *
 * ## 与浏览页 `use-browse-list` 有两处刻意不同
 *
 * 1. **没有 IntersectionObserver**，翻页由按钮触发；失败后「重试」重拉的就是**失败的那一页**，
 *    和浏览页同一个口径（不整表重来，已经翻过的页还在）。
 * 2. **没有降级 / 改写那三个字段**——审计响应里没有它们（§6.11 的形状就是
 *    `scope / items / nextCursor`），别为了「和浏览页长得像」去造。
 *
 * ## 游标失效：**只自动恢复一次**（照搬浏览页实测出来的那条）
 *
 * 翻页时 `VALIDATION_FAILED` 的唯一含义是游标与筛选对不上（SPEC §2.2 / §1.3）——
 * 签名里带了筛选条件。处理是丢弃游标、回第一页、说一句。但**连续第二次坏就停下**：
 * 服务端稳定拒绝时，自动恢复会转成没有退避的请求长龙，而且每转一圈弹一次提示。
 * 停下来的样子与其它失败一致：错误块 + 「重试」。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, toStateError } from '../../lib/api'
import { type AuditLogItem, type FetchMcpLogsParams, fetchMcpLogs } from '../../lib/api-audit'
import { notifyFailure } from '../../lib/toast'

export function useAuditLog(params: FetchMcpLogsParams) {
  const [items, setItems] = useState<AuditLogItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialDone, setInitialDone] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  /** 只认最后一次发出的请求：连点「加载更多」或换筛选时，前一个响应后到不能盖进新一页。 */
  const seq = useRef(0)

  /**
   * 失败那一页的游标（第一页是 `undefined`）。「重试」重拉的就是这一页。
   *
   * 它在按钮形态里没有浏览页那层「挡住观察器」的职责（这里没有观察器），
   * 但仍然要记：否则重试只能从第一页整表重来。
   */
  const failedCursorRef = useRef<string | undefined>(undefined)

  /** 「刚为游标失效恢复过一次，之后还没有一次成功的翻页」，见文件头。 */
  const recoveredRef = useRef(false)

  const load = useCallback(
    async (cursor?: string) => {
      const me = ++seq.current
      setLoading(true)
      setError(null)
      try {
        const page = await fetchMcpLogs({ ...params, cursor })
        if (me !== seq.current) return
        if (cursor) setItems((prev) => [...prev, ...page.items])
        else setItems(page.items)
        // 收工只认 `nextCursor === null`（SPEC §1.3），**不认「这一页不满 40 条」**：
        // 软删 / 并发插入都会让正常的页不满，按条数收工会把正常结果截断。
        setNextCursor(page.nextCursor)
        if (!cursor) setInitialDone(true)
        failedCursorRef.current = undefined
        recoveredRef.current = false
      } catch (err) {
        if (me !== seq.current) return
        // `toStateError` 而不是强转：断网时 fetch 抛的是 TypeError（http.md §4）
        const apiErr = toStateError(err)

        /*
         * 游标坏了 → 丢弃、回第一页、说一句。判据带 `cursor !== undefined`：
         * 第一页的 `VALIDATION_FAILED` 是筛选参数本身非法（例如 from > to），
         * 那时回第一页等于原地打转，应当显示错误。
         */
        if (cursor !== undefined && apiErr.code === 'VALIDATION_FAILED') {
          if (recoveredRef.current) {
            failedCursorRef.current = cursor
            setError(apiErr)
            return
          }
          recoveredRef.current = true
          failedCursorRef.current = undefined
          setNextCursor(null)
          setError(null)
          notifyFailure('翻页已失效，已回到第一页', apiErr.requestId)
          void load()
          return
        }

        failedCursorRef.current = cursor
        setError(apiErr)
      } finally {
        if (me === seq.current) setLoading(false)
      }
    },
    [params],
  )

  // 换筛选 / 换作用域：整表重置后重拉第一页
  useEffect(() => {
    setItems([])
    setNextCursor(null)
    setInitialDone(false)
    failedCursorRef.current = undefined
    recoveredRef.current = false
    void load()
  }, [load])

  /** 「加载更多」。只有 `nextCursor !== null` 时才该被点到（按钮在别处按这个条件挂）。 */
  function loadMore() {
    const cursor = nextCursor
    if (cursor === null || loading) return
    void load(cursor)
  }

  /**
   * 出错后重试：**重拉失败的那一页**。用户点名要试，恢复的那次机会重开——
   * 不然连续坏两次之后只能刷新页面。
   */
  function retry() {
    recoveredRef.current = false
    void load(failedCursorRef.current)
  }

  return {
    items,
    loading,
    initialDone,
    error,
    /** 还有没有下一页。**唯一判据**，界面据此挂 / 摘「加载更多」。 */
    hasMore: nextCursor !== null,
    loadMore,
    retry,
  }
}
