# 目录结构

## 按业务切，不按类型切

```
src/features/
├─ home/         首页两条 rail、待处理状态条
├─ discover/     首页随机图墙（「随便看看」）
├─ browse/       筛选器、无限滚动
├─ import/       上传、SSE 进度、待确认队列
├─ tagging/      打标进度、待处理列表
├─ manage/       编辑标签、删除
├─ settings/     用户设置、管理页
└─ auth/         登录 / 注册的表单与未登录外壳
```

> `search/` 2026-09-21 落地（`SearchResults.tsx` 五态 + 结果项、`use-search.ts` 的 state 机与
> 键盘路径），**2026-09-26 整个目录删除**：首页改版之后首页不渲染结果（SPEC §9.30），
> 那条列表与那套键盘路径都没有落点了（任务 2026-09-26-首页改版 §5.2）。
> `SearchBar.tsx` 早在同一天**搬到了 `components/`**——检索与筛选合流之后浏览页也要那个框
> （[state-navigation.md §6](state-navigation.md)），两个页面各写一份必然漂。
> **同一个 feature 内部按「一个文件一件事」切，
> 不按类型切**——那个目录里没有 `components/` / `hooks/`，`use-search.ts` 与两个组件平级。
> 搬家的动机是 `routes/home.tsx` 涨到 326 行（[code-style.md](code-style.md) 的上限是 150），
> 而路由文件只该做布局和数据编排。

> `home/` 是 2026-09-26 首页改版新增的：两条 rail（`MemeRail.tsx`）、待处理状态条
> （`TagStatusBar.tsx`），以及这两者共用的失败行（`FailureLine.tsx`）。
> **为什么不并进 `discover/`**：图墙是「不知道要找什么，每次换一批」，rail 是「这一类里
> 挑一张」（顺序是定的、看完走「查看全部 →」）——两种意图，混在一起正是当初把图墙从
> `search/` 里分出来的理由。三个组件都是**首页专用**，所以留在 feature 里、不进
> `components/`（那条「被两个以上 feature 用到」在这里不成立）；而它们共用的取数 hook
> 反过来**跨 feature**（图墙与 rail 都用），所以它在 `lib/`，见下面那张表。

> `discover/` 是首页下半屏那个随机图墙（2026-09-19 加）。它和 `search/` 曾同在一页但**不是一回事**：
> 搜索是「知道要找什么」，图墙是「不知道要找什么」，前者要有结果就渲染、后者要每次换一批。
> 混进 `search/` 会让那个目录同时装两种意图。接口是 `GET /memes?random=true`
> （[SPEC §6.3.2](../../../spec/06-endpoints.md)）。
> 2026-09-26 起它多了 `CardSendButton.tsx`——**卡片上那枚发送键只被图墙用**，所以住在这一端
> 而不是 `components/`；它是对「一个动作只出现一处」（裁定 4）的明写偏离，理由写在那个文件头。

> 「待处理列表」原本挂在 `manage/` 下（2026-09-19 改）。挪进 `tagging/` 是因为它读的是打标状态
> （[SPEC §6.6](../../../spec/06-endpoints.md)），和「打标进度」是同一份数据、同一个页面；
> `manage/` 留给 SPEC §6.4 的编辑与删除——那些是**写**操作，见
> [浏览页图片操作](../../../_archive/joint-tasks/2026-09-19-browse-meme-actions.md)。

每个 feature 内部自己分文件，**不建全局的 `components/Button`、`hooks/`、`types/` 这种按类型切的目录**——那会让「改搜索」变成在四个目录之间来回跳。

`src/components/` 只放**真正跨 feature 复用**的展示组件（按钮、对话框、标签选择器）。判断标准：**被两个以上 feature 用到**。只有一个 feature 用的组件留在那个 feature 里，哪怕它看起来很通用。

> **例外：应用外壳**。`components/AppSidebar.tsx`（侧边导航，2026-09-21 加）不属于任何一个
> feature——每条路由都挂在它下面（`App.tsx` 的 `AppLayout`）。上面那条「被两个以上 feature 用到」
> 针对的是 feature 之间的复用，外壳不在这个坐标系里；放回 `App.tsx` 会把那个文件顶过
> [code-style.md](code-style.md) 的 150 行上限。`components/ui/` 是另一回事（shadcn 拉下来的原语）。

