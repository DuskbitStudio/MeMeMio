# 部署

目标环境是**一台机器上同时跑多个项目**。这个前提决定了本文的绝大部分设计——不是为了跑起来，是为了**跑起来之后不影响别人、也不被别人影响**。

## 1. 命名冲突清单

单机多项目的冲突点远不止数据库名。按严重程度排列：

| 层 | Docker 默认值 | 撞车后果 |
|---|---|---|
| **数据卷** | `<目录名>_pgdata` | 🔴 **两个项目的 Postgres 挂同一个卷，数据直接损坏** |
| **网络** | `<目录名>_default` | 🔴 跨项目容器能互相连通，是安全问题 |
| 宿主机端口 | 5432 / 3000 | 🟠 后启动的那个起不来 |
| 容器名 | `<目录名>-<服务>-1` | 🟠 冲突时创建失败 |
| PG database / role | `postgres` / `postgres` | 🟠 共用实例时互相覆盖 |
| R2 对象键 | 无前缀 | 🟠 共用 bucket 时对象互相覆盖 |
| 镜像 tag | `<目录名>-app:latest` | 🟡 误推误拉 |

**最危险的是卷。** 端口冲突会立刻报错，很好发现；卷冲突是静默的——两个 Postgres 实例挂上同一个数据目录，数据库会被写坏，而且往往过一阵才发现。

## 2. 单一变量派生全部命名

不要在十几个地方各写各的前缀，**只维护一个变量，其余全部派生**。

`.env`：

```bash
APP_SLUG=mememio          # ← 全项目唯一需要改的命名变量
DB_PASSWORD=<随机生成>
```

`compose.yaml`：

```yaml
name: ${APP_SLUG}          # ← 主防线：容器/卷/网络自动带此前缀

services:
  app:
    build: .
    container_name: ${APP_SLUG}-app
    restart: unless-stopped
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
    networks: [internal, proxy]
    # 注意：不映射任何宿主机端口，见 §4

  db:
    image: pgvector/pgvector:pg17
    container_name: ${APP_SLUG}-db
    restart: unless-stopped
    environment:
      POSTGRES_DB:       ${APP_SLUG}
      POSTGRES_USER:     ${APP_SLUG}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${APP_SLUG}"]
      interval: 5s
      retries: 10
    networks: [internal]
    # 同样不映射端口，数据库只在内部网络可见

volumes:
  pgdata:
    name: ${APP_SLUG}_pgdata      # 显式命名，不依赖默认推导

networks:
  internal:
    name: ${APP_SLUG}-internal
  proxy:
    external: true
    name: shared-proxy            # 全机共享的反代网络，见 §4
```

**顶层 `name:` 是主防线**——设了它之后，Compose 会自动给卷、网络、容器加上这个前缀，不再依赖「目录名」这个极易撞车的默认值。下面的 `container_name` 和卷的 `name:` 是第二层保险，同时让 `docker ps` 的输出一眼能看出归属。

> ⚠️ Compose 的顶层 `volumes:` / `networks:` 的 **key 不支持变量插值**，只有块内的 `name:` 字段支持。所以是 `pgdata: { name: ${APP_SLUG}_pgdata }`，不是 `${APP_SLUG}_pgdata:`。

## 3. 数据库：独占实例，不共用

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. 每个项目自带 db 容器**（推荐） | 本项目一个 Postgres 容器 | 隔离彻底；代价是每实例约 100MB 内存 |
| B. 全机共用一个 Postgres | 各项目独立 database + 独立 role | 省内存；但**扩展版本互相牵制** |

**推荐 A，理由不是内存而是扩展**：本项目依赖 `pgvector` 和 `pg_trgm`，共用实例时升级 pgvector 会同时影响同机所有项目，牵一发动全身。独占一个容器，版本完全自己说了算。

若确实要走 B，则必须做到：独立 database（`mememio`）、独立 role（`mememio`）、`REVOKE` 掉该 role 对其他 database 的访问。**不要用共用 database + 表前缀的方式做隔离**——权限边界为零，一次写错 SQL 就能读到别的项目的数据。

## 4. 端口：一个都不映射

单机多项目下，手工分配宿主机端口是个治标不治本的办法，项目一多必然出错。

**做法：所有项目都不映射宿主端口，统一走一个反向代理容器。**

