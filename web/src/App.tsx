import { lazy, Suspense } from 'react'
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/auth'
import { ImportProvider, useImport } from './contexts/import'
import { AppSidebar } from './components/AppSidebar'
import { ImageViewerProvider } from './components/ImageViewer'
import { Button } from './components/ui/button'
import { ScrollArea } from './components/ui/scroll-area'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from './components/ui/sidebar'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { loginPath } from './lib/api'
import { HomePage } from './routes/home'
import { BrowsePage } from './routes/browse'
import { LoginPage } from './routes/login'
import { RegisterPage } from './routes/register'
import { OAuthConsentPage } from './routes/oauth-consent'
import { NotFoundPage } from './routes/not-found'
import { isSettled } from './features/import/use-import-queue'

/*
  导入页与设置页**切出去按需加载**。

  它们不是首屏路径：`/` 与 `/browse` 是打开应用就会走的两条，用户点进设置或导入之前，
  这两页的代码只是白下载。导入页带着待确认队列与上传那套、设置页带着全部管理面板
  （用户、邀请码、打标、重建索引），是首屏包里最重的两块之一。

  用 `import()` 时**不从模块顶层 import 页面**，否则打包器按静态依赖留在首屏包里，
  `lazy` 就只剩一个空壳。`Suspense` 边界在下面 `AppLayout` 的 `<Outlet>` 上，见那里的注释。
*/
const ImportPage = lazy(() => import('./routes/import').then((m) => ({ default: m.ImportPage })))
const SettingsPage = lazy(() =>
  import('./routes/settings').then((m) => ({ default: m.SettingsPage })),
)

/**
 * 组件参照页（`/ui`）**不进生产包**。
 *
 * 它是给开发看「主题下 shadcn 组件长什么样」的，用户点不到也不需要，但它 import 了
 * **全部** `components/ui/*`——留在包里等于让每个用户多下一份谁都用不上的代码。
 *
 * 三道一起才成立：`import.meta.env.DEV` 为假时这个三元表达式常量折叠成 `null`，
 * 那条 `import()` 随之成为死代码（`vite build` 不再产出这个 chunk）；`lazy` 让开发
 * 时它也只在真的访问 `/ui` 时才加载；`Suspense` 是 `lazy` 的必需搭配，没有它整页报错。
 * 单独只用 `lazy` 是不够的——那会把参照页切成一个**仍然会发布**的 chunk。
 */
const UiPage = import.meta.env.DEV
  ? lazy(() => import('./routes/ui').then((m) => ({ default: m.UiPage })))
  : null

/** 未登录就跳登录页，并把当前地址原样带过去（state-navigation.md §5）。 */
function RequireAuth() {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />
  }
  return <Outlet />
}

/**
 * 首页那条路由：**带 `?q=` 进来的一律交棒给 `/browse`**（2026-09-26 首页改版）。
 *
 * 首页此前自己也搜——`/?q=…` 走冻结的 `GET /search`，结果渲染在同一个页面上。
 * 现在首页是入口页、不渲染结果（SPEC §9.30），带查询词进来的人想要的显然还是「搜」，
 * 所以把他送到那条真的能筛、能翻的列表上，而不是给他一张空首页。
 *
 * 谁还会带 `?q=` 进 `/`：**别人分享的老链接、书签、以及改版前的浏览器历史**。
 * 这也正是 `state-navigation.md §1` 那条（「一次搜索是可分享的状态」）的现实含义——
 * 那些链接已经散在外面了，删掉这条路等于把它们变成 404。
 *
 * 写法沿用 `/admin/*` 那三条：**`<Navigate replace />`，而且必须挂在布局路由里面**
 * （挂外面会先卸掉整条外壳再挂回来，闪一下）。
 *
 * 空词（`/?q=` 或 `/`）**不重定向**：把人送到一个空搜索的 `/browse` 上，
 * 他看到的是「没有符合条件的图片」，而明明什么都没输入。渲染首页，那个空参数就留着不发。
 */
