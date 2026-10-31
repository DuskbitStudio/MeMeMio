import type { ReactNode } from 'react'

/**
 * 未登录三页（`/login`、`/register`、`/oauth/consent`）共用的外壳：lg 以上左品牌、右表单。
 *
 * 同意页也用它（2026-10-31 加入）：它是授权流程的中转站，不是产品界面——
 * 进应用外壳（侧边栏 + 搜索框）会让人以为已经登进了主界面。共用这一份还顺带保证了
 * 「别人点开链接」的三处第一屏在 LOGO 尺寸与留白上不会悄悄分叉。
 *
 * ## 为什么两页共用一份
 *
 * 分栏比例、品牌区、左边距**必须是同一份**。各写一份不会报错，只会让两页的 LOGO 尺寸
 * 与留白悄悄分叉——而这两页恰是「别人点开你发来的链接」时的第一屏，差一点点就很难看。
 *
 * ## 品牌区只有 LOGO，没有标语（2026-09-23 产品负责人明确要求）
 *
 * 左边**只有 mark + 字标**。那一片空白是留给它的，不是没写完。
 * 以后要往里补内容就补在这里，**不要往表单那一侧塞营销文案**。
 *
 * ## 窄屏把品牌区压成一行顶栏，表单占满剩下的高度
 *
 * 手机是这个产品的主场（styling.md「移动端不是适配，是主场」），登录页不该让人先滚过
 * 一段品牌区才够得着输入框。所以 `lg` 以下品牌区退化成一条带底边的顶栏。
 *
 * 表单那层写 `flex-1` 而不是跟着内容高度走：不写的话它会贴着品牌区往上顶，
 * 下半屏全空着，看起来像没加载完。
 *
 * ## 左栏比右栏窄（`2fr_3fr`）
 *
 * 品牌区只有一颗 LOGO，占掉一半宽度会显空；表单那侧还要装输入框、密码显隐、错误面板
 * 与页脚链接，给它更多。
 *
 * `min-h-[100dvh]` 不用 `h-screen`：`100vh` 在 iOS Safari 上是**含地址栏**的高度，
 * 用它的表现是首屏就能上下滑一小段。
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col lg:grid lg:grid-cols-[2fr_3fr]">
      <BrandPane />
      <div className="flex flex-1 items-center justify-center px-6 py-10 lg:px-12">
        {/* `max-w-sm`（24rem）不是随手写的：再宽，单行输入框在 1440px 的屏幕上会横贯半屏，
            眼睛得来回扫；再窄，「找已经在用的成员要一个」这类提示会折成三行。 */}
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  )
}

/**
 * 品牌区。两颗 LOGO 走 `<picture>` + `<source media>`，与 `AppSidebar.tsx` 同一套做法，
 * 理由也一样（那边有完整推导）：SVG 走 `<img>` 时取不到页面的 `currentColor`，
 * 而**在 SVG 文件里写 `@media (prefers-color-scheme: dark)` 在 WebKit 上不生效**——
 * 深色下会变成深底上的深图形，不是不好看，是看不见。所以备两份文件、由页面这一侧挑
 * （`<source media>` 是页面求值的），只下载用到的那一份。
 *
 * `alt` 的分工同侧边栏：文字 LOGO 是图形化的产品名，`alt="MeMeMio"` 让读屏念出来；
 * 图形 LOGO `alt=""`，名字已经由前者给了，不必读两遍。
 *
 * 尺寸比侧边栏那两颗大一档（那边是 `size-5` + `h-4`，收在导航项里）：
 * 这里是整页唯一一处品牌露出，太小就不成其为品牌区了。
 */
function BrandPane() {
  return (
    <div className="flex items-start border-b bg-muted px-6 py-8 lg:border-r lg:border-b-0 lg:px-12 lg:py-12">
      <div className="flex items-center gap-2">
        <picture className="contents">
          <source srcSet="/mememio-mark-dark.svg" media="(prefers-color-scheme: dark)" />
          <img src="/mememio-mark.svg" alt="" className="size-8 shrink-0" />
        </picture>
        <picture className="contents">
          <source srcSet="/mememio-wordmark-dark.svg" media="(prefers-color-scheme: dark)" />
          <img src="/mememio-wordmark.svg" alt="MeMeMio" className="h-6 w-auto shrink-0" />
        </picture>
      </div>
    </div>
  )
}