```
              ┌─────────────────────────────┐
  :80 :443 ── │  Caddy / nginx（唯一暴露端口）│
              └──────────────┬──────────────┘
                             │  shared-proxy 网络
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
     mememio-app      其他项目-app       又一个项目-app
            │
            │  mememio-internal 网络（外部不可达）
            ▼
       mememio-db
```

反代通过容器名访问（`http://mememio-app:3000`），**端口冲突这个问题从根上消失了**。数据库只挂在 `internal` 网络上，连反代都碰不到它。

`shared-proxy` 是一个外部网络，全机所有项目共用，需先手工创建一次：

```bash
docker network create shared-proxy
```

## 5. 镜像构建

三阶段：前端产物 → 后端产物 → 运行镜像。

```dockerfile
FROM node:22-bookworm-slim AS web
WORKDIR /w
COPY web/package*.json ./
RUN npm ci
# 词表，web 在编译期打进产物
COPY shared/ /shared/
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS api
WORKDIR /a
COPY api/package*.json ./
# 这里不能加 --omit=dev：tsc 是 devDependency
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=api /a/node_modules ./node_modules
COPY --from=api /a/dist        ./dist
# migrate 命令和启动时的版本检查都要读 migrations/
COPY --from=api /a/migrations  ./migrations
# SPA 产物，由 Hono 同域托管
COPY --from=web /w/dist        ./public
# 运行期校验标签用，和 web 打进去的是同一份
COPY shared/ /shared/
CMD ["node", "dist/server.js"]
```

**五个坑**（后三个是 2026-09-13 第一次真正构建这份 Dockerfile 时踩出来的，之前的版本构建不出来）：

- **用 `bookworm-slim`，不要用 Alpine。** `sharp` 的预编译二进制在 musl 上经常出问题，装 ffmpeg 也更麻烦。glibc 基础镜像大一些，但省掉的调试时间远超那点体积。
- **ffmpeg 会让镜像涨约 100MB+**，这是抽帧方案的必要成本，可接受。不要为了瘦身换成裁剪版 ffmpeg，动图格式的覆盖面会出问题。
- **api 阶段 `npm ci` 不能带 `--omit=dev`，构建完再 `npm prune --omit=dev`。** `tsc` 在 devDependencies 里，少了它直接 `sh: 1: tsc: not found`。prune 放在同一层，最终镜像里仍然只有运行期依赖。
- **Dockerfile 里 `#` 只有在行首才是注释。** 写成 `COPY a b   # 说明` 会把 `#` 和后面的词当成额外的源路径，报 `"/#": not found`。所有说明必须单独一行。
- **`shared/` 要 COPY 两次，路径必须是 `/shared/`。** web 阶段是编译期需要（走 Vite alias 打进产物），最终镜像是运行期需要（api 校验标签时读）。api 用 `process.cwd()/../shared/vocab/vocab.json` 定位它——开发时 cwd 是 `<repo>/api`，镜像里是 `/app`，两边都能解析到，**这是刻意对齐的，改 WORKDIR 会同时打断两边**。

还有一条不在 Dockerfile 里但由它引出：**`npm prune --omit=dev` 之后镜像里没有 `pino-pretty`**，所以日志器不能只按 `NODE_ENV` 决定挂不挂它——拿非 production 的 `NODE_ENV` 跑镜像会在加载日志器时就崩。`api/src/logger.ts` 探测的是「装没装」而不是「哪个环境」。

**`web` 的 `npm run typecheck` 必须进提交前检查和 CI。** `vite build`（esbuild）不做类型检查，`web` 与 `api` 之间的类型链路只有 `typecheck` 能验证。漏掉这条，`api` 改字段名后 `web` 端编译照过、链路断了也不知道。

不做 `npm workspaces`：两个阶段各自 `npm ci`，所以**两个工作区各有一份 lockfile**，没有根 lockfile。`web` 消费 `api` 类型靠 tsconfig `paths`（`@api/* → ../api/src/*`）+ `import type`，不走包解析，api 的运行时代码进不了前端产物。

这个 Dockerfile 同时从 `web/` 和 `api/` 构建，是[单仓库结构](architecture.md)的直接原因。

## 6. 迁移

用 `drizzle-kit` 一类工具，走**独立的 migrate 命令**：

