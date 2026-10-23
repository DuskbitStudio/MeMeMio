/**
 * 环境变量校验。
 *
 * 纯函数、零 import —— 它是 lib/ 的成员，判断标准是「不起 Postgres、不联网就能测」。
 * 退出进程和打日志由调用方（src/env.ts）做，这里只负责把一堆 string | undefined
 * 变成一个要么完整要么带着完整错误清单的结果。
 *
 * 变量清单见 docs/environments.md §1，实现约束见 agents/rules/env-validation.md。
 */

export type NodeEnv = 'development' | 'production' | 'test'

export type R2Config = {
  /** 正式 R2 时必填；`R2_ENDPOINT` 覆盖时可以为空（本地 S3 兼容实现不认 account id）。 */
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  keyPrefix: string
  /**
   * S3 endpoint 覆盖口。为 `null` 时拼 Cloudflare 正式地址（生产主路径）；
   * 设了就走任意 S3 兼容实现（本地 RustFS / MinIO）。见 docs/environments.md。
   */
  endpoint: string | null
  /**
   * 非 AWS 实现通常必须 path-style 寻址（`host/bucket/key`），否则签名 URL 会指向
   * `bucket.host` 这种解析不了的虚拟主机名。
   */
  forcePathStyle: boolean
}

export type ProviderDefaults = {
  baseUrl: string
  apiKey: string
  model: string
}

export type Env = {
  appSlug: string
  nodeEnv: NodeEnv
  port: number
  databaseUrl: string
  sessionSecret: string
  /** 加密用户 API Key 的主密钥。绝不进日志、绝不进任何响应。 */
  configEncKey: string
  r2: R2Config
  /** R2 公开访问根地址，不含末尾 /。由 storageKey 派生 url / thumbUrl 时使用。SPEC §5.2.6 */
  r2PublicBaseUrl: string
  /**
   * 预签名给**浏览器**用的 endpoint。为 `null` 时与 `r2.endpoint` 相同。
   *
   * 容器部署里这两者会不同：api 走 Docker 网络名（`s3:9000`），浏览器在宿主机上解析不了；
   * 所以本地 S3 部署要把它设成宿主可达地址（如 `http://127.0.0.1:19000`）。
   */
  r2PublicEndpoint: string | null
  /** 部署方默认视觉配置。可以为 null —— 那时导入照常，图片入库为 tagStatus = pending。 */
  defaultVision: ProviderDefaults | null
  /** 部署方默认 embedding 配置。可以为 null —— 那时搜索降级为两路，degraded: true。 */
  defaultEmbed: ProviderDefaults | null
  /**
   * 部署方默认图片向量配置。可以为 null —— 那时**一切照旧**：导入、打标、搜索
   * 与今天逐字一致，人物接口返回空列表（SPEC §5.7.2 / 任务 §5.1 第 1 条）。
   *
   * ⚠️ 它比另外两组多一层风险：这个通道**每张图都是一次付费调用**（§6.7.5），
   *    而它对图上没有测试连接记录——`image_input_works` 是 null。上游把图静默丢掉
   *    时，表现是所有人物慢慢并成一团，**不报错**。所以部署方默认值只该在
   *    「自己就是那个上游、且已经手工验过」时配置，生产环境走管理员的
   *    `PUT /config/image-embed`（它强制先测后存）。
   */
  defaultImageEmbed: ProviderDefaults | null
}

export type ParseEnvResult =
  | { ok: true; env: Env }
  | { ok: false; errors: string[] }

const CONFIG_ENC_KEY_BYTES = 32

