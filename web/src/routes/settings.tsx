import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/auth'
import { EmbedSettings } from '../features/settings/EmbedSettings'
import { InviteSettings } from '../features/settings/InviteSettings'
import { McpSettings } from '../features/settings/McpSettings'
import { ReindexPanel } from '../features/settings/ReindexPanel'
import { RetagPanel } from '../features/settings/RetagPanel'
import { RuntimeSettings } from '../features/settings/RuntimeSettings'
import { SettingsNav } from '../features/settings/SettingsNav'
import { pickSection, SETTINGS_SECTIONS, type SettingsSectionId } from '../features/settings/settings-sections'
import { UsersSettings } from '../features/settings/UsersSettings'
import { VisionSettings } from '../features/settings/VisionSettings'

/**
 * 设置页：所有设置项都在这一页，管理员比普通用户多一组「全站管理」。
 *
 * **原来的 `/admin/invites`、`/admin/embedding`、`/admin/users` 三页并进来了**，旧地址
 * 重定向到对应分区（App.tsx）。合并的是**呈现**，不是权限：管理员分段对普通用户根本不渲染，
 * 而真正的权限在服务端（state-navigation.md §4）。
 *
 * ⚠️ Embedding **仍然是全站一份、仅管理员可改**（SPEC §9.6）——这条没有因为并页而变。
 * 它现在是设置页里的一个管理员分段，不是每人一份的用户设置。settings-ux.md §2 的
 * 「两个页面」和 SPEC §9.9 的「分成两个页面」是按旧结构写的，见
 * 任务 2026-09-18-settings-merge。
 *
 * 统计面板（settings-ux.md §9）仍未做——**它要的端点已经有了**（`GET /memes/tag-status?scope=all`
 * 早就支持），只是没人把「全站：已完成 / 待处理 / 需人工 / 索引过期」这一行画出来。
 * 目前全站计数只在 `RetagPanel` 里露了三个（作为重打标的进度），索引过期那一个仍无从查看。
 * 待办留在任务 2026-09-19-tagging-status。
 *
 * ## 一次只显示一段（2026-10-25，任务 2026-10-25-设置页分区导航）
 *
 * 左侧（窄屏是上方一行）列分区，右侧只显示当前那一段；分区地址就是 `#hash`
 * （表在 `settings-sections.ts`）。这推翻了 settings-merge 时「不做页签」的决定，
 * 理由与对照写在 settings-ux.md §2。
 *
 * ⚠️ **页面上有两种「看不见」，不能统一成一种：**
 *
 * - **管理员分段对成员是「不渲染」**（下面的 `isAdmin &&`）：那是权限分块，
 *   DOM 里根本没有这些内容（settings-ux.md §2 的硬话）。
 * - **非当前段是 `hidden`**：用户有权看、只是没轮到显示。段**一直挂着**，所以三样东西
 *   不会因为切段丢掉——视觉「高级选项」里填了一半的表单、重建索引 / 重新打标的轮询、
 *   `RetagPanel` 只活在组件状态里的 `enqueuedCount` 基线（进度条的分母，settings-ux.md §10）。
 *   `hidden` 同时把内容移出 Tab 顺序与无障碍树，所以不用透明度、不移出视口。
 *   网络请求和整页时代一样多（那时本来就是全量加载），不算新增负担。
 *
 * 别因为有了 `hidden` 就把管理员分段也改成 `hidden`——那等于把权限分块降成了 CSS 隐藏。
 *
 * 2026-09-21：整页换成 shadcn 组件（原来是一套手写 BEM）。分段、顺序、折叠、管理员可见性
 * 都是契约，换的是它们长什么样。
 */
