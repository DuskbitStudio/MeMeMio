import { describe, expect, it } from 'vitest'
import { toMemeFilter } from './filter.js'

/**
 * 工具输入 → `MemeFilter` 的映射（SPEC §10.4.1）。**纯函数，不连库、不读 env。**
 *
 * 两个易错点都在这里钉住：
 *
 * 1. **键序稳定**：缓存 key 里是 `JSON.stringify(filter)`，键序变了就换 key。
 *    表现只是「缓存永不命中、每次重新付费调 AI」，不报错。
 * 2. **`favorited: false` 不是筛选**：只有 `true` 才加条件（与 `GET /memes` 同口径）。
 */

describe('toMemeFilter', () => {
  it('空输入 → 空筛选（没有多余的 undefined 键）', () => {
    expect(toMemeFilter({})).toEqual({})
  })

  it('七个维度按 VOCAB_FIELDS 的固定顺序写入，空数组不写入', () => {
    const filter = toMemeFilter({
      tones: ['阴阳怪气'],
      expressions: ['微笑'],
      tags: [],
      emotions: [],
    })

    // 空数组是「这个维度没筛」，不是「筛空集」——写成 [] 会让 SQL 多一条恒假条件
    expect(filter).toEqual({ expressions: ['微笑'], tones: ['阴阳怪气'] })
    expect(Object.keys(filter)).toEqual(['expressions', 'tones'])
  })

  it('键序与参数对象的字面顺序无关（缓存 key 依赖这一点）', () => {
    const a = toMemeFilter({ isAnimated: true, expressions: ['微笑'], favorited: true })
    const b = toMemeFilter({ favorited: true, expressions: ['微笑'], isAnimated: true })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // 语义维度在前、isAnimated 其次、favorited 最后
    expect(Object.keys(a)).toEqual(['expressions', 'isAnimated', 'favorited'])
  })

  it('isAnimated: false 是「只看静图」，必须写进筛选（与 favorited 相反）', () => {
    expect(toMemeFilter({ isAnimated: false })).toEqual({ isAnimated: false })
  })

  it('favorited 只有 true 才筛；false 等同不传', () => {
    expect(toMemeFilter({ favorited: true })).toEqual({ favorited: true })
    expect(toMemeFilter({ favorited: false })).toEqual({})
  })
})
