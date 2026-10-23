# 环境

## 1. 环境变量

```bash
# 命名（唯一需要改的）
APP_SLUG=mememio

# 数据库（主机名就是容器名，走内部网络）
DB_PASSWORD=<随机>
DATABASE_URL=postgres://${APP_SLUG}:${DB_PASSWORD}@${APP_SLUG}-db:5432/${APP_SLUG}

# 密钥
SESSION_SECRET=<随机>
CONFIG_ENC_KEY=<随机 32 字节>     # 加密用户 API Key 的主密钥

# 对象存储（开通步骤见 deployment.md §8）
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
R2_BUCKET=<bucket>
R2_KEY_PREFIX=${APP_SLUG}/        # ← 共用 bucket 时必须，否则对象互相覆盖。以 / 结尾
R2_PUBLIC_BASE_URL=https://pub-xxxx.r2.dev   # ← 必填，不带末尾 /，也不要把前缀拼进去

# 本地 S3 兼容存储（可选；不设就走 Cloudflare R2）
R2_ENDPOINT=http://mememio-s3:9000   # 设了 R2_ACCOUNT_ID 可以不填
R2_FORCE_PATH_STYLE=true             # 非 AWS 实现通常必须 true
R2_PUBLIC_ENDPOINT=http://127.0.0.1:19000  # 浏览器直传用；和容器内 endpoint 不同

# 部署方提供的默认模型配置（用户未配置时使用）
DEFAULT_VISION_BASE_URL / DEFAULT_VISION_API_KEY / DEFAULT_VISION_MODEL
DEFAULT_EMBED_BASE_URL  / DEFAULT_EMBED_API_KEY  / DEFAULT_EMBED_MODEL
# 图片向量（人物识别）。⚠️ 每张图都是一次付费调用，且这条路没有测试连接记录，
# 见 §5 与 SPEC §6.7.5
DEFAULT_IMAGE_EMBED_BASE_URL / DEFAULT_IMAGE_EMBED_API_KEY / DEFAULT_IMAGE_EMBED_MODEL
```

> 🔴 **`CONFIG_ENC_KEY` 丢失 = 所有用户配置的 API Key 全部永久解不开。**
>
> 它不在数据库备份里，必须单独离线备份。**这是本项目唯一一个「丢了就没法恢复」的东西**——数据库、图片、代码都能重建，它不能。

### `DATABASE_URL` 有两种形态

容器里和本机开发时**主机名不同**，同一个变量名两个值：

| 谁在读 | 值 | 来自哪 |
|---|---|---|
| 容器里的 app | `postgres://${APP_SLUG}:${DB_PASSWORD}@${APP_SLUG}-db:5432/${APP_SLUG}` | `compose.yaml` 的 `environment:`，**覆盖** `.env` |
| 本机 `npm run dev` / `npm test` | `postgres://...@localhost:5432/...` | 仓库根 `.env` |

`.env` 里写 localhost 形态，compose 启动 app 时用 `environment:` 盖掉。**不要为了「统一」把 `.env` 改成容器形态**——那样本机 `npm run dev` 就连不上了，而且错误发生在第一次查询，离根因很远。

