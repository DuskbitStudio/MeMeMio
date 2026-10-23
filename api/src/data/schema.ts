import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * 表结构主源是 SPEC §5，这个文件是它的 drizzle 表达，不是另一份设计。
 * 改这里之前先改 SPEC；只改这里等于偷偷改契约。
 *
 * 数据库 snake_case、接口 camelCase，转换只发生在序列化层（SPEC §7.1）。
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** AES-GCM 密文列。存 bytea 而不是 text 是 SPEC §5.3 定的，别顺手改成 base64 字符串。 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

// ── §5.1 User 与邀请 ────────────────────────────────────────────────

/** role 取值 'member' | 'admin'。见 SPEC §3.2。 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: text('role').notNull().default('member'),
    /** 登录名，唯一。不在 User 对外表示里，但在 memes.uploaderName 里使用。 */
    name: text('name').notNull(),
    /** bcrypt/scrypt 哈希，明文不落盘。SPEC §3.1。 */
    passwordHash: text('password_hash').notNull(),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'bigint' }).notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  // 同名登录不可。0001 建了这个唯一索引，schema.ts 补上声明（原因同 sessions）
  (table) => [uniqueIndex('users_name_key').on(table.name)],
)

/**
 * 会话存 PostgreSQL，不引入 Redis。见 SPEC §3.1 / §9.11
 *
 * 两个索引不是装饰：`0001_add_auth_fields.sql` 建表时就带上了它们（按 user_id 找会话、
 * 按 expires_at 清过期会话），但 schema.ts 一直没声明，于是每次 `db:generate` 都会
 * 生成一份想把它们删掉的迁移。在这里补齐，schema 与库才对得上。
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
)

export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  usedBy: uuid('used_by').references(() => users.id),
  usedAt: timestamptz('used_at'),
  expiresAt: timestamptz('expires_at'),
})

// ── §5.2 Meme ──────────────────────────────────────────────────────

/**
 * 共享库主表。**检索时不按归属过滤**，uploader_id 只用于写权限判断（SPEC §0.1 / §5.2）。
 * 所有读写只允许经过 data/memes.ts —— 软删过滤和归属检查只有在唯一入口成立时才成立。
 */
