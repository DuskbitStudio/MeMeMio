import type { ImageContent } from '@modelcontextprotocol/server'
import { getObject, headObject, thumbKeyFor } from '../storage/r2.js'
import { log } from '../logger.js'

/**
 * 图片字节的可选内联（SPEC §10.5）。
 *
 * **URL 优先，base64 只做缩略图。** IM 渠道要的是服务端能下载的公网地址（LINE 强制两个
 * HTTPS URL、钉钉只能 markdown 内联 URL ……），它们都不接受 MCP 响应里的 base64；
 * 而聊天客户端只有 `image` content 能直接显示。所以两样都给，字节那一份只在限额内给。
 *
 * ## 永远先 head 再 get
 *
 * 直接 `getObject` 会把一个「声明 1 KB、实际 2 GB」的对象整份读进内存——
 * 那正是 `storage/r2.ts` 的 `getObject` 注释警告的用法。头信息先核大小，
 * 超限就只回 URL。
 */

/** 缩略图内联上限（SPEC §10.5）。缩略图恒为 400px WebP。 */
export const THUMB_INLINE_MAX_BYTES = 512 * 1024

/** 原图内联上限（SPEC §10.5：仅 `variant: "original"` 且 ≤ 2 MiB）。 */
export const ORIGINAL_INLINE_MAX_BYTES = 2 * 1024 * 1024

/** 内联需要读取的字段。结构类型：`MemeView` / `MemeRow` / `SearchHit` 都能直接传。 */
export type MemeImageSource = {
  id: string
  storageKey: string
  mime: string
  isAnimated: boolean
}

export type InlineImageResult = {
  image: ImageContent | null
  /** 没内联时的说明（SPEC §10.4.7：超过上限是**说明**，不是错误）。 */
  note: string | null
}

/**
 * 按 variant 取图片字节。
 *
 * - `thumb`：永远读 `thumbKeyFor(storageKey)`，`mimeType` 固定 `image/webp`
 *   （`toThumbnail` 固定输出 WebP，见 `image/decode.ts`）；
 * - `original`：动图**不内联**（渠道基本不认这些字节，SPEC §10.5 的「不内联的动图一律走
 *   URL」），静图 ≤ 2 MiB 才内联，`mimeType` 用该行真实的 `mime`。
 *
 * 读失败只降级成「链接」并记日志：图片拿不到不该让整个工具报错，
 * 调用方拿到 URL 一样能发出去。
 */
export async function loadInlineImage(
  row: MemeImageSource,
  variant: 'thumb' | 'original',
): Promise<InlineImageResult> {
  if (variant === 'original' && row.isAnimated) {
    return { image: null, note: '这是动图，未内联字节，请使用图片链接。' }
  }

  const objectKey = variant === 'thumb' ? thumbKeyFor(row.storageKey) : row.storageKey
  const mimeType = variant === 'thumb' ? 'image/webp' : row.mime
  const maxBytes = variant === 'thumb' ? THUMB_INLINE_MAX_BYTES : ORIGINAL_INLINE_MAX_BYTES
  const tooLargeNote = variant === 'thumb' ? '缩略图过大，已改为链接。' : '图片过大，已改为链接。'

  // 先核大小再读字节：顺序反了就是一个内存放大器
  const head = await headObject(objectKey)
  if (head === null) {
    log.warn({ memeId: row.id, objectKey, variant }, 'mcp: 图片对象不存在或 head 失败，只回链接')
    return { image: null, note: '图片暂时无法读取，请使用图片链接。' }
  }
  if (head.sizeBytes > BigInt(maxBytes)) {
    return { image: null, note: tooLargeNote }
  }

  try {
    const bytes = await getObject(objectKey)
    return {
      image: { type: 'image', data: bytes.toString('base64'), mimeType },
      note: null,
    }
  } catch (error) {
    log.warn({ memeId: row.id, objectKey, variant, err: error }, 'mcp: 读取图片失败，只回链接')
    return { image: null, note: '图片暂时无法读取，请使用图片链接。' }
  }
}