测试另有一个库：`npm test` 会把库名加后缀 `_test` 自己建出来并跑迁移，不碰开发库。建不出来时见 [§3.1](#31-npm-test-跑不起来的两种形态)。

## 2. 启动时校验，不要运行时才发现

进程启动时一次性校验全部环境变量，**缺一个就拒绝启动并打印缺了哪个**。不要用 `process.env.X!` 这类写法把问题推到第一次调用时——那时的报错现场离根因已经很远了。

`CONFIG_ENC_KEY` 额外校验长度必须是 32 字节，短了直接拒启动。

实现约束见 `api/agents/rules/env-validation.md`。

## 3. 本地开发

需要：Node 22+、Docker（起 Postgres）、ffmpeg（本机装或用容器）。

```bash
# 1. 只起数据库。dev 那层唯一的作用是把 5432 绑到 127.0.0.1，
#    正式部署绝不能带上它（deployment.md §4 / §9）
docker compose -f compose.yaml -f compose.dev.yaml up -d db

# 2. 迁移（永远是独立命令，进程启动时只检查不执行）
cd api && npm run migrate

# 3. 两端各自起
cd api && npm run dev     # :3000
cd web && npm run dev     # :5173，proxy /api → :3000
```

本地开发时前后端**不同域**（5173 vs 3000），靠 Vite 的 `server.proxy` 把 `/api` 转发过去，这样 cookie 仍然是同域的。生产是真同域，见 [deployment.md](deployment.md)。

本地 cookie **不设 `Secure`**，生产必须设。这是唯一一处允许按环境分支的会话配置。

### 3.1 `npm test` 跑不起来的两种形态

两种都**不报「测试失败」**，所以单独列出来：

**① `TypeError: process.loadEnvFile is not a function`** —— Node 版本太旧。
`tests/global-setup.ts` 用了 `process.loadEnvFile`，它要 **Node ≥ 20.12**。
Node 18 下这不是一条测试失败，是 global setup 直接崩掉，
**而 `npm test` 仍然以 exit code 0 结束**——CI 里会被当成通过。

nvm 用户尤其注意：交互 shell 和脚本 / CI 读到的默认版本可能不是同一个。先 `node -v`。

**② `template database "template1" has a collation version mismatch`** —— 建不出 `_test` 库。
完整形态：

```
PostgresError: template database "template1" has a collation version mismatch
DETAIL: 建库时用的 collation 版本是 2.41，当前 OS 提供 2.36
```

这是**数据卷和镜像对不上**：卷是在 glibc 较新的镜像下建的，现在的镜像里 glibc 更旧
（升级 Docker Desktop 或换 `postgres` 镜像 tag 之后容易出现）。两条路：

| 做法 | 什么时候用 |
|---|---|
| `ALTER DATABASE template1 REFRESH COLLATION VERSION` | 开发库里没有你在乎的数据时。它只是把版本号标记成当前值，**不重建索引**——如果库里已有基于旧 collation 的文本索引，正确做法是 `REINDEX` 之后再 refresh |
| 换一个一次性容器跑测试 | 不想动开发库时。`docker run -d --name <名> -p 55432:5432 -e POSTGRES_PASSWORD=x -e POSTGRES_DB=mig pgvector/pgvector:pg16`，然后 `DATABASE_URL='postgres://postgres:x@localhost:55432/mig' npm test` |

**换新设备时这条大概率不会复现**——新建的卷和镜像天然是一致的。

## 4. 本地的 R2

两个选择：

| 方案 | 适用 |
|---|---|
| 连真实 R2 的一个 dev bucket，`R2_KEY_PREFIX=dev-<你的名字>/` | 推荐，行为与生产一致 |
| RustFS / MinIO 容器（S3 兼容） | 离线开发。需要 `R2_ENDPOINT`（容器内地址）、`R2_FORCE_PATH_STYLE=true`、`R2_PUBLIC_ENDPOINT`（浏览器可达地址）；设了 `R2_ENDPOINT` 后 `R2_ACCOUNT_ID` 可以不填，`R2_PUBLIC_BASE_URL` 指向「公开读根 + 桶名」。预签名 URL 的签名算法与 R2 相同，差异主要在桶策略 / CORS 要自己配 |

**不要做「本地存文件系统」的分支。** 那会让上传路径在本地和生产走两套代码，而上传路径恰恰是最难在本地复现问题的地方。

**两个选择必须选一个：进程启动时会探活 bucket，不通就起不来**（`api/src/storage/r2.ts` 的 `assertR2Reachable`，`NODE_ENV=test` 跳过）。填占位符也能起来的日子结束了——那正是 2026-09-18 花掉一整天的原因：R2 配错在运行期完全不报错，错误要等到浏览器里才现身。开通步骤见 [deployment.md §8](deployment.md)。

## 5. 没有 AI Key 时怎么开发

大部分功能不需要真实的 AI 调用：

- 不配 `DEFAULT_VISION_*` 时导入仍然可用，图片入库为 `tagStatus = pending`，这是[产品明确要求的行为](product.md)
- 不配 `DEFAULT_EMBED_*` 时搜索降级为 OCR + 标签，响应带 `degraded: true`
- 不配 `DEFAULT_IMAGE_EMBED_*` 时一切照旧，人物与系列接口返回空列表（[SPEC §5.7.2](../spec/05-data-models.md)）

**这两条降级路径不是为开发准备的便利，是生产也要走的真实路径**，所以本地跑在降级态是有价值的——它天天在验证降级没坏。

⚠️ `DEFAULT_IMAGE_EMBED_*` **不建议在共享部署里配**：它没有测试连接记录，而图片向量这条路最大的风险是上游**把图静默丢掉**——`image_input_works` 探测不到的时候，所有人物会慢慢并成一团，且不报错。走管理员的 `PUT /config/image-embed`（强制先测后存）才是给他人部署时的正路。

需要真实调用时（改提示词、跑评测集），用自己的 key 配进用户设置页，不要改环境变量。
