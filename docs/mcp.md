# MCP 接入

> **状态（2026-10-23）：契约 `accepted`；两端实现完成并通过自动化闸门；真实客户端与 IM 渠道的联合验收进行中。** 端点和设置页按 [SPEC §10](../spec/10-mcp.md) 设计；文中标「接入时实测」的条目表示**本文没有承诺它一定可用**（渠道字段与限额以官方文档为准）。契约本身以 SPEC 为准。

**MCP（Model Context Protocol）是 `api` 的第二个外部接口：让 Claude、Cursor、Cherry Studio 或你自己的 IM 机器人，用一句想表达的话检索共享表情包库，拿到可直接交付的图片地址与元数据。** 它与 `/api/v1` 并列、不替代 REST；`web` 仍然只消费 REST。只读，不需要新增任何环境变量。

## 1. 边界：只读、只交图、不发渠道

| 做 | 不做 |
|---|---|
| 按语义检索、按标签筛选、随机取图、按 id 取图 | 上传、编辑、删除、收藏、重打标、管理、改配置 |
| 返回 `url` / `thumbUrl` 与元数据 | 把图发到微信 / QQ / LINE / 钉钉 / 飞书 |
| 用个人访问令牌读**该用户可读的整个共享库** | OAuth 登录、浏览器内 MCP 客户端、跨用户权限 |

- **只读。** 不暴露用户、邀请码、密钥；令牌能读的范围与登录后一致——**是整个共享库**，不是「只看自己的图」。
- **只交付图与 URL。** 真正发到渠道由你的机器人调用各渠道官方接口完成。MCP 不代理图片、不转码；渠道要的格式由机器人处理（聊天客户端可以内联小图，有大小上限，见 [SPEC §10.5](../spec/10-mcp.md)）。
- **个人微信 / 个人 QQ 没有官方机器人 API。** 本项目不提供、不承诺任何非官方协议；用个人号跑 bot 属于渠道侧行为，封号风险与合规责任在调用方。
- **不是 REST。** 端点是 `POST /mcp`，走 JSON-RPC 2.0，没有 REST 的响应信封和错误码；鉴权与限流仍用 HTTP 状态码。

## 2. 快速开始

### 2.1 准备

