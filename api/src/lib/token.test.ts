import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, isTokenShaped, prefixOf, TOKEN_PREFIX } from './token.js'

/**
 * 令牌形状的单元测试（SPEC §10.3、§5.8）。
 *
 * 这些断言不是形式主义：格式或哈希口径一变，**已签发的令牌全部失效**，
 * 而现场表现只是「所有 MCP 客户端突然 401」——没有栈、没有错误码。
 */

describe('generateToken', () => {
  it('mcp_ 前缀 + 43 个 base64url 字符（32 字节），总长 47', () => {
    const token = generateToken()
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(token).toHaveLength(47)
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('每次都不一样（32 字节熵，重复等于随机源坏了）', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()))
    expect(tokens.size).toBe(200)
  })

  it('不带 base64 填充字符 / 标准 base64 的 + 与 /', () => {
    // 这两个字符在 URL 与 Authorization 头里虽然合法，但 base64url 口径要统一；
    // 混用的表现是「同一个令牌在两处编码下哈希不同」，排查时极难看出
    for (let i = 0; i < 50; i += 1) {
      const token = generateToken()
      expect(token).not.toContain('=')
      expect(token).not.toContain('+')
      expect(token).not.toContain('/')
    }
  })

  it('生成的令牌自己认得出（形状判定与生成口径同源）', () => {
    expect(isTokenShaped(generateToken())).toBe(true)
  })
})

describe('hashToken', () => {
  it('是 sha256 十六进制，64 字符小写', () => {
    const hash = hashToken(generateToken())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('确定性：同一令牌永远同一个哈希（校验靠它）', () => {
    const token = generateToken()
    expect(hashToken(token)).toBe(hashToken(token))
  })

  it('与 node:crypto 直接算出来的一致（换实现必须同步改库里的口径）', () => {
    const token = generateToken()
    expect(hashToken(token)).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('不同令牌哈希不同', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()))
  })
})

describe('prefixOf', () => {
  it('前 12 个字符，含 mcp_', () => {
    const token = generateToken()
    const prefix = prefixOf(token)
    expect(prefix).toBe(token.slice(0, 12))
    expect(prefix.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(prefix).toHaveLength(12)
  })

  it('只是令牌的一小段 —— 不能拿来重放', () => {
    const token = generateToken()
    expect(prefixOf(token)).not.toBe(token)
    // 12 / 47 个字符的熵约 66 位，不足以猜测完整令牌（完整令牌 256 位）
    expect(token.length - prefixOf(token).length).toBeGreaterThan(30)
  })
})

describe('isTokenShaped', () => {
  it('生成的令牌是合法形状', () => {
    expect(isTokenShaped(generateToken())).toBe(true)
  })

  it('拒绝缺前缀 / 错前缀 / 长度不对 / 非法字符', () => {
    const token = generateToken()
    const body = token.slice(TOKEN_PREFIX.length)

    expect(isTokenShaped(body)).toBe(false)
    expect(isTokenShaped(`pat_${body}`)).toBe(false)
    expect(isTokenShaped(token.slice(0, -1))).toBe(false)
    expect(isTokenShaped(`${token}x`)).toBe(false)
    // base64url 之外：空格、标准 base64 的 + /、中文
    expect(isTokenShaped(`mcp_${body.slice(0, 42)}+`)).toBe(false)
    expect(isTokenShaped(`mcp_${body.slice(0, 42)}/`)).toBe(false)
    expect(isTokenShaped('mcp_')).toBe(false)
    expect(isTokenShaped('')).toBe(false)
    expect(isTokenShaped('  ')).toBe(false)
  })

  it('拒绝带路径分隔符的拼接串（形状判定必须是整串匹配）', () => {
    const token = generateToken()
    expect(isTokenShaped(`${token}/../x`)).toBe(false)
    expect(isTokenShaped(`${token} ${token}`)).toBe(false)
    expect(isTokenShaped(` ${token}`)).toBe(false)
  })
})
