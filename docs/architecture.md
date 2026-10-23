# 架构

## 1. 技术栈

```
前端    Vite + React + TypeScript + React Router   (SPA)
后端    Hono (Node)，同域托管前端 dist + /api
数据库  PostgreSQL + pgvector + pg_trgm
队列    Postgres 自身（SELECT … FOR UPDATE SKIP LOCKED），不引入 Redis
存储    Cloudflare R2（S3 兼容），前端预签名 URL 直传，不过后端
图像    ffmpeg（动图抽帧）+ sharp（缩放/格式转换）+ pHash（去重）
AI      任意 OpenAI 兼容供应商
        视觉：用户自行配置（默认推荐 DeepSeek V4.1 Flash）
        向量：全站一份，仅管理员可配（默认推荐 Qwen3-Embedding-4B）
MCP     进程内 /mcp，Streamable HTTP + JSON-RPC；个人访问令牌，只读
部署    Docker Compose，单机可与其他项目共存
```

后端选 Hono：轻量、类型友好、部署不挑环境，与前端同一套 TypeScript。不选 Next.js 的理由见 [SPEC §9.2](../spec/09-decisions.md)，不引入 Redis 的理由见 [SPEC §9.11](../spec/09-decisions.md)。

MCP 与 REST 同进程但**中间件栈独立**：`/mcp` 走 JSON-RPC 与 Bearer 令牌，不经过 REST 的响应信封；工具复用同一套检索与数据访问层，不复制。见 [SPEC §10](../spec/10-mcp.md)。

## 2. 仓库结构

单仓库，两个工作区：

```
MemeMio-Project/
├─ AGENTS.md           总管入口
├─ spec/               跨端契约（唯一有约束力的文档）
├─ docs/               背景文档（就是这里）
├─ agents/rules/       跨端共享规则
├─ joint-tasks/        需要两端同时动的任务
├─ shared/vocab/       固定标签词表，两端共同消费
├─ api/                Hono 后端
├─ web/                Vite + React 前端
└─ _archive/           已完成任务与被取代的文档
```

**为什么是单仓库而不是前后端分仓：** 部署形态要求前后端同域、同一个镜像（见 [deployment.md](deployment.md) 的三阶段 Dockerfile），分仓会让「构建一个镜像」变成跨仓协调。而且 `shared/vocab/` 被两端同时消费，分仓之后它要么复制两份、要么变成一个需要发版的包，两种都比现在麻烦。

代价是两端的依赖树在同一棵树下，误 import 对面的代码不会立刻报错。靠 `api/agents/rules/project-structure.md` 和 `web/agents/rules/project-structure.md` 的边界约定挡，不靠工具。

## 3. 请求路径

```
浏览器、MCP 客户端、IM 机器人
  │
  ├─ GET /            ──► Hono 静态托管 web/dist（SPA fallback）
  │
  ├─ GET /api/v1/*    ──► Hono 路由
  │                        ├─ 会话中间件（cookie → actor）
  │                        ├─ handler
  │                        └─ memes 访问层（强制 deleted_at is null / assertCanMutate）
  │
  ├─ POST /mcp        ──► MCP 子应用（独立中间件栈，不经过 REST 信封）
  │                        ├─ Bearer 令牌校验（不认 cookie）
  │                        └─ 只读工具（检索 / 取图 / 随机 / 词表）
  │
  └─ PUT <预签名 URL> ──► Cloudflare R2（不经过 api）
```

**图片字节原则上不经过 `api`。** 上传走预签名直传，读取走 R2 的公开 / 签名 URL。`api` 只处理元数据——这是 Node 进程不会被大文件拖垮的前提。**唯一例外是 MCP 的可选小图内联**：缩略图 ≤512 KiB、原图 ≤2 MiB 时才读一次 R2，原图默认仍然只给 URL，见 [SPEC §10.5](../spec/10-mcp.md)。

## 4. 三个必须封装的东西

这三处是本项目最容易被绕过的抽象。**绕过一次，散落的分支就再也收不回来了。**

### 4.1 AI 调用

只允许出现两个接口，实现里只允许出现 OpenAI 兼容的请求形状，**不允许任何供应商特有的分支**：