function HomeRoute() {
  const location = useLocation()
  const q = new URLSearchParams(location.search).get('q')?.trim() ?? ''
  if (q === '') return <HomePage />
  return <Navigate to={`/browse?${new URLSearchParams({ q })}`} replace />
}

/** 导入跑着的时候顶栏留个入口，切走再切回来能找到它（import-ux.md §9）。 */
function ImportProgressLink() {
  const { phase, items, done } = useImport()
  const running = phase === 'uploading' || phase === 'processing'
  // 「有结论的」行数，判据和进度页那份是同一个（`isSettled`）：已上传但服务端还没给
  // 结论的行不算，否则顶栏这个数会跑到服务端前面。两处写两个口径是这类计数最常犯的错。
  const settled = items.filter((it) => isSettled(it.state)).length
  const total = done?.total ?? items.length

  if (!running || total === 0) return null

  return (
    <Button variant="ghost" size="sm" className="ml-auto tabular-nums" asChild>
      <Link to="/import">
        导入 {settled}/{total}
      </Link>
    </Button>
  )
}

/**
 * 按需加载的页面在下载期间的占位。
 *
 * **只有读屏看得见**（`sr-only`）：本地那个 chunk 是几十毫秒级的事，屏幕上闪一下
 * 「加载中…」比空着更扎眼。但也不能什么都不给——`Suspense` 确实会占掉一段时间
 * （慢网络下可能到一秒），读屏用户需要知道「刚才那一下点没点上」。
 * `role="status"` 是这一档的既有写法（同 `ImportProgress` 的重连提示）。
 */
function PageFallback() {
  return (
    <p role="status" className="sr-only">
      加载中…
    </p>
  )
}

/**
 * 登录后的外壳。2026-09-21 之前这里是顶部导航条 + `styles.css` 里一组 `.app__*`
 * 规则，现在换成 shadcn 的侧边导航（见 `components/AppSidebar.tsx`）。
 *
 * 顶栏**吸顶**（2026-09-21 改，此前故意不吸顶）：它唯一的常驻内容是折叠按钮，
 * 而不吸顶时按钮只在页面顶部可见——长页面往下一滚就再也折不动侧边栏了。
 *
 * 用 `sticky` 不用 `fixed`：`fixed` 把顶栏抽离文档流，下面那几处偏移量之外还得再补一层
 * `padding-top`，多一个会漂的量；`sticky` 的高度仍在流内，变的只是它在视口里的位置。
 *
 * 吸顶的代价是**几处「比它低」的地方**必须跟着算，全部按 `--app-header-h`
 * （`index.css` 的 `:root`，吸顶那天为它新加的一个值）：
 *   · 本条自己的身高（`h-(--app-header-h)`）；
 *   · 浏览页外壳被钉成 `100svh − 顶栏`（`routes/browse.tsx`；那一页试过 `sticky`
 *     左栏，实测「结果列比视口矮时可粘余量为 0」，第三稿改成的钉高布局）；
 *   · 页内 `scrollIntoView` 的落点（`scroll-mt`）——**这一项按档分**：手机档顶栏还盖着
 *     窗口滚动的页面，要加 56；md 以上页面滚的是内容区、顶栏是它的兄弟节点不是盖在它
 *     上面，那一档只有 16。（原先的实例是设置页长页的锚点，2026-10-25 设置页改成一次一段、
 *     切段即回顶，那一处撤了；将来再有就照这两档算。）
 *   · toast 避让顶栏的 `offset.top`（`components/ui/sonner.tsx`）。
 * （**三处抽屉不在这张表里**：它们在 Radix 那一层、压得住顶栏，所以按注册表原样全高，
 * 见下面 `z-index` 那段。）
 * 顶栏还得是不透的，所以 `bg-background` 不能省——省了不报错，是内容从顶栏底下透出来；
 * md 以上没有遮挡关系了（滚动区在它下面），但手机档仍是窗口滚到它底下，这一条照样成立。
 *
 * ## z-index 20（2026-09-22 定；当天先从 `z-10` 抬到 9999、又落到 60，最终收到 20）
 *
 * 抬起来是修一个**真的会画错**的现象：卡片上的角标 /「⋯」/ 收藏
 * （`components/MemeCard.tsx`）也是 `z-10`，而它们 DOM 更靠后，`SidebarInset` 又只是
 * `relative`（**不构成层叠上下文**）——同一层里按 DOM 顺序比，滚动时卡片浮层会画到顶栏上面。
 * 20 > 10，这个缺陷是修好的（首页图墙那种不带 `transform` 的卡片格子上量得到）。
 *
 * **20 这个数只和两个邻居有关**，不是「越大越保险」：
 *   · 卡片浮层 `z-10`、侧边栏 `z-10`（轨道那条 `z-20` 的细线与顶栏不相交）—— 在下面；
 *   · Radix 那一层 `z-50`（手机端导航抽屉、Dialog、Sheet、Select、Popover）—— 在**上面**。
 *
 * ⚠️ **顶栏必须低于 Radix 那一层**，反过来（60 / 9999 那两版）都错过一次：顶栏一旦高过
 * 50，三处全高面板就被它切成「顶栏 + 面板」上下两条同时显示——手机端开导航抽屉时屏幕上
 * 还留着一条 56px 的顶栏和一个 ☰，产品负责人 2026-09-22 报的就是这个
 * （「和侧边栏展开有冲突，会一起显示」）。那条顶栏还是**假的**：Radix 的模态机制给 `body`
 * 挂了 `pointer-events: none`，在它上面按下命中的是遮罩、效果是**把抽屉关掉**，
 * 不是「顶栏还活着、点 ☰ 能开合导航」。
 *
 * 20 < 50 之后，三处抽屉按注册表原样全高（`inset-y-0`），遮罩也蒙住顶栏，
 * 不用再给它们各写一段 `top-(--app-header-h)`——省掉的正是那段推导。
 *
 * 全屏阅览（`components/LightboxViewer.tsx`）不受影响：`.yarl__portal` 自带 `z-index: 9999`，
 * 本来就是数值最大的那一个。
 */
