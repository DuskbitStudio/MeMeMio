# api

Hono 后端。同域托管 `web` 的构建产物 + `/api/v1` + 只读的 `/mcp`。

**当前状态：已实现，2026-10-01 完成首次部署。** 下面是当前的结构，不再是计划。欠账（评测集、真供应商、MCP 外部客户端）见根 [README](../README.md)「当前状态」，任务台账在 [`joint-tasks/`](../joint-tasks/README.md)。

开工入口见 [AGENTS.md](AGENTS.md)。

## 结构

```
api/
├─ src/
│  ├─ server.ts            入口：env 校验 → 迁移检查 → 起 Hono
│  ├─ routes/              handler，薄，只做参数校验和编排
│  ├─ services/            业务逻辑
│  ├─ data/                数据访问层 ← 三条硬边界在这里
│  ├─ ai/                  VisionTagger / Embedder / HyDE，OpenAI 兼容
│  ├─ image/               ffmpeg 抽帧、sharp 缩放、pHash
│  ├─ mcp/                 只读 MCP 端点的工具、过滤器、缓存
│  ├─ queue/               Postgres 队列的取任务与消费
│  ├─ serialize/           数据库行 → 接口字段（snake_case → camelCase 只在这里）
│  └─ lib/                 纯函数：向量归一化、Hamming、词表校验
├─ migrations/
├─ scripts/eval.ts         评测集运行器，见 docs/eval.md
└─ tests/
```

## 三件立刻会用到的事

**起服务**：需要 Postgres（pgvector + pg_trgm）和 ffmpeg。见 [`docs/environments.md`](../docs/environments.md)。

**没有 AI key 也能跑**：导入正常，图片入库为 `tagStatus = pending`；搜索降级为 OCR + 标签。这是生产也要走的真实路径，不是开发便利。

**迁移是独立命令**，不在启动流程里自动执行。理由见 [`docs/deployment.md`](../docs/deployment.md)。

## 两个外部接口

| 接口 | 谁用 | 鉴权 |
|---|---|---|
| `/api/v1` | `web`（REST 的唯一消费者） | httpOnly cookie 会话 |
| `/mcp` | 外部 LLM 客户端与 IM 机器人框架 | 个人访问令牌（`Authorization: Bearer`） |

`/mcp` 是 JSON-RPC，不替代 REST，也不复用会话。它**只读、只交图与 URL**——上传、编辑、删除、改配置都不在它的能力里。见 [SPEC §10](../spec/10-mcp.md)。

## 数据与契约

- 表结构：[SPEC §5](../spec/05-data-models.md)
- 端点：[SPEC §6](../spec/06-endpoints.md)
- 错误码：[SPEC §2](../spec/02-errors.md)
- 词表：[`shared/vocab/`](../shared/vocab/README.md)

**类型通过 Hono RPC 导出给 `web` 消费，没有代码生成步骤。** 但类型只保证形状——`tagStatus: string` 编译得过，它必须是 SPEC §5.2.3 那四个值之一。语义靠测试和 SPEC，不靠类型检查。