> **同一条例外**：`components/ImageViewer.tsx`（全屏阅览，2026-09-21 加）。它被四个 feature
> 用到（浏览 / 搜索 / 图墙 / 打标列表），本来也够得着「两个以上」那条；但真正的原因是
> **全应用只能有这一份**——`Lightbox` 渲染成 `<button>` 帧的同一个 React 祖先链上，
> 挂两份就是两套焦点陷阱。宿主的位置还有功能含义，见 [styling.md](styling.md)「全屏阅览」。
> `MemeImage.tsx` 与它同层：前者是「一张图」，后者是「一个阅片器」。`MemeImage` 只
> import 那个 `useImageViewer()` **hook**，不 import `<Lightbox>` 本体——**四处页面各带一份
> 宿主就是四套焦点陷阱**。
>
> 2026-09-23 起 `MemeImage` 打开的是「这张图**和它所在的那一批**」（`←/→` 与底部缩略图
> 要有得翻）。那批图由页面套一层 `<MemeGallery items={…}>` 告诉它——**不往 `MemeCard` 上
> 加一个只有阅览器用得上的 prop**，那是四页共用的卡片。不套那一层不是坏掉，是「一张一张
> 地看」（翻页按钮与缩略图轨道都不出现），导入页那种零散的单张入口走这条。

## `src/lib/`

| 文件 | 内容 |
|---|---|
| `api.ts` | Hono RPC 客户端，**唯一发请求的地方** |
| `clipboard.ts` | 复制 / 下载 / 分享的分流，见 [clipboard-share.md](clipboard-share.md) |
| `vocab.ts` | 读 `shared/vocab/vocab.json`，提供筛选选项 |
| `format.ts` | 时间、文件大小等纯格式化 |
| `use-mobile.ts` | `useIsMobile()`，shadcn 的 `sidebar.tsx` 用它决定走桌面栏还是手机抽屉 |
| `use-prefetch-share.ts` | `usePrefetchShare()`，触屏那一档在渲染时把原图取好——**只给阅览器与图墙用**，浏览页瀑布流虚拟化会反复重挂，改在「⋯」打开时取（`MemeActions`），见 [clipboard-share.md](clipboard-share.md) |
| `use-meme-batch.ts` | 「取 N 张」：首页图墙与两条 rail 共用的取数 + 三态，**不分页**（分页只在 `use-browse-list.ts`） |
| `tag-status.ts` | `tag_status` / `failures[].reason` 的中文映射，**唯一一份**（SPEC §5.2.3、§6.6.1） |
| `safe-next.ts` | `safeNext()`，登录页 `?next=` 的**唯一出口**，白名单只放行站内相对路径 |
| `next-navigation.ts` | `needsDocumentLoad()` / `goToNext()`，第二个出口：判「用什么方式去」——`/oauth/authorize` 是 api 端点，软跳会落进 NotFoundPage 且服务端不签票，必须整页导航；其余仍走 SPA。见 [http.md](http.md)「服务端自己管的地址」 |
| `touch.ts` | `TOUCH = 'min-h-11'`，触摸目标 44px 的**唯一落点**，见 [styling.md](styling.md) |

> `use-mobile.ts` 是 `npx shadcn add sidebar` 拉下来的，**落点是 `components.json` 的
> `aliases.hooks` 决定的**。CLI 默认写 `@/hooks`，那会建出本文件上面明令禁止的
> 「按类型切的全局 `hooks/` 目录」，所以 2026-09-21 把它改指 `@/lib`——CLI 自己就落在了
> 这里并 import `@/lib/use-mobile`，不用手改生成出来的源码。**下次拉带 hook 的组件前先看
> 一眼那行配置还在不在**，它被改回去的表现是仓库里凭空多一个 `src/hooks/`。

**`api.ts` 是唯一发请求的地方。** 组件里不出现 `fetch`。见 [http.md](http.md)。

## 路由与页面

`src/routes/` 下每个文件对应一条路由，**只做布局和数据编排**，具体 UI 在 `features/` 里。

路由文件应该短。一个 200 行的路由文件说明业务逻辑漏到了这一层。

## 命名

- React 组件文件 PascalCase，与默认导出同名
- 其余 ts 文件 kebab-case
- 目录 kebab-case

见 [SPEC §7.6](../../../spec/07-naming.md)。

## 不要做的

**不建 `utils.ts` / `helpers.ts` / `common.ts`。** 这三个名字是垃圾桶的别名。

**不手写接口类型。** 从 `api` import，见 [http.md](http.md)。手写一份 `interface Meme` 就意味着接口改了这边不会报错。

**不维护第二份标签列表。** 筛选选项从 [`shared/vocab/`](../../../shared/vocab/README.md) 读。
