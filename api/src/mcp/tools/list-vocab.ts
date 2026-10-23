import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { termsOf, VOCAB_FIELDS, vocabulary } from '../../vocab.js'
import { actorOf } from '../auth.js'
import { toolError, toolText } from '../format.js'
import { TOOL_NAMES } from '../tool-names.js'

/**
 * `list_vocab` —— 词表版本、七个维度的全部合法值，以及当前账号的成人向许可
 * （SPEC §10.4.5）。
 *
 * 它存在的理由：模型需要知道「阴阳怪气」属于 `tones` 还是 `purposes` 才能给出有效筛选；
 * 让模型猜维度名会得到**空结果而不是错误**——那是最难自查的一类失败。
 *
 * `allowAdult` 让模型知道要不要传 `allowAdult: true`（§10.3.1），不用猜账号设置。
 *
 * 完全不碰数据库、不调 AI：词表是进程启动时从 `shared/vocab/vocab.json` 读进来的
 * （`vocab.ts`），所以这个工具只花一次序列化的钱。
 */

const inputSchema = z.object({})

export function registerListVocab(server: McpServer): void {
  server.registerTool(
    TOOL_NAMES.listVocab,
    {
      description:
        '返回标签词表的版本、更新时间、当前账号是否允许成人向（allowAdult），以及七个维度'
        + '（expressions/emotions/tones/purposes/scenes/tags/ratings）的全部合法值。'
        + '做筛选之前先调它，避免用错维度名或词表外的词；也只有 allowAdult=true 时，'
        + '其他工具传 allowAdult=true 才会生效。',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) => {
      const actor = actorOf(ctx.http?.authInfo)
      if (actor === null) return toolError('未识别的调用身份，请重新创建访问令牌。')

      // 七个维度的顺序沿用 `VOCAB_FIELDS`（与提示词、前端筛选区的展示顺序是同一份定义）
      const dimensions: Record<string, string[]> = {}
      for (const field of VOCAB_FIELDS) dimensions[field] = [...termsOf(field)]

      const payload: Record<string, unknown> = {
        version: vocabulary.version,
        updatedAt: vocabulary.updatedAt,
        allowAdult: actor.allowAdult,
        dimensions,
      }

      return {
        content: [{ type: 'text', text: toolText(payload) }],
        structuredContent: payload,
      }
    },
  )
}
