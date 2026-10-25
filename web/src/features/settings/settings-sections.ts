/**
 * 设置页的分区表（任务 2026-10-25-设置页分区导航 §3）。
 *
 * `id` 就是分区的地址：`/settings#<id>`。**这串 hash 有外面的人在用**——`/admin/*` 三条
 * 重定向（App.tsx）、`docs/mcp.md` 写给用户的 `/settings#mcp`——改名等于让那些链接
 * 静默落回第一段，所以只加不改。
 *
 * 排序有两处是有意的：
 *
 * - **重建索引不单独成段**，它和 Embedding 表单同在 `embedding` 里：确认换模型之后
 *   管理员要马上看到进度（settings-ux.md §8），`reindexToken` 也只在这一对之间传。
 * - **重新打标单独成段**（`retag`）：它和重建索引「形状像、实质相反」（settings-ux.md §10），
 *   挨着放正是最容易看混的位置；重建索引又必须留在 Embedding 段里，所以拆出去的是它。
 *
 * ⚠️ **2026-10-01 起「图片向量」这一段连同两张卡一起下线**（人物聚类暂停待方案，任务
 * 2026-10-01-人物功能临时下线 §3）。恢复时加回 `{ id: 'image-embed', label: '图片向量',
 * group: 'admin' }`，**位置在 `embedding` 之后、`runtime` 之前**，再到 `routes/settings.tsx`
 * 把 `ImageEmbedSettings` + `PersonsReindexPanel` 包进同名的一段（见任务 §5 的恢复清单）。
 */

export type SettingsGroup = 'mine' | 'admin'

export type SettingsSectionId = 'vision' | 'mcp' | 'invites' | 'embedding' | 'runtime' | 'retag' | 'users'

export type SettingsSection = {
  id: SettingsSectionId
  label: string
  /** `admin` 组对成员**不渲染**——不是 `hidden`，见 `routes/settings.tsx` 头注释。 */
  group: SettingsGroup
}

export const SETTINGS_GROUP_LABEL: Record<SettingsGroup, string> = {
  mine: '我的',
  admin: '全站管理',
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'vision', label: '视觉模型', group: 'mine' },
  // MCP 接入是所有人的分段（SPEC §10；文案契约见 §10.8）。它是只读的外部接口入口，
  // 与视觉那种「配置存储」不是一类，但同样属于「你的事」。
  { id: 'mcp', label: 'MCP 接入', group: 'mine' },
  { id: 'invites', label: '邀请码', group: 'admin' },
  { id: 'embedding', label: 'Embedding', group: 'admin' },
  { id: 'runtime', label: '运行参数', group: 'admin' },
  { id: 'retag', label: '重新打标', group: 'admin' },
  { id: 'users', label: '用户', group: 'admin' },
]

/**
 * 当前该显示哪一段。
 *
 * 不带 hash、hash 不认识、或成员带着管理员分区的 hash（`#users`）——一律退回第一段，
 * 不报错。**地址栏不跟着改写成 `#vision`**：成员手里的 `#users` 多半是管理员发来的链接，
 * 原样留着，他转给另一位管理员时还能直达；改写的话这条地址就在他这里断了。
 * 代价只是地址栏里留着一个当前没生效的 hash——导航上的 `aria-current` 标的仍是
 * 真正显示的那一段，读屏与眼睛看到的都不会错。`/settings` 不带 hash 同理不补。
 */
export function pickSection(hash: string, visible: readonly SettingsSection[]): SettingsSectionId {
  const wanted = hash.startsWith('#') ? hash.slice(1) : hash
  // 退回的「第一段」写死成 vision：它属「我的」，谁都看得到
  return visible.find((s) => s.id === wanted)?.id ?? 'vision'
}