export function parseEnv(source: Record<string, string | undefined>): ParseEnvResult {
  const errors: string[] = []

  const required = (name: string): string => {
    const raw = source[name]
    if (raw === undefined || raw.trim() === '') {
      errors.push(`${name} 未设置`)
      return ''
    }
    return raw.trim()
  }

  const appSlug = required('APP_SLUG')

  const nodeEnvRaw = source['NODE_ENV']?.trim() || 'development'
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test') {
    errors.push(`NODE_ENV 只能是 development / production / test，当前是 "${nodeEnvRaw}"`)
  }
  const nodeEnv = nodeEnvRaw as NodeEnv

  const portRaw = source['PORT']?.trim() || '3000'
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT 不是合法端口号："${portRaw}"`)
  }

  const databaseUrl = required('DATABASE_URL')
  if (databaseUrl !== '' && !isParsablePostgresUrl(databaseUrl)) {
    errors.push('DATABASE_URL 不是合法的 postgres 连接串（应形如 postgres://user:pass@host:5432/db）')
  }

  const sessionSecret = required('SESSION_SECRET')

  // 长度不对时 AES-GCM 要等到用户第一次在设置页点保存才报错，
  // 那时他看到的是一个莫名其妙的 500。宁可现在起不来。
  const configEncKey = required('CONFIG_ENC_KEY')
  if (configEncKey !== '') {
    const bytes = new TextEncoder().encode(configEncKey).length
    if (bytes !== CONFIG_ENC_KEY_BYTES) {
      errors.push(
        `CONFIG_ENC_KEY 必须正好 ${CONFIG_ENC_KEY_BYTES} 字节，当前 ${bytes} 字节`
          + `（生成：openssl rand -base64 24）`,
      )
    }
  }

  const r2KeyPrefix = required('R2_KEY_PREFIX')
  if (r2KeyPrefix !== '' && !r2KeyPrefix.endsWith('/')) {
    errors.push('R2_KEY_PREFIX 必须以 / 结尾，否则对象键会拼错')
  }

  // S3 endpoint 覆盖口：设了说明在对接 S3 兼容实现（本地 RustFS / MinIO），那套不认
  // account id；没设才是正式 R2，accountId 是拼 endpoint 的原料，必填。
  const r2EndpointOverride = source['R2_ENDPOINT']?.trim() || null
  if (r2EndpointOverride !== null && !/^https?:\/\//.test(r2EndpointOverride)) {
    errors.push('R2_ENDPOINT 必须带 http:// 或 https:// 前缀')
  }
  const r2AccountId = r2EndpointOverride === null ? required('R2_ACCOUNT_ID') : ''

  const r2: R2Config = {
    accountId: r2AccountId,
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET'),
    keyPrefix: r2KeyPrefix,
    endpoint: r2EndpointOverride,
    // 只有显式 true 才开；Cloudflare R2 走正式地址时不能开（会拼成 host/bucket/key）
    forcePathStyle: source['R2_FORCE_PATH_STYLE']?.trim() === 'true',
  }

  const r2PublicEndpoint = source['R2_PUBLIC_ENDPOINT']?.trim() || null
  if (r2PublicEndpoint !== null && !/^https?:\/\//.test(r2PublicEndpoint)) {
    errors.push('R2_PUBLIC_ENDPOINT 必须带 http:// 或 https:// 前缀')
  }

  const r2PublicBaseUrl = required('R2_PUBLIC_BASE_URL')
  if (r2PublicBaseUrl !== '' && r2PublicBaseUrl.endsWith('/')) {
    errors.push('R2_PUBLIC_BASE_URL 不能以 / 结尾，URL 会拼错（storageKey 本身不带前缀 /）')
  }

  const defaultVision = optionalProvider(source, 'DEFAULT_VISION', errors)
  const defaultEmbed = optionalProvider(source, 'DEFAULT_EMBED', errors)
  const defaultImageEmbed = optionalProvider(source, 'DEFAULT_IMAGE_EMBED', errors)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    env: {
      appSlug,
      nodeEnv,
      port,
      databaseUrl,
      sessionSecret,
      configEncKey,
      r2,
      r2PublicBaseUrl,
      r2PublicEndpoint,
      defaultVision,
      defaultEmbed,
      defaultImageEmbed,
    },
  }
}

/**
 * DEFAULT_VISION_* / DEFAULT_EMBED_* 可以整组为空 —— 那是产品要求的降级态，不是配置错误。
 * 但**填一半**是配置错误：只填 BASE_URL 不填 MODEL 的进程能起来，会在第一次打标时才炸。
 */
function optionalProvider(
  source: Record<string, string | undefined>,
  prefix: string,
  errors: string[],
): ProviderDefaults | null {
  const baseUrl = source[`${prefix}_BASE_URL`]?.trim() ?? ''
  const apiKey = source[`${prefix}_API_KEY`]?.trim() ?? ''
  const model = source[`${prefix}_MODEL`]?.trim() ?? ''

  const filled = [baseUrl, apiKey, model].filter((v) => v !== '')
  if (filled.length === 0) return null
  if (filled.length < 3) {
    errors.push(
      `${prefix}_* 填了一半：BASE_URL / API_KEY / MODEL 要么三个都填，要么三个都空`,
    )
    return null
  }
  return { baseUrl, apiKey, model }
}

function isParsablePostgresUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false
  if (url.hostname === '') return false
  if (url.pathname.replace(/^\//, '') === '') return false
  return true
}