export const memes = pgTable(
  'memes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 上传者，不是「拥有者」。命名是刻意的，见 SPEC §7.2。 */
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),

    // 存储与去重
    storageKey: text('storage_key').notNull(),
    /** 用户提供的字符串，和 mime 一样不可信。只参与 trgm，不进 search_text。SPEC §5.2.3 */
    originalFilename: text('original_filename'),
    contentHash: text('content_hash').notNull(),
    phash: bigint('phash', { mode: 'bigint' }).notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    /** 前端复制/下载分流的唯一依据，不能靠 mime 推断。SPEC §5.2.2 */
    isAnimated: boolean('is_animated').notNull(),

    // AI 产出，SPEC §5.2.3
    ocrText: text('ocr_text'),
    description: text('description'),
    // 前六个是语义维度。**不能互相推导**：微笑是 expressions、开心是 emotions，
    // 一张微笑角色配「你说得都对」的图是 expressions=微笑 / emotions=空 /
    // tones=敷衍 / purposes=表面附和。见 SPEC §4.3.1 与 §9.22。
    /** 面部表情，视觉事实 */
    expressions: text('expressions').array(),
    /** 情绪，内心状态 */
    emotions: text('emotions').array(),
    /** 表达语气，怎么说 */
    tones: text('tones').array(),
    /** 聊天用途，想完成什么交流动作 */
    purposes: text('purposes').array(),
    /** 生活情境，和什么现实场合有关 */
    scenes: text('scenes').array(),
    /** 主体与风格 */
    tags: text('tags').array(),
    /**
     * 内容分级（目前只有「成人向」）。**不是第七个语义维度**，是分级——
     * 任何表情 / 情绪的图都可能是成人向，所以不适用上面那条互不推导（SPEC §4.3、§9.23）。
     * 真实来源是人工编辑：境内模型大概率在 API 层就拒这类内容，打标那一维经常是空的。
     */
    ratings: text('ratings').array(),
    /**
     * 派生字段：ocr_text + description + 七个数组。任一来源变更时必须重算。
     *
     * ⚠️ **它只喂 embedding，不再是 trgm 的匹配目标**（SPEC §5.2.3 / §9.21）——
     * 标签值已经由标签通路精确命中一次，再让 trgm 匹配它们就是同一个信号计两遍分。
     */
    searchText: text('search_text'),
    /** 全站固定 1024 维，不是每条记录的属性，所以没有 embed_dim 字段。SPEC §5.2.4 */
    embedding: vector('embedding', { dimensions: 1024 }),

    // 溯源
    visionModel: text('vision_model'),
    embedModel: text('embed_model'),
    /** pending | ok | refused | needs_manual，SPEC §5.2.3 */
    tagStatus: text('tag_status').notNull().default('pending'),
    editedBy: uuid('edited_by').references(() => users.id),
    editedAt: timestamptz('edited_at'),

    /** 非空即已删除。所有常规读路径必须过滤，SPEC §3.4 / §5.2.5。 */
    deletedAt: timestamptz('deleted_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // content_hash 是硬约束，不能降级：字节完全相同的文件不可能出现两条记录
    uniqueIndex('memes_content_hash_key').on(table.contentHash),

    // ⚠️ phash 刻意**不是**唯一约束，只建普通索引。加了会硬性挡掉 Hamming 距离为 0 的情况，
    //    而那恰恰可能是用户看过之后决定要保留的不同图 —— 判断权在人，DB 不能先斩后奏。
    //    见 SPEC §5.2.1 / §9.7，以及 agents/rules/database.md §3。
    index('memes_phash_idx').on(table.phash),

    index('memes_created_at_idx').on(table.createdAt.desc()),
    index('memes_uploader_id_idx').on(table.uploaderId),
    index('memes_tag_status_idx').on(table.tagStatus),

    // 三路混合检索（SPEC §9.10）各自要的索引：
    // 1) pg_trgm 子串匹配。**目标是原文，不是 search_text**（SPEC §5.2.3 / §9.21）：
    //    search_text 里拼着标签值，让 trgm 也匹配它们等于同一个信号被文本路和标签路
    //    各计一次分，标签沾边的图会压过原文精确命中的图。coalesce 与 || 都是 immutable，
    //    可以直接建表达式索引；改这个表达式必须同步改 data/search.ts 里的同一份拼接。
    index('memes_text_trgm_idx').using(
      'gin',
      sql`(coalesce(${table.ocrText}, '') || ' ' || coalesce(${table.description}, '')) gin_trgm_ops`,
    ),
    index('memes_original_filename_trgm_idx')
      .using('gin', sql`${table.originalFilename} gin_trgm_ops`),
    // 2) 标签过滤，七个维度各一个（SPEC §4.3）
    index('memes_tags_idx').using('gin', table.tags),
    index('memes_expressions_idx').using('gin', table.expressions),
    index('memes_emotions_idx').using('gin', table.emotions),
    index('memes_tones_idx').using('gin', table.tones),
    index('memes_purposes_idx').using('gin', table.purposes),
    index('memes_scenes_idx').using('gin', table.scenes),
    index('memes_ratings_idx').using('gin', table.ratings),
    // 3) 向量。共享库没有 WHERE uploader_id = ? 这个过滤条件，HNSW 跑在最舒服的状态；
    //    deleted_at is null 选择率接近 1，不构成同类问题。见 agents/rules/database.md §2
    //    embed_model = 当前模型 是同一类过滤：稳态下选择率也≈1，只有换模型期间才下降，
    //    而那正是要它生效的时候（SPEC §9.20）。
    index('memes_embedding_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
)

// ── §5.3 AI 配置 ───────────────────────────────────────────────────

/** 视觉配置每人一份。api_key_enc 是 AES-GCM 密文，主密钥在 CONFIG_ENC_KEY。 */
export const userAiConfigs = pgTable('user_ai_configs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),

  visionBaseUrl: text('vision_base_url'),
  visionApiKeyEnc: bytea('vision_api_key_enc'),
  visionModel: text('vision_model'),

  visionFbBaseUrl: text('vision_fb_base_url'),
  visionFbApiKeyEnc: bytea('vision_fb_api_key_enc'),
  visionFbModel: text('vision_fb_model'),

  // 以下三个是「测试连接」的探测结果，**不接受客户端写入**。SPEC §5.3 / §9.7
  visionJsonModeWorks: boolean('vision_json_mode_works'),
  visionMultiImage: boolean('vision_multi_image'),
  verifiedAt: timestamptz('verified_at'),
})

