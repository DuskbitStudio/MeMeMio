# §5 数据模型

[返回索引](INDEX.md)

数据库使用 snake_case，接口使用 camelCase，见 [§7](07-naming.md)。本章给出结构与语义；索引和迁移的实现约束见 `api/agents/rules/database.md`。

**本节列的是「产品里有这个概念」的持久状态**：用户、库、收藏、导入批次、配置。**为某个契约的实现而存在的中间表不进本节**——例如检索快照（[§6.3.1](06-endpoints.md) 翻页用的 `search_snapshots`）：它没有对外可观察的语义，随时可能被整块换掉（[§9.29](09-decisions.md) 的第一条回退就是砍它），列进来等于让本节的正文绑死一条已声明可推翻的实现。它的结构、TTL 与清理在 `api/agents/rules/retrieval.md`。契约需要说的那部分（检索游标会过期、过期返回 `VALIDATION_FAILED`）已经在 [§1.3](01-http.md) 与 [§6.3.1](06-endpoints.md) 说完。

## §5.1 User 与邀请

```sql
users(
  id                   uuid primary key,
  role                 text not null default 'member',   -- 'admin' | 'member'
  storage_quota_bytes  bigint not null,
  created_at           timestamptz not null
);

invite_codes(
  code        text primary key,
  created_by  uuid not null,
  used_by     uuid,
  used_at     timestamptz,
  expires_at  timestamptz
);
```

对外表示：`{ id, role, storageQuotaBytes, storageUsedBytes, createdAt }`。`storageUsedBytes` 是实时聚合出来的，不是存储字段。

## §5.2 Meme

共享库主表。**检索时不按归属过滤**，`uploader_id` 只用于写权限判断。

```sql
memes(
  id            uuid primary key,
  uploader_id   uuid not null,        -- 上传者，不是「拥有者」

  -- 存储与去重
  storage_key   text not null,        -- R2 对象键
  original_filename text,             -- 上传时的原始文件名，不可信，仅参与 trgm
  content_hash  text not null,        -- SHA-256 hex
  phash         bigint not null,      -- 感知哈希
  mime          text not null,
  width         int,
  height        int,
  size_bytes    bigint not null,
  is_animated   boolean not null,

  -- AI 产出
  ocr_text      text,
  description   text,
  expressions   text[],              -- 面部表情，视觉事实
  emotions      text[],              -- 情绪
  tones         text[],              -- 表达语气
  purposes      text[],              -- 聊天用途
  scenes        text[],              -- 生活情境
  tags          text[],              -- 主体与风格
  ratings       text[],              -- 内容分级（成人向），不是语义维度
  search_text   text,                -- 上述字段拼接，供 embedding 使用
  embedding     vector(1024),

  -- 溯源
  vision_model  text,
  embed_model   text,
  tag_status    text not null,        -- pending | ok | refused | needs_manual
  edited_by     uuid,
  edited_at     timestamptz,

  deleted_at    timestamptz,
  created_at    timestamptz not null
);
```

### §5.2.1 去重字段

`content_hash` 有**全局唯一约束**，字节完全相同的文件不可能出现两条记录。

`phash` **刻意不是唯一约束，只建普通索引**。它会误判——同一模板换了字的两张表情包 Hamming 距离可能很近，但它们是两张不同的图。近似判断交给用户，DB 不能先斩后奏。理由见 [§9.7](09-decisions.md)。

两者都是全局作用域，不含 `uploader_id`：两个人传了同一张图，公共库里不该出现两条记录。

### §5.2.2 `is_animated`

前端复制 / 下载分流的唯一依据，不能靠 `mime` 推断——WebP 和 APNG 都可能是动图也可能是静图。

浏览器剪贴板只保证 `image/png`，动图写不进去。前端必须据此分流，不能让用户点了 GIF 之后发现没反应。能力边界见 [§9.2](09-decisions.md)。

### §5.2.3 AI 产出字段

