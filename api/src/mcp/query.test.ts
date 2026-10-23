import { describe, expect, it } from 'vitest'
import { buildFallbackQuery, extractVocabTerms } from './query.js'

/**
 * 长句兜底的纯函数（SPEC §10.4.2 / §9.36）。
 *
 * 这些用例只依赖 `shared/vocab/vocab.json`，不连数据库、不调 AI——兜底路径本身必须是
 * 便宜的，测试它也不该起 Postgres。
 */
describe('extractVocabTerms', () => {
  it('从真实聊天长句里抽出词表词', () => {
    const terms = extractVocabTerms('被夸会选表情包，有点不好意思又有点得意，嘿嘿')
    expect(terms).toContain('得意')
    expect(terms.length).toBeLessThanOrEqual(6)
  })

  it('按出现顺序、去重；没有词表词时为空', () => {
    const terms = extractVocabTerms('先无语再得意，最后又无语')
    expect(terms).toEqual(['无语', '得意'])
    expect(extractVocabTerms('完全无关的 zzzz 句子')).toEqual([])
  })
})

describe('buildFallbackQuery', () => {
  it('有词表词时用它们拼查询', () => {
    const query = buildFallbackQuery('被夸会选表情包，有点不好意思又有点得意，嘿嘿')
    expect(query).toContain('得意')
  })

  it('没有词表词 / 拼出来和原句相同 → null（不重复查一次同样的词）', () => {
    expect(buildFallbackQuery('完全无关的 zzzz 句子')).toBeNull()
    expect(buildFallbackQuery('得意')).toBeNull()
  })
})