```bash
docker compose run --rm app node dist/migrate.js
```

**不要放在容器启动流程里自动执行。** 将来跑多副本时会出现并发迁移，而那种故障发生在启动瞬间，最难排查。多一步手工命令换掉一类隐患，划算。

启动时**只检查不执行**：进程比对 `migrations/meta/_journal.json` 和库里 `drizzle.__drizzle_migrations` 的条数，落后就打印待跑的迁移名 + 上面那条命令，然后 `exit(1)`。「起不来」比「悄悄跑了迁移」好排查得多。

迁移文件名是 `NNNN_动词_对象.sql`（SPEC §7.6）。drizzle-kit 默认给随机名，**生成时必须带 `--name`**：

```bash
cd api && npm run db:generate -- --name=create_core_tables
```

`CREATE EXTENSION` drizzle-kit 不会生成，手工补在第一条迁移的最前面（`vector` 和 `pg_trgm`，建表就要用到）。**不要放进 compose 的 initdb 脚本**——那个只在卷第一次创建时跑一次，换环境就会漏。

## 7. 备份

| 对象 | 做法 |
|---|---|
| 数据库 | `pg_dump` 定时导出，落到 R2 或宿主机另一块盘 |
| 图片 | 已在 R2，建议开 bucket 版本控制 |
| `CONFIG_ENC_KEY` | **单独离线保存**，不放在 Docker 和数据库里 |

`pg_dump` 会带上 `vector` 类型列，**恢复端必须先装好 pgvector 扩展**，否则恢复会在中途失败。

## 8. R2：开通、公开访问与 CORS

图片全部走 R2，浏览器**直接和 R2 打交道两次**——上传时 PUT 到预签名 URL，浏览时 GET 公开地址。这两条路各有一套配置，少配一边的表现完全不同，所以分开列。

### 8.1 开通与凭证

1. Cloudflare 控制台开通 R2（需要绑卡，有免费额度）。
2. 建 bucket，名字填进 `R2_BUCKET`。
3. 在 **R2 Overview 页右上角的 `{} API` → Manage API Tokens** 建令牌：**Create User API Token**，权限选 **Object Read & Write**，Specify bucket 限定到本 bucket。
4. 建完那一屏给出 **Access Key ID** 和 **Secret Access Key**，分别填 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`。**这一屏关掉就看不到第二次了。**
5. `R2_ACCOUNT_ID` 填 account id，就是 32 位十六进制那一段。

> ⚠️ **两个 2026-09-18 现踩的坑：**
>
> - 令牌**不在 bucket 设置里**，在 R2 账户级的 Manage API Tokens。从 Cloudflare 通用的 **My Profile → API Tokens** 页建出来的令牌只给一个 token value，**不是** S3 的 Access Key ID / Secret Access Key，填进去必然连不上。
> - `R2_ACCOUNT_ID` **只填那 32 位十六进制**，不要把整条 `https://<id>.r2.cloudflarestorage.com` 粘进去。粘了之后 endpoint 会拼成两层域名，而这**不报错**——一路错到浏览器的 `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`，离根因隔着整条链路。

### 8.2 公开访问

bucket 设置里开 **Public Access**，拿到 `https://pub-<hash>.r2.dev` 形式的地址（或绑自定义域），填进 `R2_PUBLIC_BASE_URL`。

两条硬性格式要求，填错进程直接起不来或图片全裂：

- **不带末尾 `/`**（`api/src/lib/env.ts` 会拦下来）。
- **不要把 `R2_KEY_PREFIX` 拼进这个地址。** 前缀由代码统一加（`api/src/storage/r2.ts` 的 `key()`），拼进来等于前缀在两个环境变量里各写一份，两边什么时候不一致都不报错。

### 8.3 CORS

**上传要 PUT，复制要 GET，`<img>` 浏览不用配。**

- 上传是浏览器跨域 PUT，没有 CORS 会被预检拦掉
- `<img src>` 加载公开地址**不受 CORS 管**——只要 bucket 开了公开访问就能显示
- **「复制到剪贴板」要 `fetch` 那个公开地址**（取原图字节 → 转 PNG → 写剪贴板，见 [`web/agents/rules/clipboard-share.md`](../web/agents/rules/clipboard-share.md)），**这是一次跨域 GET，要 CORS**

