import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { log } from '../../logger.js'
import { actorOf } from '../auth.js'
import {
  compactItems,
  resolveAdultAccess,
  toolError,
  toolText,
  type MemeSummary,
} from '../format.js'
import { TOOL_NAMES } from '../tool-names.js'
import { detailShape, filterShape, toMemeFilter } from '../filter.js'
import { buildFallbackQuery } from '../query.js'
import { runToolSearch, type SearchToolDeps } from '../search.js'

/**
 * `search_memes` —— 按一句想表达的意思检索共享表情包库（SPEC §10.4.1）。
 *
 * 返回 `{ query, rewritten, degraded, items }`；text 默认 compact，`structuredContent`
 * 永远是完整 `MemeSummary`（§10.4.6）。
 *
 * **长句有兜底**（§9.36）：整句没结果时，从里面抽出词表里真实存在的词再查一次——
 * 真实群聊没人按标签说话，空手而归是最差的体验。
 */

const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'query 不能为空')
    .max(200, 'query 最多 200 字'),
  limit: z
    .number()
    .int()
    .min(1, 'limit 至少 1')
    .max(20, 'limit 最多 20')
    .default(8),
  ...filterShape,
  ...detailShape,
})

export function registerSearchMemes(server: McpServer, deps: SearchToolDeps): void {
  server.registerTool(
    TOOL_NAMES.searchMemes,
    {
      description:
        '按一句话想表达的意思检索共享表情包库，返回可直接交付的图片地址与元数据（按相关度排序，最多 20 条）。'
        + '七个筛选维度（expressions/emotions/tones/purposes/scenes/tags/ratings）可给多值，值之间取 AND；'
        + '词表外的值不报错，只返回空结果。需要知道各维度有哪些合法值时先调 list_vocab。'
        + '默认不返回成人向（allowAdult 默认 false）；账号设置未开启时传 true 会报错。'
        + 'text 默认 compact；需要完整字段时传 detail="full"（或直接读 structuredContent）。',
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

        let result = await runToolSearch({ ...searchParams, query: args.query })

        // 长句兜底：抽词表关键词再查一次（§9.36）。只在第一次完全为空时做，避免噪声
        if (result.items.length === 0) {
          const fallback = buildFallbackQuery(args.query)
          if (fallback !== null) {
            result = await runToolSearch({ ...searchParams, query: fallback })
          }
        }

        const fullPayload: Record<string, unknown> = {
          query: result.query,
          rewritten: result.rewritten,
          degraded: result.degraded,
          items: result.items,
        }

        const textPayload: Record<string, unknown> = args.detail === 'full'
          ? fullPayload
          : { ...fullPayload, items: compactItems(result.items) }

        return {
          content: [{ type: 'text', text: toolText(textPayload) }],
          structuredContent: fullPayload,
        }
      } catch (error) {
        // 原始错误可能带连接串 / 上游返回，只进日志（REST 的 INTERNAL 同一条纪律）。
        // MCP 没有错误信封，也不该把内部信息回给外部客户端
        log.error({ requestId: deps.requestId, err: error }, 'mcp search_memes 失败')
        return toolError('检索失败，请稍后重试。')
      }
    },
  )
}

/** 供类型断言：`fullPayload` 里的 items 是完整 summary（防止 compact 误写进 structured）。 */
export type SearchFullPayload = {
  query: string
  rewritten: string | null
  degraded: boolean
  items: MemeSummary[]
}
