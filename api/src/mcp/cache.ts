import type { MemeFilter } from '../data/memes.js'
import { mcpFilterCacheKey, type McpFilterValues } from '../lib/mcp-filter.js'

/**
 * 检索结果的进程内缓存（SPEC §10.6 的「结果缓存」那一条，实现约束见 `agents/rules/mcp.md §5`）。
 *
 * 它挡的是一次**真实的 AI 成本**：未命中的语义检索 = 1 次 HyDE 改写 + 1 次查询 embedding。
 * 群聊场景下同一条消息会被反复触发，没有这层缓存就是反复付费。
 *
 * ## 三条边界
 *
 * 1. **TTL 60 秒**。它不是数据库，也不是第二份检索快照——`search_snapshots` 是翻页快照
 *    （冻结候选名单、带游标），两者生命周期与语义都不同，不要合并。
 * 2. **最多 500 条，按插入顺序淘汰**。Map 的迭代顺序就是插入顺序，所以淘汰「最旧的」不需要
 *    额外的链表；超过上限说明查询分布很散，那时丢失命中率是正常的。
 * 3. **key 必须含 userId**。`favorited` 与将来的个性化语义都按用户算，少了它会
 *    「A 的收藏筛选结果被 B 拿到」——不报错，只是结果里混着不该出现的图。
 *
 * 缓存的是**检索结果（含内部行）**，不是图片字节：图片走 R2 的公开地址，内联那一条
 * 每次现读（`mcp/image.ts`），否则内存会被图片顶爆。多副本各缓存各的，不承诺跨副本一致
 * （与「不引入 Redis」同一条约束，SPEC §9.11）。
 */

/** TTL：契约里的 60 秒（SPEC §10.6）。 */
export const SEARCH_CACHE_TTL_MS = 60_000

/** 条目上限。超过按插入顺序淘汰最旧的。 */
export const SEARCH_CACHE_MAX_ENTRIES = 500

export type TtlCache<T> = {
  get(key: string): T | undefined
  set(key: string, value: T): void
  /** 仅供测试与排障观察。 */
  size(): number
  clear(): void
}

/**
 * 极小 TTL 缓存。**时钟可注入**，否则「60 秒后失效」这条只能靠真的等一分钟来测。
 */
export function createTtlCache<T>(options: {
  ttlMs?: number
  maxEntries?: number
  now?: () => number
} = {}): TtlCache<T> {
  const ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? SEARCH_CACHE_MAX_ENTRIES
  const now = options.now ?? Date.now

  const entries = new Map<string, { value: T; expiresAt: number }>()

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (entry.expiresAt <= now()) {
        // 过期就删掉再返回未命中：留着只会让下一次查找多走一层判断
        entries.delete(key)
        return undefined
      }
      return entry.value
    },

    set(key, value) {
      // 先删再插：更新已有键时要把它挪到队尾，否则淘汰顺序按第一次插入算
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + ttlMs })

      // 超上限从最早的开始淘汰。while 而不是 if：批量写入时可能一次超好几条
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },

    size() {
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}

/**
 * 检索缓存的 key：`userId + \0 + query + \0 + JSON.stringify(filter) + \0 + limit`
 * （`agents/rules/mcp.md §5` 定的形状）。
 *
 * `\0` 分隔是因为它是唯一不会出现在 query 与 JSON 里的字符——用 `|` 的话
 * `userId='a|b'` 与 query 里带 `|` 会拼出同一个 key，表现是串结果。
 *
 * `filter` 的键序由 `mcp/filter.ts` 的 `toMemeFilter` 固定（按 `VOCAB_FIELDS` 顺序），
 * 所以同一个筛选条件永远序列化成同一串。
 */
export function searchCacheKey(parts: {
  userId: string
  query: string
  filter: MemeFilter
  limit: number
  /** 成人向许可（§10.3.1）：同一查询在不同许可下结果不同，必须进 key。 */
  allowAdult: boolean
  /** 用户级排除过滤器（§10.3.2）：改过滤器后不能命中旧结果。 */
  excluded: McpFilterValues
}): string {
  return [
    parts.userId,
    parts.query,
    JSON.stringify(parts.filter),
    String(parts.limit),
    parts.allowAdult ? 'adult' : 'safe',
    mcpFilterCacheKey(parts.excluded),
  ].join('\0')
}