在 bucket 的 Settings → CORS Policy 填（正式部署把 origin 换成自己的域名）：

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

上面这份 2026-09-18 实测可用（`GET` 是 2026-09-19 加的）。生产同域部署时 origin 是反代那个域名，**不是** api 容器的地址——CORS 看的是浏览器地址栏。

> ⚠️ **漏配 `GET` 不会报错，只会退化成下载。** 复制路径的设计就是「失败就降级到下载」（`clipboard-share.md §6`），所以 CORS 没配好时界面上一切正常——只是**每一个用户点「复制」拿到的都是下载**，而这件事不会有任何一处日志或错误提示。**（2026-09-25 更正排查顺序）** 这里原来还写着「排查复制问题时，先确认这条 CORS，再去怀疑浏览器」，**这句把人送错过方向**：2026-09-25 的现象是「图看得见、右键能复制，点『复制』**每次**都报取不到原图」，而 bucket 的 CORS 是好的，真正的毛病在浏览器 HTTP 缓存里——页面自己会把同一张原图当 `<img>` 渲染（全屏阅览器、编辑面板、动图 hover，这些请求**不带 `Origin`**），而 r2.dev 只在请求**带** `Origin` 时才回 `Access-Control-Allow-Origin`、也只在那种时候才回 `Vary: Origin`（实测：带两个头都有，不带两个都没有），于是缓存里落的是一份既没有 ACAO、又没有 `Vary` 的响应——没有 `Vary` 就意味着它匹配之后**任何**请求，包括复制路径那次 cors 模式的 `fetch`。**这条 CORS 还是要配**，但它是原因之一，不是第一个要怀疑的：先看失败出在哪一条链上（取图 / 剪贴板权限），再决定往哪查。机制、复现与验收脚本见 [`web/agents/rules/clipboard-share.md` §4.1](../web/agents/rules/clipboard-share.md) 与 `web/scripts/verify-copy-original-cache.mjs`（后者与同目录其余 `verify-*.mjs` 一样不进版本库）。

**（2026-09-24 更正一处措辞）** 上面那句原本写着「它的表现和『这台浏览器不支持剪贴板写入』完全一样」，**现在只对了一半**：取图失败与权限被拒是分得开的（前者说「取不到原图（请求被拦下或网络不通）」，后者说「浏览器拒绝了剪贴板权限」），并且都给一个可点的链接（改动见[浏览页图片操作](../_archive/joint-tasks/2026-09-19-browse-meme-actions.md)）。2026-09-25 又把前者里「可能是 R2 的 CORS 没放行 GET」那半句删了——**那是个猜测，而且猜错之后比不说更坏**：读的人去翻部署配置，而毛病在浏览器里（见上一条）。

### 8.4 配错了怎么发现

进程启动时会对 bucket 做一次探活（`api/src/storage/r2.ts` 的 `assertR2Reachable`），不通就**拒绝启动**，日志里给出 endpoint、bucket、前缀和错误类型。

这一步是有来历的：在它存在之前，R2 配错**全程没有任何一处报错**——预签名是纯本地 HMAC 计算，假凭证照样签得出格式完美的 URL，导入接口返回 200，一切看起来都在正常工作。所以**「起不来」在这里是想要的行为**，别把它当成需要绕过的障碍。

⚠️ **但这条探活只探得到「服务端配置通不通」，探不到「浏览器那头对不对」。** 缓存毒化那一类（§8.3）里 api 与 bucket 全都正常，探活是绿的，出错的是浏览器里的一次 CORS 检查——**别把探活通过读成「复制这条路就没问题了」**。

## 9. 首次部署

前提：服务器上已经装好 Docker（带 Compose v2），并且已经有一个反代（Caddy 或 nginx）占着 80/443、管着证书。代码在服务器上拉，镜像在服务器上构建，不走镜像仓库。

**先看反代装在哪，两种接法不一样**（§9.3）：

| 反代 | 怎么找到 app | 要做的 |
|---|---|---|
| **A. 直接装在宿主机上**（`apt install nginx`，其他站点写的是 `proxy_pass http://127.0.0.1:端口`） | 宿主端口 `127.0.0.1:13080` | `.env` 里加一行 `COMPOSE_FILE`，叠加 `compose.host-proxy.yaml` |
| **B. 跑在 Docker 容器里** | 容器名 `mememio-app:3000`，走 `shared-proxy` 网络 | 把反代容器接进 `shared-proxy` |

