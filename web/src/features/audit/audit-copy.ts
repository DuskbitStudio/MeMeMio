/**
 * 审计页（`/audit`）的**文案与显示规则**。
 *
 * 文案逐字来自 [SPEC §10.8](../../../../spec/10-mcp.md)（「调用记录」那一块），
 * 和 `settings/mcp-copy.ts` 里的五句同一个地位——**不能删、不能弱化、不能改措辞**。
 * 改这里之前先改 SPEC，改完两边一起提交。
 *
 * 另有一类是**显示规则**（不是句子）：`queryText` 该显示原文还是「仅本人可见」、
 * 令牌被删后那一格显示什么。它们写成本文件的纯函数，不散在组件里——
 * 验收脚本按句子断言，规则散开就会有一个渲染点漏掉它，而漏掉的表现是
 * **别人的检索原文被显示出来**，那是隐私事故，不是样式问题。
 */

import type { AuditLogItem } from '../../lib/api-audit'

/** 契约文案（SPEC §10.8）。**逐字，不改。** */
export const AUDIT_COPY = {
  title: '调用记录',
  /**
   * 页面说明。第二句是**本页存在的理由**，不是装饰：用户看到「别人的搜索词看不到」
   * 才知道共享库的审计边界在哪（[settings-ux.md](../../agents/rules/settings-ux.md)
   * 那条「共享库的代价要在界面上说出来」的同一条）。
   */
  description:
    '每一次 MCP 工具调用都会记一行：时间、令牌、工具、检索原文、返回了哪些图和结果。连接与列出工具不记。',
  privacyHint: '他人的检索原文与返回的图不可见。',
  /** 日预算的说明。**不是错误态文案**——这是正常上限，放在说明里。 */
  budgetHint:
    '每个令牌每天最多 2000 次工具调用（UTC 0 点重置）。超限的请求不会出现在这里。',

  scopeMine: '只看我的',
  scopeAll: '全部',

  emptyNone: '还没有调用记录。',
  emptyFiltered: '没有符合这些条件的调用记录。',

  errorTitle: '加载失败',

  loadMore: '加载更多',
  loadingMore: '加载中…',
  endOfList: '没有更多了',

  /** 令牌行被物理删除（`tokenId` / `tokenName` 都是 `null`，SPEC §6.11）。 */
  deletedToken: '已删除的令牌',
  /** 别人的行：私有原文那一格。 */
  queryHidden: '仅本人可见',
  /** 本人的行、但这次调用没有检索原文（非检索类工具，或没传查询词）。 */
  queryEmpty: '—',

  outcomeOk: '成功',
  outcomeError: '失败',

  /**
   * 「返回」那一格：`<n> 张` / `未返回图`（SPEC §10.8）。**三档不能合并成一句「0 张」**，
   * 分档规则在 `readReturnText`，不在组件里。
   */
  returnCount: (n: number) => `${n} 张`,
  returnNone: '未返回图',

  /** 他人的行：张数照给，图不给（§6.11 的隐私边界比检索原文更直接）。 */
  resultHidden: '仅本人可见',

  /** 详情抽屉（SPEC §10.8 那一组）。 */
  drawerTitle: '这次调用返回的图',
  drawerOpen: '查看返回的图',
  /** 某一格按 id 现查 `GET /memes/{id}` 得到 404：已软删。**不显空白格**。 */
  drawerCellGone: '已删除或不可见',
  /** 空态文案。详情抽屉本身不会为空（没有 id 就没有入口），复用给别的调用点。 */
  drawerEmpty: '这次调用没有返回图。',

  /** 筛选项的标签。 */
  filterTool: '工具',
  filterToken: '令牌',
  filterFrom: '起始日期',
  filterTo: '结束日期',
  filterAllTools: '全部工具',
  filterAllTokens: '全部令牌',
  filterClear: '清除筛选',
  filterToggle: '筛选',
} as const

/**
 * 这一行是不是调用者本人的。
 *
 * ⚠️ 有**两处**要判「本人」：检索原文（隐私抹成 `null`）与返回明细（`resultMemeIds` 为 `null`）。
 * 两处判定必须相同——一处漏了就是「别人的检索原文/别人拿走的图被显示出来」，那是隐私事故，
 * 不是样式问题。所以只在这里判一次，`readQueryText` / `readResultMemeIds` 都调它。
 */
export function isMineRow(
  item: Pick<AuditLogItem, 'userId'>,
  opts: { meId: string; scope: 'mine' | 'all' },
): boolean {
  // `scope=mine` 下服务端只回本人的行，不必再比 id（比了也不会错，但这个判据更直接）
  return opts.scope === 'mine' || item.userId === opts.meId
}

/**
 * 这一行的检索原文该显示什么。
 *
 * ⚠️ **唯一的判定点。** 规则来自 SPEC §6.11：「只有 `scope=mine` 下的行、以及
 * `scope=all` 中 `userId` 等于调用者本人的行，才返回原文；其余行一律 `null`」。
 *
 * - 不是我的行 → 不论 `queryText` 是什么都显示「仅本人可见」（正常情况服务端已经给了
 *   `null`，这里再挡一层是防「服务端回错了、界面照抄」——**隐私规则不该只有一层**）；
 * - 我的行、`queryText` 是 `null` → 「—」。**不要**当成「仅本人可见」：
 *   `get_meme_image` / `random_meme` / `list_vocab` 本来就没有检索原文，说成
 *   「别人看不到」会让用户以为自己的搜索词没被记下来；
 * - 我的行、有原文 → 原文。
 */
