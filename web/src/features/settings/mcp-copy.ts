/**
 * MCP 接入页与接入指南的**静态文案 / 纯函数**。
 *
 * 两类内容分开看：
 *
 * 1. **契约文案**（`MCP_COPY`）逐字来自 [SPEC §10.8](../../../../spec/10-mcp.md)，
 *    和 `settings-copy.ts` 里的四段同一个地位——**不能删、不能弱化、不能改措辞**。
 *    ⚠️ SPEC 那段代码块里有几行是**源码折行**，不是文案里的换行（「卡片说明」「安全提示」
 *    各折了一处）：这里按设计稿的排版拼接成一句话，与设计稿逐字一致。`settings-copy.ts`
 *    用 `<pre>` 保留换行是因为那几段的分行**是结构**，这五句不是。
 * 2. **静态配置与渠道说明**：客户端片段由函数生成（`token` 由调用方给，指南里用
 *    `TOKEN_PLACEHOLDER`，创建成功弹窗里是真令牌）；工具、渠道、限额与 FAQ 来自
 *    [`docs/mcp.md`](../../../../docs/mcp.md) §3–§8，渠道细节以官方文档为准——
 *    本仓库没在真实渠道验收过的统一标「接入时实测」，不写成承诺。
 */

/** `POST /mcp` 的路径。地址 = 当前站点 origin + 它（SPEC §10.2）。 */
export const MCP_PATH = '/mcp'

/**
 * 接入地址。**用运行时 origin，不写死域名**：同一个构建要能跑在任意部署上，
 * 而用户复制的地址必须就是他现在访问的这个（反代、自定义域名都算）。
 */
export function mcpEndpoint(origin: string): string {
  return `${origin}${MCP_PATH}`
}

/**
 * 指南里的占位令牌。**不是真令牌**——设置页这一刻还没建，也不能从列表拿回来。
 * 形状按 SPEC §10.3 的 `mcp_` 前缀写，让用户一眼看出要替换的是哪一段。
 */
export const TOKEN_PLACEHOLDER = 'mcp_xxx'

/** `Authorization: Bearer …` 这一行（SPEC §10.3：只认这个头，不认 cookie）。 */
export function bearerHeader(token: string): string {
  return `Authorization: Bearer ${token}`
}

/** Claude Code 的命令行添加（docs/mcp.md §3.1）。 */
export function claudeCodeCommand(origin: string, token: string): string {
  return [
    'claude mcp add --transport http mememio \\',
    `  ${mcpEndpoint(origin)} \\`,
    `  --header "${bearerHeader(token)}"`,
  ].join('\n')
}

/**
 * Claude Desktop / 通用 JSON 配置（docs/mcp.md §3.2）。
 *
 * 创建成功弹窗里的「复制配置片段」用的就是它，**token 已嵌进去**——用户不用再去拼。
 * 也正因为它含明文令牌，弹窗里不能把它写进任何持久化。
 */
export function claudeDesktopConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mememio: {
          type: 'http',
          url: mcpEndpoint(origin),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

/** Cursor 的 `.cursor/mcp.json` / 用户级配置（docs/mcp.md §3.3）。字段以客户端版本为准。 */
export function cursorConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mememio: {
          url: mcpEndpoint(origin),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  )
}

/** 只支持 stdio 的客户端：用 `mcp-remote` 桥（docs/mcp.md §3.5）。 */
export function mcpRemoteCommand(origin: string, token: string): string {
  return [
    'npx -y mcp-remote \\',
    `  ${mcpEndpoint(origin)} \\`,
    `  --header "${bearerHeader(token)}"`,
  ].join('\n')
}

/** 同一座桥写进客户端配置的形状（docs/mcp.md §3.5）。 */
export function mcpRemoteConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        mememio: {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpEndpoint(origin), '--header', `Bearer ${token}`],
        },
      },
    },
    null,
    2,
  )
}

/**
 * 地址提示的渲染片段：设计稿把 `/mcp` 与 `Authorization: Bearer <令牌>` 做成行内代码。
 * **文案仍然是 SPEC §10.8 那一整句**——下面 `MCP_COPY.endpointHint` 由这些片段的
 * `text` 拼出来，单源只有一处，不会出现「组件里另抄一句、改一处漏一处」。
 */
