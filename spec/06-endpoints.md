# §6 端点

[返回索引](INDEX.md)

全部以 `/api/v1` 为前缀。请求 / 响应约定见 [§1](01-http.md)，错误见 [§2](02-errors.md)，权限见 [§3.3](03-auth-permission.md)。

## §6.1 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | `{ inviteCode, name, password }` → 建会话并返回 User |
| POST | `/auth/login` | `{ name, password }` → 建会话并返回 User |
| POST | `/auth/logout` | 204 |
| GET | `/auth/me` | 当前用户；未登录返回 `UNAUTHENTICATED` |

`/auth/me` 是 SPA 启动时的第一个请求，返回 401 即跳登录页。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET / POST | `/admin/invites` | admin，列出 / 生成邀请码 |
| GET | `/admin/users` | admin |
| PATCH | `/admin/users/{id}` | admin，仅能改 `role` 和 `storageQuotaBytes` |

## §6.2 导入

### §6.2.1 上传

前端预签名直传 R2，文件字节不经过 `api`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/imports` | `{ files: [{ fileName, sizeBytes }] }` → `{ batchId, uploads: [{ fileName, uploadUrl, tempKey }] }` |
| POST | `/imports/{batchId}/commit` | `{ items: [{ fileName, tempKey }] }` → 触发服务端处理，202 |
| GET | `/imports/{batchId}` | 批次当前状态，SSE 断线后用它补齐 |
| GET | `/imports/{batchId}/events` | SSE，见 [§1.4](01-http.md) |

签发预签名 URL 前检查配额；`commit` 时再检查一次，因为期间可能有并发上传。

### §6.2.2 服务端处理顺序

这个顺序是契约的一部分，不是实现细节——它决定了用户看到什么结果、以及花不花 AI 的钱：

```
magic bytes 探测真实格式（不信扩展名）
  → SHA-256 查库 → 精确命中 → exact_dup，静默跳过，删除暂存对象
  → pHash 计算 → 全库 Hamming 扫描 → 近似命中 → needs_review，不阻塞批次，不打标
  → 两关都过 → 写入 memes（tag_status = pending）→ 进打标队列
```

> **`accepted`（2026-09-29，[§9.33](09-decisions.md)）：上面第三行已改成三档，以下为现行契约，上面那版被取代。两端已实现，真链路验收未做，未到 `stable`。**
>
> ```
>   → pHash 计算 → 全库 Hamming 扫描（阈值 NEAR_DUP_DISTANCE）
>       → 无命中                → 继续
>       → 最近邻距离 = 0        → exact_dup，跳过，删除暂存对象（不调 AI）
>       → 最近邻距离 1…阈值     → 视觉模型看两张图，三态：
>           same      → exact_dup，跳过，删除暂存对象
>           different → 继续（当作没命中）
>           unsure / 调用失败 / 超时 / 输出不合法 / 未配视觉通道 → needs_review（人判断）
> ```
>
> 视觉调用走**上传者本人**的视觉通道（与打标同一解析，[§5.3](05-data-models.md)），只送 PNG。自动判重的条目留痕：`meme_id` = 被比中的那张、`distance` = 实测距离、`reason` = 依据。`exact_dup` 的含义因此从「字节完全相同」放宽为「库里已有这张」，SSE `item` / `done` 与批次快照的**字段形状不变**，`result` 取值集合不变。

**近似命中的图先不打标**，等用户确认「仍然导入」后才进队列——否则被判为重复的那些白花钱。

**去重在调 AI 之前。** 表情包库重复率极高，先去重直接省掉相应比例的 AI 调用；用户自带 key 之后，这是在省用户自己的钱。

### §6.2.3 待确认队列

> **`accepted`（[§9.33](09-decisions.md)）：队列的进入条件收窄为「视觉模型拿不准或没法问」**，距离 0 与模型判 `same` 的不再进来。接口、响应结构、`existing` / `tempUrl` 可为 `null` 的规则全部不变；存量条目照旧留在队列里。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/imports/reviews` | 当前用户全部待确认条目，跨批次 |
| POST | `/imports/reviews/{batchId}/{fileName}` | `{ action: "import" \| "skip" }` |

响应条目包含双方信息供并排对比：

```
{
  fileName, tempUrl, sizeBytes, width, height,
  distance,
  existing: { id, url, uploaderName, sizeBytes, width, height, createdAt } | null
}
```

**`existing` 可为 `null`。** 条目进队列后，被判为近似重复的那张已有图可能被软删——读路径按 [§3.4](03-auth-permission.md) 必须过滤 `deleted_at is null`，于是关联对象取不到。此时**不删除条目、也不自动入库**：客户端展示「原图已不存在」，`distance` 仍然显示，「仍然导入」/「跳过」两个操作照常可用。理由见 [§9.7](09-decisions.md)——系统不替用户猜，即使重复的理由已经消失，决定权仍在用户手上。

`tempUrl` 同样可为 `null`（暂存对象已过期清理），客户端展示「预览已过期」，不渲染空 `src`。

**不弹中途确认框。** 上千张图导入时每张都弹窗体验会崩掉，所以近似命中不阻塞导入，攒进队列、导入结束后一起处理。队列里只有 1 条时前端把它呈现成即时弹窗即可——**同一个接口，不同的呈现形式**，不为单张上传另做一套。

## §6.3 搜索与浏览

> **状态：`accepted`**（2026-09-26，[检索与筛选合流](../_archive/joint-tasks/2026-09-26-检索筛选合一.md)）。本节把检索与浏览合流成一个端点：`GET /memes` 吸收 `q`，有 `q` 时做三路融合检索、无 `q` 时按条件浏览，**两者都可翻页**。两端已于同日读过并确认，理由见 [§9.29](09-decisions.md)。

**列表只有一个实现。** `GET /memes` 是唯一列表端点，按请求里有没有 `q` 分派召回与排序：