A 是 §4「一个端口都不映射」的例外：宿主机上的进程进不了 Docker 网络，只能走宿主端口。例外被限定在一个单独的文件里，**只开 app、只绑 `127.0.0.1`**，`compose.yaml` 本身仍然一个 `ports:` 都没有。

### 9.1 拉代码、填 `.env`

```bash
git clone <仓库地址> mememio && cd mememio
cp .env.example .env
```

逐项填 `.env`（字段语义见 [environments.md](environments.md)），和本机开发不同的只有这几项：

| 字段 | 部署时填什么 |
|---|---|
| `APP_SLUG` | 本机唯一。改了它，下文所有 `mememio-*` 都跟着变 |
| `DB_PASSWORD` | `openssl rand -hex 24` |
| `DATABASE_URL` | 照样例留着即可——容器里的 app 不读这一行，`compose.yaml` 会覆盖 |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `CONFIG_ENC_KEY` | `openssl rand -base64 24`（正好 32 字符）。**生成完立刻离线备份一份**（§7） |
| `R2_*` | 按 §8 开通，`R2_PUBLIC_BASE_URL` 不带末尾 `/` |
| `NODE_ENV` | **必须改成 `production`** |
| `COMPOSE_FILE` | **仅接法 A**：新加一行 `COMPOSE_FILE=compose.yaml:compose.host-proxy.yaml`。之后所有 `docker compose` 子命令都自动带上两个文件，不用每次敲 `-f` |
| `APP_HOST_PORT` | **仅接法 A，可选**：默认 `13080`，和同机别的服务撞了再改 |

> ⚠️ **`NODE_ENV=production` 同时是「会话 cookie 带 `Secure`」的开关**（`api/src/routes/auth.ts`）。于是两个方向都会静默出错：
>
> - 忘了改 → cookie 不带 `Secure`，HTTPS 下照样能用，只是少了一层保护，**没有任何报错**。
> - 改了但站点走的是 HTTP → 浏览器丢掉这个 cookie，表现是**注册 / 登录返回成功，下一个请求就 401**。先确认反代那头是 HTTPS。

### 9.2 构建并起库、迁移、起服务

```bash
# 全机只需一次；已存在会报 already exists，忽略
docker network create shared-proxy

docker compose build
docker compose up -d db
docker compose run --rm app node dist/migrate.js
docker compose up -d
docker compose logs -f app
```

顺序不能换：迁移之前起 app，启动时的版本检查会发现库落后，打印待跑的迁移后 `exit(1)`（§6），`restart: unless-stopped` 会让它反复重启。

日志里要看到监听端口那一行，**且没有「R2 探活失败」**（§8.4）。探活失败时进程拒绝启动，这是有意的。

`docker network create shared-proxy` 两种接法都要跑：`compose.yaml` 把它声明成外部网络，不存在时 `up` 直接报错。接法 A 用不到它，但声明还在。

### 9.3 反代

#### 接法 A：宿主机上的 nginx

先确认端口通了（`docker compose ps` 里 app 那一行应显示 `127.0.0.1:13080->3000/tcp`）：

```bash
curl -s http://127.0.0.1:13080/api/v1/health
```