export function SettingsPage() {
  const { user } = useAuth()
  const { hash } = useLocation()
  const isAdmin = user?.role === 'admin'

  // 确认换模型后服务端会自动排重算，让重建进度区立刻重拉一次，不干等轮询
  const [reindexToken, setReindexToken] = useState(0)

  const visible = SETTINGS_SECTIONS.filter((s) => s.group === 'mine' || isAdmin)
  const active = pickSection(hash, visible)

  const rootRef = useRef<HTMLDivElement>(null)

  /*
   * 切段后回到内容区顶部。**两处都滚、不判断档位**：md 以上滚的是外壳那个 `ScrollArea`
   * 的 viewport、窗口不动；手机上反过来（styling.md「页面滚什么」）。对不在滚的那一个
   * 设 0 是空操作，所以不需要知道现在是哪一档。
   *
   * 首次进来也滚：外壳的滚动区是各页共用的，从别的页面滚到一半点进来，它还停在那个位置。
   *
   * 以前这里是 `useHashScroll`：盯着整页高度反复对齐锚点，因为上面的段数据回来会把
   * 下面的锚点往下推。一次一段之后段的位置不再随别的段变化，那一整套撤了。
   */
  useEffect(() => {
    rootRef.current?.closest('[data-slot=scroll-area-viewport]')?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [active])

  return (
    <div ref={rootRef} className="@container mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? '视觉模型与 MCP 接入是你自己的一份；邀请码、Embedding 与用户是全站的。'
            : '视觉模型与 MCP 接入是你自己的一份，其余设置由管理员维护。'}
        </p>
      </header>

      <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-start @3xl:gap-8">
        <SettingsNav sections={visible} active={active} />

        <div className="min-w-0 flex-1">
          <Section id="vision" active={active}>
            <VisionSettings />
          </Section>

          {/*
            MCP 接入对所有登录用户可见，管的是「你自己的个人访问令牌」
            （SPEC §6.8 只有本人可见，没有管理员视图）。
          */}
          <Section id="mcp" active={active}>
            <McpSettings />
          </Section>

          {isAdmin && (
            <>
              <Section id="invites" active={active}>
                <InviteSettings />
              </Section>

              {/*
                重建进度和配置是**并列**的两张卡、在**同一段**里，不是弹窗套弹窗：
                换模型触发的重算要跑几分钟，管理员确认之后要马上看到进度，
                看着进度还能继续干别的（settings-ux.md §8）。
              */}
              <Section id="embedding" active={active}>
                <EmbedSettings onReindexTriggered={() => setReindexToken((n) => n + 1)} />
                <ReindexPanel refreshToken={reindexToken} />
              </Section>

              {/*
                ⚠️ 这里原本是「图片向量」那张配置卡（`ImageEmbedSettings`）与它下面的补跑面板
                （`PersonsReindexPanel`）——两条独立的配置流，形状与上面 Embedding + ReindexPanel
                那一对同构（配置在上、动作在下）。2026-10-01 起随人物聚类暂停一起下线，
                组件仍在 `features/settings/`，恢复时包成 `image-embed` 一段挂回这个位置
                （`settings-sections.ts` 头注释、任务 2026-10-01-人物功能临时下线 §5）。
              */}

              <Section id="runtime" active={active}>
                <RuntimeSettings />
              </Section>

              {/*
                重打标与重建索引是**并列**的两件事，不是一件事的两个阶段：重建索引只重算
                向量、不调视觉；重打标反过来只调视觉、且不幂等（SPEC §6.4.3）。
                所以它**单独成段**，不和重建索引挨着（settings-ux.md §10）。
                `refreshToken` 仍跟着换模型走：换完模型之后它的计数也该重拉一次。
              */}
              <Section id="retag" active={active}>
                <RetagPanel refreshToken={reindexToken} />
              </Section>

              <Section id="users" active={active}>
                <UsersSettings />
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 一段。非当前段是 `hidden`（**挂着、不显示**），理由见文件头。
 *
 * ⚠️ **段上故意不挂 `id`**，地址只写在 `data-section` 里。挂了 `id="mcp"`，浏览器会在
 * 直达 `/settings#mcp` 和 hash 变化时**自己**滚到这个元素——它在页标题下面，落点是
 * 往下 104px（md 档）/ 260px（手机档），而且发生在上面「回顶」之后，回顶白做。
 * 实测只在段比一屏高时露出来（矮段没得滚），所以很容易以为没事。
 * 段与哪个分区对应，靠 `pickSection` 算出来的 `active`，用不着浏览器认这个锚点。
 */
function Section({
  id,
  active,
  children,
}: {
  id: SettingsSectionId
  active: SettingsSectionId
  children: ReactNode
}) {
  const label = SETTINGS_SECTIONS.find((s) => s.id === id)?.label
  return (
    <section data-section={id} aria-label={label} hidden={id !== active} className="flex flex-col gap-6">
      {children}
    </section>
  )
}
