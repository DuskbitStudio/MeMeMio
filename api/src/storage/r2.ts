import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../env.js'
import { log } from '../logger.js'

/**
 * 对象存储。**生产走 Cloudflare R2，本地可以用任意 S3 兼容实现**（RustFS / MinIO）。
 *
 * ⚠️ **这一层的操作不能进数据库事务**（agents/rules/database.md §5）。R2 不在数据库里，
 * 事务回滚不会把对象变回来。正确顺序是「先写 R2，再写库」——失败时留下的是孤儿对象，
 * 定时清理能收；反过来留下的是「库里有记录但文件不存在」，用户能直接看见。
 *
 * 键的布局见 image-pipeline.md §6，三段前缀语义不同：
 *   temp/    预签名直传的落点，待确认与失败的文件在这
 *   memes/   正式对象
 *   thumbs/  缩略图，丢了能重生成，所以清理任务只碰这里和 temp/
 */

/** 预签名 PUT 的有效期。太短会让大图传到一半失效，太长等于给了个长期上传口子。 */
const UPLOAD_URL_TTL_SECONDS = 15 * 60

/** 启动探活的超时。网络不通时进程要起不来，但不能吊死在启动上。 */
const STARTUP_PROBE_TIMEOUT_MS = 8_000

/**
 * S3 endpoint。
 *
 * `R2_ENDPOINT` 没设时拼 Cloudflare 的正式地址——这是生产路径。覆盖口用于本地开发：
 * 没有 Cloudflare 账户时用 RustFS / MinIO 这类 S3 兼容实现顶上，配合
 * `R2_FORCE_PATH_STYLE=true`（非 AWS 实现通常必须 path-style 寻址）。
 *
 * 拼错地址在运行期**完全不报错**——预签名是纯本地 HMAC，凭证假的照样签得出格式
 * 完美的 URL，所以 `assertR2Reachable` 那道探活是必须的。
 */
const R2_ENDPOINT = env.r2.endpoint ?? `https://${env.r2.accountId}.r2.cloudflarestorage.com`

const clientConfig = {
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: env.r2.forcePathStyle,
  /*
   * ⚠️ 关掉 SDK 的自动校验和（AWS SDK v3 新版默认 `WHEN_SUPPORTED`）。
   *
   * 它会给**预签名 PUT** 也塞一个 `x-amz-checksum-crc32`（空 body 的校验值）进 URL。
   * 浏览器 `fetch(uploadUrl, { method: 'PUT', body: file })` 不会带上与真实字节匹配的
   * 校验头，S3 兼容实现按 URL 里的值校验时就是 BadDigest——上传必失败，而且错误发生在
   * 浏览器与对象存储之间，api 日志里什么都看不到。
   *
   * 预签名直传的正确分工是：SDK 只签名，校验和由客户端自己决定带不带。所以这里
   * 明确要 `WHEN_REQUIRED`（只有确实需要的操作才算），不是性能取舍。
   */
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
  credentials: {
    accessKeyId: env.r2.accessKeyId,
    secretAccessKey: env.r2.secretAccessKey,
  },
}

const client = new S3Client(clientConfig)

/**
 * 签上传 URL 用的 client。
 *
 * 上传是**浏览器直传**（web/src/lib/api-imports.ts 的 uploadToR2 拿 URL 直接 PUT），
 * 所以 URL 里的 host 必须是**浏览器能解析的地址**，不是 api 自己能连的地址。
 * 容器里这两者不同：api 走 Docker 服务名（`s3:9000`），浏览器在宿主机上解析不了。
 * 所以本地 S3 部署用 `R2_PUBLIC_ENDPOINT` 单独指定；正式 R2 两者本来就相同。
 */
const presignClient = env.r2PublicEndpoint === null
  ? client
  : new S3Client({ ...clientConfig, endpoint: env.r2PublicEndpoint })

/**
 * 拼一个完整的对象键。**前缀必须带**（`R2_KEY_PREFIX` 以 / 结尾，env 校验保证），
 * 否则与同机其他项目共用 bucket 时对象会互相覆盖。
 *
 * ⚠️ **这是本项目唯一的前缀入口**，读、写、派生公开 URL 全走它。库里的 `storageKey`
 * 和各处的 `tempKey` 都是**不带前缀的相对键**，任何把它们当成 R2 上真实键的地方
 * 都必须先过这里。少一次的表现不是报错，是图片 404——而且 `R2_KEY_PREFIX` 为空时
 * 完全不可见（见 `publicUrlFor` 的注释）。
 */
function key(path: string): string {
  return `${env.r2.keyPrefix}${path}`
}