/** Embedding 配置全站一份 —— 共享库的硬约束，不是可调参数。SPEC §5.2.4 / §9.6 */
export const embedConfig = pgTable(
  'embed_config',
  {
    id: integer('id').primaryKey().default(1),
    baseUrl: text('base_url'),
    apiKeyEnc: bytea('api_key_enc'),
    model: text('model'),
    nativeDim: integer('native_dim'),
    dimParamWorks: boolean('dim_param_works'),
    verifiedAt: timestamptz('verified_at'),
  },
  (table) => [check('embed_config_singleton', sql`${table.id} = 1`)],
)

/**
 * 图片向量配置，全站单行、仅 `admin` 可改（SPEC §5.7 / §6.7.5）。
 *
 * 与 `embedConfig` 同构，多一个 `imageInputWorks`。它是**全站一份**的理由与文本
 * embedding 相同（§9.6）：人物之间要能互相比较，模型与预处理口径必须全站一致。
 * 花的是部署方的额度。
 *
 * ⚠️ `imageInputWorks` 是这份配置最重要的探测位（§6.7.5）：上游把图**静默丢掉**、
 *    照样回一个向量时，`verified_at` 非空、每张图都能算出向量，而所有人物会慢慢
 *    并成一团——**不报错**。所以写配置时它是硬闸门，见 `data/ai-configs.ts`。
 */
export const imageEmbedConfig = pgTable(
  'image_embed_config',
  {
    id: integer('id').primaryKey().default(1),
    baseUrl: text('base_url'),
    apiKeyEnc: bytea('api_key_enc'),
    model: text('model'),
    nativeDim: integer('native_dim'),
    dimParamWorks: boolean('dim_param_works'),
    /** 图真的被编码了，不是被静默丢掉。见上面的警告与 §6.7.5。 */
    imageInputWorks: boolean('image_input_works'),
    verifiedAt: timestamptz('verified_at'),
  },
  (table) => [check('image_embed_config_singleton', sql`${table.id} = 1`)],
)

/**
 * 运行参数，全站单行、仅 `admin` 可改（SPEC §5.6 / §6.5.5 / §9.26）。
 *
 * 装的是**保护机器**的那四个并发上限——`NULL` = 用代码里的默认值，空表是正常状态不是
 * 「未初始化」。判据是「改它改变吞吐还是改变产出」（§9.26），所以帧数、送 AI 的长边、
 * 去重阈值仍在 `image/constants.ts` 里。
 *
 * ⚠️ **上下限不写进 DDL。** `ffmpegConcurrency` 的上限是 `min(CPU 核数, 16)`，核数要
 *    运行期才知道，写死在这里等于把上限钉成迁移那一刻的机器核数。越界在
 *    `services/runtime-config.ts` 报 `VALIDATION_FAILED`。
 *
 * ⚠️ 与 `embedConfig` 的单行模式一致，但**没有 `source` 字段那一层**：那边的默认值来自
 *    部署方环境变量，这里的默认值只有代码常量一处，所以 `GET` 直接返回生效值。
 */
export const runtimeConfig = pgTable(
  'runtime_config',
  {
    id: integer('id').primaryKey().default(1),
    /** 以下四个：`NULL` = 用 `services/runtime-config.ts` 里那份默认值，**每进程** */
    tagConcurrency: integer('tag_concurrency'),
    tagPerUserInflight: integer('tag_per_user_inflight'),
    importConcurrency: integer('import_concurrency'),
    ffmpegConcurrency: integer('ffmpeg_concurrency'),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamptz('updated_at'),
  },
  (table) => [check('runtime_config_singleton', sql`${table.id} = 1`)],
)

/**
 * 测试连接的结果，**存在服务端**（SPEC §6.5.2）。
 *
 * 为什么必须有这张表：探测结果字段不接受客户端写入（§5.3），所以「我刚测过了」
 * 这件事不能靠前端在 `PUT` 里回传。流程被固定成「`POST /test` 实测并落这张表 →
 * `PUT` 回来按组合查到那条成功记录 → 把探测结果抄进配置行」。
 *
 * 匹配三要素是 **base_url + model + key 指纹**，少了指纹，「换了 key 没测就保存」
 * 能过校验，而那恰恰是最常见的填错方式。
 *
 * ⚠️ 本表**不存 key 明文也不存密文**，只存 SHA-256 指纹（§6.5.2 明写）。
 *    指纹只用于比对，不参与任何解密路径——所以这张表整体可以在不接触
 *    `CONFIG_ENC_KEY` 的情况下读写。
 */
