import { z } from 'zod'
import { VOCAB_FIELDS } from '../vocab.js'
import type { MemeFilter } from '../data/memes.js'

/**
 * MCP 工具的筛选参数（SPEC §10.4.1 的表）。`search_memes` 与 `pick_meme_for_reply` 共用。
 *
 * 单独成文件是为了**不把检索执行拖进来**：这个模块只做「工具输入 → `MemeFilter`」的映射，
 * 依赖面是 zod + 词表 + 一个类型，因此能被 unit 测试直接跑（不需要数据库 / env）。
 * 执行在 `mcp/search.ts`，那里才 import `services/search`。
 *
 * ## 筛选语义与浏览一致
 *
 * 七个维度多值 AND、词表外的值**不报错、返回空结果**（SPEC §10.4 开头）。
 * 所以这里不校验词表：闭集校验属于打标/编辑（§4），不属于检索。
 */

/**
 * 七个筛选维度 + `isAnimated` + `favorited`（SPEC §10.4.1 的表）。
 *
 * 用 `MemeFilter` 的字段名而不是另起一套：两个工具的输入直接映射到浏览/检索的筛选条件，
 * 中间不做「翻译」，少一层就会少一处漂移。
 */
export const filterShape = {
  expressions: z.array(z.string()).optional(),
  emotions: z.array(z.string()).optional(),
  tones: z.array(z.string()).optional(),
  purposes: z.array(z.string()).optional(),
  scenes: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  ratings: z.array(z.string()).optional(),
  isAnimated: z.boolean().optional(),
  favorited: z.boolean().optional(),
  /** 成人向请求；默认 false。账号设置未开启时传 true 是工具错误（SPEC §10.3.1）。 */
  allowAdult: z.boolean().optional(),
}

/** text 的详细程度（SPEC §10.4.6）：只影响 text，`structuredContent` 永远完整。 */
export const detailShape = {
  detail: z.enum(['compact', 'full']).default('compact'),
}

export type Detail = 'compact' | 'full'

export type FilterArgs = {
  expressions?: string[]
  emotions?: string[]
  tones?: string[]
  purposes?: string[]
  scenes?: string[]
  tags?: string[]
  ratings?: string[]
  isAnimated?: boolean
  favorited?: boolean
  allowAdult?: boolean
}

/**
 * 工具输入 → `MemeFilter`。
 *
 * ⚠️ **键的插入顺序必须稳定**（先按 `VOCAB_FIELDS`，再 `isAnimated`、`favorited`）：
 * 缓存 key 里是 `JSON.stringify(filter)`，键序变一下就是另一个 key——表现只是缓存不命中
 * （每次都重新付费调 AI），不报错。所以这里用遍历而不是手写对象字面量。
 *
 * `favorited: false` 按「不筛」处理（与 `GET /memes` 的口径一致：非 `true` 一律当不传）；
 * `false` 不是「只看未收藏」——SPEC 没给过那个语义。
 */
export function toMemeFilter(args: FilterArgs): MemeFilter {
  const filter: MemeFilter = {}

  for (const field of VOCAB_FIELDS) {
    const values = args[field]
    if (values !== undefined && values.length > 0) filter[field] = values
  }

  if (args.isAnimated !== undefined) filter.isAnimated = args.isAnimated
  if (args.favorited === true) filter.favorited = true

  return filter
}