export function tempKeyFor(batchId: string, fileName: string): string {
  return `temp/${batchId}/${fileName}`
}

/**
 * 正式对象的键。
 *
 * 用随机 uuid 而不是文件名：文件名是用户给的字符串，可能重复、可能是 `../`、
 * 可能带任何字符。用它做键既会互相覆盖，又是个路径穿越面。可读性由
 * `memes.original_filename` 提供，不靠键。
 */
export function permanentKeyFor(memeId: string, format: string): string {
  return `memes/${memeId}.${format}`
}

/**
 * 缩略图键。**必须和正式对象放在不同前缀**——清理任务只碰缩略图和 temp/，
 * 同前缀下「重建缩略图」和「删原图」就是同一次操作。
 *
 * 派生规则：保持 `memes/` 下的相对路径，只换前缀并把扩展名换成 `webp`
 * （`toThumbnail` 固定输出 WebP，见 image/decode.ts）。
 *
 * ⚠️ **写在这里、由 `serialize/meme.ts` 调用**，不各写一份。之前两边各推一套：
 * 这边写 `thumbs/<file>.jpg`，那边给 `/thumb/memes/<file>.jpg`，路径和扩展名都不一致，
 * 结果是入库成功、缩略图 404，而且**不报错**——正是那种要等用户来发现的问题。
 */
export function thumbKeyFor(storageKey: string): string {
  const rest = storageKey.startsWith('memes/') ? storageKey.slice('memes/'.length) : storageKey
  const dot = rest.lastIndexOf('.')
  const stem = dot > 0 ? rest.slice(0, dot) : rest
  return `thumbs/${stem}.webp`
}

/**
 * 签发预签名直传 URL。文件字节不经过 api，只给一个指定键的上传权。
 *
 * ⚠️ **`ContentLength` 必须绑进签名**：不绑的话这个 URL 就是一个「内容多大多小都收」
 *    的上传权，声明 1KB 实际传 500MB 照样能传完，而 api 只能在整份读进内存之后才发现
 *    （`MAX_FILE_BYTES` 挡的是读，不是写）。绑上之后 R2 拿实际 `Content-Length` 和签名
 *    里的值比，不符直接 403 —— 检查发生在字节进入 bucket 之前。
 *
 * 调用方传的是**用户声明的大小**（前端就是 `file.size`），所以只有声明值本身不合法
 * （非整数、为负、超上限）时才会误伤；那三种在 `parseSizeBytes` 里已经被拒掉了。
 * 代价是**声明值和实际不符的上传会在 R2 那里 403**，而不是留着以后被静默接受。
 */
export async function presignUpload(params: {
  batchId: string
  fileName: string
  sizeBytes: bigint
}): Promise<{ uploadUrl: string; tempKey: string }> {
  const tempKey = tempKeyFor(params.batchId, params.fileName)
  const uploadUrl = await getSignedUrl(
    // 用浏览器可达的那个 client 签：URL 里的 host 必须是用户浏览器能解析的地址
    presignClient,
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key(tempKey),
      ContentLength: Number(params.sizeBytes),
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  )
  return { uploadUrl, tempKey }
}

/**
 * 读对象，整份取回。图片管线要在本地解码，没法流式。
 *
 * ⚠️ **调用方必须先 `headObject` 核大小**（导入那两条读路径走 `services/import.ts` 的
 *    `readTempObject`）。直接调这里的表现是：一个声明 1KB、实际 2GB 的对象被整份读进
 *    内存，然后才在比较 `MAX_FILE_BYTES` 时被拒——那时内存已经吃完了。
 */
export async function getObject(objectKey: string): Promise<Buffer> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }),
  )
  if (result.Body === undefined) {
    throw new Error(`R2 对象 ${objectKey} 没有响应体`)
  }
  const bytes = await result.Body.transformToByteArray()
  return Buffer.from(bytes)
}

/**
 * 对象是否存在及大小。预签名直传后**必须实际核一下**：用户可能根本没上传成功
 * （网络断了、关掉页面了），也可能声明 1MB 实际传了 50MB。前端给的 sizeBytes 不可信。
 *
 * 唯一的调用方是 `services/import.ts` 的 `readTempObject`：导入管线和「仍然导入」
 * 两条路都在**读字节之前**用它挡掉超限的对象，顺带确认对象真的传上来了。
 */
export async function headObject(objectKey: string): Promise<{ sizeBytes: bigint } | null> {
  try {
    const result = await client.send(
      new HeadObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }),
    )
    return { sizeBytes: BigInt(result.ContentLength ?? 0) }
  } catch {
    return null
  }
}

