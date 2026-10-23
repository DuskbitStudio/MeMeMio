import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

/** 一份刚好能过的最小配置，各用例在它基础上删或改。 */
function validSource(): Record<string, string | undefined> {
  return {
    APP_SLUG: 'mememio',
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgres://mememio:pw@localhost:5432/mememio',
    SESSION_SECRET: 'session-secret-for-tests',
    CONFIG_ENC_KEY: 'x'.repeat(32),
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'akid',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET: 'bucket',
    R2_KEY_PREFIX: 'mememio/',
    R2_PUBLIC_BASE_URL: 'https://cdn.example.com',
  }
}

describe('parseEnv', () => {
  it('完整配置通过，且默认模型配置为 null 时不算错', () => {
    const result = parseEnv(validSource())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env.appSlug).toBe('mememio')
    expect(result.env.port).toBe(3000)
    // 部署方没配默认模型是合法的降级态，见 env-validation.md §4
    expect(result.env.defaultVision).toBeNull()
    expect(result.env.defaultEmbed).toBeNull()
  })

  // 骨架任务的验证点 2：缺 CONFIG_ENC_KEY 进程必须退出。
  // 退出动作在 src/env.ts，这里锁住「校验必须判它不通过，且说得出缺的是哪个」。
  it('缺 CONFIG_ENC_KEY 时失败，并指名道姓', () => {
    const source = validSource()
    delete source['CONFIG_ENC_KEY']
    const result = parseEnv(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join('\n')).toContain('CONFIG_ENC_KEY')
  })

  it('CONFIG_ENC_KEY 长度不是 32 字节时失败', () => {
    const short = parseEnv({ ...validSource(), CONFIG_ENC_KEY: 'x'.repeat(31) })
    expect(short.ok).toBe(false)

    // 32 个汉字是 96 字节，不是 32 —— 按字符数校验会放过它
    const wide = parseEnv({ ...validSource(), CONFIG_ENC_KEY: '密'.repeat(32) })
    expect(wide.ok).toBe(false)
    if (wide.ok) return
    expect(wide.errors.join('\n')).toContain('96 字节')
  })

  it('一次报出全部缺失项，不是报一个退一个', () => {
    const result = parseEnv({ APP_SLUG: 'mememio' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThan(3)
  })

  it('R2_KEY_PREFIX 不以 / 结尾时失败', () => {
    const result = parseEnv({ ...validSource(), R2_KEY_PREFIX: 'mememio' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join('\n')).toContain('R2_KEY_PREFIX')
  })

  it('R2_ENDPOINT 覆盖时可以不填 R2_ACCOUNT_ID，并解析 forcePathStyle', () => {
    const source = validSource()
    delete source['R2_ACCOUNT_ID']
    source['R2_ENDPOINT'] = 'http://mememio-s3:9000'
    source['R2_FORCE_PATH_STYLE'] = 'true'
    source['R2_PUBLIC_ENDPOINT'] = 'http://127.0.0.1:19000'
    const result = parseEnv(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env.r2.accountId).toBe('')
    expect(result.env.r2.endpoint).toBe('http://mememio-s3:9000')
    expect(result.env.r2.forcePathStyle).toBe(true)
    expect(result.env.r2PublicEndpoint).toBe('http://127.0.0.1:19000')
  })

  it('R2_ENDPOINT / R2_PUBLIC_ENDPOINT 不带协议头时失败', () => {
    const badEndpoint = parseEnv({ ...validSource(), R2_ENDPOINT: 'mememio-s3:9000' })
    expect(badEndpoint.ok).toBe(false)
    if (!badEndpoint.ok) expect(badEndpoint.errors.join('\n')).toContain('R2_ENDPOINT')

    const badPublic = parseEnv({ ...validSource(), R2_PUBLIC_ENDPOINT: '127.0.0.1:19000' })
    expect(badPublic.ok).toBe(false)
    if (!badPublic.ok) expect(badPublic.errors.join('\n')).toContain('R2_PUBLIC_ENDPOINT')
  })

  it('不设 R2_ENDPOINT 时 R2_ACCOUNT_ID 仍然必填（正式 R2 路径）', () => {
    const source = validSource()
    delete source['R2_ACCOUNT_ID']
    const result = parseEnv(source)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join('\n')).toContain('R2_ACCOUNT_ID')
  })

  it('DATABASE_URL 不是合法连接串时失败', () => {
    const result = parseEnv({ ...validSource(), DATABASE_URL: 'localhost:5432' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join('\n')).toContain('DATABASE_URL')
  })

  it('默认模型配置填一半算错', () => {
    const result = parseEnv({
      ...validSource(),
      DEFAULT_VISION_BASE_URL: 'https://example.invalid/v1',
      DEFAULT_VISION_MODEL: 'some-model',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join('\n')).toContain('DEFAULT_VISION')
  })

  it('默认模型配置三个都填时被采纳', () => {
    const result = parseEnv({
      ...validSource(),
      DEFAULT_EMBED_BASE_URL: 'https://example.invalid/v1',
      DEFAULT_EMBED_API_KEY: 'sk-xxxx',
      DEFAULT_EMBED_MODEL: 'some-embed',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.env.defaultEmbed?.model).toBe('some-embed')
  })
})