export const configTests = pgTable(
  'config_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** vision | embed | image_embed */
    scope: text('scope').notNull(),
    /**
     * 视觉配置是每人一份，embedding 配置是全站一份（§5.2.4），图片向量配置同样是全站
     * 一份（§5.7）——所以 embed / image_embed 的记录 user_id 为 null，
     * 那是「全站」而不是「不知道谁测的」。
     */
    userId: uuid('user_id').references(() => users.id),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    /** key 的 SHA-256 十六进制。见 lib/config-crypto.ts 的 fingerprintSecret。 */
    keyFingerprint: text('key_fingerprint').notNull(),
    ok: boolean('ok').notNull(),
    /** vision 探测位；embed 记录上为 null */
    jsonModeWorks: boolean('json_mode_works'),
    multiImage: boolean('multi_image'),
    /** embed 探测位；vision 记录上为 null */
    nativeDim: integer('native_dim'),
    dimParamWorks: boolean('dim_param_works'),
    /** 只有 image_embed 记录会写它（§6.7.5）；vision / embed 记录上为 null */
    imageInputWorks: boolean('image_input_works'),
    testedAt: timestamptz('tested_at').notNull().defaultNow(),
  },
  (table) => [
    /**
     * 查的永远是「这个组合最近一次测出了什么」。指纹是 64 位十六进制、选择性极高，
     * 放在 scope 后面就够把候选压到个位数，base_url / model 再在堆上比对——
     * 把长文本列也塞进索引只会让索引变大而不会更快。
     */
    index('config_tests_lookup_idx').on(table.scope, table.keyFingerprint),
  ],
)

// ── §5.4 收藏 ──────────────────────────────────────────────────────

/**
 * 收藏是**人和图的关系**，不是图的属性。共享库里必须独立成表，
 * 否则 A 收藏了 B 也会看到收藏态。软删不级联删除它，物理删除时才级联。SPEC §5.4
 */
export const userFavorites = pgTable(
  'user_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.memeId] })],
)

// ── 打标队列（SPEC §9.11） ─────────────────────────────────────────

/**
 * 用 PostgreSQL 自己做队列，不引入 Redis。理由见 SPEC §9.11。
 *
 * **它不是 `memes` 的一部分**：有独立的访问方法（`data/tag-jobs.ts`），不走 `data/memes.ts`。
 * 但入队时的 `meme_id` 必须来自 `data/memes.ts` 的查询结果——在队列表上 join `memes`
 * 会绕过 `deleted_at is null`，表现是给已删除的图打标。见 agents/rules/queue.md §8。
 *
 * 消费者（调视觉模型、生成 embedding）是独立任务，本表先建起来供入队。
 */
export const tagJobs = pgTable(
  'tag_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id, { onDelete: 'cascade' }),
    /**
     * 上传者。**冗余列，不是外键便利**——并发要按人分配（queue.md §4），
     * 一个人导入一千张不能把别人的图堵在后面，所以取任务时必须能按人分组。
     *
     * 存一份而不是 join `memes`：在队列表上 join `memes` 会绕过 `deleted_at is null`
     * （queue.md §8），而且 `memes` 的 SQL 只许出现在 `data/memes.ts`
     * （project-structure.md）。入队时的值来自 `createMeme` 的返回行，来源仍然是那一层。
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** pending | running | done | failed，状态机见 agents/rules/queue.md */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * 重试靠推后 run_after，不靠 sleep——worker 里长 sleep 会占着消费槽什么都不干。
     * 见 agents/rules/queue.md §3。
     */
    runAfter: timestamptz('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // 取任务的那条语句：where status='pending' and run_after <= now() order by run_after。
    // FOR UPDATE SKIP LOCKED 是方案成立的基础，索引要能直接喂它。
    index('tag_jobs_claim_idx').on(table.status, table.runAfter),
    /** 按人轮转取任务时要按 user_id 过滤，claim_idx 喂不了这一路。 */
    index('tag_jobs_user_idx').on(table.status, table.userId),
    /**
     * 一条 meme 同时只应有一个在途任务。
     * 重复入队（比如 commit 被重放）靠 onConflictDoNothing 变成空操作，
     * 否则同一张图会被打标两次，直接浪费用户的钱。
     */
    uniqueIndex('tag_jobs_meme_id_key').on(table.memeId),
  ],
)

