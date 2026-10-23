import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { log } from '../../logger.js'
import { actorOf } from '../auth.js'
import {
  compactItems,
  resolveAdultAccess,
  toMemeSummary,
  toolError,
  toolText,
  type MemeSummary,
  type MemeSummarySource,
} from '../format.js'
import { loadInlineImage } from '../image.js'
import { detailShape, filterShape, toMemeFilter } from '../filter.js'
import { buildFallbackQuery } from '../query.js'
import { randomToolRows, runToolSearch, type SearchToolDeps } from '../search.js'
import { TOOL_NAMES } from '../tool-names.js'

/**
 * `pick_meme_for_reply` —— 一次调用直接给出「回复用哪张」（SPEC §10.4.2）。
 *
 * 给 IM 机器人与聊天客户端用。**不返回 `chosen: null` 让调用方空手而归**（§9.36）：
 * 原句 → 词表关键词 → 安全随机，三级兜底；随机兜底会在 text 里注明。
 *
 * `inline=false` 给 IM 机器人：它们只要 URL，不需要 32 KB 的缩略图 base64。
 */

const inputSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, 'message 不能为空')
    .max(200, 'message 最多 200 字'),
  limit: z
    .number()
    .int()
    .min(1, 'limit 至少 1')
    .max(20, 'limit 最多 20')
    .default(8),
  /** `true`（默认）内联 chosen 缩略图；IM 机器人传 false 省字节。 */
  inline: z.boolean().default(true),
  ...filterShape,
  ...detailShape,
})

/** SPEC §10.4.2：备选最多 5 条。 */
const MAX_ALTERNATIVES = 5

export function registerPickMemeForReply(server: McpServer, deps: SearchToolDeps): void {
  server.registerTool(
    TOOL_NAMES.pickMemeForReply,
    {
      description:
        '给对方那句话挑一张最合适的表情包：返回 chosen（最贴合的一张）、最多 5 条 alternatives 与元数据，'
        + '默认内联 chosen 的缩略图。**message 建议传 10–20 字的意图摘要**（如「被夸了有点得意」），'
        + '不要直接塞一整段对话；工具内部有词表关键词兜底。没有精确命中时会从安全范围随机挑一张。'
        + 'IM 机器人传 inline=false 只拿 URL；默认不返回成人向（allowAdult 默认 false）。',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const actor = actorOf(ctx.http?.authInfo)
      if (actor === null) return toolError('未识别的调用身份，请重新创建访问令牌。')

      const adult = resolveAdultAccess(actor, args.allowAdult)
      if (!adult.ok) return toolError(adult.message)

      try {
        const searchParams = {
          deps,
          actorId: actor.userId,
          filter: toMemeFilter(args),
          limit: args.limit,
          allowAdult: adult.allow,
          excluded: actor.excluded,
        }

        let result = await runToolSearch({ ...searchParams, query: args.message })
        let fallbackNote: string | null = null

        if (result.items.length === 0) {
          const fallback = buildFallbackQuery(args.message)
          if (fallback !== null) {
            result = await runToolSearch({ ...searchParams, query: fallback })
          }
        }

        // 只用于读缩略图，不参与响应：SearchHit 与 MemeView 都满足 MemeSummarySource
        let chosenRow: MemeSummarySource | undefined = result.rows[0]
        let chosen: MemeSummary | null = result.items[0] ?? null
        let alternatives: MemeSummary[] = result.items.slice(1, 1 + MAX_ALTERNATIVES)

        // 第三级兜底：库里不是空的，就不该空手而归；随机也在同一套成人向过滤下取
        if (chosen === null) {
          const randomRows = await randomToolRows({
            db: deps.db,
            actorId: actor.userId,
            limit: 1,
            isAnimated: args.isAnimated,
            allowAdult: adult.allow,
            excluded: actor.excluded,
          })
          chosenRow = randomRows[0]
          chosen = chosenRow === undefined ? null : toMemeSummary(chosenRow)
          alternatives = []
          fallbackNote = '没有找到精确匹配，已从安全范围随机挑一张。'
        }

        const fullPayload: Record<string, unknown> = {
          message: args.message,
          rewritten: result.rewritten,
          degraded: result.degraded,
          chosen,
          alternatives,
        }

        const textPayload: Record<string, unknown> = args.detail === 'full'
          ? fullPayload
          : {
              ...fullPayload,
              chosen: chosen === null ? null : compactItems([chosen])[0],
              alternatives: compactItems(alternatives),
            }

        let text = toolText(textPayload)
        if (fallbackNote !== null) text = `${text}\n${fallbackNote}`

        // 缩略图内联是可选增强：读不到或超限只给链接，不把整个调用变成错误
        const inline = chosenRow === undefined || !args.inline
          ? { image: null, note: null }
          : await loadInlineImage(chosenRow, 'thumb')

        if (inline.note !== null) text = `${text}\n${inline.note}`

        const content: ({ type: 'text'; text: string } | NonNullable<typeof inline.image>)[] = [
          { type: 'text', text },
        ]
        if (inline.image !== null) content.push(inline.image)

        return { content, structuredContent: fullPayload }
      } catch (error) {
        log.error({ requestId: deps.requestId, err: error }, 'mcp pick_meme_for_reply 失败')
        return toolError('挑选表情失败，请稍后重试。')
      }
    },
  )
}
