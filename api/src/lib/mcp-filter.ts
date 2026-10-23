import { AppError } from './app-error.js'
import { isKnownLabel, termsOf, VOCAB_FIELDS } from '../vocab.js'
import type { VocabField } from './vision-output.js'

/**
 * MCP 用户级排除过滤器（SPEC §5.9 / §6.9 / §10.3.2）。
 *
 * 形状固定为七个数组，缺省 `[]`；`ratings` 永远是空数组——成人向由内容范围单独控制，
 * 不能混进过滤器（§10.3.2）。
 *
 * 这个文件只做**形状校验、词表校验和命中判断**，不碰数据库与 MCP SDK：
 * 路由、令牌鉴权、工具三处都 import 它，放在 `lib/` 避免 data → mcp 的反向依赖。
 */

export type McpFilterValues = Record<VocabField, string[]>

export type McpFilterSource = Partial<Record<VocabField, readonly string[] | null>>

const FIELDS = VOCAB_FIELDS

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVocabField(value: string): value is VocabField {
  return (FIELDS as readonly string[]).includes(value)
}

export function emptyMcpFilter(): McpFilterValues {
  const filter = {} as McpFilterValues
  for (const field of FIELDS) filter[field] = []
  return filter
}

/** 总数：入口行「已排除 N 个」与面板底部计数共用。 */
export function countMcpFilter(filter: McpFilterValues): number {
  return FIELDS.reduce((sum, field) => sum + filter[field].length, 0)
}

/**
 * 从数据库读到的 JSONB 恢复成固定形状。
 *
 * **做防御性归一化**：未知维度、非数组、非字符串都丢掉；`ratings` 强制清空——
 * 即使有人绕过了 API 直接写库，成人向也不能变成过滤器。
 */
export function normalizeMcpFilter(raw: unknown): McpFilterValues {
  const filter = emptyMcpFilter()
  if (!isRecord(raw)) return filter

  for (const field of FIELDS) {
    if (field === 'ratings') continue
    const value = raw[field]
    if (!Array.isArray(value)) continue
    filter[field] = [...new Set(value.filter((item): item is string => typeof item === 'string'))]
  }

  return filter
}

/**
 * `PUT /mcp/filter` 的请求体校验（SPEC §6.9）。**严格**：
 * 顶层只能有 `excluded`，维度名必须是七个之一，值必须在词表内。
 */
export function parseMcpFilterPayload(raw: unknown): McpFilterValues {
  if (!isRecord(raw)) {
    throw new AppError('VALIDATION_FAILED', '请求体必须是 { excluded: { ... } }')
  }

  const keys = Object.keys(raw)
  if (keys.length !== 1 || keys[0] !== 'excluded') {
    throw new AppError('VALIDATION_FAILED', '请求体必须恰好包含 excluded')
  }

  const excluded = raw['excluded']
  if (!isRecord(excluded)) {
    throw new AppError('VALIDATION_FAILED', 'excluded 必须是一个对象')
  }

  for (const key of Object.keys(excluded)) {
    if (!isVocabField(key)) {
      throw new AppError('VALIDATION_FAILED', `无法识别的过滤维度：${key}`)
    }
  }

  const filter = emptyMcpFilter()
  for (const field of FIELDS) {
    const value = excluded[field]
    if (value === undefined) continue
    if (!Array.isArray(value)) {
      throw new AppError('VALIDATION_FAILED', `${field} 必须是字符串数组`)
    }

    const seen = new Set<string>()
    const values: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new AppError('VALIDATION_FAILED', `${field} 必须是字符串数组`)
      }
      if (!isKnownLabel(field, item)) {
        throw new AppError('VALIDATION_FAILED', `${field} 里没有词表值：${item}`)
      }
      if (seen.has(item)) continue
      seen.add(item)
      values.push(item)
    }

    if (field === 'ratings' && values.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        '成人向由「内容范围」单独设置，不能加入过滤器',
      )
    }
    filter[field] = values
  }

  return filter
}

/**
 * 一张图是否被过滤器排除（SPEC §10.3.2）：**命中任一维度里的任一值即排除**。
 *
 * 传 `MemeRow` / `MemeView` 都行：只看七个数组字段，缺字段按空数组处理。
 */
export function isExcludedByFilter(item: McpFilterSource, filter: McpFilterValues): boolean {
  for (const field of FIELDS) {
    const selected = filter[field]
    if (selected.length === 0) continue
    const values = item[field]
    if (!values || values.length === 0) continue
    if (values.some((value) => selected.includes(value))) return true
  }
  return false
}

/** 把过滤器压成缓存 key 的稳定串：字段顺序固定，避免 JSONB 键序影响命中。 */
export function mcpFilterCacheKey(filter: McpFilterValues): string {
  return JSON.stringify(FIELDS.map((field) => [field, filter[field]]))
}

/** 词表里是否有这个词；给 web/测试复用。 */
export function isFilterableTerm(field: VocabField, value: string): boolean {
  return isKnownLabel(field, value)
}

/** 某个维度的全部候选（测试与 web 预览会用到）。 */
export function filterTerms(field: VocabField): readonly string[] {
  return termsOf(field)
}
