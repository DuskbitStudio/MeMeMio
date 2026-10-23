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
3. 校验不过一律 **401 + `WWW-Authenticate: Bearer realm="mememio"`**，响应体为空或简短 JSON 均可；**不要带 `resource_metadata`**（SPEC §10.3）。
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
- 集成测试连真 Postgres，**新增表要加进 `tests/helpers/test-db.ts` 的 truncate 清单**（`access_tokens` / `user_mcp_settings`）。
