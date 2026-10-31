/**
 * OAuth 同意页与「已连接应用」的契约文案（SPEC §10.8「授权同意 · *」「已连接应用 · *」）。
 *
 * 与 `features/settings/mcp-copy.ts` 同一个地位：**逐字照抄，前端不现编、不弱化**。
 * 两组文案只在这里出现一次，同意页与设置页各自 import——不要在某一个组件里另抄一份，
 * 改了一处漏一处的表现是「一个页面在说只读，另一个页面在说别的」。
 *
 * ## 为什么单独一个文件，而不是并进 `mcp-copy.ts`
 *
 * 同意页是**未登录用户也能走到**的页面（登录页的 `next` 会把人送回来），它不能 import
 * 设置页那棵树——那会顺带拉进令牌创建弹窗、过滤器面板一整串只给已登录用户看的东西。
 * 文案是纯数据，放这里谁都能引，不会把页面依赖带过去。
 */

import { formatRelativeTime } from '../../lib/format'

/** 同意页的一次性链接（`/oauth/consent?ticket=…`，SPEC §10.10.3）。 */
export const OAUTH_CONSENT_PATH = '/oauth/consent'

/**
 * 同意页地址，带 ticket。**同一个函数给三处用**：登录页回跳（`loginPath` 的参数）、
 * 组件内重试、CDP 验收脚本。ticket 是服务端下发的 opaque 串，这里只做 URL 编码。
 */
export function consentPath(ticket: string): string {
  return `${OAUTH_CONSENT_PATH}?ticket=${encodeURIComponent(ticket)}`
}

/**
 * 契约文案。参数化的三条是函数，其余是定值。
 *
 * ⚠️ 「授权同意 · 说明」在 SPEC 里是**两行**。那是句子的分行，不是排版结构
 * （`settings-copy.ts` 用 `<pre>` 是因为那几段的分行是结构）：这里拆成两条独立文案，
 * 组件按 `<p>` 各自成段，与设计稿的观感一致，也方便第二条单独加视觉强调。
 */
export const OAUTH_COPY = {
  /** 授权同意 · 标题。 */
  consentTitle: (clientName: string) => `允许「${clientName}」访问你的表情包库？`,
  /** 授权同意 · 说明（第 1 行）。 */
  consentBody: (clientName: string) =>
    `${clientName} 将能以只读方式检索这个共享库，和你登录后看到的内容一样。`,
  /** 授权同意 · 说明（第 2 行）。 */
  consentReadOnly: '它不能上传、修改或删除任何图片。',
  /** 授权同意 · 回跳。主机名是服务端算好的 `redirectHost`，前端不解析 URL。 */
  consentRedirect: (host: string) => `授权完成后会回到：${host}`,
  /** 授权同意 · 未验证。DCR 注册的应用一律标注（§10.10.2）。 */
  consentUnverified: '这个应用是自助注册接入的，我们无法核实它的身份。只在你信任的客户端里授权。',
  /** 授权同意 · 内容范围。 */
  consentContentScope: '内容范围与过滤器沿用你的 MCP 设置（成人向默认关闭）。',
  /** 授权同意 · 操作。 */
  consentCancel: '取消',
  consentApprove: '允许',
  /** 授权同意 · 失效。ticket 无效 / 过期 / 已用 / 非本人统一这一句。 */
  consentExpired: '这个授权链接已失效或已被使用。回到客户端重新发起连接。',
  /** 加载失败（连不上服务端那一类）。ticket 本身没说错，所以不复用「失效」。 */
  consentLoadError: '同意页暂时打不开，检查网络后再试。',
  consentRetry: '重试',
  /** 提交时按钮上的文案（阻止重复点击，且不只是把按钮置灰）。 */
  consentSubmitting: '提交中…',
  /**
   * 已达上限（SPEC §10.8「已连接应用 · 数量上限」）。approve 时服务端回
   * `VALIDATION_FAILED` + `details.fields` 指 `grantLimit`，这里原样显示。
   */
  consentLimit: '已达上限（20 个）。先撤销不用的应用，再授权新的。',
  /** 去设置页管理已连接应用。 */
  consentManage: '去设置页管理',

  // --- 已连接应用（设置页 #mcp，SPEC §10.8）--------------------------------

  /** 已连接应用 · 标题。 */
  grantsTitle: '已连接应用',
  /** 已连接应用 · 说明。 */
  grantsDescription:
    '通过 OAuth 授权接入的客户端。撤销后它们会立即收到 401，需要重新授权。',
  /** 已连接应用 · 空态。 */
  grantsEmpty: '还没有应用通过 OAuth 接入。',
  /** 已连接应用 · 列项。主机名与时间由调用方给（时间走 `formatRelativeTime`）。 */
  grantItem: (clientName: string, host: string, lastUsed: string) =>
    `${clientName} · 回跳到 ${host} · 最近使用 ${lastUsed}`,
  /**
   * 已连接应用 · 列项（从未使用）。`lastUsedAt` 为 `null` 时**整段换掉**，
   * 不渲染成「最近使用 —」或空时间——两种都读起来像坏了（§10.8 呈现规则）。
   */
  grantItemNeverUsed: (clientName: string, host: string) =>
    `${clientName} · 回跳到 ${host} · 从未使用`,
  /** 已连接应用 · 撤销确认。 */
  grantsRevokeConfirm: (clientName: string) =>
    `撤销后「${clientName}」立即失去访问权限，需要重新授权才能接入。确定撤销？`,
  /** 已连接应用 · 数量上限。与同意页提交时收到的那条是同一句话，共用一份。 */
  grantsLimit: '已达上限（20 个）。先撤销不用的应用，再授权新的。',
} as const

/**
 * 「已连接应用」一行的取文案规则（SPEC §10.8 呈现规则那段要求实现放在这里，不放组件里）。
 *
 * `lastUsedAt === null` 的含义是「签下来之后一次都没用过」（刚批准，或客户端一直没发起请求），
 * 是**正常的初始状态**，不是缺数据——所以整行换成「列项（从未使用）」，而不是把空值塞进
 * 「最近使用 …」。`expiresAt` 也允许为空，但模板里没有它，这里不碰。
 *
 * 时间是相对时间（`formatRelativeTime`：七天内「N 分钟前」，再往前给日期）。它自己对
 * `null` 也返回「从未使用」，所以这里必须**先分支**再调用——否则会得到「最近使用 从未使用」。
 */
export function grantLine(grant: {
  clientName: string
  /** 批准时那条回跳的主机名（§6.10），不是 `redirect_uris[0]` 的。 */
  redirectHost: string
  lastUsedAt: string | null
}): string {
  if (grant.lastUsedAt === null) {
    return OAUTH_COPY.grantItemNeverUsed(grant.clientName, grant.redirectHost)
  }
  return OAUTH_COPY.grantItem(
    grant.clientName,
    grant.redirectHost,
    formatRelativeTime(grant.lastUsedAt),
  )
}