export const MCP_ENDPOINT_HINT_PARTS = [
  { text: 'Streamable HTTP。地址固定带 ', code: false },
  { text: '/mcp', code: true },
  { text: ' 路径；请求头里放 ', code: false },
  { text: 'Authorization: Bearer <令牌>', code: true },
  { text: '。', code: false },
] as const

/**
 * 契约文案（SPEC §10.8）。**逐字照抄，不在前端现编。**
 *
 * 「一次性提醒」两处用同一份字符串：创建弹窗（提前警告）与创建成功弹窗（只显示一次）。
 * 两处各写一份的话，迟早有一处改成「只显示一次」、另一处还是「只显示一次」的旧说法。
 */
export const MCP_COPY = {
  /** 卡片说明。 */
  cardDescription:
    '让 Claude、Cursor、Cherry Studio 或你自己的聊天机器人，通过 MCP 用一句话检索这个表情包库。只读——不会上传、修改或删除任何图片。',
  /** 地址提示（由 `MCP_ENDPOINT_HINT_PARTS` 拼出，见上）。 */
  endpointHint: MCP_ENDPOINT_HINT_PARTS.map((part) => part.text).join(''),
  /** 令牌说明。 */
  tokenHint: '令牌等同于你的账号登录凭证，只能读取；创建后完整串只显示一次。',
  /** 一次性提醒。 */
  oneTimeNotice:
    '这串令牌只显示这一次。关掉窗口后就看不到了，只能重新创建。请先复制或保存到密码管理器。',
  /** 安全提示。 */
  securityNotice:
    '令牌只能读，但能读到整个共享库（和登录后一样）。只配置在你信任的客户端；怀疑泄露就立即撤销。',
  /** 边界脚注。 */
  boundaryFootnote:
    'MCP 只负责把图交给你的机器人。真正发到微信 / QQ / LINE，由机器人调用各渠道的官方接口完成。',
  /** 撤销确认，名称代入。 */
  revokeConfirm: (name: string) =>
    `「${name}」将立即失去访问权限。正在使用它的客户端会收到 401。这个操作不可撤销。`,
  /** 内容范围（成人向）标题。 */
  contentScopeTitle: '允许成人向内容',
  /** 内容范围说明。 */
  contentScopeDescription:
    '关闭时，所有 MCP 工具都不会返回标记为「成人向」的表情包。只影响你自己的 MCP 请求，不影响 Web 端浏览。',
  /** 开启后的补充说明。 */
  contentScopeEnabledHint:
    '已开启。工具还需要在本次调用里显式传 allowAdult: true 才会返回成人向。',
  /** 开启确认。 */
  adultConfirmTitle: '开启成人向内容？',
  adultConfirmDescription:
    '开启后，你的 MCP 客户端可以在你明确要求时返回成人向表情包。建议只在私聊 / 私人机器人里使用。确定开启？',
  adultConfirmAction: '确定开启',
  /** 关闭成人向时的状态文案。 */
  contentScopeOff: '已关闭',
  contentScopeOn: '已开启',
  /** 过滤器入口。 */
  filterTitle: '过滤器',
  filterEntryDescription:
    '按标签限制 MCP 能返回的内容。选中的标签不会出现在检索结果里；只影响 MCP，不影响 Web 端浏览。',
  filterUnset: '未设置',
  filterExcluded: (count: number) => `已排除 ${count} 个`,
  filterAdultNote: '成人向内容由「内容范围」单独设置，不在这里选择。',
  /** 过滤器面板。 */
  filterPanelDescription:
    '选中的标签不会出现在 MCP 的检索结果里。只影响 MCP，不影响 Web 端浏览。',
  filterSearchPlaceholder: '搜索标签，如 猫、阴阳怪气…',
  filterNoMatch: '没有匹配的标签。',
  filterNoSelection: '未排除任何标签',
  filterAdultHint: '此项需要单独设置，请到「内容范围」开启或关闭。',
  filterGoContentScope: '去「内容范围」',
  filterEmpty: '未排除任何标签，MCP 返回全部内容。',
  filterSaving: '保存中…',
  filterClear: '清空',
  filterCancel: '取消',
  filterSave: '保存',
  filterDiscardTitle: '放弃未保存的更改？',
  filterDiscardDescription: '有未保存的更改，关闭后本次选择会丢失。',
  filterDiscardAction: '放弃更改',
  filterLoadError: '过滤器加载失败',
  filterSaveError: '过滤器保存失败',
} as const

