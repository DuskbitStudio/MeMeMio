import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { log } from '../../logger.js'
import { getMemeById } from '../../data/memes.js'
import type { Db } from '../../data/db.js'
import { actorOf } from '../auth.js'
import {
  compactItems,
  isAdultRatings,
  resolveAdultAccess,
  toMemeSummary,
  toolError,
  toolText,
} from '../format.js'
import { detailShape } from '../filter.js'
import { isExcludedByFilter } from '../../lib/mcp-filter.js'
import { loadInlineImage } from '../image.js'
import { TOOL_NAMES } from '../tool-names.js'

/**
 * `get_meme_image` —— 按 id 取一张图的元数据，可选内联字节（SPEC §10.4.3）。
 *
 * **`inline: false` 是给 IM 机器人的**：它们只要 URL；`inline: true` 是给聊天客户端的：
 * 只有 `image` content 能直接显示。超过内联上限是**说明不是错误**（§10.4.7）。
 *
 * 成人向图默认拒绝（§10.3.1）；用户排除过滤器对按 id 取也生效（§10.3.2）——
 * 调用方已经知道 id 也不能绕过账号设置。
 */

const inputSchema = z.object({
  memeId: z.uuid('memeId 必须是 uuid'),
  variant: z.enum(['thumb', 'original']).default('thumb'),
  inline: z.boolean().default(true),
  allowAdult: z.boolean().optional(),
  ...detailShape,
})

type GetMemeImageDeps = {
  db: Db
  requestId: string
}

export function registerGetMemeImage(server: McpServer, deps: GetMemeImageDeps): void {
  server.registerTool(
    TOOL_NAMES.getMemeImage,
    {
      description:
        '按 memeId 取一张图的元数据；inline=true（默认）时在不超过内联上限的情况下追加图片字节。'
        + 'variant 选 thumb（默认，400px WebP）或 original（仅静图且 ≤2 MiB 时内联）。'
        + '已删除或不存在的 id 返回工具错误；成人向图在默认设置下不返回（需账号开启并显式 allowAdult=true）。',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const actor = actorOf(ctx.http?.authInfo)
      if (actor === null) return toolError('未识别的调用身份，请重新创建访问令牌。')

      const adult = resolveAdultAccess(actor, args.allowAdult)
      if (!adult.ok) return toolError(adult.message)

      try {
        // 软删过滤在数据层（`getMemeById` 永远不返回已删的），查不到就是工具错误
        const row = await getMemeById(args.memeId, actor.userId, deps.db)
        if (row === null) return toolError('这张表情不存在。')

        // 成人向闸门在「拿到行之后」判：id 猜不到，但设置可以挡住
        if (isAdultRatings(row.ratings) && !adult.allow) {
          return toolError('这张表情被标记为成人向，当前 MCP 设置不允许返回。')
        }

        // 用户排除过滤器对按 id 取也生效（§10.3.2）
        if (isExcludedByFilter(row, actor.excluded)) {
          return toolError('这张表情被 MCP 过滤器排除。')
        }

        const summary = toMemeSummary(row)
        const fullPayload: Record<string, unknown> = { ...summary }
        const textPayload: Record<string, unknown> = args.detail === 'full'
          ? fullPayload
          : { ...compactItems([summary])[0] }

        if (!args.inline) {
          return { content: [{ type: 'text', text: toolText(textPayload) }], structuredContent: fullPayload }
        }

        const inline = await loadInlineImage(row, args.variant)
        const text = inline.note === null ? toolText(textPayload) : `${toolText(textPayload)}\n${inline.note}`

        const content: ({ type: 'text'; text: string } | NonNullable<typeof inline.image>)[] = [
          { type: 'text', text },
        ]
        if (inline.image !== null) content.push(inline.image)

        return { content, structuredContent: fullPayload }
      } catch (error) {
        log.error({ requestId: deps.requestId, err: error }, 'mcp get_meme_image 失败')
        return toolError('读取图片失败，请稍后重试。')
      }
    },
  )
}
