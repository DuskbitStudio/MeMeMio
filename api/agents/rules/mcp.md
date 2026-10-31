# MCP 接入

契约见 [SPEC §10](../../../spec/10-mcp.md)、令牌模型 [§5.8](../../../spec/05-data-models.md#58-访问令牌)、管理端点 [§6.8](../../../spec/06-endpoints.md#68-访问令牌)。本文是实现约束。

## 1. 放在哪，不放在哪

```
src/mcp/              MCP 子应用与工具（不认识 HTTP 错误信封，只认识 MCP）
src/routes/access-tokens.ts   令牌 REST（cookie 会话，普通业务端点）
src/data/access-tokens.ts     令牌的全部 SQL（唯一入口）
src/lib/token.ts      令牌生成 / 哈希 / 前缀（纯函数，可单测）
```

**不把 MCP 挂进 `src/app.ts`。** `web` 通过 `AppType` 消费 api 的类型，`app.ts` 的 import 图会整个进入 `web` 的 typecheck；MCP SDK 依赖 Node 类型与自己的 wire 类型，塞进去只会让前端闸门变慢、变脆。做法是：

- `src/mcp/app.ts` 只依赖 `hono` 与 SDK，导出 `createMcpApp(deps)`；**不 import `env.ts` / `db.ts` / `data/*`**，这样它能被 unit 测试直接构造。
- `src/mcp/production.ts` 组装真实依赖（db、令牌校验、工具工厂），导出 `mcpApp`。
- `src/server.ts` 在 `serve()` 的 `fetch` 上按 path 分流：`/mcp` → `mcpApp.fetch(req)`，其余 → `app.fetch(req)`。
- 静态产物回退、全局 bodyLimit、全局错误信封都不影响 `/mcp`——它有自己的中间件栈。

## 2. 传输配置

```ts
createMcpHandler(buildServer, {
  legacy: 'stateless',          // 2026-07-28 + 2025 代，见 SPEC §10.2
  maxRequestBodySize: 256 * 1024,
  onerror: (err) => log.error({ err }, 'mcp handler error'),
})
```

- **不显式设 `responseMode`**：默认 `auto` 在「工具不发中途通知」时就是单个 JSON。写成 `'json'` 会让 SDK 每次启动打一条「json 会丢通知」的警告，而本服务的工具不发 progress/logging，那条警告在此永远不成立，只会污染启动日志。
- `handler.fetch(c.req.raw, { authInfo })`；**不传 `parsedBody`**，让 handler 自己读原始 body（我们自己要 peek body 做工具限流时用 `c.req.raw.clone()`，不要消费原流）。
- `GET` / `DELETE /mcp` 由 SDK 按规范回 405，不要自己写。
- 不引入 `createMcpHonoApp`：它的 Host 白名单要求部署时配置域名，而本项目没有新增环境变量；Origin 拒绝与 body 上限在我们自己的 Hono 层做。

## 3. 鉴权

`src/mcp/auth.ts`（或 app 内中间件）按顺序做：

1. 读 `Authorization`；不是 `Bearer ` 前缀 → 401。
2. `sha256(token)` → `data/access-tokens.findActiveByHash()`，必须同时满足 `revoked_at is null` 且（`expires_at is null` 或 `> now()`）。
3. 校验不过一律 **401 + 同一个挑战头**（SPEC §10.3）：

   ```http
   WWW-Authenticate: Bearer realm="mememio", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mememio:read"
   ```

   **只有一个 401 出口**：无令牌、格式错、失效、过期、撤销都是它，不按令牌前缀分流。
   `resource_metadata` 对 PAT 与 OAuth 访问令牌**统一携带**——挑战发生时系统还不知道
   这个 Bearer 是什么，而走发现流程的客户端只认头里的这一个入口（[§9.38](../../../spec/09-decisions.md)）。
   `<origin>` 来自 `createOriginResolver(deps.publicOrigin)`：配了 `PUBLIC_ORIGIN` 就固定用它，
   否则按 `Host` + `X-Forwarded-Proto` 推导。**`createMcpApp` 不读 env**，origin 由调用方注入，
   `/mcp` 的挑战与 `/.well-known/*` 的 issuer 必须是同一个 origin，否则客户端拼出的端点不一致。

   挑战头里有 `resource_metadata`，**响应体里不放**：SDK 只读头。
4. 成功时构造 `AuthInfo`：

```ts
{
  token,
  clientId: user.id,
  scopes: ['mememio:read'],
  expiresAt: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : undefined,
  extra: { userId: user.id, role: user.role, tokenId: row.id },
}
```

5. 更新 `last_used_at`：**内存节流 5 分钟/令牌**。不要每个请求 UPDATE。
6. 令牌值不进日志。日志只记 `{ requestId, tokenId, userId }`。

工具里取身份：`ctx.http?.authInfo?.extra`。**不要相信 `clientId` 之外的自定义字段来自客户端**——`AuthInfo` 是我们自己构造的，只有校验通过才会出现。

## 4. 限流

两个桶，键都是 `tokenId`：

| 桶 | 判定 | 阈值 |
|---|---|---|
| 全部 MCP 请求 | 每请求 | 120 / 分钟 |
| 检索类工具 | 方法 `tools/call` 且 `params.name` ∈ {`search_memes`, `pick_meme_for_reply`} | 30 / 分钟 |

- 为了知道工具名，中间件可以 `await c.req.raw.clone().text()` 后解析 JSON；**解析失败不要拦**，交给 SDK 回 JSON-RPC parse error（但仍计入总桶）。
- 超限返回 HTTP `429` + `Retry-After`（秒）。
- 进程内滑动窗口，多副本各限各的——与 [rate-limit.md](../../../api/src/middleware/rate-limit.ts) 的既有口径一致，不引入共享存储。

### 4.1 日预算（第二道闸）

分钟桶之后还有一道**按令牌的日预算**（SPEC §10.11）：每键 2000 次/UTC 自然日，超了同样 `429`，
`Retry-After` 是**到下一个 UTC 0 点的秒数**（`secondsUntilUtcMidnight`），不是分钟桶那种窗口剩余。

- **计数源是数据库**（`countMcpCallsToday` 数 `mcp_call_logs`），不是内存：审计行本身就是计量表，
  多副本天然一致，也不需要另建一张计数表。
- **键是 `budgetKey` 不是 `tokenId`**：OAuth 访问令牌每小时刷新换一行，按行计会在每小时重置；
  鉴权层按 `grant_id ?? token_id` 算好塞进 `AuthInfo.extra`（`mcp/auth.ts`），中间件只读。
- **只拦真正的工具调用**：`peekJsonRpcCall` 拿到的 `toolName` 为 null（握手、`tools/list`、
  未知工具名）不查库、不计数。未知工具由 SDK 回 JSON-RPC error，根本不执行。
- **查库失败 = 未超限**（fail-open）。计数坏掉不该让整个 MCP 服务 503；`onDailyCountError`
  记 `requestId` / `tokenId` 供排查。
- **两道闸拦下的请求都不写审计**。顺序固定：分钟桶 → 日预算 → 执行 → 审计。审计写在工具回调里，
  被拦的请求走不到那里；反过来在中间件里写一行「被拦」也是错的，§10.11 的审计只记执行过的调用。

## 5. 结果缓存

`src/mcp/cache.ts`：进程内 Map + 60 秒 TTL + 最多 500 条（超过按插入顺序淘汰）。

- key：`userId + '\0' + query + '\0' + JSON.stringify(filter) + '\0' + limit + '\0' + safe|adult + '\0' + 排除过滤器`。**必须含 userId**：`favorited` 与将来的个性化语义都按用户算；**必须含成人向许可与账号过滤器**：两者都改变结果集，漏了会让改设置后的同 query 命中旧结果（§10.3.1 / §10.3.2）。
- 只缓存 `search_memes` / `pick_meme_for_reply` 的检索结果；不缓存图片字节。
- 命中不调用 HyDE / embedding；未命中才走 `runSearch`。
- 不要落库：`search_snapshots` 是翻页快照，不是查询缓存，两者生命周期与语义都不同。

## 6. 工具实现

- 文件：`src/mcp/tools/*.ts`，一个工具一个文件；`src/mcp/server.ts` 只负责注册与顺序（`search_memes` → `pick_meme_for_reply` → `get_meme_image` → `random_meme` → `list_vocab`，**顺序固定**）。
- 检索：**直接组合 `runSearch` + `fetchHits`**（`services/search.ts`），不落快照、不分页。**不要用 `searchMemes`**：那个函数的注释写明「新端点不要用它」，它的存在是给测试用的。
- 随机：`data/memes.ts` 的 `listMemes({ random: true, ...filter }, actorId)`。
- 单条：`getMemeById(id, actorId)`；软删过滤在 data 层，查不到就返回工具错误，不自己拼条件。
- 输出：**只有一份** `MemeSummary` 组装函数（`src/mcp/format.ts`），字段清单见 SPEC §10.4.6。不要直接 `c.json(serializeMeme(row))`——序列化器里有 `uploaderId` / `favorited` / `tagStatus` 等 MCP 不该返回的字段。
- `ocrText` / `description` 截断 120 字、去控制字符；每个结果文本以固定「不可信数据」声明开头（SPEC §10.4.7）。
- **text 默认 compact**（`detail` 参数）：text 只给选图必需字段，`structuredContent` 永远完整。不要把 compact 误写进 structuredContent。
- **成人向过滤在工具层做**（SPEC §10.3.1）：`runToolSearch` 多取候选、按 `ratings` 过滤；`randomToolRows` 同理。**不要改 `data/search.ts` 的共享 SQL**——那会让 Web 的语义跟着变。
- **账号排除过滤器也在工具层做**（SPEC §10.3.2）：令牌鉴权把 `user_mcp_settings.excluded` 归一化后放进 `AuthInfo.extra.excluded`；`runToolSearch` / `randomToolRows` 多取候选后按 `isExcludedByFilter` 过滤；`get_meme_image` 拿到行后也要判。**同样不要改共享 SQL**。
- **过滤器校验只在 `lib/mcp-filter.ts`**：`parseMcpFilterPayload` 严格校验词表与 `ratings` 非空；`normalizeMcpFilter` 负责把数据库里的脏 JSON 变成安全形状。路由与鉴权都 import 它，不要各写一份。
- **图层（Layer）顺序**：先成人向闸门（可能直接工具错误），再用账号过滤器（静默隐藏）；`get_meme_image` 两个都判，报错文案分别对应。
- **两层闸门**：`resolveAdultAccess(actor, args.allowAdult)`；设置关闭时传 true → `toolError`，不静默忽略。`list_vocab` 返回账号的 `allowAdult`。
- **`pick` 三级兜底**（SPEC §10.4.2）：原句 → 词表关键词（`mcp/query.ts`）→ 安全随机；随机兜底要在 text 里注明，不返回 `chosen: null`（库非空时）。
- 错误：用户可自纠的（参数越界、meme 不存在、账号未开启成人向）→ `{ content:[text], isError:true }`；未知工具/解析错误交给 SDK。**不要抛 `AppError`**：那套信封是 REST 的，MCP 没有它的出口。
- `server.ts` 的 `McpServer` 要带 `instructions`（构造器第二个参数），告诉模型「先总结意图再 pick、一次发一张、成人向默认关闭」。这是给模型的使用说明，不是用户文案。

## 7. 图片

- 缩略图内联：`headObject(thumbKeyFor(row.storageKey))` → 超 512 KiB 不内联 → `getObject` → base64。
- 原图内联：仅在 `variant === 'original'` 且 `headObject.sizeBytes <= 2 MiB` 时；否则只回 URL + 一句说明。
- **永远先 head 再 get**（[r2.ts](../../../api/src/storage/r2.ts) 的注释）：直接 get 会把一个声明 1KB、实际 2GB 的对象整份读进内存。
- 不新增图片代理/转码端点（SPEC §10.5）。

## 8. 令牌（REST 侧）

- `src/lib/token.ts`：`mcp_` + base64url(32 字节)；`sha256` 十六进制；`prefix` = 前 12 个字符。纯函数，必须单测。
- 创建响应是完整令牌**唯一**一次出现的地方；响应头 `Cache-Control: no-store`。
- 列表只回 `prefix`；撤销幂等；不存在/不属于本人都是 404。
- 上限 10 个有效令牌；`name` 1–64 字；`expiresInDays` 1–3650。

### OAuth 访问令牌与 PAT 共用同一条校验链

OAuth 2.1 授权服务器（SPEC §10.10）签发的访问令牌就是 `access_tokens` 里的一行：
`kind = 'oauth'`、`grant_id` 指向授权，**校验、限流、工具行为与 PAT 逐字相同**——
`/mcp` 只有一条鉴权路径，不新增第二个中间件。

| 位置 | 规则 |
|---|---|
| `findActiveByHash` | **不加 `kind` 过滤**。加了会把 OAuth 令牌挡在 `/mcp` 外面，而这正是它存在的理由 |
| `createAccessToken` / `listActiveTokens` | **只算 `kind = 'pat'`**。「最多 10 个」与设置页列表是个人访问令牌的，一次 OAuth 授权不该挤掉 PAT 名额，也不该出现在 PAT 列表里（OAuth 授权有自己的 20 条上限与 `/api/v1/oauth/grants`） |
| 撤销 | 撤销 grant → 其下所有访问令牌与刷新令牌一并失效；单撤销一个访问令牌不影响 grant |

**凭证不互通**（SPEC §3.1 / §3.3）：OAuth 访问令牌与 PAT 能在 `/mcp` 上用，**都不能**在
`/api/v1` 上当 cookie 用；`/api/v1/oauth/*` 只认 cookie，Bearer 一律 401。

## 9. 测试

- `src/lib/token.test.ts`（unit）：格式、前缀、哈希、长度。
- `src/mcp/app.test.ts`（unit）：`createMcpApp` 注入假依赖，验证 401、Origin 403、429、tools/list 顺序与 JSON-RPC 形状。**这条不依赖数据库**，Docker 没起也能跑。
- `tests/access-tokens.test.ts`（integration）：创建/列表/撤销/上限/一次性返回/不入响应。
- `tests/mcp-auth.test.ts`（integration）：缺失/格式错/过期/撤销 → 401；有效令牌可调用；日志不落值（用日志替身或抓 stderr）。
- `tests/mcp-tools.test.ts`（integration）：搜索结果与 `GET /memes?q=` 同序；软删不出现；`favorited` 按令牌用户；不返回内部字段；图片内联上限与回退。
- `tests/mcp-policy.test.ts`（integration）：设置端点默认/读写/校验；成人向三态（默认排除、只开设置仍排除、设置+参数才返回）；compact/full；`pick.inline`；长句兜底与随机兜底。
- `tests/mcp-filter.test.ts`（integration）：`/mcp/filter` 默认/读写/校验；search/pick/random/get 全面过滤；Web 端不受影响；改过滤器后同 query 不命中旧缓存。
- `src/lib/mcp-filter.test.ts`（unit）：过滤器解析、词表校验、`ratings` 拒绝、脏 JSON 归一化、命中判断、缓存 key 稳定。
- `src/mcp/query.test.ts`（unit）：词表关键词提取与兜底查询（不依赖数据库）。
- `tests/mcp-oauth.test.ts`（integration）：OAuth 2.1 全流程——DCR 校验（fragment / 非 https / 超 10 个 / 错误 auth method）、两种 well-known 形态、401 带 `resource_metadata` 与 `scope`、授权码完整流程、错 verifier 不烧码、码重放撤 grant、刷新旋转与复用检测、20 条 grant 上限、撤销幂等、PAT 不回归。
- 集成测试连真 Postgres，**新增表要加进 `tests/helpers/test-db.ts` 的 truncate 清单**（`access_tokens` / `user_mcp_settings`，以及 OAuth 的 `oauth_clients` / `oauth_grants` / `oauth_authorization_requests` / `oauth_authorization_codes` / `oauth_refresh_tokens` / `mcp_call_logs`）。
- `tests/mcp-audit.test.ts`（integration）：审计写行、`queryText` 只对本人可见、`scope=all` 的权限与跨用户 `tokenId`、日预算 429 与次日恢复、OAuth 刷新不重置预算、写日志失败不拦请求、清理只删 90 天前的行。**连库用例一律经 `tests/helpers/mcp-audit.ts` 的 `createTestAudit(db)`**，不要各自拼一份写实现。

## 10. 调用审计（实现约束）

契约在 SPEC §10.11 / §5.11 / §6.11，这里只记「代码上必须怎么放」：

**写在哪。** `mcp/server.ts` 的 `withAudit` 包装 `server.registerTool`，每个工具回调执行完写一行。
不要改到 `app.ts` 去解析响应——工具名与 `isError` 只有注册那一层拿得到，从 JSON-RPC 响应
反推会随协议版本（2025 代的请求级 SSE / 2026-07 的单 JSON）漂移。

**失败只降级。** 写失败捕获后调 `audit.onError`，然后**原样返回工具结果**；工具自己抛的异常
记为 `'error'` 再上抛。任何情况下不能让检索因为一行审计失败而失败。

**身份只信 `AuthInfo.extra`。** `userId` / `tokenId` / `budgetKey` 全部来自 `actorOf(ctx.authInfo)`，
从不读工具参数。`tokenId` 记令牌行（OAuth 是这一小时的访问令牌行），`budgetKey` 记预算键
（OAuth 是 `grant_id`）——两者不同，别合并成一个字段。

**`queryText` 只对两个工具写。** `search_memes` 取 `args.query`，`pick_meme_for_reply` 取
`args.message`，其余一律 null。**不序列化整个参数对象**：里面可能有过滤器、成人向开关，
写进审计等于把用户的筛选习惯也存成日志。

**读路径的脱敏在 SQL 里，不在序列化里。** `data/mcp-call-logs.ts` 的 `privacyQueryText` 用
`case when user_id = caller end` 投影原文列。不要改成「先查出来、路由里按 userId 抹 null」——
那样多一条读路径就多一个会漏的地方。

**清理折进 `queue/cleanup.ts` 的 `sweep()`**，按「先数、记日志、再删」的既有形状，
**不要新起 `setInterval`**。保留 90 天，物理删除。
