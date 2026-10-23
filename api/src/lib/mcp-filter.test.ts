import { describe, expect, it } from 'vitest'
import {
  countMcpFilter,
  emptyMcpFilter,
  isExcludedByFilter,
  mcpFilterCacheKey,
  normalizeMcpFilter,
  parseMcpFilterPayload,
} from './mcp-filter.js'
import { AppError } from './app-error.js'

/**
 * MCP 排除过滤器的纯函数（SPEC §10.3.2）。
 *
 * 这些校验是**安全边界**：词表校验挡住无效值，`ratings` 校验挡住把成人向混进
 * 过滤器；归一化函数还负责把数据库里的脏 JSON 变成安全形状。全部不需要数据库。
 */

function expectValidationError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('VALIDATION_FAILED')
    return error as AppError
  }
  throw new Error('expected VALIDATION_FAILED')
}

describe('emptyMcpFilter / countMcpFilter', () => {
  it('七个维度都是空数组，计数为 0', () => {
    const filter = emptyMcpFilter()
    expect(Object.keys(filter)).toEqual([
      'expressions',
      'emotions',
      'tones',
      'purposes',
      'scenes',
      'tags',
      'ratings',
    ])
    expect(countMcpFilter(filter)).toBe(0)
  })
})

describe('parseMcpFilterPayload', () => {
  it('合法的七维输入：缺省维度补空数组、重复值去重', () => {
    const filter = parseMcpFilterPayload({
      excluded: {
        emotions: ['开心', '开心', '得意'],
        tags: ['猫'],
      },
    })
    expect(filter.emotions).toEqual(['开心', '得意'])
    expect(filter.tags).toEqual(['猫'])
    expect(filter.ratings).toEqual([])
    expect(countMcpFilter(filter)).toBe(3)
  })

  it('未知维度 / 词表外的值 / 非数组 / 错误顶层形状都是 VALIDATION_FAILED', () => {
    expectValidationError(() => parseMcpFilterPayload({ excluded: { moods: ['开心'] } }))
    expectValidationError(() => parseMcpFilterPayload({ excluded: { emotions: ['不存在的情绪'] } }))
    expectValidationError(() => parseMcpFilterPayload({ excluded: { emotions: '开心' } }))
    expectValidationError(() => parseMcpFilterPayload({ excluded: null }))
    expectValidationError(() => parseMcpFilterPayload({ excluded: {}, extra: 1 }))
    expectValidationError(() => parseMcpFilterPayload(null))
  })

  it('ratings 非空 → VALIDATION_FAILED（成人向由内容范围单独控制）', () => {
    const error = expectValidationError(() =>
      parseMcpFilterPayload({ excluded: { ratings: ['成人向'] } }),
    )
    expect(error.message).toContain('成人向')
  })
})

describe('normalizeMcpFilter', () => {
  it('脏 JSON 归一化成固定形状：未知维度丢掉、ratings 强制清空、非字符串丢掉', () => {
    const filter = normalizeMcpFilter({
      emotions: ['开心', 3, null, '开心'],
      ratings: ['成人向'],
      moods: ['开心'],
      tags: '猫',
    })
    expect(filter.emotions).toEqual(['开心'])
    expect(filter.ratings).toEqual([])
    expect(filter.tags).toEqual([])
    expect(filter).not.toHaveProperty('moods')
  })

  it('非对象 / null → 空过滤器', () => {
    expect(normalizeMcpFilter(null)).toEqual(emptyMcpFilter())
    expect(normalizeMcpFilter('x')).toEqual(emptyMcpFilter())
    expect(normalizeMcpFilter([])).toEqual(emptyMcpFilter())
  })
})

describe('isExcludedByFilter', () => {
  it('任一维度、任一值命中即排除', () => {
    const filter = parseMcpFilterPayload({ excluded: { emotions: ['开心'], tags: ['猫', '狗'] } })
    expect(isExcludedByFilter({ emotions: ['开心', '得意'] }, filter)).toBe(true)
    expect(isExcludedByFilter({ tags: ['狗'] }, filter)).toBe(true)
    expect(isExcludedByFilter({ emotions: ['委屈'], tags: ['兔子'] }, filter)).toBe(false)
    expect(isExcludedByFilter({ emotions: null, tags: null }, filter)).toBe(false)
  })

  it('空过滤器永远不排除', () => {
    expect(isExcludedByFilter({ emotions: ['开心'] }, emptyMcpFilter())).toBe(false)
  })
})

describe('mcpFilterCacheKey', () => {
  it('稳定：同一内容不同键序不影响；内容不同则不同', () => {
    const a = parseMcpFilterPayload({ excluded: { emotions: ['开心'], tags: ['猫'] } })
    const b = parseMcpFilterPayload({ excluded: { tags: ['猫'], emotions: ['开心'] } })
    expect(mcpFilterCacheKey(a)).toBe(mcpFilterCacheKey(b))
    expect(mcpFilterCacheKey(a)).not.toBe(mcpFilterCacheKey(emptyMcpFilter()))
  })
})