| | 无 `q` | 有 `q` |
|---|---|---|
| 召回 | 按条件筛（[§6.3.2](#632-浏览)） | **在筛后的候选集里**三路召回 + RRF 融合（[§6.3.1](#631-搜索)） |
| 排序 | `created_at desc, id desc` | 融合分 `desc`，`id` 作 tiebreaker |
| 额外字段 | `degraded: false`、`rewritten: null`、`matchedBy: []` | 真实值（[§6.3.1](#631-搜索)） |
| 游标 | `(created_at, id)` 全序上的位置 | 一次检索快照里的位置 |

**响应形状恒定，不按模式变字段。** 两种请求都返回 `items` / `nextCursor` / `degraded` / `rewritten`，每条 `item` 都带 `matchedBy`。Hono RPC 推导出的类型是两端唯一的同步手段（[§0.2](00-overview.md)），两种形状会让前端每个消费点都要分支。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/memes` | **唯一列表端点**。按条件浏览，或带 `q` 检索；游标分页；`random=true` 时改为随机抽样 |
| GET | `/memes/{id}` | 单条 |

### §6.3.1 搜索

```
GET /memes?q=今天真的不想上班&emotions=无语&tags=猫&isAnimated=true&cursor=…&limit=40
```

`q` 去掉首尾空白后必须非空才走本节。**空串或只有空白按「无 `q`」处理**（走 [§6.3.2](#632-浏览)），不返回错误——用户清空搜索框是常规操作，不是非法请求。

响应：

```
{
  items: [ { ...Meme, matchedBy: ["vector", "ocr"] } ],
  nextCursor: "…",
  degraded: false,
  rewritten: "一只趴在桌上的猫，看起来非常疲惫"
}
```

`matchedBy` 说明这条是被哪几路召回的，供前端做轻量提示，**不用于排序**——排序由服务端的 RRF 融合决定，客户端不重排。

**它是这一次检索的性质，不是这张图的属性。** 所以它只出现在列表响应里：`GET /memes/{id}` 与写操作的响应都不带它——[§5.2.6](05-data-models.md) 的对外表示里没有这个字段，那是定下来的形状，不是遗漏。客户端把写操作的结果并回列表缓存时**保留原有的 `matchedBy`**：编辑一张图不会改变它是被哪几路召回的，服务端也不会为一次编辑重跑检索。

`degraded: true` 表示**本次搜索的向量通路没有覆盖全库**，只靠文本和标签补齐。两类情况会置位：

| 情况 | 向量路 |
|---|---|
| embedding 未配置，或编码 / 查询失败 | 完全没跑 |
| 有记录的 `embed_model` 与当前配置不一致（重算进行中、或重算任务卡在 `failed`） | 跑了，但**只在当前模型的向量里跑**，旧模型那部分召不回 |

前端应当告知用户结果可能不全，但**不阻断搜索**。

> **向量路按 `embed_model = 当前模型` 过滤，而不是整条路停摆。** 两个模型的向量在同一个空间里比距离是没有意义的——它们的余弦相似度不是「更像」，只是噪声，混进 RRF 会把无关的图推到前面。但换模型期间把向量路整条关掉又太狠：已经重算完的那部分是好的。所以过滤而非停摆，同时用 `degraded` 诚实地说「这次没覆盖全」。见 [§9.20](09-decisions.md)。

**`degraded` 说的是本次查询的召回覆盖，不是库里每条记录被索引得多全。** 单条记录可能 `tag_status = ok` 但 `embedding` 为 null（打标成功、向量化失败，向量化会单独重试）。这种图不出现在向量路的召回里，但仍能被文本和标签搜到，而 `degraded` 仍然是 `false`——因为向量路本身是通的、口径也是全库的。**不要用 `degraded` 判断某一张图有没有被索引**，那是两个不同层次的问题；分级降级的理由见 [§9.5](09-decisions.md)。

`rewritten` 是 HyDE 改写后的查询，返回它是为了让用户理解「为什么搜出这些」，可以不展示。改写失败时为 `null`，不影响其余通路。**它是一个字符串，不是结构化的查询理解结果**——改写只喂给向量路，不参与过滤。

**筛选与检索是「先过滤后召回」。** [§6.3.2](#632-浏览) 那张表里的筛选条件（七个词表维度、`isAnimated`、`favorited`、`uploader`、`tagStatus`）在三路取 top-N **之前**生效：候选先被限定在筛后的集合里，再分别按语义、文本、标签排序。放到融合之后再滤的表现是「我明明筛了，结果却少了一大截」——被剔掉的名额不会有别的图补上。

**查询里的否定条件是过滤，不是打分。** 「不要真人」「别动漫」这类明确排除，在三路召回之前就把对应标签的图剔掉，不靠排序把它们压下去。模型推断出的偏好只加分，用户写死的条件才过滤。

**检索可以翻页，深度没有契约上限。** 游标指向**一次检索快照**里的位置：同一次检索里排序在整条会话中稳定，翻页不会出现重复或漏，**中途上传的新图也不会出现在这次检索的后续页里**——它就是那一次检索的那一个快照。游标只在它那次快照活着的时候有效，过期返回 `VALIDATION_FAILED`（[§2.2](02-errors.md)）；快照能活多久、每次向后翻要重扫多少候选，都是 `api` 的实现约束。

**深度由召回池决定，不由产品口味决定。** 每条通路能给出多少候选是有代价的（`api/agents/rules/retrieval.md`），所以**筛得越窄越早到底**：筛后集合只剩几十条时，`nextCursor` 很快就是 `null`。那不是错误，是筛后没有更多了。

**有没有下一页只看 `nextCursor`，不要用「这一页不满」推断。** 一页的名单是照快照取的，但行是**取名单时现查的**，查的时候照样带 `deleted_at is null`（[§3.4](03-auth-permission.md)）：这一页里若有条目在首发之后被删掉，它**少给一条而不补**，页就不是满的。**软删过滤优先于「一页必须满」。**「一页拿不满」因此有三种成因（到头了、筛得窄、有条目被删），客户端区分不了也不需要区分——`nextCursor` 已经把答案给了。

**`q` 与 `random=true` 互斥**：同时传返回 `VALIDATION_FAILED`。理由与 [§6.3.2](#632-浏览) 的 `random` + `cursor` 相同——忽略哪一个都是客户端看不出错的错误结果。

RRF 参数、HyDE 提示词、各通路权重都是 `api` 的实现约束，不在本规范定义，见 `api/agents/rules/retrieval.md`。

### §6.3.2 浏览

```
GET /memes?emotions=无语&tags=猫&isAnimated=true&favorited=true&uploader=me&cursor=...
```

| 参数 | 说明 |
|---|---|
| `expressions` / `emotions` / `tones` / `purposes` / `scenes` / `tags` / `ratings` | 七个词表维度（[§4.3](04-vocabulary.md)），各自可重复，**所有值之间都是 AND** |
| `isAnimated` | 布尔 |
| `favorited` | `true` 时只返回当前用户收藏的 |
| `uploader` | `me` 或用户 id |
| `tagStatus` | 仅本人或 admin 可用，用于「待处理」列表（[§6.6.2](#662-待处理列表)） |
| `person` | **`proposed`**（[§6.7](#67-人物与系列)）。人物 id，**单值**：一张图至多归一个人物，两个人物取 AND 恒为空，重复传返回 `VALIDATION_FAILED`。不存在的 id 返回空列表 |
| `series` | **`proposed`**（同上）。系列 id，单值；返回其下所有人物的图。与 `person` 同时给时取 AND |
| `limit` | 单页条数，默认 40、最大 100。`random=true` 时它同时是**抽样条数** |
| `random` | `true` 时随机抽样，见下 |

**这张表在带 `q` 时同样生效**，而且生效位置是「三路召回之前」（[§6.3.1](#631-搜索)）。`random` 与 `q` 互斥，见下。

**`uploader` 和 `favorited` 是筛选项，不是安全边界。** 不传就是全库，这是设计本身，见 [§0.1](00-overview.md)。

#### `random=true`：随机抽样

> **状态：`accepted`**（2026-09-19 新增并转正）。兼容性新增能力，两端已确认。见[首页随机图墙](../_archive/joint-tasks/2026-09-19-home-random-grid.md)。
>
> 它**已经是线上行为**（两端已实现并在真库上跑通），但还没进 `stable`——`stable` 要等联合验收归档时由总管转，见 [§8.1](08-collaboration.md)。

```
GET /memes?random=true&limit=10
```

```
{ items: [ ...Meme ], nextCursor: null }
```

首页要有一屏「随便看看」，**它在全库里抽**，不是「最新的 N 张里抽几张」。这个区别是本节存在的理由：只在新图里随机的话，库用上三个月之后，用户按一百次刷新也见不到那张三个月前的图，而「把老图重新翻出来」正是这个入口唯一的用途。

- **抽样发生在所有筛选之后。** 七个词表维度 / `isAnimated` / `favorited` / `uploader` / `tagStatus` 照常生效，软删记录照常排除（[§3.4](03-auth-permission.md)）。**随机不绕过任何过滤**——这是实现时最容易出错的地方：`order by random()` 写起来太顺手，条件漏掉也不会报错，只会让别人的图或已删的图出现在首页。
- **`nextCursor` 恒为 `null`。** 随机序没有「下一页」这个概念，给出游标只会让客户端把「随机的第二页」接在「随机的第一页」后面，而那看起来像正常翻页。
- **与 `cursor` 互斥**：同时传返回 `VALIDATION_FAILED`。不静默忽略其中一个——忽略哪个都是客户端看不出错的错误结果。
- **与 `q` 互斥**：同上。`q` 要的是「这次检索里最相关的那些」，随机序没有相关性可言，同时传只能二选一。
- 返回顺序由抽样决定，**客户端不应假设任何顺序**（不保证与 `created_at` 有关）。
- `random` 是**兼容性新增**（[§8.3](08-collaboration.md)）：不传时行为与本节此前完全一致。

抽样怎么实现（`order by random()` 的扫描代价、什么规模要换方案）是 `api` 的实现约束，不在本规范定义，见 `api/agents/rules/database.md`。

## §6.4 管理

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| PATCH | `/memes/{id}` | 所有人 | 改 `description` 与七个词表维度数组，写 `edited_by` |
| DELETE | `/memes/{id}` | 上传者或 admin | 软删，204 |
| POST | `/memes/{id}/restore` | 上传者或 admin | 撤销软删 |
| PUT / DELETE | `/memes/{id}/favorite` | 所有人 | 收藏 / 取消 |
| POST | `/memes/retag` | 上传者或 admin | `{ memeIds[] }` 或 `{ filter: {...} }`，批量重打标 |
| GET | `/memes/duplicates` | 所有人 | 主动查重，异步任务 |

`PATCH /memes/{id}` 的标签值必须在词表内，见 [§4.5](04-vocabulary.md)。人工编辑和模型输出走同一套校验，不开后门。

`POST /memes/retag` 的语义见 [§6.4.3](#643-post-memesretag-的语义)——**实现口径与本节原措辞有一处已知偏差**（每张图用**其上传者**的配置，不是调用者的），那节说明了原因与它落不了地的部分。

### §6.4.1 `PATCH /memes/{id}` 的语义

> **状态：`accepted`**（2026-09-19 细化）。路径与权限自始为 `accepted`，本节补的是请求体与错误码——这些不定死，两端会各写一个。见[浏览页图片操作](../_archive/joint-tasks/2026-09-19-browse-meme-actions.md)。

请求体**只接受八个字段**：`description` / `expressions` / `emotions` / `tones` / `purposes` / `scenes` / `tags` / `ratings`。其余字段（**包括 `ocrText`**）出现在请求体里即 `VALIDATION_FAILED`（[§2.2](02-errors.md)）。

部分更新：**没出现的字段不动**。三种传法含义不同，实现必须区分：

| 传法 | 含义 |
|---|---|
| 字段不出现 | 不改这个字段 |
| `description: null` | 清空描述 |
| `tags: []` | 清空这个维度的标签 |

七个数组的每个元素必须在**对应维度**的词表内（[§4.5](04-vocabulary.md)，含 alias 归一化）。一个词属于哪个维度是确定的——`微笑` 是 `expressions`，传进 `emotions` 里同样是不合法值。**不在词表内返回 `VALIDATION_FAILED`，不是 `AI_INVALID_OUTPUT`**——后者（[§2.4](02-errors.md)）描述的是模型输出的失败，会走重试与降级；人工编辑是一次普通请求，客户端要展示的是「这个词不在词表里，请从列表里选」。**约束是同一套，错误码不是**，两者混用的表现是编辑失败时前端去等一个永远不会来的 AI 降级。

**`ocrText` 不可编辑**（它在库里是 `ocr_text`，[§5.2.3](05-data-models.md)）。它是模型对图像的读数，人工改它会让文本和图不再对应，而 `search_text` 会忠实转发这个错——一条搜出来的 OCR 文本和图上的字对不上，没有任何地方会报错。它是打标结果，要重来只能靠 `POST /memes/retag`，不是靠手改。

`edited_by` / `edited_at` 与内容字段**在同一条 UPDATE 里写**（[§3.3](03-auth-permission.md)）。**`search_text` 也必须在那一条里重算**——[§5.2.3](05-data-models.md) 那句「任一来源变更时必须重算」的落点就是这里，拆成两条语句中间崩掉会留下一条文本与标签对不上的记录，不报错。

响应是**更新后的完整 Meme**，与 `GET /memes/{id}` 同形（[§1.1](01-http.md)）。客户端据此就地更新列表，不再拉一次。

**并发编辑是最后写入者赢，不做冲突检测、不做 ETag。** 共享库里所有人都能编辑（[§9.1](09-decisions.md)），两个人同时改一张图的概率不低，而「谁赢了」没有正确答案可言。客户端因此**不维护影子副本**（[state-navigation.md §2](../web/agents/rules/state-navigation.md)）——那条规则的第一个真实后果就在这个端点上。

#### 编辑会让向量陈旧，本次不处理

改了 `description` 或三个数组就改了 `search_text`（[§5.2.3](05-data-models.md)），而它的 `embedding` 是拿旧文本算的。

**不自动重算，也不自动入队。** 两条理由都不是图省事：

1. **Embedding 走部署方的 key，而编辑对全员开放**（[§9.3](09-decisions.md)、[§3.3](03-auth-permission.md)）。每次编辑重算一次向量，等于给所有人开了一条烧部署方预算的路径，而这条路径上没有任何东西需要它——被改的字段本来就落在 `pg_trgm` 与标签过滤两路上，向量陈旧只让这一张图在语义检索里偏后。
2. 手动 [`POST /admin/reindex`](#654-重建索引) 已经覆盖它，管理员点一次就能补。

代价要如实记下：**被编辑过的图，语义检索质量会下降，而 `GET /admin/reindex/status` 的 `stale` 看不见它**——那个数的口径是 `embed_model` 与当前模型不一致，而编辑不改 `embed_model`。所以「`stale: 0` 但搜出来不对」不是 bug，是本节写下的取舍。增量重算是独立任务，见 [§9.19](09-decisions.md)。

### §6.4.2 `DELETE /memes/{id}` 的语义

> **状态：`accepted`**（2026-09-19 细化）。同上。

软删（[§5.2.5](05-data-models.md)），**204**。R2 上的对象 30 天后由定时任务物理删除，此时才从配额中释放。

**不幂等：对一条已软删的记录再调一次返回 `NOT_FOUND`，不是 204。** 与收藏那两条刻意不同——那两条幂等是因为前端会重发（双击、断网重试、乐观更新回滚），而**删除不做乐观更新**（[state-navigation.md §8](../web/agents/rules/state-navigation.md)），客户端不会在没看到结果的情况下再发一次。剩下的重复调用只可能来自「这张图已经不在列表里了」，此时 404 比 204 诚实：它同时是「别人已经删了」和「你删过了」的同一个答案。客户端把 404 当成功处理即可（那张图本来就要从列表里消失）。

**软删记录连 `PATCH` 也够不着**：改一条已删的图返回 `NOT_FOUND`，不是 `FORBIDDEN`、也不静默成功。这是 [§3.4](03-auth-permission.md) 软删过滤在写路径上的样子——先查（`deleted_at is null`）再判权限，查不到就把 `NOT_FOUND` 抛出去，归属检查根本没机会跑。

### §6.4.3 `POST /memes/retag` 的语义

> **状态：`accepted`**（2026-09-22）。路径与权限自始为 `accepted`（§6.4 那张表），本节把实现语义定死并**修正一处此前的措辞偏差**。见[批量重打标](../joint-tasks/2026-09-22-retag-endpoint.md)。

**用途：让已有的图按当前的提示词与词表重跑一遍视觉模型。** 它是 §6.6.2 那张表里的「换个配置重跑视觉模型」那一行，也是 `needs_manual` 的图**唯一**能被模型重新处理的路。改提示词或改词表之后，存量图不会自己更新——没有这个接口就只能靠人工逐张 `PATCH`。

请求体**两个形状，恰好给一个**：

| 形状 | 含义 |
|---|---|
| `{ memeIds: string[] }` | 指定这几张 |
| `{ filter: { uploader?, tagStatus? } }` | 按条件选中一批 |

**都给或都不给 → `VALIDATION_FAILED`**，不是「取并集」也不是「默认全库」。未知键出现在请求体里即 `VALIDATION_FAILED`（与 [§6.4.1](#641-patch-memesid-的语义) 同一条规则，包括与本节无关的 `useDefaultConfig`）。`memeIds: []` 是**合法的空集**，返回 `enqueuedCount: 0`——**不能**退化成「全库」；空数组和「没给这个字段」在客户端看起来都像「什么都没传」，把前者当后者解释的表现是「想重打一张，结果全库付了一遍钱」。

`filter.uploader` 取 `'me'` 或 uuid，`filter.tagStatus` 取四个状态之一。**`tagStatus` 先校验枚举、再判角色**（[§3.3](03-auth-permission.md) 的同一顺序）：一个非法枚举值不论调用者是谁都返回 `VALIDATION_FAILED`，不能因为「反正要 403 了」就跳过校验——那会让 `scope=foo` 那类静默越权在别处重演。`filter.uploader` 指向别人时非 admin 返回 `FORBIDDEN`，**不是静默收窄到自己**。

```
{ enqueuedCount: 74, skippedEditedCount: 1, skippedUnconfiguredCount: 0 }
```

三个计数**都带 `Count` 后缀**（[§6.5.3](#653-配置的对外表示) 的理由：叫得像布尔的数字会让客户端写 `=== true`，静默判错）。`enqueuedCount` 是**本次真正入队**的条数，不是选中条数——重复触发（上一轮还没跑完就又点一次）时已经处于 `pending` 的行不再计入，所以**对同一批连续调两次，第二次是 `0`**。

#### 不碰人工编辑过的图

**`edited_by` 非空的行直接跳过，计入 `skippedEditedCount`，不入队、不改它的 `tag_status`。** 九个字段（`description` 与七个词表维度数组、`ocrText`）是**破坏性覆盖**，重打会连同人补的标签一起换掉，而人工编辑没有任何自动留痕。§6.6.2 把「人工补」和「重跑模型」分成两条路，这里就是那条分界线的落点：**机器输出不该冲掉人的工作。**

代价要如实记下：**被跳过的图不会因此获得新的维度。** 词表新增一维之后，人工编辑过的那张图会**永久**保留空数组——`edited_by` 不会被清，仓库里也没有「取消编辑」的路径。出路是管理员用 `PATCH /memes/{id}` 人工补上那一维（[§6.4.1](#641-patch-memesid-的语义)）。要真的重跑它，得先接受人工编辑被覆盖。

#### 入队即置回 `pending`

入队与 `tag_status = 'pending'` 在**同一个事务**里提交（`queue.md §2`），这是选型的一部分，不是顺手的：

1. **进度唯一的可见来源就是它。** 重打没有自己的状态，跑完库里也没有「这张被重打过」的痕迹；界面轮询 [§6.6.1](#661-汇总) 的计数才看得到进展。不改 `tag_status` 的话，界面在整段时间里一动不动。
2. **它同时关掉了一条会让重打静默失效的快速路径。** `tagging.ts` 对「`tag_status = ok` 且无向量但有文本」的图只重算向量、**不调视觉**（那是省钱的正规分支）。只重置队列行、不改 `tag_status` 的话，这批图会被接口算作成功入队、花掉 embedding 的钱、**标签一个都不变**。

⚠️ 但要说完整：**重打一次并不持久地修好「`ok` 且无向量」这个群体。** 视觉成功之后 embedding 仍可能终局失败，图会回到 `ok` + 空向量，快速路径**重新武装**。只有成功的 embedding 才真的关掉它。

**正在跑（`status = running`）的行不能被改回 `pending`。** 消费端只看 `pending` 认领，重置一个在跑的行会让第二个 worker 认领同一条、**同一张图付两次钱**。所以入队只更新非 `running` 的行，且 `tag_status` 的置回**必须依据更新真的命中了哪些行**，不能依据传入的 id 列表——否则某个 id 因为 `running` 被跳过时，它的图仍被翻成 `pending`，两个写入互相矛盾。

#### 配置口径：用上传者的，不是调用者的

**每张图用它自己上传者的视觉配置。** 这与 §6.4 原先那句「用调用者自己配置的模型」不同，是**实现口径的既成事实**，本次把文档改成与实现一致，而不是反过来。

原因是结构性的：消费端在后台队列里跑，**没有请求上下文**，拿不到「谁点的这个按钮」。配置解析的入参只有图的 `uploaderId`。要真按调用者的配置跑，需要给 `tag_jobs` 加一列存配置快照、并把它串到 `resolveVisionConfig`——那是 [§9.3](09-decisions.md) 里「管理员兜底」那条设想的**前置条件**，不是一次改动能顺带做的。所以：

- **`useDefaultConfig` 在 v1 被拒绝（`VALIDATION_FAILED`），不是被忽略。** 它落在请求体里就按未知键处理。接受一个不生效的参数比拒绝它更坏——管理员会以为兜底生效了。
- **由此，§9.3 设想的「admin 对任意图片重新打标」目前只在「图的上传者自己配了通道」时成立。** 全站都没配的用户，其图重打不了。这是**已知缺口**，不是缺陷。
- 「没配通道就不入队」必须**逐个上传者判定**，不能用「全站是否配置过」的全局检查——后者在「A 配了、B 没配」时会排一批必然失败的任务，表现是那些图永远停在 `pending`、每轮被重新认领、**任何地方都不报错**。跳过多少张报在 `skippedUnconfiguredCount` 里。

#### 不是幂等的——它花钱

**再点一次就是再花一遍全库的视觉调用。** 与 [`POST /admin/reindex`](#654-重建索引) 刻意相反：那条是幂等且免费的（只算 embedding，走部署方 key），所以界面允许重复点、连说明都写着「重复触发是安全的」。**retag 不能复用那句话。**

调用者要担的是**图片上传者的** AI 预算（上方口径）。界面上这一条必须挡住误点：**确认框是主闸门**，另有「队列正在跑时禁用」作为辅助。⚠️ 辅助那条的判据只能是「有任务在 `running`」，**不能是「有任务 `pending`」**——`pending` 会由别人的上传造成，更会由「上传者没配视觉通道」的图**永远**停在那个状态（上方「配置口径」那条已知缺口），拿它当闸门等于把按钮永久禁用，那是比误点更坏的失败：不报错，也没有出路。

「已经 `pending` 的行不会重复入队」只保证**不重复收费**，不保证「再点一次没有代价」——上一轮跑完之后再点，全库会重新跑一遍。

#### 界面必须说出来的三件事

文案是契约（`settings-ux.md` 开头），所以在这里定死，不在 web 端现编。触发前的确认框要说：

1. **它花的是图片上传者的 AI 预算**，不是部署方的。
2. **重打可能让一部分图变成「需人工」——它们的旧标签不会丢。** 提示词多问了「是不是成人向」之后，一批原先 `ok` 的图可能终局失败（[§9.23](09-decisions.md) 记着这条没有实测支撑）。这不是数据损坏，是一个**可用的回退值**，但界面必须提前说明，否则管理员看到「需人工」变多会以为点坏了。
3. **人工编辑过的图会被跳过，而且不会因此获得新维度。**（上方「不碰人工编辑过的图」的代价。）

**`POST /admin/reindex` 那句「重复触发是安全的」不能复用。** 它成立的前提是幂等，而本接口不幂等。

进度**只轮询 [§6.6.1](#661-汇总) 的计数**（`scope=all`），不另做端点：retag 本身无状态，跑完库里没有任何「这张被重打过」的痕迹，专门的 status 端点只能是 `tag_jobs` 的计数换个地方再说一遍。**由此百分比没有服务端的分母**——`counts.pending` 是绝对值，界面上要做成百分比得用「本次触发排上的条数」当基线，那只在刚点过的那一屏里成立。跨页回来就只剩计数，这是正常的，不是残缺。

## §6.5 配置与测试连接

| 方法 | 路径 | 权限 |
|---|---|---|
| GET / PUT | `/config/vision` | 本人 |
| POST | `/config/vision/test` | 本人 |
| GET / PUT | `/config/embed` | admin |
| POST | `/config/embed/test` | admin |
| POST | `/admin/reindex` | admin |
| GET | `/admin/reindex/status` | admin |

图片向量（人物用）的配置与重算是另一份全站配置，**`proposed`**，见 [§6.7.5](#675-图片向量配置与重算)。

### §6.5.1 测试连接是这里最重要的接口

用户会填各种中转服务，实际行为经常与文档不符。**不让用户手填能力、也不假设任何能力，全部实测。**

视觉测试响应：

```
{
  ok: true,
  canReceiveImage: true,
  jsonModeWorks: true,        // response_format: json_object
  multiImageWorks: false,     // 不支持则动图回退拼图模式
  vocabCompliant: true,       // 返回的标签是否落在词表内
  rawResponse: "..."          // 模型原始返回，失败时必须原样带回
}
```

Embedding 测试响应：

```
{
  ok: true,
  nativeDim: 2560,            // 实测，不信文档、不让人填
  dimParamWorks: true,        // dimensions 参数是否生效
  willTruncate: true,         // 需要客户端截断 + 重新归一化
  rawError: null
}
```

**`rawResponse` / `rawError` 是这个接口的核心价值**——失败时把模型的原始返回原样展示出来，用户才能判断是模型能力问题还是配置填错。不要吞掉它，也不要包装成友好文案。

### §6.5.2 测试不通过不允许保存

`PUT /config/*` 校验该配置组合已有成功的测试记录（按 baseUrl + model 匹配），否则返回 `CONFIG_TEST_REQUIRED`。

Embedding 实测维度 < 1024 直接拒绝保存，返回 `EMBED_DIM_TOO_SMALL`。

更换 embedding 模型且库里已有数据时，`PUT` 需要带 `confirmReindex: true`，否则返回 `EMBED_MODEL_CHANGED`。确认后自动触发全站重建索引，期间搜索降级（`degraded: true`），不中断服务。理由见 [§9.6](09-decisions.md)。

**测试记录由服务端保存，客户端不参与。** 探测结果字段不接受客户端写入（[§5.3](05-data-models.md)），所以「测过了」这件事不能靠前端回传——`POST /config/*/test` 必须把结果存在服务端，`PUT` 从那条记录里抄探测结果写进配置行。存法属实现细节，但记录里**不保存 key 明文或密文**。

匹配三要素：**baseUrl + model + key 指纹**（key 的 SHA-256，只用于比对）。比 §6.5.2 开头那句多一个 key——key 恰恰是最常填错的那一项，只按 baseUrl + model 匹配会让「换了 key 没测就保存」通过校验，而那正是最需要挡住的情况。

### §6.5.3 配置的对外表示

`GET /config/vision`：

```
{
  source: "user" | "default",     // 当前生效的是自己的配置还是部署方默认
  baseUrl: "https://...",         // source=default 时回显部署方默认值
  model: "...",
  apiKey: "****1234",             // 固定 "****" + 后四位；未配置时 null
  verifiedAt: "2026-09-16T...",   // 没通过过测试则 null
  jsonModeWorks: true,            // 探测结果，未测过则 null
  multiImageWorks: false
}
```

`GET /config/embed` 同构，能力字段换成 `nativeDim` / `dimParamWorks`。

`PUT /config/*` 与 `POST /config/*/test` 的请求体同形，只有 `baseUrl` / `model` / `apiKey` 三个字段——**探测结果字段不出现在请求体里**。`apiKey` 传脱敏串视为「不修改」（[§3.5](03-auth-permission.md)）；此前没配过 key 时传脱敏串等于没传，返回 `VALIDATION_FAILED`。

测试要能在保存之前跑，所以 `POST /config/*/test` 接受尚未保存的配置；它不改变当前生效的配置。

`PUT /config/embed` 的响应在配置之外多两个字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `reindexTriggered` | boolean | 本次保存是否换掉了模型 |
| `reindexEnqueuedCount` | number | 本次保存排进重算队列的条数；没换模型、或库里没有向量时为 `0` |

它们回答的是「**这一次保存**有没有引发重算」——`GET /admin/reindex/status` 只能告诉你此刻有没有重算在跑，分不出那是不是你刚才那一下造成的。

**条数不是布尔。** 入队时这个数已经算出来了，退化成 `true` / `false` 是白扔掉信息：管理员点完保存最想知道的就是「这一下牵动了多少条」。它和 `status.stale` 不是一个东西——`stale` 是此刻全局待重算的量，会被并发的手动触发和 worker 的消费改写；这个数是**那一次保存**的记账，不随后续变化。

名字必须带 `Count`。叫 `reindexEnqueued` 而返回数字，客户端写 `=== true` 会**静默**判错——不报错、不告警，只是保存完不跳进度条。

### §6.5.4 重建索引

`POST /admin/reindex` 把所有向量过期的记录排进重算队列，**幂等**——重复调用不会让同一条记录重算两遍。换模型时由 `PUT /config/embed` 自动触发，这个端点是管理员手动补触发用的（[queue.md §6](../api/agents/rules/queue.md) 的「重算过期向量」）。

它的响应体是 `{ enqueuedCount, ...status }`——`enqueuedCount` 是**这一次点击**排进队列的条数，
其余字段与 `GET` 的状态同形，省掉前端触发完再拉一次。`enqueuedCount: 0` 不是错误，
它的意思是「该排的都已经排上了」，幂等本来就该这样。

名字带 `Count` 的理由同 [§6.5.3](#653-配置的对外表示)：这个仓里已经因为一个叫得像布尔的数字
返回过一次契约偏差，同一个概念在两个端点上不能有两个名字。

**重算只重算 embedding。** 从 `search_text` 重新生成向量，不重新调视觉模型、不改 AI 产出字段——换 embedding 模型不影响打标结果，重跑视觉是白花钱。

`GET /admin/reindex/status`：

```
{
  running: boolean,      // 队列里还有未完成的重算任务
  total: number,         // 有向量的非软删记录数
  done: number,          // embed_model 与当前配置一致的条数
  stale: number,         // 待重算
  failed: number         // 重试耗尽的条数，需要看日志
}
```

进度必须来自库里的真实计数，**不能是进程内存里的计数器**——重启后内存计数归零，进度条会从头开始，那是假的。失败的条目留在队列里不做断点续传（[queue.md §7](../api/agents/rules/queue.md)），`stale` 长时间不降就是出了问题。

**队列里存在 `pending` / `running` / `failed` 任一状态的重算任务时，搜索必须返回 `degraded: true`**（[§6.3.1](#631-搜索)），因为此时库里的向量一部分仍属于旧模型，向量路只在当前模型那部分里召回、覆盖不全。判断这一条的查询会落在每个搜索请求上，必须是索引命中的存在性查询或带短期缓存，不能是全表 count。

**`failed` 也算。** 重试耗尽的任务留在表里不再推进，而它对应的记录仍然带着旧模型的向量——只看 `pending` / `running` 会让「未完成任务归零、混模型永久存在」这件事静默发生。见 [§9.20](09-decisions.md)。

### §6.5.5 运行参数

> **状态：`accepted`**（2026-09-23）。新增能力，两端已确认契约、实现已落两端。**尚未转 `stable`**——联合验收还差真 api × 真浏览器的联调，见[运行参数任务](../joint-tasks/2026-09-23-runtime-config.md)的「总管裁定」。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/admin/runtime` | 仅 `admin` |
| PUT | `/admin/runtime` | 仅 `admin` |

```
{
  tagConcurrency: 2,           // 生效值，不是「存进去的值」
  tagPerUserInflight: 1,
  importConcurrency: 2,
  ffmpegConcurrency: 2,
  cpuCount: 8,                 // ffmpegConcurrency 的上限由来，界面要显示「上限 8（本机核数）」
  updatedAt: "2026-09-23T...", // 从没改过则 null
  updatedBy: "uuid" | null
}
```

`PUT` 的请求体是同样四个字段**全部必填**，一次性提交整组——不做部分更新：它本来就是一个四格表单，而部分更新会让界面不知道该显示哪一次的值。响应与 `GET` 同形，回显**归一化之后**的生效值（等于默认值的输入落成 `NULL`，见 [§5.6](05-data-models.md)）。

**返回生效值而不是原始值**，是为了让界面不必知道「哪些列是空的」。字段含义、上下限与交叉约束见 [§5.6](05-data-models.md)；越界返回 `VALIDATION_FAILED`。

**生效不是事务性的「立即」**，承诺的措辞是「保存后**新开的**任务按新值跑」：

| 谁 | 何时读到新值 |
|---|---|
| 打标 worker | 下一轮 tick。那一轮可能正卡在等一个在途任务完成上（`JOB_TIMEOUT_MS` 最长 90 秒） |
| 导入管线 | 下一批。**已经在跑的批次整批用旧值**，不中途改 |

**不为「立即生效」去打断在途任务。** 被打断的打标任务会永远停在 `running`，表现是「这几张图再也不会被打标」——不报错、不告警，正是 `stopTagWorker` 那条注释（`queue/worker.ts`）写明要避免的。

**不做「恢复默认」端点。** 四格填回默认值就是恢复默认，服务端把它归一成 `NULL` 即可；多一个端点等于多一条「默认值是什么」的知识要同步。

**不做单独的「当前吞吐是多少」端点。** 生效证据复用 [§6.6.1](#661-汇总) 的 `GET /memes/tag-status`——`counts.pending` 的下降速率就是它。新造一个端点只会把同一批计数换个地方再说一遍。

## §6.6 打标状态

> **状态：`accepted`**（2026-09-19 新增为 `proposed`，2026-09-24 转档）。两端实现已落、契约文本两端各自确认。**还不是 `stable`**：差的是一次验证——真库里造一张 `needs_manual`，核对汇总的 `needsManual` 等于列表条数。见[打标状态界面](../joint-tasks/2026-09-19-tagging-status.md)、[§9.28](09-decisions.md)。

导入的终点是 `tag_status = pending`（[§6.2.2](#622-服务端处理顺序)），打标在后台队列里跑。**在补上本节之前，这件事对用户没有任何反馈**——打完了不知道，打失败了也不知道。

这不是新需求，是三处已经写下的承诺一直没有落点：[§5.2.3](05-data-models.md) 说 `needs_manual` 的图「在待处理列表里」，[§6.3.2](#632-浏览) 的 `tagStatus` 参数写着「用于「待处理」列表」，[styling.md](../web/agents/rules/styling.md) 说这类图「角标「需人工」，可点进去补」。**注意「列表」是有的（`GET /memes` 能按 `tagStatus` 筛），缺的是计数和入口**——没人知道有 7 张图卡着，自然也不会去看那个列表。

### §6.6.1 汇总

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/memes/tag-status` | 本人；`admin` 可带 `scope=all` |

```
GET /api/v1/memes/tag-status
```

```
{
  scope: "mine",
  visionConfigured: true,
  counts: { ok: 982, pending: 120, refused: 0, needsManual: 7 },
  running: 2,
  failures: [ { reason: "unreachable", count: 4 }, { reason: "refused", count: 3 } ]
}
```

| 字段 | 含义 |
|---|---|
| `scope` | 回显生效范围，`mine`（缺省）或 `all` |
| `visionConfigured` | 当前生效的视觉通道是否可用。`mine` 看调用者自己的（含部署方默认兜底），`all` 看全站是否有任一可用通道 |
| `counts` | 按 `tag_status` 分组的条数，四个取值全给，没有的写 `0` |
| `running` | 此刻库里 `status = running` 的打标任务数 |
| `failures` | 终局失败的任务按原因分组的条数，降序 |

**`counts.pending` 必须和 `visionConfigured` 一起看才有意义。** 前者是「多少张还没标」，后者回答「它们会不会自己好」——通道不可用时任务不消费、也不计失败重试（[§2.4](02-errors.md) 的 `AI_NOT_CONFIGURED`），**配好之后自动补打标，用户不需要做任何操作**。界面必须把这句话说出来，否则一大批 `pending` 看起来就是卡死了。

**计数口径**：`counts` 只统计 `deleted_at is null` 的记录（[§3.4](03-auth-permission.md)），`scope=all` 同理。同一批图必须和 `GET /memes?uploader=me&tagStatus=X` 的筛选结果一致——两处对不上就是有一个漏了软删过滤。

`failures[].reason` 是**失败类别**，只有 `unreachable` / `refused` / `invalid_output` / `unsupported` / `embed_failed` 五个取值，不是给用户看的文案——中文文案由客户端映射。

**只返回类别，不返回 `tag_jobs.last_error` 原文。** 原文是给日志看的诊断串：格式随时会变，而且随着供应商适配的深入迟早会把上游返回的内容带进来。**类别是契约，诊断串不是**——把诊断串发出去，等于让前端依赖一个从没承诺过的字符串格式，这和 [§2.1](02-errors.md) 不把底层 message 回显给用户是同一条理由。

> ⚠️ **`failures` 里会有 `tag_status = ok` 的图。** `embed_failed` 是「打标成功、向量没算出来」（[§5.2.3](05-data-models.md)），它**不落在 `counts.needsManual` 里**。所以 `sum(failures) ≠ counts.needsManual` 是正常的，不要试图让它们对上，也不要为了对上把它排除——那正是「这张图能被文字搜到、只是进不了向量路」这个状态唯一会被看见的地方。

`running` 取库里的真实值，不是进程内存计数：多副本下它合计所有副本在跑的任务。被 SIGKILL 卡住的 `running` 要到下次进程启动回收（`requeueStaleRunningJobs`）才降下来，在此之前这个数会偏大——这是可接受的近似，**不要为了它去加一个实时对账任务**。

`scope=all` 仅 `admin` 可用，其他角色传它返回 `FORBIDDEN`；缺省是 `mine`，不传参数的普通用户行为与显式传 `mine` 完全一致。

### §6.6.2 待处理列表

**列表复用 [§6.3.2](#632-浏览) 的 `GET /memes`，不新增端点。**

```
GET /api/v1/memes?uploader=me&tagStatus=needs_manual&limit=50
```

`tagStatus` 的参数语义、单值约束与权限在 §6.3.2 / §3.3 已定，本节不重复。视图按状态分开请求（一个 `tagStatus` 一次），因为参数是单值的。

`refused` 当前**不可达**：它要求主副通道都被拒绝，而副通道尚未接入（[§9.5](09-decisions.md) 仍是 `proposed`），所有终局失败都落 `needs_manual`。界面按四个取值全量映射文案，但不为 `refused` 单独做交互。

**「人工补」是 [`PATCH /memes/{id}`](#641-patch-memesid-的语义)，不是重跑模型。** 两者不能互相替代，也不合成一个「重试」按钮：

| 你要做的 | 用哪个 | 花谁的钱 |
|---|---|---|
| 模型标错了 / 标得不全，人工补上 | `PATCH /memes/{id}`——改 `description` 与七个词表维度数组 | 不花钱 |
| 换个配置重跑视觉模型 | `POST /memes/retag` | **图片上传者**的 AI 预算（见 [§6.4.3](#643-post-memesretag-的语义)） |

**不要在 §6.4 之外另造一个「重试」端点**，那会让同一个语义有两条实现。`retag` 已实现（[§6.4.3](#643-post-memesretag-的语义)），所以 `needs_manual` 的图现在是**两条路都通**：人工用 `PATCH` 补，或按当前提示词重跑模型。**但人工编辑过的图会被 `retag` 跳过**——那是 [§6.4.3](#643-post-memesretag-的语义) 写下的取舍，不是这一节能替代的：一旦人补过标签，这张图就只会走人工那条路。

**「进度」不另做端点。** 重打没有自己的任务表，跑完库里也没有「这张被重打过」的痕迹，专门造一个进度接口只能把 [§6.6.1](#661-汇总) 的计数换个地方再说一遍。界面轮询 `GET /memes/tag-status?scope=all` 即可。

## §6.7 人物与系列

> **状态：`proposed`**（2026-09-29）。新增能力，数据模型见 [§5.7](05-data-models.md)，取舍见 [§9.34](09-decisions.md)，任务见[人物识别与聚类](../joint-tasks/2026-09-29-人物识别与聚类.md)。两端读过并确认后转 `accepted`。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/persons` | 所有人 | 人物列表，[§6.7.3](#673-列表详情与合并建议) |
| GET | `/persons/{id}` | 所有人 | 单个 |
| PATCH | `/persons/{id}` | 所有人 | 改名、归系列、设封面、隐藏 |
| GET | `/persons/{id}/suggestions` | 所有人 | 「可能是同一个」 |
| POST | `/persons/{id}/merge` | 所有人 | 把别的人物并进这一个 |
| POST | `/persons/{id}/rejections` | 所有人 | 「不是同一个」 |
| POST | `/persons/assignments` | 所有人 | 把几张图放进 / 拆出 / 移出人物 |
| GET / POST | `/series` | 所有人 | 系列列表 / 新建 |
| GET / PATCH | `/series/{id}` | 所有人 | 单个 / 改名、改成员 |
| DELETE | `/series/{id}` | 创建者或 `admin` | 删系列，人物不动 |
| GET / PUT | `/config/image-embed` | admin | 图片向量配置，[§6.7.5](#675-图片向量配置与重算) |
| POST | `/config/image-embed/test` | admin | 测试连接 |
| POST | `/admin/persons/reindex` | admin | 补算 / 重算人物向量 |
| GET | `/admin/persons/reindex/status` | admin | 进度 |

浏览页按人物 / 系列筛不在这里，是 [§6.3.2](#632-浏览) 的两个参数 `person` / `series`。

### §6.7.1 权限与留痕

**人物与系列的写操作对所有人开放，与编辑标签同一个理由**（[§9.1](09-decisions.md)）：谁认出了这是谁，起个名字对所有人都是净收益。人物跨越许多上传者的图，「上传者本人」在这里没有对应物，收窄只剩「仅 admin」一条路，那等于把全站的命名压在一个人身上。

**这些写操作都不调 AI。** 合并建议从已存的向量算，改名、合并、移图只动表，所以开放编辑不会开出一条烧钱的路径（对比 [§9.19](09-decisions.md) 为什么不让编辑触发重算）。

留痕是防滥用的唯一手段（[§3.3](03-auth-permission.md)）：`persons.updated_by` / `series.updated_by` 与内容在同一条语句里写；逐图的归属写进 `meme_subjects.assigned_by`。

**逐图的操作按 `edit` 过 `assertCanMutate`**（[§3.4](03-auth-permission.md)）。它写的不是 `memes` 表，但要的是同一样东西：先带 `deleted_at is null` 查到那张图，查不到就 `NOT_FOUND`（[§6.4.2](#642-delete-memesid-的语义) 那条「软删记录连 `PATCH` 也够不着」）。不另写一套判断。

**删除系列限创建者或 `admin`**，与删图同一个不对称：删掉的是别人挑选人物的工作，而且不可撤销。其余操作都能被下一个人改回来。

**并发是最后写入者赢**，不做冲突检测，理由同 [§6.4.1](#641-patch-memesid-的语义)。

### §6.7.2 对外表示

Person：

```
{
  id,
  name,                    // null 表示未命名
  seriesId, seriesName,    // 不属于任何系列时两者都是 null
  isHidden,
  memeCount,               // 未软删的图数，恒 ≥ 1（为 0 的人物不出现，§5.7.4）
  cover: { memeId, thumbUrl },
  updatedBy?, updatedAt?
}
```

Series：

```
{
  id, name,
  personCount,             // 图数 ≥ 1 的人物数
  memeCount,               // 其下人物图数之和
  cover: { memeId, thumbUrl } | null,   // 取图数最多那个人物的封面；空系列为 null
  createdBy, createdAt, updatedBy?, updatedAt?
}
```

**Meme 的对外表示不变**，[§5.2.6](05-data-models.md) 不加「属于哪个人物」。这个信息只在人物语境里用得到：按人物筛的时候，客户端已经知道当前筛的是谁，「不是他」「设为封面」都能直接带上那个 id。

**不返回任何相似度数值**，包括合并建议。阈值与口径归 `api`，数值一旦外露，前端就会长出第二套阈值。

### §6.7.3 列表、详情与合并建议

```
GET /persons?q=塞西&series=none&named=true&minCount=2&cursor=…&limit=40
```

| 参数 | 说明 |
|---|---|
| `q` | 名字包含，去首尾空白、不区分大小写；空串按不传 |
| `series` | 系列 id，或 `none`（不属于任何系列） |
| `named` | `true` 只要有名字的，`false` 只要未命名的；不传两种都要 |
| `hidden` | `true` 只要隐藏的；**不传或 `false` 只要没隐藏的** |
| `minCount` | 图数下限，默认 1 |

**`named` / `hidden` 只认 `true` / `false`，别的值 `VALIDATION_FAILED`。** 这与 [§6.3.2](#632-浏览) 的 `isAnimated`（非 `true` 一律当 false）刻意不同：那边当 false 是无害的保守取值，这边把 `hidden=yes` 当没传，等于**静默放宽**——隐藏的人物会铺满 modal，而客户端看不出自己传错了。

`minCount` 的默认值 1 与「不传 = 全返」是同一件事，因为人物的图数恒 ≥ 1（[§5.7.4](05-data-models.md)）。**服务端不替客户端兜更高的下限**：modal 默认只看够两张的，那是界面的选择（[任务](../joint-tasks/2026-09-29-人物识别与聚类.md) §2 第 5 条），换一个客户端可以要别的。

排序固定为 `memeCount desc, id`，游标分页（[§1.3](01-http.md)）。**图数在翻页途中变了，可能重复或漏一格**——不做快照，这是一个浏览面，不是检索。

`GET /series` 接受 `q`（同上），排序同上。`GET /persons/{id}`、`GET /series/{id}` 返回单个；人物的图全被软删时是 `NOT_FOUND`（[§5.7.4](05-data-models.md)），系列不论空不空都在。

`GET /persons/{id}/suggestions`：

```
{ items: [ Person ] }      // 最多 3 条，最像的在前；可以为空
```

不含隐藏的人物，不含与它点过「不是同一个」的人物。**建议按组给，不做全站的「待合并清单」**：探测里按组给几乎全对，排成一张全站清单时拖尾要点掉几十条错的才收得全（[§9.34](09-decisions.md)）。所以界面上只在某个人物的语境里问「这一组可能和谁是同一个」，不承诺「把待合并的清空」。

### §6.7.4 写操作

**请求体里引用别的实体时，错误码看这个 id 在请求里是什么角色：**

- **它是这次要操作的对象**（`memeIds`、`sourceIds`、`assignments` 的 `personId`）→ 不存在**或不可见**都是 `NOT_FOUND`。客户端手里的 id 过期了（那张图被删了、那个人物被合并或被移空），正确反应是重拉列表，不是改请求。
- **它是某个字段的取值**（`seriesId`、`coverMemeId`、`name`）→ `VALIDATION_FAILED`。请求本身不成立，重发一次也一样。

人物那一侧的「不可见」指图全被软删（[§5.7.4](05-data-models.md)）：`GET` 返回 `NOT_FOUND` 的人物，`assignments` 也放不进去，两处同一个判据。

**状态码一律 200，除了本节明确写成 `204` 的两处**（`rejections` 与 `DELETE /series/{id}`），与 [§1.1](01-http.md) 一致：写操作返回被修改后的资源，删除返回 `204`。**`POST /series` 不是 `201`**——SPEC 只在需要的地方写明状态码，仓库里 `POST /admin/invites`、`POST /auth/register` 的 `201` 是 SPEC 未收录的历史行为，不作为新端点的依据。

**`PATCH /persons/{id}`** 只接受 `name` / `seriesId` / `coverMemeId` / `isHidden` 四个字段，部分更新，未知字段 `VALIDATION_FAILED`（[§0.4](00-overview.md)）。

- `name`：去首尾空白后 1–40 字、不含控制字符；`null` 清空（回到未命名）。**不要求唯一**：同一个角色碎成两组、各被起了同一个名字，是很正常的中间态，那是合并的信号，不是冲突。
- `seriesId`：`null` 移出系列；指向不存在的系列 `VALIDATION_FAILED`。
- `coverMemeId`：必须是这个人物下未软删的图，否则 `VALIDATION_FAILED`；`null` 回到自动取封面。

响应是更新后的 Person。

**`POST /persons/{id}/merge`**：`{ sourceIds: string[] }`（1–20 个）。`sourceIds` 里各人物的图全部归到 `{id}`，然后删除这些来源人物。

- 名字、系列、封面、隐藏**用目标的**；目标未命名时取 `sourceIds` 里第一个有名字的，系列同理。所以「留哪个名字」由客户端选谁当目标来决定。
- 来源身上的「不是同一个」**转到目标上**，否则同一条错建议会在合并后换个身份回来。目标与某个来源之间的「不是同一个」丢弃：人刚刚明确说了它们是同一个。
- `sourceIds` 含 `{id}` 或有重复：`VALIDATION_FAILED`。任何一个人物不存在：`NOT_FOUND`，**整个请求不生效**（一个事务）。
- **不可撤销。** 合错了的出路是把图移出来（下面的 `assignments`）。界面的确认框必须说出这一点和涉及的图数。

响应是合并后的目标 Person。

**`POST /persons/{id}/rejections`**：`{ otherId }`，记一条「不是同一个」，204，幂等。`otherId` 等于 `{id}`：`VALIDATION_FAILED`。

**`POST /persons/assignments`**：把几张图放到哪。请求体**三种形状恰好给一种**，都给、都不给、给两种都是 `VALIDATION_FAILED`：

| 形状 | 含义 |
|---|---|
| `{ memeIds, personId }` | 放进这个人物 |
| `{ memeIds, newPerson: { name? } }` | 拆出来成一个新人物 |
| `{ memeIds, none: true }` | 不属于任何人物 |

- `memeIds` 1–100 个、不重复。任何一张不存在或已软删：`NOT_FOUND`，整个请求不生效。
- `personId` 指向不存在**或图全被软删**的人物：同样 `NOT_FOUND`（本节开头的规则），整个请求不生效。图全被软删的人物收不了图——它此刻对客户端本来就不存在；要在这个前提下归拢，用 `newPerson` 新建一个，之后人再合并。
- 写 `assigned_by = 调用者`，此后机器不再改这几张的归属（[§5.7.2](05-data-models.md)）。还没算过向量的图也能放，向量以后补算，归属不动。
- 被移空的人物当场删除（[§5.7.4](05-data-models.md)）。

```
{ movedCount: 3, person: Person | null }    // none 时为 null
```

**`POST /series`**：`{ name, personIds? }`；**`PATCH /series/{id}`**：`{ name?, personIds? }`。

- `name` 规则同人物名，但**全站唯一**（去首尾空白、不区分大小写），重复返回 `CONFLICT`（[§2.3](02-errors.md)）。系列是人手建的、数量少，同名两个只会让人不知道往哪个里放。
- **系列的 `name` 不接受 `null`**（`VALIDATION_FAILED`），人物的 `name: null` 才是「回到未命名」。两者的差别是有意的：人物可以没有名字——机器刚成组时本来就没有，人再慢慢起；系列没有名字就什么都不剩，它是一个完完全全由人建出来的东西。
- `personIds` 是**这个系列的完整成员**，不是增量：没列出的原成员移出系列，列出的若原本属于别的系列就改到这里来。界面上是「勾选哪些人物属于它」，整份提交与之对应。
- `personIds` 里**允许**出现图全被软删的人物（客户端看不到它，但行还在）。软删是可逆的（[§5.7.4](05-data-models.md)），人做过的系列成员关系不该因为一次临时删除被机器抹掉；那些图恢复之后，人物会带着原来的系列回来。系列的人物数与图数只数可见的，所以这种成员在界面上暂时不计数。
- 响应是 Series。

**`DELETE /series/{id}`**：204；不是创建者也不是 admin 返回 `FORBIDDEN`。已删的再删一次 `NOT_FOUND`，理由同 [§6.4.2](#642-delete-memesid-的语义)。

### §6.7.5 图片向量配置与重算

**`/config/image-embed` 与 `/config/embed` 同构**：先测后存、测试记录由服务端保存、按 baseUrl + model + key 指纹匹配、`EMBED_DIM_TOO_SMALL`、密钥只回显 `"****" + 后四位`、空配置回退部署方环境变量（[§6.5.1](#651-测试连接是这里最重要的接口)–[§6.5.3](#653-配置的对外表示)、[§3.5](03-auth-permission.md)）。环境变量名与 `DEFAULT_EMBED_*` 并列，写进 [`docs/environments.md`](../docs/environments.md) 与 `.env.example`。

它是**全站一份**，不是每人一份：人物向量要能互相比，全站必须是同一个模型、同一个口径，这与文本 embedding 归部署方是同一个约束（[§9.6](09-decisions.md)）。花的是部署方的额度。

⚠️ **回退到部署方环境变量时没有测试连接记录，`imageInputWorks` 无处可查。** 上游把图静默丢掉时，表现是所有人物的向量慢慢并成一团，**不报错**（下面那个探测就是为它设的）。所以那三个变量只在自己就是上游、且**手工验过**时才填；`.env.example` 里写了这一条。这是 §6.7.5 唯一一条「配置生效但没被验过」的通路。

测试响应在 embedding 那份之外多一个字段：

```
{ ok, nativeDim, dimParamWorks, willTruncate, imageInputWorks, rawError }
```

**`imageInputWorks` 是这份配置最重要的探测。** 测试时送两张明显不同的图，两份向量几乎一样（或上游报的图片 token 为 0）就判 `false`，`ok` 随之为 `false`。探测时见过上游把图**静默丢掉**、照样回一个向量（[任务](../joint-tasks/2026-09-29-人物识别与聚类.md) §9.1）；这种配置存进来，每张图都会被编码成差不多的向量，所有人物会慢慢并成一团，**不报错**。

换模型且库里已有人物向量时，`PUT` 要带 `confirmReindex: true`，否则 `EMBED_MODEL_CHANGED`；响应同样带 `reindexTriggered` / `reindexEnqueuedCount`。**已有的归属不动**（[§5.7.2](05-data-models.md)），重算只换向量。

**第一次配好不自动补跑。** 存量补跑由管理员点 `POST /admin/persons/reindex`：它把所有未软删、没有当前口径向量的图排进队列，**幂等**，响应 `{ enqueuedCount, ...status }`。与 `/admin/reindex` 不同的是它**每张图都是一次付费调用**，界面上点之前要说清条数和花谁的钱。配好之后新进来的图自动算，不用点。

`GET /admin/persons/reindex/status` 与 [§6.5.4](#654-重建索引) 的状态同形：`{ running, total, done, stale, failed }`，来自库里的真实计数。**人物向量的重算不影响 `degraded`**——那个字段只说检索的向量路，人物不参与检索召回。

## §6.8 访问令牌

> **状态：`proposed`**（2026-10-22）。为 [§10 MCP 接入](10-mcp.md) 提供的令牌管理接口，纯新增。令牌的形态、存储与安全规则见 [§10.3](10-mcp.md#103-鉴权与访问令牌)。

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/access-tokens` | 本人 |
| GET | `/access-tokens` | 本人 |
| DELETE | `/access-tokens/{id}` | 本人 |

**三个端点都要求 cookie 会话（[§3.1](03-auth-permission.md#31-会话)），不接受 Bearer。** 令牌是给 MCP 客户端用的；管理令牌仍然走浏览器。**没有管理员视图**——任何人只能看、建、撤销自己的令牌。

### `POST /access-tokens`

```
{ name: "我的 Claude", expiresInDays?: 90 }
```

| 字段 | 规则 |
|---|---|
| `name` | 去首尾空白后 1–64 字，只用于显示。**不要求唯一**：两台设备起同一个名字是正常的 |
| `expiresInDays` | 可选正整数，1–3650；不传 = 永不过期 |

**每用户最多 10 个有效令牌（未撤销且未过期）**，超过返回 `VALIDATION_FAILED`。**不自动清理最旧的令牌**——那会让一台正在用的客户端突然 `401`，而用户不知道为什么；**也不把已过期的行计入名额**——那些行不在列表里，用户撤不掉，会把账号永久卡在满额。

响应 **201**：

```
{
  id, name, prefix,
  token,                     // 完整令牌，只在这一次响应里出现
  createdAt, expiresAt       // ISO 8601；expiresAt 可为 null
}
```

- `token` 是完整值，**不会再有第二次机会**。响应带 `Cache-Control: no-store`。
- `prefix` 是令牌前 12 个字符（含 `mcp_`），之后每次列表都只回它。
- `token_hash` 永不出现。

### `GET /access-tokens`

```
{
  items: [ { id, name, prefix, createdAt, lastUsedAt, expiresAt } ]
}
```

- 按 `createdAt desc` 排序。
- **只返回未撤销且未过期的令牌**；过期 / 撤销的从列表消失（行保留在库里做审计，见 [§5.8](05-data-models.md#58-访问令牌)）。
- `lastUsedAt` / `expiresAt` 可为 `null`（分别表示"从未用过"与"永久"）。
- 不返回 `token`、`prefix` 之外的任何令牌材料，也不返回 `userId`。

### `DELETE /access-tokens/{id}`

204，**幂等**：对已撤销的令牌再调一次仍返回 204。只写 `revoked_at`，不物理删除。

- 不存在、或不属于调用者的 id 一律 `NOT_FOUND`（不区分两种，避免探测别人的令牌 id）。
- **撤销立即生效**：下一次 MCP 请求返回 `401`。

### 错误码

| code | 何时 |
|---|---|
| `UNAUTHENTICATED` | 没有有效 cookie 会话 |
| `VALIDATION_FAILED` | `name` / `expiresInDays` 不合法，或已达 10 个上限 |
| `NOT_FOUND` | 撤销目标不存在或不属于本人 |

## §6.9 MCP 设置

> **状态：`accepted`**（2026-10-23）。[§10.3.1](10-mcp.md#1031-内容范围成人向默认关闭) 的内容范围设置与 [§10.3.2](10-mcp.md#1032-过滤器按标签排除) 的过滤器设置，纯新增。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/mcp/settings` | 本人（cookie 会话） |
| PUT | `/mcp/settings` | 本人（cookie 会话） |
| GET | `/mcp/filter` | 本人（cookie 会话） |
| PUT | `/mcp/filter` | 本人（cookie 会话） |

- **只认 cookie 会话**，不接受 Bearer；MCP 端点是只读的，不能改自己的设置。
- `/mcp/settings` 响应固定 `{ allowAdult: boolean }`，默认 `false`。没有设置行时回默认值，不返回 404。
- `PUT /mcp/settings` 请求体**恰好** `{ allowAdult: boolean }`；未知字段、非布尔值 → `VALIDATION_FAILED`。
- `/mcp/filter` 响应固定：

  ```
  { excluded: { expressions: [], emotions: [], tones: [], purposes: [],
                scenes: [], tags: [], ratings: [] } }
  ```

  七个维度**总是出现**（缺省为空数组）；`ratings` 只能是空数组——成人向由 `/mcp/settings` 单独控制。
- `PUT /mcp/filter` 请求体**恰好** `{ excluded: {...} }`：未知维度、非数组、词表外的值、非空 `ratings` 都是 `VALIDATION_FAILED`；重复值按出现顺序去重。空数组等于不过滤。
- **不提供管理员视图**：任何人只能改自己的设置。
- 两个设置都只影响 MCP（[§10.3.1](10-mcp.md#1031-内容范围成人向默认关闭)、[§10.3.2](10-mcp.md#1032-过滤器按标签排除)），不影响 Web 端读路径。