/**
 * 设置页既有的 `NOTICE` 配方（`settings-ui.ts`），这里只保留**形状**：
 * `rounded-2xl border bg-muted/40 p-4`。
 *
 * 那一段是 `font-mono + whitespace-pre-wrap` 的契约原文面板；MCP 这几处要装图标与一句话，
 * 不是 `<pre>`，所以不直接复用那个常量，但**底色、圆角、内边距必须一致**——
 * 它表达的都是「这是一段说明」，而且**不能用 `Alert`**（自带 `role="alert"`，
 * 这里是说明不是警报，见 styling.md「文案要有承载物」）。
 */
export const MCP_NOTICE = 'rounded-2xl border bg-muted/40 p-4 text-sm'

/** 行内代码片段的样式（表格 / 步骤里的 `Authorization: Bearer …` 那一类）。 */
export const MCP_INLINE_CODE =
  'rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere'

/** 接入指南的四个客户端页签。与 docs/mcp.md §3 的小节一一对应。 */
export const MCP_CLIENT_TABS = [
  { id: 'claude', label: 'Claude Code / Desktop' },
  { id: 'cherry', label: 'Cherry Studio' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'stdio', label: '其他（stdio）' },
] as const

/** `tools/list` 的五个工具与一句话说明（SPEC §10.4；顺序固定，客户端可缓存）。 */
export const MCP_TOOLS = [
  {
    name: 'search_memes',
    summary: '按一句想表达的意思检索候选列表；默认 compact 文本，成人向默认不返回。',
  },
  {
    name: 'pick_meme_for_reply',
    summary: '直接挑一张最适合回复的，附缩略图 + 最多 5 个备选；IM 机器人可传 inline=false 只拿 URL。',
  },
  {
    name: 'get_meme_image',
    summary: '取指定表情包的图片链接；可选内联缩略图，成人向需显式允许。',
  },
  {
    name: 'random_meme',
    summary: '随机抽几张，适合「随便来一张」；默认排除成人向。',
  },
  {
    name: 'list_vocab',
    summary: '列出七个标签维度的合法值，以及当前账号是否允许成人向。',
  },
] as const

export type McpChannel = {
  name: string
  /** 机器人要做什么 + 哪些细节以渠道官方文档为准。 */
  detail: string
  /** 只有「个人号」那一行是警告：没有官方接口，不提供、不承诺。 */
  warning?: boolean
}

/**
 * IM 渠道（`docs/mcp.md` §5）。**只写「机器人要做什么」**，字段名与阈值一律指向官方文档；
 * 本仓库没在真实渠道验收过的，结尾都带「接入时实测」。
 */
export const MCP_CHANNELS: readonly McpChannel[] = [
  {
    name: 'QQ 机器人',
    detail:
      '把 url 交给平台换 file_info，再按图片消息接口发。机器人资质与平台能力以官方文档为准；接入时实测。',
  },
  {
    name: '钉钉',
    detail:
      '群机器人没有独立的图片消息类型，把 url 内联进 markdown 消息（markdown 图片语法）。加签 / 关键词 / 白名单以官方文档为准；接入时实测。',
  },
  {
    name: '企业微信',
    detail:
      '群机器人：下载图后 base64 + md5 发图；自建应用：下载图，上传临时素材换 media_id 再发。字段与大小上限以官方文档为准；接入时实测。',
  },
  {
    name: '微信公众号',
    detail:
      '下载图 → 上传素材换 media_id → 客服消息 / 自动回复发图。客服消息有 48 小时窗口，具体口径与素材接口权限以官方文档为准；接入时实测。',
  },
  {
    name: '飞书',
    detail:
      '先上传 / 换取 image_key，再发图片消息。应用权限与 tenant_access_token 以官方文档为准；接入时实测。',
  },
  {
    name: 'LINE',
    detail:
      '直接填两个公网 HTTPS URL：原图 url + 预览图 thumbUrl。thumbUrl 是 WebP，是否被接受以官方文档为准；接入时实测。',
  },
  {
    name: '个人微信 / 个人 QQ',
    detail:
      '没有官方机器人 API。非官方协议违反 ToS、有封号风险，本项目不提供，也不承诺可用。',
    warning: true,
  },
]

