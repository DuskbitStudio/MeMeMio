# Mememio · 表情包语义检索

不需要记得那张图叫什么、放在哪，只需要描述自己想说什么。

Mememio 是一个邀请制的共享表情包检索服务。所有人的上传进同一个库、所有人都能搜到；入库时由多模态模型一次性完成打标与 OCR，搜索时只查索引、不再调用 AI。

> **当前状态（2026-09-24）：两端已实现，尚未部署。** `api`（Hono + PostgreSQL/pgvector）与 `web`（Vite + React SPA）都在本仓，SPEC 里的端点绝大部分已落地并有测试。**一次真实部署都没有做过**，所以多数跨端联合验收还欠着，词表与检索的评测也没跑过——这两件事决定了「能用」和「好用」之间的距离。见[当前任务](joint-tasks/README.md)。

## 从哪里开始

| 目的 | 入口 |
|---|---|
| 理解产品和范围 | [产品说明](docs/product.md) |
| 以 AI 项目总管身份接任务 | [AGENTS.md](AGENTS.md) |
| 看系统边界和依赖 | [系统架构](docs/architecture.md) |
| 查跨端约定 | [SPEC 索引](spec/INDEX.md) |
| 理解某个设计为什么是这样 | [设计决策](spec/09-decisions.md) |
| 接着当前工作继续做 | [当前任务](joint-tasks/README.md) |
| 部署到自己的机器 | [部署手册](docs/deployment.md) |
| 接入 LLM 聊天或 IM 机器人 | [MCP 接入](docs/mcp.md) |

## 工作区

| 目录 | 用途 | 入口 |
|---|---|---|
| `api/` | Hono API、PostgreSQL、导入队列、AI 调用 | [README](api/README.md) |
| `web/` | Vite + React SPA | [README](web/README.md) |
| `shared/vocab/` | 固定标签词表，跨端单一数据源 | [README](shared/vocab/README.md) |
| `spec/` | 跨端契约主源 | [INDEX](spec/INDEX.md) |
| `docs/` | 产品、架构、环境、部署、评测 | [README](docs/README.md) |

单 Git 仓。`web` 构建产物由 `api` 同域托管，Docker 镜像三阶段构建，见 [部署手册](docs/deployment.md)。

## 这个项目真正的难点

不在存储，甚至不在检索——**在打标质量**。向量检索、混合排序、pgvector 都是成熟方案，照做就能跑通；决定「搜得准不准」的唯一变量是 AI 有没有真的理解这张图想表达什么。

衡量它的手段是三件事：[评测集](joint-tasks/2026-09-13-eval-set.md)、[标签词表](joint-tasks/2026-09-13-vocab-v1.md)、[供应商探测](joint-tasks/2026-09-13-provider-spikes.md)。理由见 [产品说明 · 核心判断](docs/product.md)。

**但它们不阻塞核心功能。** 当前口径是先用 `proposed` 版本落代码、边用边迭代，改了提示词或词表就直说「这一维没有数据」——决定与代价见 [SPEC §9.27](spec/09-decisions.md)。