export async function putObject(
  objectKey: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key(objectKey),
      Body: body,
      ContentType: contentType,
    }),
  )
}

/**
 * 删除对象。**不抛错**——删除是收尾动作，删不掉只该留日志。
 *
 * 报错出去会让「精确重复」这条路径因为清理失败而变成导入失败，而用户的图本来就已经
 * 重复了，这时的正确行为是照常跳过。
 */
export async function deleteObject(objectKey: string): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key(objectKey) }))
  } catch (error) {
    log.warn({ err: error, objectKey }, 'R2 删除失败，留给定时清理')
  }
}

/**
 * 公开访问地址。图片由 CDN 直出，api 不做图片代理。SPEC §5.2.6
 *
 * **必须经 `key()`**：入参是不带前缀的相对键，R2 上的对象带前缀，少了它给出的地址
 * 指向一个不存在的对象。2026-09-18 首次接真实 R2 时整页裂图就是这条——
 * 对象在 `mememio/thumbs/x.webp`，响应里给的是 `/thumbs/x.webp`。
 *
 * ⚠️ 这个 bug 在 `R2_KEY_PREFIX` 为空时**完全不可见**，所以钉它的测试必须用非空前缀
 * （见 r2.test.ts）。也**不要**改成把前缀塞进 `R2_PUBLIC_BASE_URL`：那样前缀在两个
 * 环境变量里各写一份，两边不一致时同样不报错。
 */
export function publicUrlFor(objectKey: string): string {
  return `${env.r2PublicBaseUrl}/${key(objectKey)}`
}

/**
 * 启动时对 bucket 做一次轻量探活，不通就拒绝启动（agents/rules/env-validation.md §3）。
 *
 * 2026-09-18 第一次接真实 R2，配错了**全程没有任何一处报错**：`env` 只校验变量填没填，
 * 预签名是纯本地 HMAC——凭证是假的照样签出格式完美的 URL，`POST /imports` 返回 200，
 * 错误最终只以浏览器的 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` 现身，离根因隔了整条链路。
 * 那一天昂贵的不是少拼一段前缀，是这个。态度同 `lib/env.ts` 对 `CONFIG_ENC_KEY` 的：
 * **宁可现在起不来**，错误现场就是根因。
 *
 * 用 `ListObjectsV2` 而不是 `HeadBucket`：Head 响应没有 body，鉴权失败时拿不到
 * 错误码，只能看到一个光秃秃的 403，而「凭证错」和「令牌没授权到这个 bucket」
 * 是两种要分开查的事。`MaxKeys: 1` 让它和桶里有多少对象无关。
 *
 * ⚠️ 错误信息只带 endpoint / bucket / 前缀，**绝不带凭证**（硬边界，SPEC §5.3）。
 *    S3 的鉴权错误体会把 AccessKeyId 回显出来，所以这里只取 `error.name`，
 *    不取 `message`、不取原始错误体。
 */
export async function assertR2Reachable(): Promise<void> {
  // 单测把 SDK 的 send 换成了内存替身（tests/helpers/r2-memory.ts），探活在那里既没有
  // 意义又会让整套测试变成要联网
  if (env.nodeEnv === 'test') return

  try {
    await client.send(
      new ListObjectsV2Command({
        Bucket: env.r2.bucket,
        Prefix: env.r2.keyPrefix,
        MaxKeys: 1,
      }),
      // 没有超时的话，DNS 或 TLS 层卡住时进程会停在启动上不动，
      // 那比起不来更难看出发生了什么
      { abortSignal: AbortSignal.timeout(STARTUP_PROBE_TIMEOUT_MS) },
    )
  } catch (error) {
    // 超时会以 AbortError 现身，直译出去会让人以为是谁主动取消了
    const name = error instanceof Error ? error.name : 'UnknownError'
    const reason = name === 'AbortError' ? `超时 ${STARTUP_PROBE_TIMEOUT_MS}ms` : name
    throw new Error(
      `R2 探活失败（${reason}）：endpoint=${R2_ENDPOINT} bucket=${env.r2.bucket} `
        + `keyPrefix=${env.r2.keyPrefix}\n`
        + '常见原因：R2_ACCOUNT_ID 粘成了整条 endpoint URL、令牌不是 R2 的 S3 凭证、'
        + 'bucket 名拼错、令牌没授权到这个 bucket。\n'
        + '完整步骤见 docs/deployment.md §8。',
    )
  }

  log.info(
    { endpoint: R2_ENDPOINT, bucket: env.r2.bucket, keyPrefix: env.r2.keyPrefix },
    'R2 已连通',
  )
}
