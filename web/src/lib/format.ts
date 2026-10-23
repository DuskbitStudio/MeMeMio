/**
 * `bytes` 收 string 是有意的：`sizeBytes` 在服务端的库里是 bigint，出响应时
 * `toString()` 了（直接进 JSON 会丢精度），所以同一类字段在有些接口上是数字、
 * 有些接口上是字符串。归一化收敛在这里，调用点不用各自记得 `Number()`。
 */
export function formatBytes(bytes: number | string | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  const n = typeof bytes === 'number' ? bytes : Number(bytes)
  // NaN 只能来自服务端给了个不是数字的串。显示「—」比显示「NaN B」诚实
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * 只要日期（MCP 令牌的「过期」列）。
 *
 * 过期时间落到哪一天就够判断了，带上时分反而让一列五格的数据看起来更挤；
 * 与 `formatDate` 分开而不是加参数：`formatDate` 的调用点很多，加一个布尔参数
 * 每处都要重新读一遍它到底要哪种。
 */
export function formatDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-CN')
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * MCP 令牌列表的「最后使用」：**七天内说相对时间，再往前改成绝对日期**（SPEC §6.8 的
 * `lastUsedAt` 可以为 `null`）。
 *
 * 为什么分档：这一列回答的是「这台设备还用不用」。刚用过的说「2 分钟前」一眼就懂；
 * 三个月前的那条说「93 天前」反而要在脑子里换算，不如直接给日期。
 *
 * `null` 的文案是「从未使用」而不是「—」：它是**正常的初始状态**（刚建的令牌），
 * 说清楚比留白有用。
 *
 * 取不到时间（服务端给了个不是日期的串）时回落到「—」，与 `formatBytes` 对 NaN 的处理同理：
 * 显示一个诚实的不认识，比显示 `NaN 天前` 强。**未来时间按「刚刚」处理**——服务端与本机
 * 有时钟偏差，显示「-2 分钟前」只会让人以为页面坏了。
 */
export function formatRelativeTime(iso: string | null): string {
  if (iso === null) return '从未使用'

  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'

  const diff = Date.now() - at
  if (diff < MINUTE_MS) return '刚刚'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`
  if (diff < 2 * DAY_MS) return '昨天'
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`

  return new Date(at).toLocaleDateString('zh-CN')
}
