import type { ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../../components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs'
import { TOUCH } from '../../lib/touch'
import { cn } from '../../lib/utils'
import {
  MCP_CHANNELS,
  MCP_CLIENT_TABS,
  MCP_FAQ,
  MCP_LIMITS,
  MCP_SAFETY,
  MCP_TOOLS,
  TOKEN_PLACEHOLDER,
  bearerHeader,
  claudeCodeCommand,
  claudeDesktopConfig,
  cursorConfig,
  mcpEndpoint,
  mcpRemoteCommand,
  mcpRemoteConfig,
} from './mcp-copy'
import { COPY_FAILED_TEXT, useCopyText } from './use-copy-text'

/**
 * 「MCP 接入指南」侧边抽屉（设置页 · 查看完整接入指南）。
 *
 * ## 内容分五节，顺序就是用户接进来的顺序
 *
 * 准备 → 客户端配置 → 让模型用起来 → 接到 IM → 限制与安全。第 2 节按客户端分页签，
 * 是**唯一需要交互的部分**；其余全是静态内容。**不用 `Accordion`**：本仓那条
 * 「Radix 折叠高度是展开那一刻的快照」的坑（styling.md）不值得为一个静态抽屉再踩一次，
 * 而且这里的页签是「同一件事换个客户端看」，本来就不该叠起来。
 *
 * ## 这里的令牌永远是占位符
 *
 * 设置页这一刻**拿不到完整令牌**（API 只回 `prefix`），所以片段里写 `TOKEN_PLACEHOLDER`。
 * 只有「令牌已创建」弹窗里的「复制配置片段」才带真令牌——那边由
 * `McpTokenCreatedDialog` 自己生成，不要把两条路混成一个组件。
 *
 * ## 文案归属
 *
 * 静态内容来自 [`docs/mcp.md`](../../../../docs/mcp.md) §3–§8。渠道名与「机器人要做什么」
 * 是文档里那张表；**字段名、阈值、资质要求一律指向各渠道官方文档**，本仓库没在真实渠道
 * 验收过的都写「接入时实测」——这是 [SPEC §10.5](../../../../spec/10-mcp.md) 的口径，
 * 不要在 UI 里把它们升级成承诺。
 */

/** 每节的开头。`trailing` 给第 3 节那枚「5 个工具」角标。 */
function Section({
  index,
  title,
  trailing,
  children,
}: {
  index: number
  title: string
  trailing?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">
          {index}. {title}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  )
}

/**
 * 带复制的代码块。
 *
 * `overflow-x-auto` 是**块内**横向滚动（代码行本来就长），页面与抽屉本身不横溢。
 * 复制按钮绝对定位在右上角，所以 `pre` 右侧留了 `pr-20`——不然长行的开头会被它压住。
 */
function CodeBlock({ code, label }: { code: string; label: string }) {
  const { target, state, copy } = useCopyText()
  const copied = target === code && state === 'copied'
  const failed = target === code && state === 'failed'

  return (
    <div className="relative rounded-2xl border bg-muted/40">
      <pre className="overflow-x-auto px-4 py-3 pr-20 font-mono text-xs leading-relaxed">
        {code}
      </pre>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(TOUCH, 'absolute top-2 right-2')}
        onClick={() => copy(code)}
        aria-label={`复制${label}`}
      >
        {copied ? '已复制' : '复制'}
      </Button>
      {failed && (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {COPY_FAILED_TEXT}
        </p>
      )}
    </div>
  )
}

/** 行内代码（与设置页那几处同一个配方）。 */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere">
      {children}
    </code>
  )
}

