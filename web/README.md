# web

Vite + React + TypeScript 的 SPA。生产由 `api` 同域托管构建产物。

**当前状态：已实现，2026-10-01 完成首次部署。**

开工入口见 [AGENTS.md](AGENTS.md)。

## 结构

```
web/
├─ src/
│  ├─ main.tsx
│  ├─ routes/            页面级组件，与路由一一对应，只做布局与数据编排
│  ├─ features/          按业务切：home / discover / browse / import / tagging / manage / settings / auth
│  │                     （`persons/` 与 `lib/api-persons.ts` 仍在，但渲染点已撤，见下文）
│  ├─ components/        被两个以上 feature 复用的展示组件
│  ├─ contexts/          登录态、导入队列
│  ├─ lib/               api 客户端、剪贴板分流、纯函数
│  └─ index.css          Tailwind v4 入口与语义 token
└─ public/               manifest、sw.js、图标
```

目录怎么切、一个新组件该放哪，见 [project-structure.md](agents/rules/project-structure.md)。

## 页面

| 路由 | 内容 |
|---|---|
| `/` | **入口页**：搜索框只负责把人送到 `/browse?q=`，自己不搜也不渲染结果；主体是随机图墙 + 两条 rail + 待处理状态条（[SPEC §9.30](../spec/09-decisions.md)） |
| `/browse` | 全应用唯一的一条列表。`?q=` 与七个词表维度同串，可筛可翻 |
| `/import` | 导入 + 进度 + 待确认队列 + 打标状态 |
| `/settings` | 左侧分区导航，一次一段：「我的」（视觉模型、MCP 接入）与「全站管理」（邀请码、Embedding 与重建索引、运行参数、重新打标、用户）。后一组对普通用户**不渲染** |
| `/login`、`/register` | 登录 / 邀请码注册 |
| `/ui` | 组件参照页，**只在开发期注册**（`import.meta.env.DEV`），不进生产包 |

分区地址沿用 `#锚点`（`/settings#mcp`、`/settings#reindex` 之类），可以直接复制直达。`/admin/*` 是重定向到对应锚点，不是 404。

## 本地开发

```bash
npm run dev      # :5173，proxy /api → :3000
```

需要 `api` 同时跑着。本地前后端不同域，靠 Vite 的 `server.proxy` 让 cookie 仍然同域。见 [`docs/environments.md`](../docs/environments.md)。

类型闸门是 `npm run typecheck`——它会把 `api/src/` 一起编译。不要在本地 `--no-save` 装临时包，会把 `hono` 版本漂移出去然后闸门红。

浏览器验收不装 Playwright：`scripts/verify-*.mjs` 是零依赖 CDP 脚本，驱动系统 Chrome，对着 `127.0.0.1` 上的 dev 或预览服务跑。

## 契约

- 端点与响应：[SPEC §6](../spec/06-endpoints.md)
- 错误码与客户端行为：[SPEC §2](../spec/02-errors.md)
- SSE 事件：[SPEC §1.4](../spec/01-http.md)
- 筛选选项数据源：[`shared/vocab/`](../shared/vocab/README.md)，**不维护第二份标签列表**

类型走 Hono RPC，从 `api` 直接 import，没有生成步骤。**类型只保证形状**：`tagStatus: string` 编译得过，它必须是 SPEC §5.2.3 那四个值之一；`degraded`、`matchedBy`、软删语义都不在类型里。
