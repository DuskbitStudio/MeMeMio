# MCP 接入：LLM 聊天与 IM 机器人通过只读 MCP 输出表情包

**状态**：`in_progress`（2026-10-22 开工；同日两端实现落齐、自动化闸门通过，只差真实客户端与 IM 渠道）｜ **性质**：**跨端**（api + web）｜ 开于 2026-10-22

契约：[SPEC §10](../spec/10-mcp.md)（`proposed`）、令牌模型 [§5.8](../spec/05-data-models.md#58-访问令牌)、令牌端点 [§6.8](../spec/06-endpoints.md#68-访问令牌)、决策 [§9.35](../spec/09-decisions.md)。实现约束：[`api/agents/rules/mcp.md`](../api/agents/rules/mcp.md)。

**产品负责人 2026-10-22 已拍板四件事**：只读 / v1 用 PAT / 本期做 web 设置页 / 默认挂载（不设开关）。

## 1. 为什么要做

表情包库现在只有 Web 这一个出口：聊天时要先切到浏览器、搜、复制，再切回去。MCP 让 LLM 聊天客户端（Claude Code / Desktop、Cursor、Cherry Studio……）和 IM 机器人框架（LangBot / Dify / n8n / 自研）直接"按一句想说的话检索并拿到图"。

**边界要写死：MCP 只负责把图交给调用方，不负责发到微信 / QQ / LINE。** 渠道发送由机器人调官方接口完成；个人微信号 / QQ 号 2026 年仍没有官方机器人 API，本项目不提供非官方协议（[SPEC §10.1](../spec/10-mcp.md#101-范围与地位)）。

## 2. 做完的标准

- `POST /mcp` 能完成 2026-07-28 与 2025 代（`initialize`）两种客户端的 `tools/list` / `tools/call`；无令牌 `401`，带 `WWW-Authenticate: Bearer`。
- 5 个工具（`search_memes`、`pick_meme_for_reply`、`get_meme_image`、`random_meme`、`list_vocab`）按 SPEC §10.4 的输入输出工作；搜索结果的 id 顺序与同一用户 `GET /memes?q=` 一致。
- 软删的图不出现在任何工具结果里；工具输出**不含** `storageKey` 等内部字段；令牌 A 看不到令牌 B 的 `favorited`。
- 每个令牌每分钟 30 次检索 / 120 次请求，超限 `429` + `Retry-After`；60 秒内同一查询命中进程内缓存，不重复调 AI。
- 设置页能创建令牌（名称 + 有效期）、**完整令牌只显示一次**、复制、列表（前缀 / 最后使用 / 过期）、撤销；刷新页面不会再看到完整值；撤销后 MCP 请求立刻 `401`。
- 真实客户端连一次；至少一条 IM 渠道（推荐钉钉 webhook 或 QQ 机器人）跑通"检索 → 发图"。

## 3. api 端

| # | 改什么 | 位置 |
|---|---|---|
| 1 | 迁移 `0011_create_access_tokens`；`schema.ts` 加 `accessTokens` | `api/migrations/`、`api/src/data/schema.ts` |
| 2 | 令牌纯函数：生成 / sha256 / 前缀 | `api/src/lib/token.ts` + 单测 |
| 3 | 令牌访问层（唯一 SQL 入口） | `api/src/data/access-tokens.ts` |
| 4 | 令牌 REST 三端点（cookie 会话） | `api/src/routes/access-tokens.ts`，挂 `app.ts` |
| 5 | Bearer 校验 + 401 + `last_used_at` 节流 | `api/src/mcp/auth.ts` |
| 6 | MCP 子应用（不 import env/db，可注入依赖）：requestId、256KiB、Origin 403、令牌限流 | `api/src/mcp/app.ts` |
| 7 | 生产组装：真实 db / 令牌 / 工具工厂 | `api/src/mcp/production.ts` |
| 8 | 工具实现与 `MemeSummary` 格式化（截断 + 不可信声明） | `api/src/mcp/tools/*.ts`、`api/src/mcp/format.ts` |
| 9 | 60s LRU 缓存 | `api/src/mcp/cache.ts` |
| 10 | `server.ts` 按 path 分流 `/mcp` → `mcpApp`，**不进 `app.ts` 的 RPC 类型链** | `api/src/server.ts` |
| 11 | 测试：unit（token / app 传输）+ integration（令牌 CRUD、鉴权、工具、限流、软删、字段裁剪） | `api/src/**/*.test.ts`、`api/tests/mcp-*.test.ts` |
| 12 | 新增表进 truncate 清单 | `api/tests/helpers/test-db.ts` |

**依赖**：`@modelcontextprotocol/server@2.3.1`、`@modelcontextprotocol/hono@2.0.2`、`zod@4.2.0`（依赖变更单独一个 chore 提交）。

## 4. web 端

**入口**：设置页新增所有人可见的「MCP 接入」分段（`#mcp`，排在「视觉模型」之后），不是一级导航。URL `/settings#mcp` 可直达。

| # | 改什么 | 位置 |
|---|---|---|
| 1 | `SECTIONS` 加 `{ id: 'mcp', label: 'MCP 接入', adminOnly: false }`，挂 `<McpSettings />` | `web/src/routes/settings.tsx` |
| 2 | 卡片：说明 / 只读 Badge / 接入地址 + 复制 / 令牌列表 / 三步 / 安全提示 / 边界脚注 | `web/src/features/settings/McpSettings.tsx` |
| 3 | 创建弹窗：名称（1–64）+ 有效期（30/90/365/永久，默认 90） | `McpTokenCreateDialog.tsx` |
| 4 | 一次性令牌弹窗：完整值只显示一次、复制令牌、复制 `Authorization` 头、复制配置片段、关闭前二次确认 | `McpTokenCreatedDialog.tsx` |
| 5 | 撤销确认（`AlertDialog`，默认焦点取消） | `McpTokenRevokeDialog.tsx` |
| 6 | 接入指南 `Sheet`：准备 / 客户端 Tabs / 5 个工具 / IM 渠道 / 限制安全 | `McpGuideSheet.tsx` |
| 7 | 静态配置片段与渠道说明 | `mcp-copy.ts` |
| 8 | 三个令牌接口的 RPC 封装 | `web/src/lib/api.ts` |
| 9 | `lastUsedAt` 展示（<7 天相对时间，否则绝对时间；null 为「从未使用」） | `web/src/lib/format.ts` |

**文案是契约**：逐字照抄 [SPEC §10.8](../spec/10-mcp.md#108-文案契约)，不在组件里现编。视觉与交互规范按 [`settings-ux.md`](../web/agents/rules/settings-ux.md)、[`styling.md`](../web/agents/rules/styling.md)：语义 token、44px 指针分档、表格在窄屏转"标签 / 值"堆叠、弹窗焦点锁内、不自动聚焦（手机不弹键盘）。

**设计稿**（仓库外临时附件，`_design/mcp/`）：`settings-desktop.png`（列表态）、`settings-empty.png`（空态）、`dialog-create.png`、`dialog-created.png`、`guide-sheet.png`、`settings-mobile.png`（390）。实现按 shadcn 组件落地，不照抄 HTML。

**阻塞关系**：web 的接口封装依赖 api 第 4 条（令牌 REST）先合入；其余界面可以在那之前先做。

## 5. 文档（P3）

- `docs/mcp.md`：客户端配置、stdio 桥、IM 渠道矩阵与合规边界。
- `docs/environments.md`：**没有新增环境变量**（默认挂载，不设开关）。
- `docs/deployment.md`：反代对 `/mcp` 的 SSE / 超时 / 请求体提示；R2 公开桶是交付前提。
- `docs/architecture.md`：请求路径加 `/mcp`；`README.md` 入口表加 MCP。

## 6. api 端验收

**2026-10-22 实现完成**（api 执行者实现，总管复核）。迁移 `0011_create_access_tokens`（drizzle-kit 生成，未手改历史迁移）、`lib/token.ts`、`data/access-tokens.ts`、`routes/access-tokens.ts`、`src/mcp/` 全部子模块、`server.ts` 按 pathname 分流；`app.ts` 不含任何 MCP import。

实测（本机 Node 24，无 .env / 无 Docker / 无 Postgres）：

- `cd api && npm run typecheck`：**通过**。
- `npx vitest run --project unit src/mcp/ src/lib/token.test.ts`：**4 文件 / 39 tests 全过**（token、mcp app 传输、filter、cache）。
- 总线传输冒烟（临时脚本 + 假依赖，已删除）：
  - 无令牌 → `401` + `WWW-Authenticate: Bearer realm="mememio"`，无 `resource_metadata`，带 `X-Request-Id`；
  - 无协议头 `tools/list` → 200 `text/event-stream`（2025 代无状态回退，结果在 `data:` 行）；
  - 2026-07-28 头 + `_meta` → 200 `application/json`，含 `resultType: complete` / `ttlMs` / `cacheScope`；
  - `GET /mcp` → 405；`Origin` → 403。
- `npx vitest run --project unit`（全量）：217 passed / 1 failed；失败集中在 4 个既有 suite（`shutdown`、`routes/health`、`ai/probe`、`storage/r2`）与 `process-error-handlers` 子进程，均因**本机缺 `.env`** 在 import `env.ts` 时 exit(1)，与本次改动无关；新增文件 0 失败。

**真库 integration（2026-10-22 补跑）**：本机起临时 `pgvector/pgvector:pg17` 容器（端口 55432，避开被系统占用的 5432），用测试环境变量跑 `npm test`——**62 files / 741 tests 全过**，其中本次新增的 `tests/access-tokens.test.ts`、`tests/mcp-auth.test.ts`、`tests/mcp-tools.test.ts` 全绿（含「搜索 id 序列与 `GET /memes?q=` 一致」「软删不出现在结果」「字段裁剪」「favorited 按令牌用户」「限流 429」「图片内联上限」）。首次跑暴露 2 条**测试自身**的缺陷（工厂 `storageKey` 被写死成 `memes/`、用例往 `text` 列塞 NUL 字节），已修并复跑；实现代码未因此改动。

**迁移**：在空库 `mememio` 上跑 `tsx src/migrate.ts` 成功，`access_tokens` 表、唯一索引与 cascade 外键均按 §5.8 建出。

**仍未做的**：真实 LLM 客户端与 IM 渠道（见 §8）。

## 7. web 端验收

**2026-10-22 实现完成**（web 执行者实现，总管复核）。

- `cd web && npm run typecheck`：**通过**（会编译 api/src）。
- `cd web && npm run build`：**通过**（13.23s；仅既有的 chunk >500 kB 警告）。
- 设置页新增「MCP 接入」分段（`#mcp`，全员可见，视觉模型之后）；创建 / 一次性显示 / 列表 / 撤销 / 接入指南 Sheet 全部落地；窄屏用标签-值堆叠，桌面用表格。
- 执行者用临时 Vite 预览 + Edge headless/CDP + mock 接口核对了桌面 / 390 窄屏、空态、创建 / 已创建 / 关闭确认 / 撤销确认、指南 Sheet、浅色与深色；临时文件已删除。
- 文案按 SPEC §10.8 逐字核对（一次性提醒、安全提示、边界脚注、撤销确认）；完整令牌只活在「已创建」弹窗 state，grep 无 localStorage / sessionStorage / URL 持久化。

**未实测**：真 api + 真 DB 联调、剪贴板真实写入（权限 / 失败分支）、真机与粗指针 44px、会话过期 401 跳转（沿用既有 `toApiError` 拦截）。

## 8. 联合验收

**部分完成（2026-10-22 / 2026-10-23 三轮）。** 自动化闸门全绿：

1. 真 Postgres 下 `npm test`：**2026-10-23 第三轮复跑 67 files / 773 tests 全过**（含 MCP integration、`mcp-policy.test.ts`、`mcp-filter.test.ts`；迁移 0012/0013 在空库跑通）；
2. `api typecheck`、`web typecheck`、`web build`、文档链接检查（0 失效）全过；
3. 真实前端（Vite dev + mock 契约数据 + headless）渲染 `/settings`、创建弹窗、接入指南 Sheet，页面 0 异常；部署栈上 headless 打开设置页「内容范围」默认关闭态与开启确认框、打开「过滤器」选择器并完成选中→保存→取消（未保存确认），页面 0 异常；
4. 部署栈真链路复核：默认 `get_meme_image` 对成人向 id 返回工具错误；设置开启后仍需 `allowAdult: true` 才返回；`search` compact text 5.8 KB→4.3 KB、`pick inline=false` wire 25.9 KB→8.5 KB；过滤器 `{emotions:['开心']}` 生效后 `get` 报「被过滤器排除」、`search`/`random` 不再返回该图，重置为空恢复。

**剩下两件必须有外部条件的事，当前环境不具备**：

1. **真实 MCP 客户端**：Claude Code / Cherry Studio / Cursor 一个都没连过。
2. **一条 IM 渠道**：没有渠道凭据；`docs/mcp.md` 的渠道细节全部标了「接入时实测 / 以官方文档为准」。

下一步（部署后由产品负责人执行）：

1. 按 `docs/deployment.md` 部署并填 `.env`（**不需要 MCP 相关环境变量**）；
2. 注册首个管理员 → 设置页「MCP 接入」创建令牌；
3. 用 Claude Code / Cherry Studio 各连一次，确认 `tools/list` 出现 5 个工具、`pick_meme_for_reply` 能在会话里显示缩略图；
4. 选一条最容易的渠道（推荐钉钉群机器人 webhook 或 QQ 开放平台机器人）跑通「检索 → 发图」；
5. 以上通过后 §10 转 `stable`；失败项回填本文件。

## 9. 已知取舍与后续

- 不做 OAuth：`claude.ai` connectors 这类只走 OAuth 的宿主直连不了，用 stdio 桥或另立决定（[§9.35](../spec/09-decisions.md)）。
- 不做图片代理 / 转码：渠道格式（如 WebP、动图）适配归机器人侧；R2 必须开公开访问。
- 不做写工具、MCP 会话；需要时另立契约。
- **`resources` / `prompts` 本轮不做**（产品负责人待定；说明见 2026-10-23 的评审记录）。
- 令牌创建后不可再查看完整值；丢失只能重建。

## 10. 2026-10-23 第二轮：内容范围与上下文成本（P1）

**产品负责人拍板**：成人向默认关闭（设置页要能选）、结果压缩 + `pick.inline`、暂不做审计表与令牌日预算、客户端优先级按现状、本地 S3 compose 示例不进仓库（线上仍 R2）。

**契约**：[§10.3.1](../spec/10-mcp.md#1031-内容范围成人向默认关闭)、[§10.4.6](../spec/10-mcp.md#1046-memesummary工具内统一的对外表示)、[§5.9](../spec/05-data-models.md#59-mcp-设置)、[§6.9](../spec/06-endpoints.md#69-mcp-设置)、[§9.36](../spec/09-decisions.md)。

**api 端**：迁移 `0012_create_user_mcp_settings`；`data/mcp-settings.ts` + `routes/mcp-settings.ts`；`findActiveByHash` 带 `allowAdult`；工具层成人向过滤（多取候选再过滤，不改共享 SQL）；text 默认 compact；`pick.inline`；长句词表兜底 + 安全随机兜底；`McpServer` instructions。测试新增 `tests/mcp-policy.test.ts` 与 `src/mcp/query.test.ts`。

**web 端**：`lib/api.ts` 读写设置；`McpSettings.tsx` 增加「内容范围」开关（默认关闭、开启确认、错误/重试）；`mcp-copy.ts` 增加文案与 FAQ；接入指南工具表同步。

**未做**：审计表 / 令牌日预算 / resources / prompts / OAuth / stdio 桥（按拍板与现状）。

**2026-10-23 成员可见性复核**：用一个真实 `member` 账号验证——设置页能看到「MCP 接入」与「内容范围」，能建令牌，令牌能调 `tools/list`，能读写 `/api/v1/mcp/settings`，全部 200。**MCP 从第一版起就是成员功能**，但设置页副标题写的是「视觉模型是你自己的一份，其余设置由管理员维护」，把 MCP 误读成管理员功能；已改为「视觉模型与 MCP 接入是你自己的一份」，并把 MCP 行补进 `web/agents/rules/settings-ux.md` 的分段表。

**本轮闸门**（回填）：见 §8。

## 11. 2026-10-23 第三轮：过滤器（排除标签）

**产品负责人**：在「设置 → MCP 接入 → 过滤器」加入标签选择器；成人向标红、提示「此项需要单独设置」。设计稿见 `_design/mcp/filter-*.png`。

**契约**：[§10.3.2](../spec/10-mcp.md#1032-过滤器按标签排除)、[§5.9](../spec/05-data-models.md#59-mcp-设置)、[§6.9](../spec/06-endpoints.md#69-mcp-设置)、[§9.37](../spec/09-decisions.md)。**排除式、用户级、七维、命中任一即排除；成人向不进过滤器；只影响 MCP。**

**api 端**：迁移 `0013_add_mcp_excluded`（`user_mcp_settings.excluded jsonb`）；`lib/mcp-filter.ts`（解析/校验/归一化/命中/cache key）；`data/mcp-settings.ts` 增 `getMcpFilter` / `updateMcpFilter`；`GET/PUT /api/v1/mcp/filter`；令牌鉴权带 `excluded`；`runToolSearch` / `randomToolRows` / `get_meme_image` 应用过滤；cache key 含过滤器。测试新增 `src/lib/mcp-filter.test.ts` + `tests/mcp-filter.test.ts`。

**web 端**：`lib/api.ts` 读写过滤器；`McpSettings.tsx` 增加过滤器入口（未设置 / 已排除 N 个 + 标签预览 + 成人向提示）；`McpFilterSheet.tsx` 标签选择器（搜索、七维折叠、成人向红色禁用 + 引导内容范围、未保存确认、清空/保存）；`mcp-copy.ts` 文案；指南同步。

**部署验证**：member 账号真链路——默认空过滤器；PUT `{emotions:['开心']}` 后 `get_meme_image` 对被标记图返回工具错误、`search_memes` / `random_meme` 不再返回；重置为空；UI 选中→保存→入口计数更新、未保存关闭确认均通过；headless 页面 0 异常。

**本轮闸门**（回填）：见 §8。
