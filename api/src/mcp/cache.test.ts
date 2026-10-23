import { describe, expect, it } from 'vitest'
import { emptyMcpFilter, mcpFilterCacheKey } from '../lib/mcp-filter.js'
import {
  createTtlCache,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  searchCacheKey,
} from './cache.js'

/**
 * 检索结果缓存的单元测试（SPEC §10.6、`agents/rules/mcp.md §5`）。
 *
 * 缓存的三条实现约束全是**静默**的：TTL 失效早一点/晚一点、淘汰顺序反了、key 少了 userId，
 * 都不会报错——最多是多付一次 AI 账单，或者把别人的收藏筛选结果给出去。
 * 所以这里把「60 秒」「最多 500 条」「key 含 userId」逐条钉住。
 */

describe('createTtlCache', () => {
  it('默认 TTL 是 60 秒、上限 500 条（SPEC §10.6）', () => {
    expect(SEARCH_CACHE_TTL_MS).toBe(60_000)
    expect(SEARCH_CACHE_MAX_ENTRIES).toBe(500)
  })

  it('未命中的 get 是 undefined，不是 null', () => {
    const cache = createTtlCache<number>()
    expect(cache.get('missing')).toBeUndefined()
  })

  it('TTL 内命中，到期后失效（时钟可注入，不用真的等一分钟）', () => {
    let now = 1_000
    const cache = createTtlCache<string>({ ttlMs: 60_000, now: () => now })

    cache.set('k', 'v')
    expect(cache.get('k')).toBe('v')

    now += 59_999
    expect(cache.get('k')).toBe('v')

    now += 1 // 正好到期
    expect(cache.get('k')).toBeUndefined()
    // 过期条目在 get 时就被删掉，不会留下永远涨的内存
    expect(cache.size()).toBe(0)
  })

  it('超过上限按插入顺序淘汰最旧的', () => {
    const cache = createTtlCache<number>({ maxEntries: 3, ttlMs: 60_000 })

    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('d')).toBe(4)
    expect(cache.size()).toBe(3)
  })

  it('更新已有键会挪到队尾（否则它会被当成最旧的淘汰）', () => {
    const cache = createTtlCache<number>({ maxEntries: 2, ttlMs: 60_000 })

    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10) // a 现在是最新的
    cache.set('c', 3) // 应该淘汰 b，不是 a

    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(10)
    expect(cache.get('c')).toBe(3)
  })
})

describe('searchCacheKey', () => {
  const filter = { expressions: ['微笑'], isAnimated: true }
  const excluded = emptyMcpFilter()

  it('同一份输入得到同一个 key（命中靠它）', () => {
    const parts = { userId: 'u1', query: '猫', filter, limit: 8, allowAdult: false, excluded }
    expect(searchCacheKey(parts)).toBe(searchCacheKey({ ...parts }))
  })

  it('key 必须含 userId —— favorited 是按用户算的', () => {
    const base = { query: '猫', filter, limit: 8, allowAdult: false, excluded }
    expect(searchCacheKey({ ...base, userId: 'u1' })).not.toBe(
      searchCacheKey({ ...base, userId: 'u2' }),
    )
  })

  it('query / limit / filter / 成人向许可 / 过滤器任一不同都换 key', () => {
    const base = { userId: 'u1', query: '猫', filter, limit: 8, allowAdult: false, excluded }
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, query: '狗' }))
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, limit: 9 }))
    expect(searchCacheKey({ ...base, filter: {} })).not.toBe(searchCacheKey(base))
    // 成人向许可不同 → 结果集不同，不能共用缓存（§10.3.1）
    expect(searchCacheKey(base)).not.toBe(searchCacheKey({ ...base, allowAdult: true }))
    // 过滤器不同 → 结果集不同，不能共用缓存（§10.3.2）
    expect(searchCacheKey(base)).not.toBe(
      searchCacheKey({ ...base, excluded: { ...excluded, emotions: ['开心'] } }),
    )
  })

  it('key 的形状是 userId \\0 query \\0 JSON(filter) \\0 limit \\0 safe|adult \\0 过滤器（顺序固定）', () => {
    const key = searchCacheKey({ userId: 'u1', query: '猫', filter: {}, limit: 8, allowAdult: false, excluded })
    expect(key.split('\0')).toEqual(['u1', '猫', '{}', '8', 'safe', mcpFilterCacheKey(excluded)])
  })
})