```ts
VisionTagger.tag(images: PNG[], prompt) → TagResult
Embedder.embed(texts: string[])         → Float32Array[1024][]
```

供应商差异（是否支持 `json_object`、是否支持多图、是否透传 `dimensions`）全部由「测试连接」探测后存进配置——视觉的存进 `user_ai_configs`，向量的存进 `embed_config`——**运行时读配置决定走哪条路径，不在代码里按 baseUrl 猜**。

实现约束见 `api/agents/rules/ai-providers.md`。

### 4.2 memes 访问层

所有涉及 `memes` 表的读写都要走它，负责两件事：

- 读路径强制 `deleted_at is null`
- 写路径强制 `assertCanMutate(meme, actor, action)`

理由见 [SPEC §3.4](../spec/03-auth-permission.md)。这是共享化之后风险最集中的地方——风险不在读路径（全库可读是设计本身），在写路径。

### 4.3 图像归一化

送 AI 的永远只有 PNG，动图统一抽帧。见 [SPEC §9.4](../spec/09-decisions.md)，实现约束见 `api/agents/rules/image-pipeline.md`。

**原图原样存 R2**，展示和发送始终用原图，只有喂 AI 这一路做归一化。

## 5. 数据流

### 5.1 导入

```
web: 选文件 → POST /imports 拿预签名 URL
  → 直传 R2 的 temp/ 前缀
  → POST /imports/{id}/commit
  → 订阅 SSE

api: magic bytes 探测 → SHA-256 查库 → pHash 全库扫
  → 通过的写 memes（tag_status=pending）+ 入队
  → 近似命中的留在 temp/，进待确认队列

worker（同进程，Postgres 队列）:
  取任务 → 抽帧/缩放 → 主通道打标 → 失败则副通道
  → 校验词表 → 拼 search_text → embed → 写回
```

**打标 worker 与 HTTP 服务同进程**，靠 `FOR UPDATE SKIP LOCKED` 保证多副本时不重复消费。首期单副本，但代码不假设单副本。

### 5.2 搜索

```
q → HyDE 改写（搜索者自己的视觉模型，纯文本调用）
  ├─ pg_trgm 子串匹配  ─┐
  ├─ 标签过滤          ─┼─► RRF 融合 → 前 N 条
  └─ 向量 HNSW 检索    ─┘
```

三路并行发起，任意一路失败不阻断其余（向量路失败时响应带 `degraded: true`）。检索与浏览是同一个列表端点（`GET /memes`，按有没有 `q` 分派，都可以翻页），见 [SPEC §6.3](../spec/06-endpoints.md)。

**搜索时不调用视觉模型打标，只有 HyDE 改写这一次纯文本调用。** 语义理解的成本发生在入库。

### 5.3 MCP

```
MCP 工具调用 → 60 秒进程内缓存（同一用户 / 查询 / 筛选 / limit / **成人向许可**）
  ├─ 命中 → 直接返回，不调 AI
  └─ 未命中 → 复用 §5.2 的三路召回（HyDE 用令牌用户的视觉配置，embedding 用全站配置）
```

工具只读，不落快照、不分页；`random_meme` / `list_vocab` 不产生 AI 调用。结果里的 `url` / `thumbUrl` 是 R2 公开地址，图片字节仍不经过 `api`（可选的小图内联是唯一例外，见 §3）。

## 6. 状态在哪

| 状态 | 存在哪 | 备份 |
|---|---|---|
| 元数据、向量、会话、队列 | PostgreSQL | `pg_dump` |
| MCP 访问令牌与内容范围 | PostgreSQL（`access_tokens` 只存 SHA-256 与前缀；`user_mcp_settings` 只存 `allow_adult` 与 `excluded` 标签） | `pg_dump` |
| 原图与缩略图 | Cloudflare R2 | bucket 版本控制 |
| 用户 API Key 的解密主密钥 | 环境变量 `CONFIG_ENC_KEY` | **必须单独离线备份** |

**只有一个有状态组件（Postgres）加一个对象存储。** 没有 Redis、没有独立向量库、没有本地磁盘上的持久数据——容器可以随时重建。

`CONFIG_ENC_KEY` 是唯一一个「丢了就没法恢复」的东西，见 [environments.md](environments.md)。
