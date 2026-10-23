import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { Db } from '../../data/db.js'
import { log } from '../../logger.js'
import { actorOf } from '../auth.js'
import { compactItems, resolveAdultAccess, toMemeSummary, toolError, toolText } from '../format.js'
import { detailShape } from '../filter.js'
import { randomToolRows } from '../search.js'
import { TOOL_NAMES } from '../tool-names.js'

/**
 * `random_meme` —— 随机抽几张（SPEC §10.4.4）。
 *
 * 走 `randomToolRows`（内部是 `listMemes({ random: true })`）：随机、软删过滤、标签条件
 * 全都在数据层那一份 WHERE 里；**不产生任何 AI 调用**。
 *
 * 默认排除成人向（§10.3.1）：随机比检索更容易撞到库里那 10 张，安全默认值在这里尤其重要。
 */

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1, 'limit 至少 1')
    .max(10, 'limit 最多 10')
    .default(3),
  isAnimated: z.boolean().optional(),
  /** 成人向请求；默认 false。账号设置未开启时传 true 是工具错误（§10.3.1）。 */
  allowAdult: z.boolean().optional(),
  ...detailShape,
})

type RandomMemeDeps = {
  db: Db
  requestId: string
}

export function registerRandomMeme(server: McpServer, deps: RandomMemeDeps): void {
  server.registerTool(
    TOOL_NAMES.randomMeme,
    {
      description:
        '从共享表情包库里随机抽 1–10 张（默认 3 张），返回图片地址与元数据；不保证顺序。'
        + 'isAnimated 可选，只看动图或只看静图。默认不返回成人向（allowAdult 默认 false）。',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, ctx) => {
      const actor = actorOf(ctx.http?.authInfo)
      if (actor === null) return toolError('未识别的调用身份，请重新创建访问令牌。')

      const adult = resolveAdultAccess(actor, args.allowAdult ?? undefined)
      if (!adult.ok) return toolError(adult.message)

      try {
        const rows = await randomToolRows({
          db: deps.db,
          actorId: actor.userId,
          limit: args.limit,
          isAnimated: args.isAnimated,
          allowAdult: adult.allow,
          excluded: actor.excluded,
        })
        const items = rows.map(toMemeSummary)

        const fullPayload: Record<string, unknown> = { items }
        const textPayload: Record<string, unknown> = args.detail === 'full'
          ? fullPayload
          : { items: compactItems(items) }

        return {
          content: [{ type: 'text', text: toolText(textPayload) }],
          structuredContent: fullPayload,
        }
      } catch (error) {
        log.error({ requestId: deps.requestId, err: error }, 'mcp random_meme 失败')
        return toolError('随机抽取失败，请稍后重试。')
      }
    },
  )
}