export function readQueryText(
  item: AuditLogItem,
  opts: { meId: string; scope: 'mine' | 'all' },
): string {
  if (!isMineRow(item, opts)) return AUDIT_COPY.queryHidden
  const text = item.queryText?.trim() ?? ''
  return text === '' ? AUDIT_COPY.queryEmpty : item.queryText!
}

/**
 * 令牌那一格：`名称 · 前缀`。
 *
 * 令牌行被物理删除时服务端给 `tokenId` / `tokenName` 都为 `null`（§6.11），
 * 这时显示「已删除的令牌」——**不要**显示空串或「—」，那一格会看起来像渲染坏了。
 * 前缀是展示用身份，不是密钥（§6.11 明写），可以显示。
 */
export function readTokenLabel(
  item: Pick<AuditLogItem, 'tokenId' | 'tokenName' | 'tokenPrefix'>,
): string {
  if (item.tokenId === null || item.tokenName === null) return AUDIT_COPY.deletedToken
  if (item.tokenPrefix === null) return item.tokenName
  return `${item.tokenName} · ${item.tokenPrefix}`
}

/**
 * 「返回」那一格该显示什么——**唯一的分档点**（SPEC §10.8）。
 *
 * 三档，**不能合并成一句「0 张」**：
 *   - `outcome === 'error'` → 「未返回图」。失败不是空结果，写成 `0 张` 会读成「查了没查到」；
 *   - `list_vocab` → 「未返回图」。这个工具本来就不返回图，`0` 对它是正常值；
 *   - 其余 `ok` → 「`<resultCount>` 张」，`0` 就是「一张都没匹配上」。
 *
 * 不看 `scope` / `userId`：数量不受隐私约束，他人的行照常显示张数。
 */
export function readReturnText(
  item: Pick<AuditLogItem, 'outcome' | 'tool' | 'resultCount'>,
): string {
  if (item.outcome === 'error') return AUDIT_COPY.returnNone
  if (item.tool === 'list_vocab') return AUDIT_COPY.returnNone
  return AUDIT_COPY.returnCount(item.resultCount)
}

/**
 * 这一行返回了哪些图的 id；没有可给的就 `null`。
 *
 * ⚠️ 他人的行**永远** `null`，即使服务端万一回了数组——与 `readQueryText` 同一层防御。
 * **绝不拿 `resultCount` 去凑列表**（§10.8 明写）：张数只说数量，说不出是哪几张。
 */
export function readResultMemeIds(
  item: Pick<AuditLogItem, 'userId' | 'resultMemeIds'>,
  opts: { meId: string; scope: 'mine' | 'all' },
): string[] | null {
  if (!isMineRow(item, opts)) return null
  const ids = item.resultMemeIds
  return ids === null || ids.length === 0 ? null : ids
}

/**
 * 「返回明细」那一格（他人行的「查看返回的图」位置）该显示什么；本人的行返回 `null`。
 *
 * §10.8 只给了「他人的行 → 仅本人可见」。**不能无条件写这句话**：
 *
 * - 失败的行、`list_vocab` 的行：这一趟确实没返回图，「仅本人可见」会让人以为藏了东西，
 *   而「返回」那一格已经写着「未返回图」了——这里留空；
 * - 本人**确实返回了图**（`resultCount > 0`）的行：写「仅本人可见」，这是隐私边界在界面上
 *   的唯一体现，删掉它管理员会以为抽屉坏了。
 *
 * 判据用 `resultCount` 而不是 `resultMemeIds`：他人行后者恒 `null`，用它判等于永远显示。
 * 数量不是隐私（§6.11），正是为了让这句话能说得准确。
 */
export function readResultDetailText(
  item: Pick<AuditLogItem, 'userId' | 'outcome' | 'tool' | 'resultCount'>,
  opts: { meId: string; scope: 'mine' | 'all' },
): string | null {
  if (isMineRow(item, opts)) return null
  if (item.outcome === 'error' || item.tool === 'list_vocab') return null
  return item.resultCount > 0 ? AUDIT_COPY.resultHidden : null
}

/**
 * 这一行有没有抽屉入口。
 *
 * 只有「本人 + 有 id」才有。`list_vocab` 与失败的行**没有入口，不是灰掉的按钮**——
 * 灰按钮会让人以为点一下能加载出来（任务文件 §5）。
 */
export function canOpenResult(
  item: Pick<AuditLogItem, 'userId' | 'resultMemeIds'>,
  opts: { meId: string; scope: 'mine' | 'all' },
): boolean {
  return readResultMemeIds(item, opts) !== null
}

/** 工具名到人话，只用于筛选项的标签；记录本身照显示工具名（它是调用方认的那个名字）。 */
export const TOOL_LABELS: Record<string, string> = {
  search_memes: 'search_memes（检索）',
  pick_meme_for_reply: 'pick_meme_for_reply（挑选）',
  get_meme_image: 'get_meme_image（取图）',
  random_meme: 'random_meme（随机）',
  list_vocab: 'list_vocab（词表）',
}
