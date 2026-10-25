import { useId, useState, type ReactNode } from 'react'
import { ChevronDownIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * 设置页的提示块：**一句常显的标题 + 可折叠的细节**，默认收起。
 *
 * 2026-10-25 之前这些提示是七八种写法散在各张卡里：契约文案是 `p-4` 的 `<pre>` 面板、
 * MCP 是带盾牌图标的告示条、其余是裸的 `text-sm text-muted-foreground` 段落，
 * 有的整段占掉一屏。统一成一个组件之后，「这是一段说明」在页面上只有一种长相。
 *
 * ## 折叠要用 Button，不用 Accordion
 *
 * 同 `VisionSettings` 里「高级选项」那条取舍：`AccordionContent` 的高度是展开那一刻量的
 * 快照，之后长出来的内容会被静默裁掉（styling.md 那条高度快照）。这里的细节里可能装
 * 测试结果、报错和 `<pre>`，所以用 `aria-expanded` + 条件渲染。
 *
 * ## 标题是**摘要**，不是标签
 *
 * 默认收起意味着标题是用户唯一会读到的一句，所以它得自己站得住——写成「说明」或
 * 「注意事项」就是把内容藏进了一次点击后面。契约文案的标题由 `ContractTip` 从原文里
 * 取那行 ⚠️，不是另写一句。
 *
 * ## 没有细节时就是一块静态面板
 *
 * 只有一句话的提示（安全提醒、边界脚注、令牌只显示一次）不给折叠交互——一个点了没变化的
 * 按钮比没有按钮更糟。`children` 不传时渲染成不可交互的一行。
 *
 * 语气只有两档，且**都不是 `Alert`**：那是警报（`role="alert"`，读屏立刻念），
 * 而这里是说明。`warning` 只换图标与前景色，底色不动——设置页上没有红色说明块。
 */
type TipProps = {
  /** 常显的那一句。折叠状态下它是全部可见内容，所以要能独立成句。 */
  title: ReactNode
  /** 展开后看到的内容。不传则不折叠、不给箭头。 */
  children?: ReactNode
  /** `warning` 用于「这条读漏了会花错钱 / 泄露」的提示，图标换成三角警示。 */
  tone?: 'info' | 'warning'
  /** 默认收起。目前没有任何一处需要默认展开——那等于没用上这个组件。 */
  defaultOpen?: boolean
}

export function Tip({ title, children, tone = 'info', defaultOpen = false }: TipProps) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const collapsible = children !== undefined && children !== null
  const Icon = tone === 'warning' ? TriangleAlertIcon : InfoIcon

  const icon = (
    <Icon
      aria-hidden="true"
      className={cn(
        'mt-0.5 size-4 shrink-0',
        tone === 'warning' ? 'text-foreground' : 'text-muted-foreground',
      )}
    />
  )

  if (!collapsible) {
    return (
      <div
        data-slot="tip"
        className="flex items-start gap-2.5 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground"
      >
        {icon}
        <p className="min-w-0">{title}</p>
      </div>
    )
  }

  return (
    <div data-slot="tip" className="rounded-2xl border bg-muted/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 rounded-2xl px-4 py-3 text-left text-sm outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {icon}
        <span data-slot="tip-title" className="min-w-0 flex-1 font-medium">
          {title}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div id={id} data-slot="tip-body" className="px-4 pt-1 pb-4 text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * 契约文案面板（SPEC §9.9、settings-ux.md §4）。
 *
 * **原文一个字不动，只在渲染时把 ⚠️ 那行提到标题上。** 四段文案的承重句本来就是
 * ⚠️ 开头的那一行——「你的打标结果会进入公共库，所有人都会搜到」是共享库代价在界面上
 * 唯一的体现，它必须一直看得见，不能跟着细节一起收起来。其余部分（接口要求 / 推荐）
 * 默认收起，需要的人点开。
 *
 * 所以折叠改的是**构图**，不是措辞：字符串仍是 `settings-copy.ts` 里那份、逐字可比，
 * 这里只做切分。⚠️ 本身不显示（那是个 emoji），由 `TriangleAlertIcon` 承担同样的分量。
 *
 * `text-sm` 是不能更小的底线：§4 明令「不能删、不能弱化」，缩字号就是一种弱化。
 */
export function ContractTip({ text }: { text: string }) {
  const lines = text.split('\n')
  // **所有** ⚠️ 开头的行都提出来，不是只提第一行：图片向量那段有两句（「全站唯一一份」
  // 与「配好之后不会自动补算已有的图」），后一句才是它的承重句（settings-ux.md §4）。
  // 只提第一行等于把最该常显的那句收起来了。
  const warnings: string[] = []
  const rest: string[] = []
  for (const line of lines) {
    if (/^\s*⚠️?/.test(line)) warnings.push(line.trim().replace(/^⚠️?\s*/, ''))
    else rest.push(line)
  }
  // 找不到 ⚠️ 行就整段原样收进细节里、标题退回一句中性的——目前的四段都有，
  // 这条分支是给将来新加文案的人留的，不静默丢文字。
  if (warnings.length === 0) {
    return (
      <Tip title="接口要求与费用提醒">
        <NoticeText text={text} />
      </Tip>
    )
  }

  // 删掉被提走那几行留下的空段（原文里 ⚠️ 行与下一段之间通常隔一空行）
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift()

  return (
    <Tip
      tone="warning"
      title={
        warnings.length === 1 ? (
          warnings[0]
        ) : (
          <span className="flex flex-col gap-1">
            {warnings.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )
      }
    >
      <NoticeText text={rest.join('\n')} />
    </Tip>
  )
}

/**
 * 契约文案的正文：`whitespace-pre-wrap` 保住缩进与分行（那是它的结构：接口要求 / ⚠️ / 推荐
 * 三段），`wrap-anywhere` 让窄屏上的长 URL 不撑破面板，`**新开的**` 剥星号加粗。
 *
 * 不套自己的边框与底色——外层就是 `Tip` 的面板，再套一层是框里套框。
 */
function NoticeText({ text }: { text: string }) {
  return (
    <pre className="font-mono wrap-anywhere whitespace-pre-wrap">
      {text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
      )}
    </pre>
  )
}