// ── 重建索引队列（SPEC §6.5.4） ────────────────────────────────────

/**
 * 换 embedding 模型后全站重算向量的队列。**独立于 `tag_jobs`**，三个理由缺一不可：
 *
 * 1. `tag_jobs` 上 `meme_id` 有唯一索引——一条重算任务和同一张图的待打标任务会互相踢掉
 * 2. 重算**不调视觉模型**，只从 `search_text` 重新算向量（§6.5.4），重试策略也不同
 * 3. 打标并发按人分组（一个人导入一千张不该堵住别人），而重算是**运维操作，不是谁的配额**，
 *    所以本表没有 `user_id` 列——不是忘了冗余，是不按人分组
 *
 * 和 `tag_jobs` 一样：入队的 `meme_id` 必须来自 `data/memes.ts` 的查询结果，
 * **不许在本表上 join `memes`**——那会绕过 `deleted_at is null`（queue.md §8）。
 */
export const reindexJobs = pgTable(
  'reindex_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id, { onDelete: 'cascade' }),
    /** pending | running | done | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamptz('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('reindex_jobs_claim_idx').on(table.status, table.runAfter),
    /**
     * 幂等的落点（§6.5.4「重复调用不会让同一条记录重算两遍」）：
     * `PUT /config/embed` 自动触发和 `POST /admin/reindex` 手动补触发都靠
     * onConflictDoNothing 撞这个唯一索引变成空操作。
     *
     * 它同时也是搜索侧 `degraded` 那条存在性查询的索引——见 claim_idx。
     */
    uniqueIndex('reindex_jobs_meme_id_key').on(table.memeId),
  ],
)

// ── §5.5 导入批次 ──────────────────────────────────────────────────

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  total: integer('total').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  /** created_at + 24h。但 needs_review 的条目在用户处理前不清理，见 SPEC §5.5。 */
  expiresAt: timestamptz('expires_at').notNull(),
  /**
   * commit 时刻。**非空即已提交**，服务端处理只能启动一次。
   *
   * commit 要在处理开始前抢一个原子标志：否则客户端重试一次 commit（网络抖动下常见）
   * 就会让同一批文件被处理两遍——第二遍不报错，只是把每个文件又走一遍 ffmpeg、
   * 又判一次重复。有它就退化成一次幂等的空操作。
   */
  committedAt: timestamptz('committed_at'),
})

export const importItems = pgTable(
  'import_items',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    /** imported | exact_dup | needs_review | failed */
    result: text('result'),
    memeId: uuid('meme_id').references(() => memes.id),
    /** needs_review 时指向库里相似的那张。保留 similar 一词是 SPEC §7.2 的历史例外。 */
    similarTo: uuid('similar_to').references(() => memes.id),
    distance: integer('distance'),
    tempStorageKey: text('temp_storage_key'),
    reason: text('reason'),
    /**
     * 待确认队列要拿它和库里那张并排对比（SPEC §6.2.3），而条目本身还没进 `memes`，
     * 配额在 commit 时就该按声明值扣住，所以要在条目上留一份。
     */
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.fileName] }),
    // 待确认队列是跨批次查 result = 'needs_review'（SPEC §6.2.3），
    // 主键前缀是 batch_id，帮不上这个查询。
    index('import_items_result_idx').on(table.result),
  ],
)