1. **开通 R2 公开访问。** 工具返回的 `url` / `thumbUrl` 是 R2 公开地址；bucket 没开 Public Access 时，聊天客户端和 IM 渠道都下载不到图。步骤见[部署手册 §8.2](deployment.md#82-公开访问)。
2. **反代透传 `/mcp`。** 地址与 `/api` 同源，TLS 由反代终结；不需要为 `/mcp` 单独写 `location`，但要注意缓冲、超时和请求体上限，见[部署手册 §9.3](deployment.md#93-反代)。
3. **不需要新增环境变量。** 端点默认挂载，没有开关；要停用就撤销全部令牌或回滚版本（[SPEC §10.2](../spec/10-mcp.md#102-端点与传输)）。

### 2.2 创建令牌

1. 登录后打开**设置页 →「MCP 接入」**（直达 `https://<你的域名>/settings#mcp`）。
2. 点「创建令牌」，填名称（1–64 字，例如「我的 Claude」）和有效期。有效期可选；不填 = 永不过期。
3. **完整令牌只在创建成功的那一次显示**，形如 `mcp_` 开头的一长串。复制保存到密码管理器；关掉后只能重建。
4. 列表里只显示前缀（前 12 个字符）、最后使用时间、过期时间；撤销立即生效。

每个用户最多 10 个有效令牌（未撤销且未过期）。令牌格式、存储与生命周期见 [SPEC §10.3](../spec/10-mcp.md#103-鉴权与访问令牌)；管理端点见 [SPEC §6.8](../spec/06-endpoints.md#68-访问令牌)。

### 2.4 可选：内容范围与过滤器

设置页「MCP 接入」里还有两项**用户级**设置，默认都不启用：

- **内容范围 → 允许成人向内容**：默认关闭。MCP 默认不返回标记「成人向」的图；打开后，工具还要在本次调用显式传 `allowAdult: true` 才返回（[SPEC §10.3.1](../spec/10-mcp.md#1031-内容范围成人向默认关闭)）。
- **过滤器**：按标签排除。选中的标签不会出现在任何 MCP 工具结果里；**只影响 MCP，不影响 Web 端浏览**。成人向不在这里选，由上面那个开关单独控制（[SPEC §10.3.2](../spec/10-mcp.md#1032-过滤器按标签排除)）。

需要调设置时在浏览器里操作 `GET/PUT /api/v1/mcp/settings` 与 `/api/v1/mcp/filter`（cookie 会话，见 [SPEC §6.9](../spec/06-endpoints.md#69-mcp-设置)）。

### 2.3 填到客户端

| 项 | 值 |
|---|---|
| 地址 | `https://<你的域名>/mcp` |
| 传输 | Streamable HTTP |
| 请求头 | `Authorization: Bearer <token>` |
| 方法 | `POST`（`GET` / `DELETE` 是 405：本服务没有会话和长流） |

先确认地址没写错、令牌没漏带：

```bash
# 不带令牌：应返回 401 + WWW-Authenticate: Bearer realm="mememio"
curl -i -X POST https://<你的域名>/mcp

# 带令牌：返回 200。没有协议头的请求按 2025 代回退，响应是 text/event-stream，
# 结果在 data: 那一行的 JSON-RPC 里；2026-07-28 客户端会带协议头，回普通 JSON。
curl -s https://<你的域名>/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> 401 只说明令牌不对，不说明地址不存在；带 `Origin` 头的请求一律 403，见 §8。真实客户端会自己完成版本协商并带齐 `MCP-Protocol-Version` / `Mcp-Method` 等头，上面的 curl 只是连通性自测。

## 3. 客户端配置

三种凭证写法是同一件事：地址、传输、`Authorization` 头。**客户端配置文件里会留下明文令牌**，别提交到仓库，共享配置前先删掉这个头。

### 3.1 Claude Code

```bash
claude mcp add --transport http mememio https://<你的域名>/mcp \
  --header "Authorization: Bearer <token>"
```

在会话里输入 `/mcp` 可以看到 `mememio` 是否连上。默认作用域与写入位置以 `claude mcp add --help` 为准；无论用哪种作用域，带令牌的配置文件都不要提交。

### 3.2 Claude Desktop 与通用 JSON 配置

编辑 `claude_desktop_config.json`（Claude Desktop：设置 → Developer → Edit Config）：

```json
{
  "mcpServers": {
    "mememio": {
      "type": "http",
      "url": "https://<你的域名>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

改完**完全退出并重启客户端**。不同客户端 / 版本对远程 HTTP 的支持不一样：只支持 stdio 的版本用 §3.5 的桥；只走 OAuth 的宿主（如 `claude.ai` connectors）不能直接用这种静态请求头，见 §8。

### 3.3 Cursor

在项目 `.cursor/mcp.json` 或用户级 `~/.cursor/mcp.json` 写：

```json
{
  "mcpServers": {
    "mememio": {
      "url": "https://<你的域名>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

保存后在 MCP 面板刷新，应出现 `mememio` 的 5 个工具。字段名、是否要求 `type`（`http` / `streamable-http`）以当前 Cursor 版本为准。

### 3.4 Cherry Studio

「设置 → MCP 服务器 → 添加服务器」：

- 类型选 **Streamable HTTP**（有的版本叫「HTTP」）；
- URL 填 `https://<你的域名>/mcp`；
- 在「自定义请求头」里加 `Authorization: Bearer <token>`。

保存后如果工具列表为空，先确认请求头确实带上了——不少客户端把自定义头放在二级设置里。菜单名称随版本变化，以客户端为准。

### 3.5 只支持 stdio 的客户端：用 `mcp-remote` 桥

```bash
npx -y mcp-remote https://<你的域名>/mcp \
  --header "Authorization: Bearer <token>"
```

写进客户端配置时：

```json
{
  "mcpServers": {
    "mememio": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<你的域名>/mcp",
        "--header",
        "Authorization: Bearer <token>"
      ]
    }
  }
}
```

- 首次运行会下载依赖，机器需要能访问 npm；内网环境先 `npm i -g mcp-remote`，再把 `command` 换成 `mcp-remote`，并删掉 `args` 里的 `-y` 和 `mcp-remote` 两项。
- Windows 上部分客户端不认 `npx` 直接作为命令，改成 `cmd` + `/c` + `npx`，以客户端文档为准。
- `--header` 的参数格式随 `mcp-remote` 版本可能变化，跑 `npx mcp-remote --help` 确认。

## 4. 工具清单

5 个工具全部只读，`tools/list` 顺序固定（客户端可以缓存）。输入里的七个筛选维度与 Web 浏览一致：同一维度多值取 AND；**词表外的值不报错，直接返回空结果**——先调 `list_vocab` 比让模型猜维度名可靠。

| 工具 | 什么时候用 | 主要输入 | 返回 |
|---|---|---|---|
| `search_memes` | 有明确想表达的意思，要一组候选自己挑 | `query` 1–200 字、`limit` 1–20（默认 8）、七个筛选维度、`isAnimated`、`favorited`、`detail`、`allowAdult` | `query` / `rewritten` / `degraded` / `items[]` |
| `pick_meme_for_reply` | 聊天里要「直接回一张」，不想自己挑 | `message` 1–200 字（建议先压成 10–20 字意图）、`inline`（默认 true）、同上的筛选参数 | `chosen`（1 条；精确检索为空时会安全随机兜底）+ `alternatives`（最多 5 条）+ 可选缩略图 |
| `get_meme_image` | 已知 `memeId`，要元数据或图 | `memeId`、`variant`（`thumb` 默认 / `original`）、`inline`（默认 true）、`allowAdult` | `MemeSummary`；允许时附一条 MCP `image` |
| `random_meme` | 没有明确意图：暖场、随机发一张 | `limit` 1–10（默认 3）、`isAnimated`、`allowAdult` | `items[]`（默认排除成人向） |
| `list_vocab` | 构建筛选前先查合法值 | 无 | 词表版本 + 七个维度 + 当前账号 `allowAdult` |

每条 `MemeSummary` 含 `id`、`description`、`ocrText`（截断到 120 字）、七个标签维度、`isAnimated`、`mime`、`width` / `height` / `sizeBytes`、公开地址 `url` 与缩略图 `thumbUrl`；**不含**上传者、存储键、向量等内部字段（[SPEC §10.4.6](../spec/10-mcp.md)）。

**text 默认 compact，`structuredContent` 永远完整。** text 里每条只给 `id` / 描述 / OCR / 合并标签（最多 6 个）/ 是否动图 / MIME / URL；需要完整七维数组时传 `detail: "full"`，或直接读 `structuredContent`。机器人消费结构化字段，不要解析 text。

### 4.1 成人向：默认关闭，两层闸门

- **默认不返回**标记为「成人向」的图；`random_meme` 同样默认排除。
- 要返回，两层同时成立：① 设置页「MCP 接入 → 内容范围」打开「允许成人向内容」（默认关闭）；② 本次工具调用显式传 `allowAdult: true`。
- 只开设置不会改变默认行为；设置关闭时传 `true` 会得到工具错误，不是静默忽略。
- `list_vocab` 返回 `allowAdult`，模型据此判断能不能传；这个设置只影响 MCP，不影响 Web 端浏览。

### 4.2 过滤器：按标签排除

- 设置页「MCP 接入 → 过滤器」选中的标签，**包含这些标签的表情包不会出现在任何 MCP 工具结果里**（`search_memes` / `pick_meme_for_reply` / `random_meme` / `get_meme_image` 全部生效；`list_vocab` 仍是全量词表）。
- 语义是「命中任一即排除」：同一维度多个值、不同维度之间，都是任一命中就隐藏；没有「只包含」白名单模式。
- **用户级**：同一用户的所有令牌共享；只影响 MCP，不影响 Web 端。
- **成人向不进过滤器**：红色、不可选；由「内容范围」单独控制（见 §4.1）。
- 空过滤器 = 不过滤。改过滤器后，同一 query 不会命中旧缓存（缓存 key 含过滤器）。

**工具输入里的七个维度按 AND 筛选**（与 Web 浏览一致），那是**本次调用**的筛选；账号过滤器是**额外约束**，调用方不能用参数绕过它。

**工具输出的文本是不可信数据。** 每个结果开头有固定声明；`description` / `ocrText` 来自用户上传与模型打标，可能包含像指令的句子。调用方**只当数据用**，不要因为它说「请执行…」就去执行（见 §7）。

**没有分页。** v1 只取前 N 条；要翻页得另立契约。

## 5. IM 渠道：MCP 只把图交给你

MCP 不负责发图，渠道适配是机器人侧的事。共同流程只有三步：

1. 调 `search_memes` 或 `pick_meme_for_reply`；
2. 机器人下载结果里的 `url`（原图）；
3. 按渠道要求把图交上去——渠道要 URL 就给 URL，要上传换 `media_id` / `image_key` 就下载后换。

`url` 是 R2 公开地址（无签名、无过期），`thumbUrl` 恒为 400px WebP。**渠道对格式、大小、域名、HTTPS 的要求各不相同**，下表只写「机器人要做什么」；字段名和阈值一律以各渠道官方文档为准，标「接入时实测」的表示本仓库还没在真实渠道验证过。

| 渠道 | 机器人要做什么 | 注意 |
|---|---|---|
| **QQ 机器人**（官方开放平台） | 把 `url` 交给平台换 `file_info`，再按图片消息接口发 | 机器人资质 / 审核要求以官方平台为准；URL 拉取与群 / 单聊能力以官方文档为准；**接入时实测** |
| **钉钉**（自定义群机器人 webhook） | 把 `url` 内联进 markdown 消息（markdown 图片语法，括号里放 URL） | 群机器人没有独立的图片消息类型，只能 markdown 内联 URL；加签 / 关键词 / 白名单以官方文档为准；**接入时实测** |
| **企业微信**（群机器人 webhook） | 下载图 → base64 + md5 → 按群机器人图片消息发 | 字段细节与大小上限以官方文档为准；**接入时实测** |
| **企业微信**（自建应用） | 下载图 → 上传临时素材拿 `media_id` → 发应用消息 | 企业资质、应用可见范围与 secret 均以官方文档为准；**接入时实测** |
| **微信公众号** | 下载图 → 上传素材拿 `media_id` → 客服消息 / 自动回复发图 | **客服消息有 48 小时窗口**（用户先发消息才能回，具体口径以官方文档为准）；订阅号与素材接口权限以官方文档为准；**接入时实测** |
| **飞书** | 先把图上传 / 换取 `image_key`，再发图片消息 | 应用权限与 `tenant_access_token` 以官方文档为准；富文本也可用 `image_key`；格式与大小限制以官方文档为准；**接入时实测** |
| **LINE**（Messaging API） | 直接填两个公网 HTTPS URL：原图 + 预览图 | 必须 HTTPS 且公网可访问；`thumbUrl` 是 WebP，是否被接受**接入时实测**；格式与尺寸限制以官方文档为准 |
| **个人微信 / 个人 QQ** | **不做** | 2026 年仍没有官方机器人 API；非官方协议违反 ToS、有封号风险，本项目不提供 |

**格式不支持时在机器人侧转。** `url` 可能是 GIF；`thumbUrl` 恒为 WebP。渠道只收 JPEG / PNG 或不收动图时，机器人自己用 ffmpeg / sharp 之类的工具转——MCP 端没有图片代理或转码端点，这是有意为之（[SPEC §10.9](../spec/10-mcp.md)）。

**图片打不开先查 R2。** 渠道拉不到 `url` 时，先在浏览器或另一台机器 `curl` 一下公开地址；打不开就是 bucket 没开 Public Access 或 `R2_PUBLIC_BASE_URL` 配错，不是 MCP 的问题。

## 6. 限制与成本

| 项 | 限制 |
|---|---|
| 检索类工具限流 | 每个令牌 **30 次/分钟**（`search_memes` / `pick_meme_for_reply`） |
| 全部 MCP 请求限流 | 每个令牌 **120 次/分钟** |
| 超限 | HTTP `429` + `Retry-After`（秒） |
| 输入长度 | `query` / `message` 1–200 字；`limit` 1–20；`random_meme` 1–10 |
| 请求体 | 256 KiB，超过 `413` |
| 结果缓存 | 进程内 **60 秒**（同一用户 / 查询 / 筛选 / limit / **成人向许可 / 过滤器**才命中）；命中不重复调 AI |
| 令牌数量 | 每人最多 10 个**有效**令牌（未撤销且未过期） |
| 分页 | 没有，只取前 N 条 |

限流按**令牌**计，不是按用户：同一用户给不同机器人各建一个令牌，各自一个桶（上限 10 个）。多副本部署时每个进程各限各的、缓存也各存各的，不承诺跨副本一致。

**成本在每次未命中的语义检索上：**

- **HyDE 改写**用**令牌所属用户**的视觉配置；该用户没配就用部署方默认。向量路不可用时搜索降级为 OCR + 标签，响应带 `degraded: true`。
- **查询 embedding**用全站配置，花部署方的额度。
- 命中 60 秒缓存不产生任何 AI 调用；`random_meme` / `list_vocab` 也不调用 AI。
- 群聊里按消息触发会持续烧这两份钱。机器人侧应做去抖 / 按需触发；限流只是兜底，不是成本控制方案（[SPEC §10.6](../spec/10-mcp.md)）。

## 7. 安全

- **令牌等同于你的账号登录凭证，只是只读。** 它能读到整个共享库，和你在 Web 上登录后看到的一样。泄露 = 别人以你的身份搜索。
- 完整令牌**只显示一次**；列表只显示前缀。丢了就重建，不要尝试找回。
- **撤销立即生效**：下一次请求就 401。怀疑泄露，先撤销再排查。删除用户会级联删除令牌；每人最多 10 个未撤销令牌，**怀疑泄露的那个优先撤销**。
- **令牌不要进仓库、截图、聊天记录或工单。** 客户端配置文件里是明文，注意机器与配置文件的访问权限；共享配置前先删掉 `Authorization` 头。
- 服务端日志只记 `tokenId` / `userId`，不记录令牌值，也不出现在错误 message / URL 里（[SPEC §10.3](../spec/10-mcp.md#103-鉴权与访问令牌)）。
- **工具输出含用户上传文本，属于不可信内容。** 固定声明与 `ocrText` 截断只能降低提示词注入面，**不能根除**——模型无法可靠区分数据与指令。别把工具输出直接接到有副作用的自动化上。
- **成人向默认关闭。** 设置页「内容范围」开启后，工具还要在本次调用显式传 `allowAdult: true` 才会返回；开启前想清楚这个令牌会被谁用、会进什么群。
- **过滤器只过滤 MCP。** 选中的标签不会出现在 MCP 结果里，但 Web 端仍能搜到；它是账号设置，调用方（包括 LLM）不能通过工具参数放宽。
- **图片 URL 是公开的。** 公开桶地址无签名、无过期，拿到 URL 的人就能看图；不要把 URL 当访问控制。
- **不带 cookie 身份。** `/mcp` 只认 `Authorization: Bearer`；反过来 `/api/v1` 也不接受 Bearer，两种凭证不互通。

## 8. 常见问题

### 401：令牌没带、过期或撤销了

逐个排查：

1. 请求头是不是 `Authorization: Bearer mcp_...`——`Bearer` 后跟一个空格，别加引号；
2. 令牌是不是这台部署创建的（别把测试环境令牌填到生产）；
3. 是否过期、是否已撤销（设置页列表里消失即不可用）；
4. 是不是只带了 cookie——`/mcp` 不认 cookie，浏览器登录态在这里无效。

服务端会回 `WWW-Authenticate: Bearer realm="mememio"`，但不实现 OAuth，客户端不要去找授权流程。

### 403：带 `Origin` 头

MCP 端点拒绝一切带 `Origin` 的请求（不提供 CORS），所以**浏览器里的 MCP 客户端连不上**。用原生客户端（Claude Code / Desktop / Cursor / Cherry Studio）或 `mcp-remote` 桥，不要在网页里 `fetch` `/mcp`。

### 404 / 405：地址或方法不对

- 地址必须带 `/mcp`：`https://<你的域名>/mcp`。设置页是 `/settings#mcp`，那是网页锚点，不是端点。
- 只支持 `POST`。`GET` / `DELETE /mcp` 返回 405——本服务没有会话、没有独立长流、不支持断线续传。
- 404 还可能意味着部署的版本还没有 MCP：确认镜像版本，或先看 `POST /mcp` 是否返回 401（有 401 说明端点存在）。

### 工具不出现 / 连不上

- 客户端没完成握手：保存配置后**完全重启**客户端，再刷新 MCP 面板；
- 自定义请求头没带上：有些客户端把 headers 放在二级设置里，或只对某种传输类型生效；
- 客户端只支持 stdio：用 §3.5 的 `mcp-remote`；
- 客户端只走 OAuth 的宿主（如 `claude.ai` connectors）：PAT 直连不了，用桥接或换原生客户端；本服务不实现 OAuth（[SPEC §10.9](../spec/10-mcp.md)）；
- 协议版本不匹配：服务端支持 2026-07-28 与 2025 代 `initialize` 客户端，不匹配时可能 400，升级客户端或用支持 Streamable HTTP 的版本。

### 图片打不开

1. 在**外网**能访问 `url` / `thumbUrl` 吗？不能 → R2 公开访问没开，或 `R2_PUBLIC_BASE_URL` 配错（末尾 `/`、把 `R2_KEY_PREFIX` 拼进去都是典型错误，见[部署手册 §8.2](deployment.md#82-公开访问)）；
2. 用自定义域时证书和 DNS 是否生效？渠道要求公网 HTTPS，内网地址 / 自签证书不行；
3. 是聊天客户端不显示、但 URL 本身能打开吗？客户端可能不渲染纯文本 URL，这是客户端行为；`pick_meme_for_reply` / `get_meme_image` 会内联缩略图（有大小上限），原图只给 URL。

### 动图 / WebP 发不出去

`thumbUrl` 恒为 WebP，原图可能是 GIF。渠道（尤其部分 IM 与公众号素材接口）对格式 / 大小有限制时，机器人在发送前转成渠道接受的格式；MCP 不转码、不代理，这是设计边界。是否支持以渠道官方文档和接入时实测为准。

### 429：被限流

按 `Retry-After` 秒数退避。检索类工具 30 次/分钟、全部请求 120 次/分钟，都按令牌计。群聊高频触发时在机器人侧合并请求 / 去抖，别靠重试。

### 413：请求体太大

MCP 请求体上限 256 KiB。正常工具参数远小于这个值——不要把图片字节塞进 JSON-RPC 参数，MCP 只收文本参数。

### 400：协议错误

协议版本、`Mcp-Method` / `Mcp-Name` 等头与请求不匹配时，服务端按协议回 400（不走 REST 错误信封）。先确认客户端版本；这不是令牌问题。

### 按标签筛不出东西

七个维度的值必须在词表里；**词表外不报错，只返回空**。先调 `list_vocab` 拿当前版本与合法值，再让模型构筛选条件。`favorited: true` 只看令牌所属用户的收藏，别人看不到。

### `pick_meme_for_reply` 为什么返回「随机挑一张」

精确检索和词表关键词都没命中时，工具会从**安全范围**（默认排除成人向与账号过滤器）随机兜底，并在 text 里注明。把 `message` 换成 10–20 字的意图摘要（「被夸了有点得意」而不是整段对话）通常能直接命中。

### 设了过滤器后结果变少 / 搜不到某张图

这是预期行为：设置页「MCP 接入 → 过滤器」选中的标签会被排除，且对 `search_memes` / `pick_meme_for_reply` / `random_meme` / `get_meme_image` 全部生效。过滤器是账号级、只影响 MCP；Web 端仍能搜到。检查设置页的「已排除 N 个」和标签预览，或清空过滤器。

### 成人向内容怎么才能返回

两层同时成立才返回：① 设置页「MCP 接入 → 内容范围」打开「允许成人向内容」（默认关闭）；② 工具调用里显式传 `allowAdult: true`。只开设置不会改变默认行为；设置关闭时传 `true` 会得到工具错误。`list_vocab` 会告诉模型当前账号是否允许。

### 想停用 MCP

没有开关：撤销全部令牌，或回滚版本（[SPEC §10.2](../spec/10-mcp.md#102-端点与传输)）。不要加「MCP 开关」——令牌建了却 404 是更坏的失败。

## 9. 相关

- 契约：[SPEC §10](../spec/10-mcp.md)；令牌模型 [§5.8](../spec/05-data-models.md#58-访问令牌)；令牌管理端点 [§6.8](../spec/06-endpoints.md#68-访问令牌)；MCP 设置模型 [§5.9](../spec/05-data-models.md#59-mcp-设置) 与端点 [§6.9](../spec/06-endpoints.md#69-mcp-设置)；设计决策 [§9.35](../spec/09-decisions.md)、[§9.36](../spec/09-decisions.md)、[§9.37](../spec/09-decisions.md)。
- 部署：[部署手册](deployment.md)（反代 §9.3、R2 公开访问 §8.2）；[环境变量](environments.md)——**MCP 不需要新增任何变量**。
- 实现约束与测试面：[`api/agents/rules/mcp.md`](../api/agents/rules/mcp.md)。
- 当前进度与联合验收：任务板里的 MCP 接入任务；状态变更见 [SPEC §10.7](../spec/10-mcp.md#107-兼容与状态)。