function AppLayout() {
  return (
    // Radix 的 Tooltip 没有 Provider 会**直接抛错**（不是降级），
    // 而侧边栏的图标窄栏模式全靠 tooltip 显示菜单名。registry 的 SidebarProvider
    // 里不含 Provider，这一步漏了整个应用白屏。
    <TooltipProvider>
      <SidebarProvider>
        {/*
          全屏阅览挂在**这一层**，不是挂在卡片里。位置是有讲究的：它包住 `SidebarInset`，
          于是 `<Lightbox>` 的 React 祖先链只有外壳，**不经过任何页面**——否则首页那个挂在
          根 `<section>` 上的键盘 handler 会连阅览器里的 Esc / ↑↓ 一起接走
          （`components/ImageViewer.tsx` 头部有完整推导，那是本次最容易静默出错的一处）。
          `Enter` 2026-09-26（裁定 4）起不再是泄漏项，原因写在同一处，别照着这一行的键列表
          去核对。
        */}
        <ImageViewerProvider>
          <AppSidebar />
          {/*
            ## 页面级的滚动发生在**内容区**，不在窗口（2026-09-26）

            改前这两个类都没有：外壳是自然高度、页面滚的是**窗口**
            ——于是这一页显示的是**系统原生滚动条**（桌面 15px，macOS 上还会随系统偏好整条
            消失），与浏览页 / 两条 rail 那几根 Radix 浮层条在同一屏上不像一套。
            现在 md 以上由下面那个 `ScrollArea` 承担滚动，全站一种条。

            **手机档刻意不改**（`md:` 前缀，不是漏写）：

            - 触屏本来就不显示滚动条，换过去在视觉上什么也换不到；
            - 窗口能滚，iOS / Android 的地址栏才会随滚动收起，换成内部滚动区就**永久少掉
              那条地址栏让出的高度**；
            - `BrowseResults` 手机那一档的瀑布流指标读的就是 `window.scrollY`（它按「谁真的
              在滚」分支），窗口留着，那段代码一行不用动。

            代价是「谁在滚」这件事**按断点分叉**：任何依赖滚动量的代码都要自己认档
            （`features/browse/BrowseResults.tsx` 的瀑布流指标就是按「谁真的在滚」分的那两支）。

            `md:h-svh` 的尺子必须是 `svh`：浏览页把自己的高度钉成
            `100svh − var(--app-header-h)`，两把尺不一样的话那一页会差出地址栏那一段。
          */}
          <SidebarInset className="md:h-svh md:overflow-hidden">
            {/*
              `sticky` 现在只对手机档有意义（那一档页面仍在滚窗口，长页面往下一滚还得能
              折侧边栏）；md 以上滚动发生在下面那层，顶栏本来就不动，`sticky` 是惰性的
              ——**但不删**：删了手机档就没吸顶了，而两档共用这一份 JSX。

              `z-20` 的理由也随之改了一半：改前它压的是「滚动时卡片浮层画到顶栏上」，
              现在卡片在下面的滚动区里、本来就压不到顶栏。留着是因为两处的层叠顺序由它
              一次说清（卡片浮层 `z-10` 在滚动区内部，顶栏 `z-20` 在它之上），
              以及手机档还有窗口滚动这一档。**别往上抬**：Radix 那一层（抽屉 / Dialog /
              Sheet）是 `z-50`，抬过 50 就会被顶栏切成两条（2026-09-22 那次就是这个问题）。
            */}
            <header className="sticky top-0 z-20 flex h-(--app-header-h) shrink-0 items-center gap-2 border-b bg-background px-4">
              {/*
                44 是手机那一档的（手指按抽屉开关），鼠标那一档回到 32——
                一个 44 的方块摆在 56 高的顶栏里，四周的空比图标本身还大。
                闸门是指针不是宽度，理由同 `lib/touch.ts`。
              */}
              <SidebarTrigger className="size-11 pointer-fine:size-8" />
              {/*
                进度放顶栏而不是侧边栏：手机端（<768px）整条导航收进抽屉，
                侧边栏上的角标就看不见了，而 import-ux.md §9 要的是「切走再切回来还能看到」。
                折叠成图标窄栏时侧边栏角标同样会隐藏，顶栏是唯一两个形态下都在的位置。
              */}
              <ImportProgressLink />
            </header>
            {/* `SidebarInset` 自己就是 `<main>`，这里不能再套一层，会出现两个 main 地标 */}
            {/*
              ## 页面滚动区

              `type="always"` 是**必需的**，不是保险：Radix 的 viewport 高度是按「挂着哪几根
              条」定的——`overflow-y` 在有条时是 `scroll`、没条时**是 `hidden`**
              （`@radix-ui/react-scroll-area` 的 `ScrollAreaViewport`）。默认的 `type="hover"`
              要 `pointerenter` 才挂上条，于是**指针没进过内容区之前这一页根本不能滚**：
              键盘 / PageDown / `scrollIntoView`（设置页 MCP 段滚到 `#mcp-content-scope` 那条）全都不动，
              **而且不报任何错**。`type="always"` 一进页面就挂条，首帧起就是 `scroll`，
              与它替下来的原生窗口滚动行为逐项一致。滑块仍然是**真溢出时才画**
              （`hasThumb`：`viewport/content` 落在 (0,1) 之间才有），所以短页面不会多出一根。

              ## `[&>[data-slot=scroll-area-viewport]>div]:block!` 不是凑数的

              Radix 在 viewport 里套了一层行内样式写死 `min-width:100%; display:table` 的
              盒子（见 `components/ui/scroll-area.tsx` 头部）。表盒的宽度**上限是内容的
              min-content**，而首页那两条 rail 的行是 `shrink-0` 的横排（`features/home/MemeRail.tsx`）
              ——它本来就该比屏幕宽、由 rail 自己那根横条来滚，可它的 min-content 会
              一路穿过 rail 的 viewport 顶进这层表盒：实测 1264 窗口下首页内容层被撑到
              **1200px**（其余页面都是 1008），`max-w-6xl` 那层因此按 1152 排、右半边被
              viewport 裁掉。压回块级之后宽度就只由这一层决定，与改版前逐像素一致。

              压的是**这层表壳**（`>` viewport `>` div，必须逐级直取）：写成后代选择器会
              连 rail 自己那层表壳一起压，那是另一件事（rail 的横条靠它撑宽）。
              其余页面本来就不受这层影响，`min-width:100%` 的兜底在它们那里是准的。

              `p-6` 留在 viewport **里面**：内边距要跟着内容一起滚。浏览页那条
              `md:-my-6 md:py-6` 的算式正是靠它——那个 `-my-6` 取消的就是这 24px。

              手机档 `md:flex-1` 不生效，这一层高度由内容决定（与浏览页结果列同一档），
              页面照旧滚窗口，见 `SidebarInset` 那段。
            */}
            <ScrollArea
              type="always"
              className="md:min-h-0 md:flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!"
            >
              <div className="p-6">
                {/*
                  按需加载的页面在这里兜底（`Suspense` 是 `lazy` 的必需搭配，没有它整页报错）。
                  边界**包 `Outlet` 而不是包整个 `Routes`**：包在外面的话，一次切页会把侧边栏
                  与顶栏一起换成 fallback，整条外壳闪一下——用户看到的像是应用重开了。
                  在这一层，外壳留着、换掉的只有内容区。
                */}
                <Suspense fallback={<PageFallback />}>
                  <Outlet />
                </Suspense>
              </div>
            </ScrollArea>
          </SidebarInset>
        </ImageViewerProvider>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export function App() {
  return (
    <AuthProvider>
      {/* 导入队列挂在这里而不是 /import 里：切到搜索页时它要继续跑（import-ux.md §9） */}
      <ImportProvider>
        {/*
          全站提示挂在这一层，**在 `Routes` 之外**：登录 / 注册两条路由不带 `AppLayout`，
          挂进外壳那两页就没有提示可用（而那两页的失败态本来就在页内，见 `feedback.md`）。
          位置、层级、避开顶栏那几条都在 `components/ui/sonner.tsx` 里。
        */}
        <Toaster />
        <Routes>
          {/*
            登录 / 注册不带外壳。它们各自是一个专注任务页，旁边挂一条导航栏只是噪音；
            以前带导航是顶部条时代的遗留（那条导航在两页上也几乎全是登录后才有效的入口）。
          */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          {/*
            MCP OAuth 同意页（SPEC §10.10.3）：api 的 `/oauth/authorize` 把人 302 到这里。
            和上面两页同级、不进 `AppLayout`——它是授权流程的中转站，不是产品界面；
            未登录的回登录页也由页面自己判断（带上带 ticket 的 `next`）。
          */}
          <Route path="/oauth/consent" element={<OAuthConsentPage />} />

          <Route element={<AppLayout />}>
            <Route element={<RequireAuth />}>
              <Route path="/" element={<HomeRoute />} />
              <Route path="/browse" element={<BrowsePage />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>

            {/* 开发期才有这条路由（见文件上方 `UiPage` 的推导）。生产包里 `UiPage` 是
                `null`，真的有人手工敲 `/ui` 会落到下面的 `*` 路由，得到 404 页。 */}
            {UiPage !== null && (
              <Route
                path="/ui"
                element={
                  <Suspense fallback={null}>
                    <UiPage />
                  </Suspense>
                }
              />
            )}

            {/*
              三个管理页并进了 /settings（见 routes/settings.tsx）。旧地址保留成重定向而不是
              直接删掉：管理员的书签和文档里的链接都指着它们，404 比多留三行路由贵。
              放在布局路由**里面**——放外面的话重定向会先卸掉整条外壳再挂回来，闪一下。
            */}
            <Route path="/admin" element={<Navigate to="/settings" replace />} />
            <Route
              path="/admin/invites"
              element={<Navigate to="/settings#invites" replace />}
            />
            <Route
              path="/admin/users"
              element={<Navigate to="/settings#users" replace />}
            />
            <Route
              path="/admin/embedding"
              element={<Navigate to="/settings#embedding" replace />}
            />

            {/* `*` 路由验证「刷新任意深层 URL 不 404」，见 api/src/server.ts mountWebDist */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </ImportProvider>
    </AuthProvider>
  )
}