export function McpGuideSheet({
  origin,
  trigger,
}: {
  /** 运行时 origin：片段里的接入地址 = origin + `/mcp`。 */
  origin: string
  /** 触发按钮（`SheetTrigger asChild`）。**由调用点给，不在这个组件里长按钮**：
   *  它在设置页标题行上，和抽屉内容不是同一块布局。 */
  trigger: ReactNode
}) {
  const endpoint = mcpEndpoint(origin)
  const placeholderToken = TOKEN_PLACEHOLDER

  return (
    <Sheet>
      {/*
        用 `SheetTrigger` 而不是「受控 open」：Radix 关抽屉时会把焦点还给触发器。
        自己拿 state 开、又没有 trigger 的话，焦点会掉在 body 上——键盘用户按 Esc 之后
        就在这一页里失位了（`MemeActions` 的注释记过同一条）。
      */}
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      {/*
        宽度要带**同一个 `data-[side=right]:` 前缀**才盖得住注册表的 `w-3/4`
        （变体不同不合并，见 `MemeEditPanel` 的注释）。移动端全宽，桌面 576px。
        注册表那枚关闭按钮是 32px 且没有 className 口子，所以关掉、自己放一个
        （同 `BrowseFilterSheet` / `AppSidebar` 对注册表缺陷的做法）。
      */}
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="shrink-0 flex-row items-start justify-between gap-4 border-b p-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <SheetTitle>MCP 接入指南</SheetTitle>
            <SheetDescription>把 MeMeMio 的表情包库接进 LLM 聊天客户端或 IM 机器人。</SheetDescription>
          </div>
          <SheetClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-8 pointer-coarse:size-11 bg-secondary"
              aria-label="关闭"
            >
              <XIcon className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        {/* 只让中间这段滚、标题常驻（同 `BrowseFilterSheet` 的结构） */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          <div className="flex flex-col gap-8 p-6">
            <Section index={1} title="先准备两样东西">
              <p className="text-sm text-muted-foreground">
                接入地址 <Code>{endpoint}</Code>，以及一个访问令牌。令牌在设置页创建，只能读取。
              </p>
            </Section>

            <Section index={2} title="客户端配置">
              <Tabs defaultValue="claude" className="gap-3">
                {/*
                  页签在手机上会折行（四个标签加起来比 390 的抽屉宽）。`h-auto!` 必须写在
                  **触发器**上：注册表给的是 `h-[calc(100%-1px)]`，而 `TabsList` 一旦
                  折成两行，每个触发器仍按整个容器的高算，第二行会盖住下面的说明文字
                  （实测：390 档两行各 63px，压住「命令行添加…」那一行；而且不报错）。
                  `TOUCH` 补 44px 触摸目标，与设置页其他可点控件同一条规则。
                */}
                <TabsList className="h-auto! w-full flex-wrap justify-start rounded-2xl p-1">
                  {MCP_CLIENT_TABS.map((tab) => (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      className={cn(TOUCH, 'h-auto! flex-none px-3')}
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                <TabsContent value="claude" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    命令行添加（推荐，Claude Code 直接读取）：
                  </p>
                  <CodeBlock
                    label=" Claude Code 添加命令"
                    code={claudeCodeCommand(origin, placeholderToken)}
                  />
                  <p className="text-sm text-muted-foreground">或者写进配置文件：</p>
                  <CodeBlock
                    label=" Claude Desktop 配置"
                    code={claudeDesktopConfig(origin, placeholderToken)}
                  />
                  <p className="text-xs text-muted-foreground">
                    改完完全退出并重启客户端。配置文件里会留下明文令牌，不要提交到仓库。
                  </p>
                </TabsContent>

                <TabsContent value="cherry" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    「设置 → MCP 服务器 → 添加服务器」：
                  </p>
                  <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
                    <li>类型选 Streamable HTTP（有的版本叫「HTTP」）。</li>
                    <li>
                      URL 填 <Code>{endpoint}</Code>。
                    </li>
                    <li>在「自定义请求头」里加：</li>
                  </ol>
                  <CodeBlock
                    label=" Cherry Studio 请求头"
                    code={bearerHeader(placeholderToken)}
                  />
                  <p className="text-xs text-muted-foreground">
                    保存后如果工具列表为空，先确认请求头确实带上了——不少客户端把自定义头放在二级设置里。
                    菜单名称随版本变化，以客户端为准。
                  </p>
                </TabsContent>

                <TabsContent value="cursor" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    在项目 <Code>.cursor/mcp.json</Code> 或用户级 <Code>~/.cursor/mcp.json</Code>{' '}
                    写：
                  </p>
                  <CodeBlock
                    label=" Cursor 配置"
                    code={cursorConfig(origin, placeholderToken)}
                  />
                  <p className="text-xs text-muted-foreground">
                    保存后在 MCP 面板刷新，应出现 mememio 的 5 个工具。字段名、是否要求{' '}
                    <Code>type</Code>（http / streamable-http）以当前 Cursor 版本为准。
                  </p>
                </TabsContent>

                <TabsContent value="stdio" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    只支持 stdio 的客户端用 <Code>mcp-remote</Code> 桥：
                  </p>
                  <CodeBlock
                    label=" mcp-remote 命令"
                    code={mcpRemoteCommand(origin, placeholderToken)}
                  />
                  <p className="text-sm text-muted-foreground">写进客户端配置时：</p>
                  <CodeBlock
                    label=" stdio 桥配置"
                    code={mcpRemoteConfig(origin, placeholderToken)}
                  />
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                    <li>首次运行会下载依赖，机器需要能访问 npm；内网环境先全局安装再接。</li>
                    <li>
                      Windows 上部分客户端不认 npx 直接作为命令，改成 cmd + /c + npx，以客户端文档为准。
                    </li>
                    <li>
                      <Code>--header</Code> 的参数格式随 mcp-remote 版本可能变化，跑{' '}
                      <Code>npx mcp-remote --help</Code> 确认。
                    </li>
                  </ul>
                </TabsContent>
              </Tabs>
            </Section>

            <Section
              index={3}
              title="让模型用起来"
              trailing={<Badge variant="outline">5 个工具</Badge>}
            >
              {/* 工具表：窄屏「名称 / 说明」堆叠，sm 以上两列。`Table` 的单元格默认
                  不换行，这一张又长又窄，所以不用它。 */}
              <ul className="flex flex-col divide-y rounded-2xl border">
                {MCP_TOOLS.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex flex-col gap-1 p-3 sm:grid sm:grid-cols-[11rem_1fr] sm:gap-3"
                  >
                    <code className="font-mono text-xs font-medium">{tool.name}</code>
                    <p className="text-sm text-muted-foreground">{tool.summary}</p>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                同一维度多值取 AND；词表外的值不报错、直接返回空结果。先调{' '}
                <Code>list_vocab</Code> 比让模型猜维度名可靠。
              </p>
            </Section>

            <Section index={4} title="接到微信 / QQ / LINE">
              <p className="text-sm text-muted-foreground">
                MCP 只负责把图交给你的机器人；真正发到渠道，由机器人调用各渠道的官方接口完成。
              </p>
              <ul className="flex flex-col divide-y rounded-2xl border">
                {MCP_CHANNELS.map((channel) => (
                  <li
                    key={channel.name}
                    className="flex flex-col gap-1 p-3 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{channel.name}</span>
                      {channel.warning && <Badge variant="destructive">无官方接口</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{channel.detail}</p>
                  </li>
                ))}
              </ul>
            </Section>

            <Section index={5} title="限制与安全">
              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-medium">限额与成本</h4>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  {MCP_LIMITS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-medium">安全</h4>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                  {MCP_SAFETY.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <h4 className="text-sm font-medium">常见问题</h4>
                <dl className="flex flex-col gap-3">
                  {MCP_FAQ.map((item) => (
                    <div key={item.q} className="flex flex-col gap-0.5">
                      <dt className="text-sm font-medium">{item.q}</dt>
                      <dd className="text-sm text-muted-foreground">{item.a}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