// ── 检索快照（SPEC §6.3.1 分页的实现约束） ─────────────────────────
//
// SPEC §6.3.1 只规定「游标指向一次检索快照里的位置」，**没有规定快照存在哪里**——
// 「快照能活多久、每次向后翻要重扫多少候选，都是 api 的实现约束」。这一行就是那个实现。
//
// 它不是 `memes` 的一部分（有独立的访问方法 `data/search-snapshots.ts`），也不出现在
// 任何响应里：客户端只拿到一个不透明游标。**它是一份一次性缓存**，30 分钟没人用它就
// 被清理任务删掉（`queue/cleanup.ts`），删了之后那个游标报 `VALIDATION_FAILED`——
// 与「游标坏了」同一个码、同一个客户端动作（SPEC §1.3）。
//
// 两列 jsonb 的形状定义在 `data/search-snapshots.ts`（它才是这一行内容的主人），
// 读取时**逐字段运行时校验**，不做 `as` 强转（code-style.md：`as` 是把类型检查关掉）。
export const searchSnapshots = pgTable(
  'search_snapshots',
  {
    id: uuid('id').primaryKey(),
    /**
     * 快照属于谁。**翻页时要校验**：游标是不透明串，转手给别人之后那个人会拿着
     * 别人的 `favorited` / `uploader=me` 过滤条件去查——那不是越权读别人的图，
     * 但确实是在用别人的筛选条件，属于「客户端看不出错的错误结果」。
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 冻结的检索输入：查询词、筛选条件、时点、改写文本与查询向量。 */
    inputs: jsonb('inputs').notNull(),
    /** 只追加的候选名单 + 已发出的页 + 当前预取深度。 */
    state: jsonb('state').notNull(),
    /**
     * 创建时刻。**插入时显式写入**（不是 `defaultNow()`）：它同时是这次检索的**时点**
     * ——首屏那次扫描与后来每一次重扫都以它为「只看这个时刻之前入库的图」的上界
     * （SPEC §6.3.1：中途上传的新图不出现在后续页里）。取数据库的 `now()` 会和首屏
     * 用的那个 JS 时刻差几毫秒，那几毫秒里上传的图就能从后面的页漏进来。
     */
    createdAt: timestamptz('created_at').notNull(),
    /**
     * 过期时刻，**每次用到这张快照就往后推**（下滑 TTL）。见 `services/search-snapshot.ts`：
     * 从创建算起的固定 TTL 会让「滚了半小时的人」在滚到一半时被判过期。
     */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  // 清理任务唯一的查询条件就是它。不建 userId 索引：按 id 取（主键）已经够了
  (table) => [index('search_snapshots_expires_at_idx').on(table.expiresAt)],
)

// ── §5.7 人物与系列 ────────────────────────────────────────────────

/**
 * 系列：人物的父级，**只由人挑选组成，机器不生成**（SPEC §5.7.3）。
 *
 * 它是开集，不进 §4 的词表，`memes` 上也不加字段——理由与梗名相同（§9.18）。
 *
 * ⚠️ `name` 的唯一性是**去首尾空白后不区分大小写**（§5.7），所以唯一索引建在
 *    表达式 `lower(btrim(name))` 上，不建在 `name` 上。写库时的重名判定与这条
 *    索引必须同时存在：只靠应用层判重，两个人同时建同名系列会各建一个。
 */
export const series = pgTable(
  'series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** 最后一次人工改动。留痕是防滥用的唯一手段（§6.7.1）。 */
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamptz('updated_at'),
  },
  (table) => [
    uniqueIndex('series_name_key').on(sql`lower(btrim(${table.name}))`),
    // 列表按名字过滤（§6.7.3 的 `q`）走 trgm；系列数量少，但同名的前缀搜索会全表扫
    index('series_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
)

/**
 * 人物：一组被认为是同一个角色 / 同一个人的 meme（SPEC §5.7）。
 *
 * 机器自动成组、人命名与修正。图数为 0 的人物**行保留但不出现在任何列表里**
 * （§5.7.4）——图被恢复时人物跟着回来，与收藏不级联是同一个道理。
 *
 * ⚠️ `series_id` 是 `on delete set null`：删系列只删 `series` 这一行，
 *    其下人物与图都不动（§5.7.3），这条外键就是那句话的落点。
 * ⚠️ `cover_meme_id` 同样 `set null`：物理删除一张图时，别让人物的封面指向一个
 *    已经不存在的 id（软删的封面由 `§5.7.4` 的读路径回落，不归外键管）。
 */
export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null = 未命名。**不要求唯一**：同名两组是合并的信号，不是冲突（§6.7.4）。 */
    name: text('name'),
    seriesId: uuid('series_id').references(() => series.id, { onDelete: 'set null' }),
    /** 人指定的封面。为 null 或那张已软删时取成员里最新的一张（§5.7.4）。 */
    coverMemeId: uuid('cover_meme_id').references(() => memes.id, { onDelete: 'set null' }),
    /** 非空 = 隐藏（「这组不是人物」）。**新图照挂**（§5.7.2）。 */
    hiddenAt: timestamptz('hidden_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamptz('updated_at'),
  },
  (table) => [
    // 列表按系列筛（`series=<id>`）与 series 的成员计数都走它
    index('persons_series_id_idx').on(table.seriesId),
    index('persons_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
  ],
)

/**
 * 一张图一行：整图算一个向量，至多归一个人物（SPEC §5.7）。
 *
 * 三列可为空各有含义：`embedding` 为空 = 人先归了类、向量还没算；
 * `person_id` 为空 = 还没分配，或人判定它不属于任何人物；
 * `assigned_by` 非空 = **人放进 / 移出过，机器不再改**（§5.7.2）。
 *
 * ⚠️ `embed_model` 存的是「模型 + 预处理口径」（如 `Qwen/…@768`），不是裸模型名。
 *    改长边等于换模型、存量要重算（§5.7.1），比较只在同一口径的向量之间做——
 *    这个字段就是那个口径的唯一落点，拼接见 `ai/image-embedder.ts`。
 *
 * ⚠️ `person_id` 的外键**不加 `on delete cascade`**：人物行只在「一张图都不剩」
 *    时被删除，那一刻不该还有行指着它。真有行指着却被删掉，要的是当场报错
 *    （约束冲突），而不是安静地把归属抹成 null——后者正是「人说了不是他、
 *    过两天又回来了」的温床。
 */
export const memeSubjects = pgTable(
  'meme_subjects',
  {
    memeId: uuid('meme_id')
      .primaryKey()
      .references(() => memes.id, { onDelete: 'cascade' }),
    embedding: vector('embedding', { dimensions: 1024 }),
    embedModel: text('embed_model'),
    personId: uuid('person_id').references(() => persons.id),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamptz('assigned_at'),
  },
  (table) => [
    // 质心、成员列表、图数：全都按 person_id 分组或过滤，这是本表最热的一路
    index('meme_subjects_person_id_idx').on(table.personId),
    /**
     * 向量。**分配那一步不走它**（和每个人物的质心比，是一次 `group by` 聚合），
     * 走它的是合并建议：两组之间的相似度取「两组里最像的那一对图」（§6.7.3），
     * 那是逐成员找最近邻，正是 HNSW 的形状。SPEC §5.7 也明写了要建。
     */
    index('meme_subjects_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops'),
    ),
  ],
)

/**
 * 人点过的「这两个不是同一个」：合并建议不再给这一对（SPEC §5.7）。
 *
 * ⚠️ **较小的 id 放前面**（§5.7.4 与 §6.7.4 都写了）。不这么做的话
 * `(A,B)` 与 `(B,A)` 会各存一条，而查建议时只按一个方向过滤，
 * 表现是「点了不是同一个，建议里它还在」——不报错。
 * 落点在 `data/persons.ts`，那里是唯一的写入路径。
 *
 * 人物被删时级联删除：合并会把来源人物删掉，合并前那对「不是同一个」正是要丢掉的
 * （§6.7.4：「人刚刚明确说了它们是同一个」）。
 */
export const personRejections = pgTable(
  'person_rejections',
  {
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    otherPersonId: uuid('other_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.otherPersonId] }),
    // 主键前缀是 person_id，查「和 X 有关的拒绝」时另一侧用不上，这里补一个
    index('person_rejections_other_idx').on(table.otherPersonId),
  ],
)

// ── 人物向量队列（SPEC §5.7.2 / §6.7.5） ───────────────────────────

/**
 * 算人物向量的队列。**独立于 `tag_jobs`**（§5.7.2：人物是附加能力，
 * 不能挡入库也不能挡打标），也独立于 `reindex_jobs`（那个装的是文本向量、
 * 口径与重试语义都不同）：
 *
 * 1. `tag_jobs` 上 `meme_id` 有唯一索引——一条人物向量任务和同一张图的待打标任务
 *    会互相踢掉，而「打标失败不能连带人物」正是本任务的一条硬要求
 * 2. 打标并发按人分组（一个人导入一千张不该堵住别人），而人物向量**花的是部署方
 *    的钱、全站一份配置**，与 `reindex_jobs` 同属运维口径，所以本表没有 `user_id`
 * 3. 终局失败**只记在本表的行上**，不动 `memes.tag_status`
 *
 * 和另外两张队列一样：入队的 `meme_id` 必须来自 `data/memes.ts` 的查询结果，
 * **不许在本表上 join `memes`**（queue.md §8）。
 */
export const personVectorJobs = pgTable(
  'person_vector_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memeId: uuid('meme_id')
      .notNull()
      .references(() => memes.id, { onDelete: 'cascade' }),
    /** pending | running | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    runAfter: timestamptz('run_after').notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('person_vector_jobs_claim_idx').on(table.status, table.runAfter),
    /**
     * 幂等的落点：导入时入队（可能被重放）与 `POST /admin/persons/reindex`
     * 的手动补触发都靠 onConflictDoNothing 撞它变成空操作。
     *
     * ⚠️ 完成时**删行而不是留 done**，理由与 `reindex_jobs_meme_id_key` 逐字相同：
     *    留着会让这张图在下一次换口径时静默入不了队。
     */
    uniqueIndex('person_vector_jobs_meme_id_key').on(table.memeId),
  ],
)

// ── §5.8 访问令牌（MCP 凭证） ──────────────────────────────────────

/**
 * MCP 的个人访问令牌（PAT）。**只存哈希与展示用 prefix，不存明文，也不存密文**
 * （SPEC §5.8 / §10.3）：令牌是 32 字节强随机值，SHA-256 足够，而且它本来就不需要
 * 被读回来——存密文只会多一层密钥管理。
 *
 * **不用 `sessions` 表**：会话是浏览器生命周期、随请求变化；令牌是长期凭证、显式撤销，
 * 两者的清理与审计语义都不同。判据与 §9.35 一致。
 *
 * `revoked_at` / `expires_at` 非空的记录**保留**（回答「这个令牌什么时候没的」），
 * 列表接口只展示仍然有效的那些（§6.8）。校验路径必须同时判两个：
 * `revoked_at is null` 且（`expires_at is null` 或 `expires_at > now()`）。
 */
export const accessTokens = pgTable(
  'access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 设备 / 渠道标签，1–64 字，**不要求唯一**（两台设备同名是正常的，§6.8）。 */
    name: text('name').notNull(),
    /** 展示用：令牌前 12 个字符（含 `mcp_`）。列表只回它，完整值只在创建响应出现一次。 */
    prefix: text('prefix').notNull(),
    /** `sha256(token)` 十六进制。校验按它查，唯一索引就是那次查询的入口。 */
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** 从未使用为 null。写入必须节流（§5.8：逐请求 UPDATE 是写放大）。 */
    lastUsedAt: timestamptz('last_used_at'),
    /** null = 永不过期。 */
    expiresAt: timestamptz('expires_at'),
    /** 非空 = 已撤销，**立即生效**（下一次 MCP 请求 401，§10.3）。 */
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    // 校验时按 token_hash 查，必须唯一——哈希碰撞意味着两个令牌不可区分
    uniqueIndex('access_tokens_token_hash_key').on(table.tokenHash),
    // 列表与「每用户最多 10 个有效令牌」的计数
    index('access_tokens_user_id_idx').on(table.userId),
  ],
)

// ── §5.9 MCP 设置（内容范围） ──────────────────────────────────────

/**
 * MCP 的用户级设置。**没有行 = 全用默认值**（`allow_adult = false`），
 * PUT 时惰性 upsert 一行（SPEC §5.9）。
 *
 * 只影响 MCP 工具是否返回成人向图；**不影响 Web 端的全库可读**（§3.3）。
 * 与 `access_tokens` 是两层：令牌管"谁能调"，这里管"调到什么范围"。
 */
export const userMcpSettings = pgTable('user_mcp_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** 默认关闭；打开后还要每次调用显式传 `allowAdult: true` 才返回（§10.3.1）。 */
  allowAdult: boolean('allow_adult').notNull().default(false),
  /**
   * 按维度存排除值；`{}` = 不过滤（SPEC §5.9 / §10.3.2）。形状由
   * `lib/mcp-filter.ts` 的 `normalizeMcpFilter` 归一化，这里只当 JSONB 存。
   */
  excluded: jsonb('excluded').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})