单次视觉调用产出全部字段，不做独立 OCR 链路。**七个数组字段的取值必须落在 [§4](04-vocabulary.md) 对应维度的词表内**，且五个语义维度之间不互相推导——判据见 [§4.3.1](04-vocabulary.md#431-维度之间不能互相推导)；`ratings` 不是语义维度、不适用那条判据（[§4.3](04-vocabulary.md)）。**`ratings` 允许缺席**：老提示词 / 不认识这一维的模型不会回这个键，缺席按空数组处理，不是失败。

`search_text` 是 `ocr_text` + `description` + 七个数组拼接的结果，**供 embedding 使用**。它是派生字段，任何一个来源字段变更时必须重算。

> ⚠️ **`pg_trgm` 匹配的是 `ocr_text` + `description` + `original_filename`，不是 `search_text`。**
>
> 两者刻意不同。标签值已经由标签通路精确命中一次，如果再让它们出现在文本通路的匹配目标里，同一个词会在 RRF 融合前被两条通路各算一次分——一张靠标签沾边的图会压过一张原文精确命中的图。**文本通路只管文本，标签通路只管标签。** 见 [§9.21](09-decisions.md)。
>
> `original_filename` 的待遇则相反：**它参与 `pg_trgm`，但不进 `search_text`，因此不进 embedding。** 存下来的理由是从网上保存的表情包文件名里常带梗名，那是梗名最便宜的来源之一（见 [§9.18](09-decisions.md)）；不进 embedding 的理由是大量文件名是 `IMG_1234.jpg`、`微信图片_20240101.jpg` 这类纯噪声，混进向量只会稀释语义。

`original_filename` 是用户提供的字符串，**和 `mime` 一样不可信**：不据此判断格式、不用于构造任何路径、入库前限长并去掉控制字符。它对应 §5.2.6 的 `originalFilename`，前端在图片加载失败时用它兜底显示。

`tag_status`：

| 值 | 含义 | 可否被搜到 |
|---|---|---|
| `pending` | 尚未打标（未配模型，或排队中） | 只能按文件属性浏览 |
| `ok` | 打标成功 | 全部三路 |
| `refused` | 主副通道都被拒绝 | 无语义描述，靠 OCR 和人工标签 |
| `needs_manual` | 需要人工补，在待处理列表里 | 同上 |

### §5.2.4 `embedding`

全站固定 1024 维。**不是每条记录的属性**，所以表里没有 `embed_dim` 字段。

`embed_model` 保留，用于管理员更换模型后找出待重算的记录，**同时是向量通路的召回条件**——见 [§6.3.1](06-endpoints.md#631-搜索) 与 [§9.20](09-decisions.md)。全站统一 embedding 的理由见 [§9.6](09-decisions.md)——这是共享库带来的硬约束，不是可调参数。

### §5.2.5 软删

`deleted_at` 非空即已删除。所有常规读路径必须过滤，见 [§3.4](03-auth-permission.md)。

R2 上的原图延迟清理：软删满 30 天后由定时任务物理删除，此时才从配额中释放。

### §5.2.6 对外表示

```
{
  id, uploaderId, uploaderName,
  url, thumbUrl,            // 由 storageKey 派生的访问地址，不返回 storageKey 本身
  mime, width, height, sizeBytes, isAnimated, originalFilename,
  ocrText, description,
  expressions[], emotions[], tones[], purposes[], scenes[], tags[], ratings[],
  tagStatus, visionModel,
  favorited,                // 当前登录用户是否收藏，见 §5.4
  editedBy?, editedAt?, createdAt
}
```

**不返回**：`contentHash`、`phash`、`embedding`、`searchText`、`embedModel`、`deletedAt`、`storageKey`。它们是内部字段，客户端没有消费场景。

**上面那份清单就是「展示全部图片信息」的上限。** 编辑面板想显示得越全，越容易滑向「再要一个字段」——`phash` 和 `embedding` 对用户没有任何可读的含义，`storageKey` 是应该被派生 URL 取代的东西。**不要为了把面板填满去加接口字段**：这份清单里没有的，就是界面上不该出现的。

## §5.3 AI 配置

视觉配置每人一份，Embedding 配置全站一份。两者待遇不同的理由见 [§9.3](09-decisions.md) 与 [§9.6](09-decisions.md)。

```sql
user_ai_configs(
  user_id                 uuid primary key,

  vision_base_url         text,
  vision_api_key_enc      bytea,        -- AES-GCM，主密钥在 CONFIG_ENC_KEY
  vision_model            text,

  vision_fb_base_url      text,         -- 副通道，可空
  vision_fb_api_key_enc   bytea,
  vision_fb_model         text,

  -- 「测试连接」探测结果，不由用户填写
  vision_json_mode_works  boolean,
  vision_multi_image      boolean,
  verified_at             timestamptz
);

-- 全站单行表
embed_config(
  id               int primary key default 1 check (id = 1),
  base_url         text,
  api_key_enc      bytea,
  model            text,
  native_dim       int,                 -- 实测输出维度
  dim_param_works  boolean,             -- dimensions 参数是否生效
  verified_at      timestamptz
);
```

探测结果字段**不接受客户端写入**——它们只能由测试连接接口写入。用户手填的「支持多图」不算数，见 [§9.7](09-decisions.md)。

对外表示的密钥字段固定为 `"****" + 后四位`，且回传该字符串视为「不修改」，见 [§3.5](03-auth-permission.md)。

配置为空时回退到部署方的环境变量默认值。对外表示包含 `source: "user" | "default"`，让用户知道当前用的是哪一套。

## §5.4 收藏

收藏是**人和图的关系**，不是图的属性。共享库里它必须独立成表，否则 A 收藏了 B 也会看到收藏态。

```sql
user_favorites(
  user_id     uuid not null,
  meme_id     uuid not null,
  created_at  timestamptz not null,
  primary key (user_id, meme_id)
);
```

Meme 的对外表示里 `favorited` 字段是针对**当前登录用户**计算的，不是全局计数。首期不返回收藏总数，也不参与排序。

软删不级联删除收藏记录——恢复一张误删的图时，原来收藏它的人应该还在收藏列表里看到它。物理删除时才级联。

## §5.5 导入批次

```sql
import_batches(
  id          uuid primary key,
  user_id     uuid not null,
  total       int not null,
  created_at  timestamptz not null,
  expires_at  timestamptz not null      -- created_at + 24h
);

import_items(
  batch_id          uuid not null,
  file_name         text not null,
  result            text,               -- imported | exact_dup | needs_review | failed
  meme_id           uuid,               -- 命中或新建的记录；exact_dup 时是被比中的那张
  similar_to        uuid,               -- needs_review 时指向库里相似的那张
  distance          int,                -- needs_review 时的 Hamming 距离；自动判重的 exact_dup 也写（§9.33）
  temp_storage_key  text,               -- needs_review 时文件暂存的 R2 键
  reason            text,
  primary key (batch_id, file_name)
);
```

批次元信息 24 小时后清理，但 **`needs_review` 的条目在用户处理前不清理**——它是待办，不是日志，见 [§6.2.3](06-endpoints.md)。

待确认的文件已经在 R2 上（前端预签名直传），暂存在 `temp/` 前缀下，`temp_storage_key` 指向它。用户选「仍然导入」时移到正式前缀并建 `memes` 记录；选「跳过」时删除该对象。**超过 7 天未处理的待确认条目连同暂存对象一起清理**，避免 temp 前缀无限增长——清理前不需要再问用户，跳过是默认行为。

## §5.6 运行参数

> **状态：`accepted`**（2026-09-23）。新增能力，两端已确认契约、实现已落两端。**尚未转 `stable`**——联合验收还差真 api × 真浏览器的联调，见[运行参数任务](../joint-tasks/2026-09-23-runtime-config.md)的「总管裁定」。

全站单行表，仅 `admin` 可改（[§3.3](03-auth-permission.md)）。它装的是**保护机器**的那几个数——并发上限——**不装产品语义参数**：帧数、送 AI 的长边、去重阈值仍然留在代码常量里，判据见 [§9.26](09-decisions.md)。

```sql
runtime_config(
  id                     int primary key default 1 check (id = 1),
  tag_concurrency        int,        -- 本进程打标在途任务数上限
  tag_per_user_inflight  int,        -- 本进程内每个用户的在途上限
  import_concurrency     int,        -- 单批次导入管线并发
  ffmpeg_concurrency     int,        -- 本进程 ffmpeg 子进程上限
  updated_by             uuid,       -- 谁改的
  updated_at             timestamptz
);
```

**列可空，`NULL` 表示「用代码默认值」。** 空表、空行、空列都是正常状态，不是「未初始化」——刚部署的站一次都不配，行为与常量时代逐字相同。保存时**等于默认值的输入归一成 `NULL`**：显式存一个 `2` 会在将来默认值改成别的数时把它钉住，而界面上看不出「这是被钉住的旧默认值」。

`GET /admin/runtime` 直接返回**生效值**，没有 `source` 字段。这与 [§5.3](#53-ai-配置) 的 AI 配置不同——那边有「用户自己的配置 vs 部署方环境变量默认」两层来源要区分，这里只有一层，默认值是代码里的常量，环境变量里根本没有这一项。

| 字段 | 下限 | 上限 | 代码默认 |
|---|---|---|---|
| `tagConcurrency` | 1 | 16 | 2 |
| `tagPerUserInflight` | 1 | 4 | 1 |
| `importConcurrency` | 1 | 8 | 2 |
| `ffmpegConcurrency` | 1 | `min(CPU 核数, 16)` | 2 |

越界返回 `VALIDATION_FAILED`，**不是静默截断**——截断的表现是「填了 16、提示保存成功、回显还是 2」，管理员会以为没存上。`ffmpegConcurrency` 的上限取 CPU 核数，因为那是「这台机器同时能跑几个 ffmpeg」唯一有依据的判据。

**交叉约束：`tagPerUserInflight ≤ tagConcurrency`。** 一个人最多能占多少槽，大于总槽数时这一项等于不存在——**静默无效的配置比报错更难查**，所以按越界处理。

⚠️ **这里的每一个数都是「每个服务进程」的，不是全站的。** 多副本时实际全局上限 = 配置值 × 进程数。这与 [queue.md §1](../api/agents/rules/queue.md)「不假设单副本」相邻但不冲突：那张规则管的是**正确性**（不重复消费），这里的并发数管的是**节流**；改成真正的全局上限需要分布式限流，而本项目不引入 Redis（[§9.11](09-decisions.md)）。接口文案与界面措辞都必须按「每个服务进程」说。

生效**不是事务性的「立即」**：打标 worker 在下一轮 tick 读到新值，而那一轮可能正卡在等一个在途任务完成上；导入按批次读一次，已经在跑的批次整批用旧值。见 [§6.5.5](06-endpoints.md)。

## §5.7 人物与系列

> **状态：`proposed`**（2026-09-29）。新增能力，见[人物识别与聚类](../joint-tasks/2026-09-29-人物识别与聚类.md)。两端读过并确认后转 `accepted`；取舍理由见 [§9.34](09-decisions.md)，端点见 [§6.7](06-endpoints.md)。

**人物**是一组被认为是同一个角色 / 同一个人的 meme，由机器自动成组、由人命名与修正。**系列**是人物的父级（通常是一部作品），只由人挑选人物组成。

两层都是**开集**，不进 [§4](04-vocabulary.md) 的词表，`memes` 上也不加字段——理由与梗名相同（[§9.18](09-decisions.md)）：闭集存在的意义是让不同模型的输出可比，而人物每加一张图都可能多一个。

```sql
-- 一张图一行：整图算一个向量，至多归一个人物
meme_subjects(
  meme_id       uuid primary key,
  embedding     vector(1024),     -- 可空：人先归了类、向量还没算，或还没轮到
  embed_model   text,             -- 模型标识 + 预处理口径，见 §5.7.1
  person_id     uuid,             -- 可空：还没分配，或人判定它不属于任何人物
  assigned_by   uuid,             -- null = 机器分配；非空 = 人放进 / 移出过，机器不再改
  assigned_at   timestamptz
);

persons(
  id             uuid primary key,
  name           text,            -- null = 未命名；不要求唯一
  series_id      uuid,            -- 至多属于一个系列
  cover_meme_id  uuid,            -- 人指定的封面，可空
  hidden_at      timestamptz,     -- 非空 = 隐藏（「这组不是人物」），新图照挂
  created_at     timestamptz not null,
  updated_by     uuid,            -- 最后一次人工改动
  updated_at     timestamptz
);

series(
  id          uuid primary key,
  name        text not null,      -- 去首尾空白后全站唯一，不区分大小写
  created_by  uuid not null,
  created_at  timestamptz not null,
  updated_by  uuid,
  updated_at  timestamptz
);

-- 人点过的「这两个不是同一个」：合并建议不再给这一对
person_rejections(
  person_id        uuid not null,  -- 两个 id 里较小的那个
  other_person_id  uuid not null,
  created_by       uuid not null,
  created_at       timestamptz not null,
  primary key (person_id, other_person_id)
);

-- 全站单行表，与 embed_config 同构，多一个探测字段
image_embed_config(
  id                 int primary key default 1 check (id = 1),
  base_url           text,
  api_key_enc        bytea,
  model              text,
  native_dim         int,
  dim_param_works    boolean,
  image_input_works  boolean,       -- 图真的被编码了，不是被静默丢掉，见 §6.7.5
  verified_at        timestamptz
);
```

### §5.7.1 人物向量

**整图一个向量，不裁剪、不画框。** 送之前缩放到固定长边，截到 1024 维并重新 L2 归一化。长边的具体值与挂人物的相似度阈值是 `api` 的实现约束，留在代码常量里（[§9.26](09-decisions.md)）。动图取代表帧，与近似重复判定同一取法。

**一张图多个角色同框时，只归一个人物。** 这是整图方案的已知代价，见 [§9.34](09-decisions.md)。

**预处理口径是向量空间的一部分。** 同一张图换一个长边送进去，两份向量的相似度可能比两个不同角色还低（[任务](../joint-tasks/2026-09-29-人物识别与聚类.md) §9.1 发现 1）。所以 `embed_model` 记的是「模型 + 预处理口径」，**改长边与换模型同等对待**：存量全部重算，比较只在同一口径的向量之间做——与 [§9.20](09-decisions.md) 同一条道理，不同空间的余弦相似度是噪声。

**它与 `memes.embedding` 是两个空间，不能混比。** 后者由 `search_text` 算、属于文本向量（[§5.2.4](#524-embedding)），前者是图片向量。两份向量由两份配置管，**换文本 embedding 模型不重算人物向量，反之亦然**。

### §5.7.2 分配

**新图入库后异步算向量、挂人物，不挡入库也不挡打标。** 没配图片向量、调用失败、这一步整个出问题，图照样入库、打标、能被搜到，只是暂时不属于任何人物。人物是附加能力，不能挡核心路径（[§9.27](09-decisions.md) 同一条原则）。

挂的规则：离已有的某个人物足够近就挂上，否则自成一个新的未命名人物。隐藏的人物照样参与——否则被隐藏的那组会在下一张图进来时重新长出来。

**机器只「挂」，不「并」。** 两个已有人物之间，机器最多给合并建议（[§6.7.3](06-endpoints.md)），合不合由人点。误合并比碎片伤人：误合并会让按人物筛混进别的角色，碎片只是多一格。

**分配只发生一次。** 已经分配过的行，重算只换向量、不重新分配。`assigned_by` 非空的行，不论 `person_id` 是某个人物还是 null，任何后续的重算、补跑都不碰它的归属——**人做过的决定，机器不改**。被人移出的图若被机器重新挂回去，表现是「我明明说了不是他，过两天又回来了」，不报错。

### §5.7.3 系列

**系列是父级，人物是子级，一个人物至多属于一个系列。** 机器不生成系列，全靠人从人物里挑；系列可以是空的（刚建、还没挑）。

删除系列只删 `series` 这一行，其下人物的 `series_id` 置空，人物与图都不动。

### §5.7.4 软删与计数

人物的图数、封面、成员，**一切读路径都带 `memes.deleted_at is null`**（[§3.4](03-auth-permission.md)）。

- **图数**：该人物下未软删的图。
- **封面**：`cover_meme_id`；为 null 或那张已软删时，取成员里 `created_at` 最新的一张。
- **图全被软删的人物不出现**在任何列表里，`GET /persons/{id}` 返回 `NOT_FOUND`。行保留：图被恢复时人物跟着回来，与收藏不级联是同一个道理（[§5.4](#54-收藏)）。
- 物理删除时级联删 `meme_subjects` 那一行；人物因此一张图都不剩时，连同它的 `person_rejections` 一起删。
- 人把一个人物的图全部移走（含被合并掉）时，该人物当场删除。
- **系列**的图数 = 其下人物图数之和；人物数只数图数 ≥ 1 的。

## §5.8 访问令牌

> **状态：`proposed`**（2026-10-22）。[§10 MCP 接入](10-mcp.md) 的凭证，纯新增。管理端点见 [§6.8](06-endpoints.md#68-访问令牌)，安全规则见 [§10.3](10-mcp.md#103-鉴权与访问令牌)。

```sql
access_tokens(
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,            -- 设备/渠道标签，1–64 字，不要求唯一
  prefix       text not null,            -- 展示用，令牌前 12 个字符（含 mcp_）
  token_hash   text not null,            -- sha256(token) 十六进制
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,              -- 从未使用为 null
  expires_at   timestamptz,              -- null = 永不过期
  revoked_at   timestamptz               -- 非空 = 已撤销
);
```

**只存哈希，不存明文，也不存密文。** 令牌是 32 字节强随机值，SHA-256 足够；这比把它加密存起来少一层密钥管理——它本来就不需要被读回来。

`token_hash` 上建唯一索引（校验时按它查），`user_id` 上建普通索引（列表与数量上限）。**不用现有的 `sessions` 表**：会话是浏览器生命周期、随请求变化；令牌是长期凭证、显式撤销，两者的清理与审计语义都不同。

- `last_used_at` 的写必须节流（实现约束）：MCP 每个请求都可能命中一次令牌校验，逐请求 UPDATE 是写放大。
- `revoked_at` / `expires_at` 非空的记录**保留**，用于回答"这个令牌什么时候没的"；列表接口只展示仍然有效的那些（[§6.8](06-endpoints.md#68-访问令牌)）。
- 用户被物理删除时级联删除；这与 `sessions` 的 `on delete cascade` 同一条规则。

## §5.9 MCP 设置

> **状态：`accepted`**（2026-10-23）。新增能力，[§10 MCP 接入](10-mcp.md#1031-内容范围成人向默认关闭) 的内容范围与[过滤器](10-mcp.md#1032-过滤器按标签排除)设置。端点见 [§6.9](06-endpoints.md#69-mcp-设置)。

```sql
user_mcp_settings(
  user_id      uuid primary key references users(id) on delete cascade,
  allow_adult  boolean not null default false,   -- 默认关闭；只影响 MCP，不影响 Web
  excluded     jsonb not null default '{}'::jsonb, -- 按维度存排除值；{} = 不过滤
  updated_at   timestamptz not null default now()
);
```

**没有行 = 全用默认值（`allow_adult = false`、`excluded = {}`）**，`PUT` 时惰性 upsert 一行；空表是正常状态，不是"未初始化"。

`excluded` 的对外形状固定为七个数组（缺省为 `[]`）：

```json
{
  "expressions": [], "emotions": [], "tones": [], "purposes": [],
  "scenes": [], "tags": [], "ratings": []
}
```

- 语义见 [§10.3.2](10-mcp.md#1032-过滤器按标签排除)：**命中任一即排除**。
- `ratings` 只能是空数组；成人向由 `allow_adult` 单独控制，不能进过滤器（写入时校验）。
- 值必须在词表内；非法值/未知维度 → `VALIDATION_FAILED`。
- **没有行或空对象都表示不过滤**，不区分"未设置"和"清空"。

**它与 `access_tokens` 是两层不同的东西：** 令牌是"谁能调"，设置是"调到什么范围"。一个用户的所有令牌共享同一个设置；v1 不做按令牌区分——那会把设置页变成每个令牌一个开关，而真实需求（家庭 bot / 私人 bot）还没出现。

**只影响 MCP。** Web 端的搜索、浏览、收藏仍按 [§3.3](03-auth-permission.md#33-权限矩阵) 全库可读，不因这个开关隐藏任何图。