然后在 `http {}` 里加一个 `server`：

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name mememio.example.com;
    # ssl_certificate / ssl_certificate_key：全局已配且证书覆盖这个子域时不用写

    location / {
        proxy_pass http://127.0.0.1:13080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 导入进度走 SSE，服务端 15 秒发一次心跳；超时必须比它长
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
```

HTTP → HTTPS 跳转的那个 `server` 的 `server_name` 里也加上这个域名。

> 为什么只要一个 `location /`：api 同域托管前端（`/api/*` 之外全回退 `index.html`），前后端是同一个进程，不需要像静态站那样拆 `root` 和 `/api/`。

⚠️ **Docker 发布的端口不受 ufw 管**——它直接写 iptables。所以 `compose.host-proxy.yaml` 必须绑 `127.0.0.1`；写成 `"13080:3000"` 会让不带 HTTPS 的 app 直接暴露在公网上，而 `ufw status` 里看不出来。

#### 接法 B：容器里的反代

把反代容器接到 `shared-proxy` 网络上（已经接过的跳过这步）：

```bash
docker network connect shared-proxy <反代容器名>
```

**Caddy**（自动申请证书）：

```caddyfile
meme.example.com {
	reverse_proxy mememio-app:3000
}
```

**nginx**：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name meme.example.com;
    # ssl_certificate / ssl_certificate_key 按你已有的证书方案填

    location / {
        # 反代的 DNS 解析：容器重建后 IP 会变，用 Docker 内置 DNS 按名字每次解析
        resolver 127.0.0.11 valid=30s;
        set $upstream http://mememio-app:3000;
        proxy_pass $upstream;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 导入进度走 SSE，服务端 15 秒发一次心跳；超时必须比它长
        proxy_read_timeout 120s;
        proxy_buffering off;
    }
}
```

#### 两种接法都适用

**`X-Forwarded-For` 是限流的前提，不是可选项。** api 按「反代追加在末尾的那一项」认客户端 IP，默认信任**一层**反代（`api/src/lib/client-ip.ts` 的 `TRUSTED_PROXY_HOPS = 1`）。所以：

- **nginx 必须设这个头**，用 `$proxy_add_x_forwarded_for`（追加）或 `$remote_addr`（覆盖）都行，末尾一项都是真实客户端。**不设**时 nginx 会把客户端自己带的 `X-Forwarded-For` 原样转发，末尾一项由请求方随便填，每次换一个值就换一个限流桶——登录限流（每分钟 10 次）等于没有。
- Caddy 默认就会设，不用写。
- **反代前面如果还有一层**（Cloudflare 橙云、云厂商负载均衡），就不是一层了。末尾那一项会变成 CDN 节点的地址，同一节点背后的人共用一个限流桶。**这种结构先不要上**，要改 api 端的取法。

请求体上限不用调：导入只上传文件清单，图片本身由浏览器直传 R2，最大请求体约 1 MB（`api/src/app.ts` 的 `MAX_BODY_BYTES`），nginx 默认的 `client_max_body_size 1m` 刚好够。

#### `/mcp` 与普通 REST 的差异

MCP 与 `/api` 同源同端口，反代仍然用上面那一个 `location /` 就行。额外注意四点：

- **TLS 由反代终结。** 公网域名需要 HTTPS：聊天客户端对远程地址一般要求 TLS，LINE 这类渠道强制两个公网 HTTPS URL；`api` 不提供证书。
- **SSE 缓冲关、读超时 ≥120 秒。** 本服务的工具都是快操作、固定返回 JSON（[SPEC §10.2](../spec/10-mcp.md#102-端点与传输)），但 Streamable HTTP 允许请求级升级为 SSE，客户端探测也可能挂长连接；沿用上面的 `proxy_buffering off` 与 `proxy_read_timeout 120s`，**不要单独给 `/mcp` 调小**。
- **请求体上限 256 KiB 由服务端执行（超了 413）。** nginx 默认的 `client_max_body_size 1m` 够用，**不要调到 256 KiB 以下**。
- **带 `Origin` 的请求一律 403。** 这是有意拒绝浏览器内的 MCP 客户端，不是 CORS 配错；见 [MCP 接入](mcp.md)。

**R2 公开桶是 MCP 的交付前提。** 工具返回的 `url` / `thumbUrl` 是 R2 公开地址，bucket 没开 Public Access 时聊天客户端和 IM 渠道都拿不到图；开通与格式要求见 §8.2。MCP **不需要新增环境变量**，默认挂载、没有开关。

配完 reload 反代，确认：

```bash
curl -s https://meme.example.com/api/v1/health
# {"status":"ok","startedAt":"...","vocabVersion":"..."}
```

### 9.4 首个管理员：反代一通立刻注册

**第一个注册的人自动成为管理员（`User`），不需要邀请码**（SPEC §3.2）。之后所有注册都要邀请码。这意味着从反代生效到你注册完成之间，**谁先打开 `/register` 谁就是管理员**。这个空窗期是有意保留的（[SPEC §9.32](../spec/09-decisions.md)），靠操作顺序避开：

1. 反代 reload 之后，**立刻**打开 `https://meme.example.com/register`，邀请码留空，注册。
2. 确认自己是管理员：

   ```bash
   docker compose exec db psql -U mememio -d mememio -c "select name, role, created_at from users order by created_at"
   ```

   只有一行、`role` 是 `User`、名字是你的——完成。

3. **如果第一行不是你**：马上把反代那条站点注释掉并 reload，然后清空用户及其挂着的一切（对方可能已经生成了邀请码、填了模型配置，这些表都有外键指向 `users`，只删 `users` 会失败）：

   ```bash
   docker compose exec db psql -U mememio -d mememio -c "truncate users cascade"
   ```

   ⚠️ **这条命令只在全新的库上用。** `cascade` 会连带清空所有引用用户的表，包括 `memes`——上线之后任何时候敲它，都是清库。

   再回到第 1 步。

之后给别人的邀请码在管理页生成。

### 9.5 上线后第一轮核对

走一遍 §10 的清单。其中三条只有在真域名下才验得到，别跳过：

- R2 CORS 的 `AllowedOrigins` 换成了正式域名；
- 真导一张图，`url` 和 `thumbUrl` 在浏览器里打得开；
- 点一次「复制」，剪贴板里是图而不是下载。

### 9.6 以后更新

```bash
git pull
docker compose build
docker compose run --rm app node dist/migrate.js
docker compose up -d
```

`migrate` 每次都跑：没有新迁移时它什么也不做（drizzle 按账本跳过已跑过的），漏跑时新镜像会起不来（§6）。

## 10. 落地检查清单

新机器部署或者新加一个同机项目时，逐条核对：

- [ ] `.env` 里 `APP_SLUG` 已改成本项目专属值，且与同机其他项目不重复
- [ ] `docker volume ls` 中本项目的卷带 `APP_SLUG` 前缀，且不与他人同名
- [ ] `docker network ls` 中内部网络带前缀；`shared-proxy` 已创建
- [ ] `compose.yaml` 里**没有任何 `ports:` 映射**（db 尤其不能暴露）；接法 A 的端口只在 `compose.host-proxy.yaml` 里，且绑的是 `127.0.0.1`（§9.3）
- [ ] **部署机上不存在、也永远不要用 `compose.dev.yaml`**——它唯一的作用是给本机开发把 db 的 5432 绑到 `127.0.0.1`，只在显式 `-f compose.dev.yaml` 时才生效。命名成 `compose.override.yaml` 会被自动加载，所以刻意**没有**这么命名
- [ ] `R2_KEY_PREFIX` 已设置（若与其他项目共用 bucket），且以 `/` 结尾
- [ ] `R2_PUBLIC_BASE_URL` 已设置，**不带末尾 `/`**，且**没有**把 `R2_KEY_PREFIX` 拼进去（§8.2）
- [ ] R2 的 S3 凭证来自 **R2 → Manage API Tokens**，不是通用 API Tokens 页那个 token value（§8.1）
- [ ] bucket 的 CORS 已配，`AllowedOrigins` 是**正式域名**而不是 `localhost:5173`，且 `AllowedMethods` **同时有 `PUT` 和 `GET`**（§8.3）
- [ ] 在浏览器里点一次「复制」——**剪贴板里是图，不是下载**。漏了 CORS 的 `GET` 时这一步会静默退化成下载（§8.3）
- [ ] 起一次进程确认没有「R2 探活失败」——它是 R2 配错唯一会主动报出来的地方（§8.4）
- [ ] 真导一张图，在浏览器里打开返回的 `url` 和 `thumbUrl`，**看到图**而不是 404
- [ ] 用真实 MCP 客户端连一次 `/mcp`，能列出 5 个工具；不带令牌的请求返回 `401` 而不是 `404`（[MCP 接入](mcp.md)）
- [ ] `CONFIG_ENC_KEY` 已离线备份到 Docker 和数据库之外的地方
- [ ] `.env` 里 `NODE_ENV=production`，且站点走 HTTPS（§9.1：两者不匹配时登录后立刻 401）
- [ ] 反代已配置指向 `${APP_SLUG}-app`，并设置了 `X-Forwarded-For`；反代前面**没有**再套一层 CDN（§9.3）
- [ ] 首个注册的账号是自己，`role = 'User'`（§9.4）
