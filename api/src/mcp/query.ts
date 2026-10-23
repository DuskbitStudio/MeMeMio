import { termsOf, VOCAB_FIELDS } from '../vocab.js'

/**
 * 检索兜底：从一句自然语言里提取**词表里真实存在的词**（SPEC §10.4.2 的「词表关键词重试」）。
 *
 * 为什么需要：真实的群聊消息是「被夸会选表情包，有点不好意思又有点得意，嘿嘿」这种长句，
 * 直接拿整句去检索会空手；而库里存的标签是「得意 / 害羞 / 开心」这种短词。把长句里
 * 命中的词表词抽出来再查一次，命中率显著高于整句。
 *
 * ⚠️ **只做「包含」判断，不做分词、不调 AI。** 词表 285 个词逐个 includes，成本可忽略；
 *    分词要维护词典、调用模型要花钱，都不适合一个兜底路径。
 */

/** 最多用几个词重试。太多会变成 OR 噪声，反而把精确结果挤掉。 */
const MAX_FALLBACK_TERMS = 6

/** 抽到的词按在句子里出现的先后排序，去重；单字词（如「猫」）保留，它们同样是有效标签。 */
export function extractVocabTerms(message: string): string[] {
  const found: { term: string; at: number }[] = []

  for (const field of VOCAB_FIELDS) {
    for (const term of termsOf(field)) {
      if (term === '') continue
      const at = message.indexOf(term)
      if (at >= 0) found.push({ term, at })
    }
  }

  // 同一位置优先长词（「阴阳怪气」不该同时把「怪气」也塞进去）；再按出现顺序
  found.sort((a, b) => (a.at === b.at ? b.term.length - a.term.length : a.at - b.at))
  const unique: string[] = []
  for (const { term } of found) {
    if (!unique.includes(term)) unique.push(term)
    if (unique.length >= MAX_FALLBACK_TERMS) break
  }
  return unique
}

/**
 * 给原句生成兜底查询；没有可用的词表词、或生成的查询与原句相同，返回 null
 * （调用方据此决定要不要再查一次 / 要不要走随机兜底）。
 */
export function buildFallbackQuery(original: string): string | null {
  const terms = extractVocabTerms(original)
  if (terms.length === 0) return null

  const query = terms.join(' ')
  return query === original.trim() ? null : query
}
