import { describe, expect, it, vi } from 'vitest'

/**
 * 预签名 URL 的三条性质（本地 S3 部署踩过的坑，见 storage/r2.ts 顶部注释）：
 *
 * 1. **host 用 `R2_PUBLIC_ENDPOINT`**（浏览器可达），不是 api 容器里的 `R2_ENDPOINT`——
 *    容器名浏览器解析不了，表现是上传时 `ERR_NAME_NOT_RESOLVED`。
 * 2. **path-style**：`/bucket/key`，不是 `bucket.host/key`；非 AWS 实现通常只支持前者。
 * 3. **不带 SDK 自动附上的 `x-amz-checksum-*` 参数**：它是空 body 的校验值，浏览器 PUT
 *    真实字节时会对不上（BadDigest），而错误只出现在浏览器与对象存储之间。
 *
 * 环境变量必须在 import 之前 stub（`src/env.ts` 在 import 那一刻读 process.env），
 * 所以这里用动态 import，并且把全部必填项一次性给全——不依赖本机 `.env`。
 */
const REQUIRED_ENV: Record<string, string> = {
  APP_SLUG: 'presign-test',
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SESSION_SECRET: 'session-secret',
  CONFIG_ENC_KEY: 'x'.repeat(32),
  R2_ENDPOINT: 'http://mememio-s3:9000',
  R2_FORCE_PATH_STYLE: 'true',
  R2_PUBLIC_ENDPOINT: 'http://127.0.0.1:19000',
  R2_ACCESS_KEY_ID: 'akid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
  R2_KEY_PREFIX: 'prefix/',
  R2_PUBLIC_BASE_URL: 'http://127.0.0.1:19000/bucket',
}

for (const [name, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(name, value)

const { presignUpload } = await import('./r2.js')

describe('presignUpload（本地 S3）', () => {
  it('用 R2_PUBLIC_ENDPOINT 签出浏览器可达的 path-style URL', async () => {
    const { uploadUrl, tempKey } = await presignUpload({
      batchId: 'batch-1',
      fileName: 'cat.png',
      sizeBytes: 1234n,
    })

    expect(tempKey).toBe('temp/batch-1/cat.png')

    const url = new URL(uploadUrl)
    // 宿主可达地址，而不是容器服务名 mememio-s3:9000
    expect(url.origin).toBe('http://127.0.0.1:19000')
    // path-style：/bucket/prefix/相对键
    expect(url.pathname).toBe('/bucket/prefix/temp/batch-1/cat.png')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
  })

  it('不把 SDK 的空 body 校验和塞进 URL（否则浏览器 PUT 真实字节会 BadDigest）', async () => {
    const { uploadUrl } = await presignUpload({
      batchId: 'batch-2',
      fileName: 'dog.webp',
      sizeBytes: 10n,
    })
    expect(uploadUrl).not.toMatch(/x-amz-checksum/i)
  })
})