/** 限额与成本（SPEC §10.6；`docs/mcp.md` §6）。数字是契约，措辞归本端。 */
export const MCP_LIMITS: readonly string[] = [
  '检索类工具（search_memes / pick_meme_for_reply）每个令牌 30 次/分钟；全部 MCP 请求 120 次/分钟。超限返回 429 + Retry-After。',
  'query / message 1–200 字；limit 1–20（random_meme 1–10）；请求体上限 256 KiB。',
  '结果缓存 60 秒（同一用户、同一查询、同一筛选、同一 limit、同一成人向许可才命中），命中不重复调 AI。',
  '语义检索未命中缓存时会产生 AI 调用：HyDE 改写用令牌所属用户的视觉配置，查询 embedding 用全站配置。',
  '每人最多 10 个有效令牌（未撤销且未过期）；完整令牌只显示一次，列表只有前缀。没有分页，只取前 N 条。',
]

/** 安全边界（`docs/mcp.md` §7）。 */
export const MCP_SAFETY: readonly string[] = [
  '令牌等同于你的账号登录凭证，只是只读；它能读到整个共享库。泄露 = 别人以你的身份搜索。',
  '令牌不要进仓库、截图、聊天记录；客户端配置里是明文，共享配置前先删掉 Authorization 头。',
  '工具输出含用户上传文本，属于不可信内容；不要把工具输出直接接到有副作用的自动化上。',
  '图片 URL 是公开地址（无签名、无过期），拿到 URL 的人就能看图，不要把它当访问控制。',
  '成人向默认关闭：设置页「内容范围」开启后，工具还要在本次调用显式传 allowAdult: true 才会返回。',
  '怀疑泄露立即撤销：下一次 MCP 请求就 401。停用 MCP 只能撤销全部令牌或回滚版本，没有开关。',
]

export type McpFaqItem = { q: string; a: string }

/** 常见问题（`docs/mcp.md` §8）。只留「连不上时先查什么」，不复制整页文档。 */
export const MCP_FAQ: readonly McpFaqItem[] = [
  {
    q: '401：令牌没带、过期或撤销了',
    a: '确认请求头是 Authorization: Bearer mcp_…（Bearer 后跟一个空格、不加引号）；确认令牌属于这台部署；过期或已撤销就重新创建。',
  },
  {
    q: '403：带 Origin 头',
    a: 'MCP 端点拒绝一切带 Origin 的请求，也不提供 CORS。浏览器里的 MCP 客户端连不上，请用原生客户端或 mcp-remote 桥。',
  },
  {
    q: '工具不出现 / 连不上',
    a: '保存配置后完全重启客户端并刷新 MCP 面板；检查自定义请求头是否真的带上；只支持 stdio 的客户端用 mcp-remote；只走 OAuth 的宿主用不了静态请求头。',
  },
  {
    q: '429：被限流',
    a: '按 Retry-After 秒数退避。群聊高频触发时在机器人侧合并请求 / 去抖，别靠重试。',
  },
  {
    q: '图片打不开',
    a: '先在外网访问 url / thumbUrl：打不开多半是 R2 桶没开 Public Access，或 R2_PUBLIC_BASE_URL 配错，不是 MCP 的问题。',
  },
  {
    q: 'pick_meme_for_reply 为什么是「随机挑一张」',
    a: '精确检索和词表关键词都没命中，工具从安全范围随机兜底，并在文本里注明。把 message 换成 10–20 字意图摘要通常更准。',
  },
  {
    q: '成人向内容怎么才能返回',
    a: '先在设置页「内容范围」开启（默认关闭），再在工具调用里显式传 allowAdult: true；两层同时成立才返回，只开设置不会改变默认行为。',
  },
]
