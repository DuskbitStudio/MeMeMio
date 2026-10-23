import { hc, type InferRequestType, type InferResponseType } from 'hono/client'
import type { AppType } from '@api/app'
import { VOCAB_FIELDS, type VocabField } from './vocab'

/**
 * **唯一发请求的地方。** 组件里不出现 fetch。
 *
 * 类型从 api 直接 import，没有生成步骤、不手写接口类型（SPEC §0.2）。
 * 但**类型只保证形状，SPEC 保证含义** —— 软删语义、degraded、tagStatus 的取值
 * 都不在类型里，类型检查通过不等于契约遵守。
 *
 * 同域：cookie 自动带，不手动加 Authorization header。本地靠 Vite proxy。
 */
export const api = hc<AppType>('/')

/** SPEC §2.1 的错误信封。客户端按 code 分支，**不解析 message 文本**。 */
export type ApiErrorBody = {
  error: {
    code: string
    message: string
    requestId: string
    details?: Record<string, unknown>
  }
}

export class ApiError extends Error {
  readonly code: string
  /** 必须展示给用户 —— 报问题时它是唯一能对上服务端日志的东西。 */
  readonly requestId: string
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  /**
   * `RATE_LIMITED` 的退避秒数（SPEC §2.2「按 `Retry-After` 退避」）。
   *
   * 头缺失或格式不认识时是 `null`——那时只能把 message 摆出来，没有倒计时可给。
   * 解析放在这里而不是各个调用点：登录页只认得秒数，而头有两种合法形式（见 `parseRetryAfter`）。
   */
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    body: ApiErrorBody['error'],
    retryAfterSeconds: number | null = null,
  ) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.requestId = body.requestId
    this.details = body.details
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * `Retry-After` → 秒数。**两种形式都要认**：`120`（delta-seconds）与 HTTP-date
 * （`Wed, 21 Oct 2026 07:28:00 GMT`）。RFC 允许任一，而 SPEC §2.2 只写了「按 `Retry-After`
 * 退避」没钉形式——只认数字的表现是换个服务端写法倒计时就消失，且不报错。
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null
  const raw = header.trim()

  const seconds = Number(raw)
  if (Number.isInteger(seconds) && seconds >= 0) return seconds

  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/**
 * 服务端可能新增错误码（那是兼容变更），所以解析不出信封时也要给出能用的错误，不能白屏。
 *
 * ⚠️ **它不只是个解析函数，还是会话过期的统一拦截点**：401 且不是下面那四个 auth 端点时，
 * 会顺手清 user 并跳到登录页（`onUnauthenticated`）。所有读路径都经过这里，这正是要的效果
 * ——**副作用发生在「造错误对象」这一刻**，调用点不需要各自记得处理 401。
 */
export async function toApiError(res: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))

  let err: ApiError | null = null
  try {
    const body = (await res.json()) as ApiErrorBody
    if (body?.error?.code) err = new ApiError(res.status, body.error, retryAfter)
  } catch {
    // 落到下面的兜底
  }

  err ??= new ApiError(
    res.status,
    {
      code: 'INTERNAL',
      message: `请求失败（HTTP ${res.status}）`,
      requestId: res.headers.get('X-Request-Id') ?? '未知',
    },
    retryAfter,
  )

  // 会话过期：清 user + 跳登录页（SPEC §2.2）。**放在唯一发请求的地方**，不是为了少写几行
  // ——读路径有十几条（浏览 / 搜索 / 图墙 / 打标 / 导入 / 设置），逐个调用点去写，
  // 漏掉任何一条的表现都是「会话过期后一直提示加载失败，用户只能反复点重试」。
  if (err.code === 'UNAUTHENTICATED' && !isSessionPath(res.url)) onUnauthenticated?.()

  return err
}

/**
 * 把 `catch` 到的任何东西收敛成一个能渲染的 `ApiError`。
 *
 * 断网、代理挂了、`fetch` 抛的 `TypeError` 都不是 `ApiError`，而错误态必须能读出
 * 「连不上服务端」而不是白屏（http.md §4）。**每个拉数据的界面都要这一层**，
 * 所以放在这里，不要各写各的。
 */
export function toStateError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  return new ApiError(0, {
    code: 'NETWORK',
    message: '连不上服务端，确认 api 是否已启动',
    requestId: '无',
  })
}

// --- 会话过期：唯一的拦截点 -------------------------------------------------

/**
 * 会话过期时的处置函数，由 `AuthProvider` 在挂载时注册（`contexts/auth.tsx`）。
 *
 * 用注册而不是在这里直接 import context / router：这个模块是**非 React 的**，
 * 拿不到 `useNavigate`，而把它变成 hook 就要每个调用点自己记得调一次——那又回到
 * 「十几条读路径逐个去写」的老问题。
 */
let onUnauthenticated: (() => void) | null = null

export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn
}

/**
 * 登录页地址，**带 `next` 回跳参数**（state-navigation.md §5）。
 *
 * 回跳是这一端最容易被用户抱怨的细节：从别人发来的搜索链接进来、登录完被丢到首页，
 * 搜索词就没了。所以生成地址的地方**只有这一个**——`RequireAuth`（路由拦下）、
 * 会话过期的拦截器、设置页保存时都用它，各写一份迟早会有一份忘了带 `next`。
 *
 * ⚠️ **`next` 是攻击者可控的，回跳前必须在登录页校验。** 那道闸门是
 * `features/auth/LoginForm.tsx` 的 `safeNext`（挡 `//evil.com` 这类跨源），
 * 这里只负责生成，不负责信任。
 */
export function loginPath(from: string): string {
  return `/login?next=${encodeURIComponent(from)}`
}

/**
 * 会话类端点。**这四条路径上的 401 不是「会话过期」**：
 *
 *   - `login` / `register`：这时根本还没有会话，401 是**凭据不对**（api 对两种情况
 *     返回同一条消息以免枚举用户名）；
 *   - `me`：启动时的一次探测，`AuthProvider` 自己区分「未登录」与「连不上服务器」，
 *     见 `contexts/auth.tsx`；
 *   - `logout`：会话本来就可能是已经没了的那个状态。
 *
 * 不排除它们的话，「密码输错一次」会被当成会话过期：清掉刚填的表单、把人从 `/login`
 * 再跳一次 `/login`，而且 `next` 变成 `/login` 自己——登录成功后原地打转。
 */
const SESSION_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
])

/** 取不到 URL 时按普通接口处理：宁可跳一次登录，也不放过真的会话过期。 */
function isSessionPath(rawUrl: string): boolean {
  try {
    return SESSION_PATHS.has(new URL(rawUrl).pathname)
  } catch {
    return false
  }
}

// 路径段带连字符，只能走下标访问；而 `typeof x['a'].b` 这种混写不合法，
// 所以先把客户端类型取出来再下两层——两行是为了过语法，不是为了绕类型检查。
type MemesClient = typeof api.api.v1.memes

/**
 * `GET /memes` 的响应（SPEC §6.3）。**从 api 派生，不手写。**
 *
 * ⚠️ **形状恒定，不按模式变字段**（§6.3 那张表）：带不带 `q` 都返回
 * `items` / `nextCursor` / `degraded` / `rewritten`，每条 item 都带 `matchedBy`。
 * 无 `q` 时后三个是**常量**（`false` / `null` / `[]`）而不是「字段不存在」，
 * 所以消费点不必按有没有 `q` 分支——拿到的永远是同一组字段。
 */
export type MemesResponse = InferResponseType<typeof api.api.v1.memes.$get>

/**
 * SPEC §5.2.6 对外表示。storageKey、contentHash、phash、embedding 不在响应里。
 *
 * **从 api 派生，不手写。** 手写一份意味着接口加了字段这边不会有编译错误，
 * 而「改字段名 web 编译失败」正是类型同步的全部价值（code-style.md）。
 *
 * 注意一个反直觉的字段，手写很容易写错：
 *   - `sizeBytes` 是**字符串**（bigint 走 JSON 会丢精度，服务端 toString 了）
 *
 * ⚠️ 它**含 `matchedBy`**（列表端点两个分支都带，§6.3）：那是**这一次检索的性质、
 * 不是这张图的属性**，所以 `GET /memes/{id}` 与写操作的响应（`MemeDetail`）没有它。
 * 把写操作的结果并回列表时**保留原有值**，别补 `[]`——见 `use-meme-edit.ts`。
 */
export type Meme = MemesResponse['items'][number]

/**
 * 单条的对外表示（`GET /memes/{id}`）。与列表项**同形**——服务端是同一个 `serializeMeme`——
 * 但仍然单独推导一次：`PATCH /memes/{id}` 的响应就是它（SPEC §6.4.1）。
 */
export type MemeDetail = InferResponseType<MemesClient[':id']['$get']>

/**
 * `PATCH /memes/{id}` 的请求体，**只认描述 + 七个词表维度**（SPEC §6.4.1 / §4.3）。
 *
 * 三种传法含义不同，调用点别混：
 *   - 字段不出现 → 不改这个字段（所以只发改过的那些）
 *   - `description: null` → 清空描述
 *   - `tags: []` → 清空这个维度的标签
 *
 * ⚠️ **这份类型是手写的，因为它推不出来。** `PATCH /memes/{id}` 的 handler 直接
 * `c.req.json()`、没有挂请求体校验器，所以 Hono RPC 给出的输入类型只有
 * `{ param: { id: string } }`——**`json` 那一段根本不存在**。
 *
 * 于是这里有一个真实的缺口：**请求体的形状没有类型同步**。改字段名（比如
 * `emotions` → `emotionsV2`）服务端会拒，但前端编译期不会报错，只会在运行时收到
 * 一个 `VALIDATION_FAILED`。补法是 api 端给这条路由挂一个校验器让 RPC 能推导，
 * 那是 api 的实现约束（见 api/agents/rules/database.md 一类的本端规则），
 * 不是这一端能决定的——已回报总管，见任务 2026-09-19-browse-meme-actions。
 *
 * ⚠️ 这个缺口在 v0.2.0 拆维度那次**真的咬了一口**：某一维漏发，
 * 编译期一声不响，运行时也不报错——服务端只是没收到那个字段，于是按「不改」处理。
 * 所以这七维写成 `Partial<Record<VocabField, string[]>>` 而不是手写字段。
 */
export type MemePatch = { description?: string | null } & Partial<Record<VocabField, string[]>>

export type FetchMemesParams = Partial<Record<VocabField, string[]>> & {
  /**
   * 查询词（SPEC §6.3.1）。**它就是「这次是检索还是浏览」那个开关**：
   * 去掉首尾空白后为空（或根本不传）走浏览分支，否则走三路融合检索。
   *
   * 传空串不报错、按浏览处理（§6.3.1）——用户清空搜索框是常规操作。
   * ⚠️ 与 `random` **互斥**，两个都传服务端返回 `VALIDATION_FAILED`（§6.3.2）。
   */
  q?: string
  isAnimated?: boolean
  favorited?: boolean
  uploader?: string
  tagStatus?: string
  cursor?: string
  limit?: number
  /**
   * 在筛选之后做全库随机抽样（SPEC §6.3.2）。
   *
   * ⚠️ 三件事不在类型里，用的时候要记得：
   *   - 随机序**没有下一页**，这一路返回的 `nextCursor` 恒为 `null`；
   *   - **不要和 `cursor` 一起传**，服务端返回 `VALIDATION_FAILED`；
   *   - 它是**全库**抽样，不是「最新一批里抽几张」——首页靠它把老图翻出来。
   */
  random?: boolean
  /**
   * 只看某个人物的图（SPEC §6.3.2，`proposed`）。**单值**——一张图至多归一个人物，
   * 两个人物取 AND 恒为空，所以服务端对重复参数返回 `VALIDATION_FAILED`。
   *
   * ⚠️ **不存在的 id 返回空列表，不是错误**（§6.3.2）。所以「筛完是空的」有两种成因，
   * 界面不要把它当成出错的信号。
   */
  person?: string
  /**
   * 只看某个系列下所有人物的图（SPEC §6.3.2）。同理单值，与 `person` 同时给时取 AND。
   *
   * ⚠️ **这里只认具体 id。** `none`（不属于任何系列）只在 `GET /persons` 上有
   * （api 的 `readSeriesFilter` 只给那个端点接），传到这里是 `VALIDATION_FAILED` ——
   * 这是 2026-09-30 记在任务 §10.6.1 的缺口，不是实现遗漏。
   */
  series?: string
}

export async function fetchMemes(params: FetchMemesParams = {}): Promise<MemesResponse> {
  const qs = new URLSearchParams()
  // 每个维度各自是**可重复键**（`?emotions=无语&emotions=疲惫`），所有值之间是 AND。
  // 遍历 `VOCAB_FIELDS` 而不是手写七行：漏掉一行不会报错，只是那一维的筛选静默失效。
  for (const field of VOCAB_FIELDS) params[field]?.forEach((v) => qs.append(field, v))
  // 空白查询词**不传**，不是传空串：服务端两种都当浏览处理（§6.3.1），
  // 但传空串会让 `filtersKey`（`use-browse-filters`）在一个没有实际内容的参数上变来变去。
  if (params.q?.trim()) qs.set('q', params.q.trim())
  if (params.isAnimated !== undefined) qs.set('isAnimated', String(params.isAnimated))
  if (params.favorited) qs.set('favorited', 'true')
  if (params.uploader) qs.set('uploader', params.uploader)
  if (params.tagStatus) qs.set('tagStatus', params.tagStatus)
  if (params.cursor) qs.set('cursor', params.cursor)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.random) qs.set('random', 'true')
  // 人物 / 系列筛选（SPEC §6.3.2）。单值、不重复——服务端对重复参数返回
  // `VALIDATION_FAILED`，所以这里用 `set` 而不是 `append`。
  if (params.person) qs.set('person', params.person)
  if (params.series) qs.set('series', params.series)

  const res = await fetch(`/api/v1/memes?${qs.toString()}`)
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<MemesResponse>
}

/**
 * `GET /memes/tag-status` 的汇总（SPEC §6.6.1）。**从 api 派生，不手写。**
 *
 * 两处含义不在类型里，读的时候要记得（web/AGENTS.md §4）：
 *   - `counts` 只统计未软删的记录，口径与 `fetchMemes({ uploader:'me', tagStatus })` 一致；
 *   - `failures` 里会有 `tag_status = ok` 的图（`embed_failed`），
 *     所以 `sum(failures)` 与 `counts.needsManual` **不相等是对的**。
 */
export type TagStatusSummary = InferResponseType<MemesClient['tag-status']['$get']>

/**
 * 打标汇总（SPEC §6.6.1）。
 *
 * `scope` 缺省是 `mine`（只看自己上传的）。`all` 是全站、**仅管理员**，非管理员传它
 * 服务端返回 `FORBIDDEN`——所以只有管理员分段能传。
 *
 * 全库重打标的进度必须看 `all`：那个操作打的就是全库，只看自己那份会永远停在 0。
 */
export async function fetchTagStatus(scope?: 'mine' | 'all'): Promise<TagStatusSummary> {
  const qs = scope === undefined ? '' : `?scope=${scope}`
  const res = await fetch(`/api/v1/memes/tag-status${qs}`)
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<TagStatusSummary>
}

// --- 批量重打标（仅管理员那一段用，权限在服务端） --------------------------

/**
 * `POST /memes/retag` 的请求体（SPEC §6.4.3）。**两个形状恰好给一个。**
 *
 * ⚠️ 这个类型**推不出来，只能手写**：api 侧的请求体是在 handler 里手工校验的
 *    （`routes/memes.ts` 的 `parseRetagBody`），没走 validator，Hono RPC 的
 *    `InferRequestType` 对它只能给出 `unknown`——同 `api-config.ts` 的 `ConfigInput`。
 *    代价是「api 改字段名 → web 编译失败」那层保护在这里没有，改形状时要人工跟着改。
 *
 * ⚠️ 但**响应**类型仍然是推出来的（下面的 `RetagResult`），那条链路没断。
 *
 * `uploader` 的 `'me'` 是个**保留字面量**，其余取值是 uuid；`tagStatus` 取 §5.2.3 的四个值。
 * 这里写成 `string` 不做联合：它们只在 `parseRetagBody` 里校验，写在类型里是假的精确。
 */
export type RetagInput =
  | { memeIds: string[] }
  | { filter: { uploader?: string; tagStatus?: string } }

/**
 * `POST /memes/retag` 的响应（SPEC §6.4.3）。
 *
 * `enqueuedCount` 是**这一次新排上**的条数，`0` 不是错误——连着点两次，第二次就是 0
 * （上一轮还在队列里的行不再计入）。另外两个 `skipped*` 存在的意义是让「一条都没排上」
 * 可解释：否则界面只能说「0 条」，而那有三种完全不同的成因。
 */
export type RetagResult = InferResponseType<MemesClient['retag']['$post']>

/**
 * 触发批量重打标（SPEC §6.4.3）。
 *
 * ⚠️ **与 `startReindex` 最要紧的差别：这个接口不幂等。** 重建索引重复点是安全的
 *    （服务端 `onConflictDoNothing`，连说明都写着「重复触发是安全的」），重打标重复点
 *    是把同一批图再送一遍视觉模型、**再花一遍图片上传者的钱**。所以调用方必须先弹确认框，
 *    跑着的时候还要禁用——那句话在这里**不能复用**。
 */
export async function startRetag(body: RetagInput): Promise<RetagResult> {
  const res = await fetch('/api/v1/memes/retag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<RetagResult>
}

/**
 * 检索通路标识。**只用于展示，不参与排序**——顺序由服务端 RRF 融合决定（SPEC §6.3.1）。
 * 服务端可能新增通路，所以用 Record<string, string> 查表并保留原值兜底，不做穷举联合。
 */
export const MATCHED_BY_LABELS: Record<string, string> = {
  vector: '向量',
  ocr: 'OCR',
  tags: '标签',
}

/**
 * `matchedBy` 的原始取值 → 可显示的标签数组。
 *
 * 未知取值**原样显示**（服务端可能新增通路），所以查表带兜底、不做穷举联合配合。
 * 放在这里而不是各个页面里：卡片角标只有一处消费点（合并后的列表），
 * 各写一份就会在「新通路要不要显示」这种事上漂开。
 */
export function matchedBadges(matchedBy: string[]): string[] {
  return matchedBy.map((m) => MATCHED_BY_LABELS[m] ?? m)
}

/**
 * 收藏/取消收藏。`favorited=true` 发 PUT，`false` 发 DELETE（SPEC §6.4）。
 * 调用前已乐观更新，失败时调用方负责回滚。
 */
export async function toggleFavorite(memeId: string, favorited: boolean): Promise<void> {
  const res = await fetch(`/api/v1/memes/${memeId}/favorite`, {
    method: favorited ? 'PUT' : 'DELETE',
  })
  if (!res.ok && res.status !== 204) throw await toApiError(res)
}

/**
 * `PATCH /memes/{id}` —— 人工改标签与描述（SPEC §6.4.1）。**权限是所有人**：
 * 共享库里谁发现标错了都能顺手改掉（§9.1），前端不要自己加归属判断。
 *
 * 返回**更新后的完整 Meme**，调用点据此就地更新列表，不再拉一次（§6.4.1）。
 * 并发编辑是最后写入者赢，不做冲突检测、不做 ETag——所以前端**不能维护影子副本**
 * （state-navigation.md §2）。
 *
 * 用 fetch 而不是 RPC 客户端方法，和 fetchMemes 同一个理由：
 * RPC 客户端把非 2xx 直接当异常抛，拿不到 SPEC §2.1 的错误信封，
 * 而 `VALIDATION_FAILED`（词表外标签）恰恰是要把 message 展示给用户的。
 */
export async function patchMeme(id: string, patch: MemePatch): Promise<MemeDetail> {
  const res = await fetch(`/api/v1/memes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<MemeDetail>
}

/**
 * `DELETE /memes/{id}` —— 软删，204（SPEC §6.4.2）。上传者或 admin，其余 `FORBIDDEN`。
 *
 * **404 当成功处理。** 这张图本来就要从列表里消失，而 404 同时是「别人已经删了」和
 * 「你删过了」的同一个答案——删除**不幂等**是有意的：删除不做乐观更新
 * （state-navigation.md §8），客户端不会在没看到结果的情况下再发一次。
 *
 * 这个判断放在这里而不是调用点：漏掉它的表现只是一句莫名其妙的错误提示，
 * 每个调用点都得记一次，迟早会忘。
 */
export async function deleteMeme(id: string): Promise<void> {
  const res = await fetch(`/api/v1/memes/${id}`, { method: 'DELETE' })
  if (res.ok || res.status === 404) return
  throw await toApiError(res)
}

export async function fetchHealth() {
  const res = await api.api.v1.health.$get()
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

// stub — replace with InferResponseType<typeof api.auth.me.$get> once api exports the route
export type User = {
  id: string
  role: 'admin' | 'member'
  storageQuotaBytes: number
  storageUsedBytes: number
  createdAt: string
}

export async function fetchMe(): Promise<User> {
  const res = await fetch('/api/v1/auth/me')
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function login(name: string, password: string): Promise<User> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function register(name: string, password: string, inviteCode: string): Promise<User> {
  const res = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password, inviteCode }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<User>
}

export async function postLogout(): Promise<void> {
  const res = await fetch('/api/v1/auth/logout', { method: 'POST' })
  if (!res.ok && res.status !== 204) throw await toApiError(res)
}

export type InviteCode = {
  code: string
  status: 'unused' | 'used' | 'expired'
  createdBy: string
  createdAt?: string
  expiresAt: string | null
  usedBy: string | null
}

export async function fetchInvites(): Promise<InviteCode[]> {
  const res = await fetch('/api/v1/admin/invites')
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { items: InviteCode[] }
  return data.items
}

export async function createInvite(expiresAt?: string): Promise<InviteCode> {
  const res = await fetch('/api/v1/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: expiresAt ?? null }),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json() as Promise<InviteCode>
}

export type AdminUser = {
  id: string
  name: string
  role: 'admin' | 'member'
  storageQuotaBytes: number
  storageUsedBytes: number
  createdAt: string
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await fetch('/api/v1/admin/users')
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { items: { id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: string; storageUsedBytes: string; createdAt: string }[] }
  return data.items.map((u) => ({
    ...u,
    storageQuotaBytes: Number(u.storageQuotaBytes),
    storageUsedBytes: Number(u.storageUsedBytes),
  }))
}

export async function patchAdminUser(
  id: string,
  patch: { role?: 'admin' | 'member'; storageQuotaBytes?: number },
): Promise<{ id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: number; createdAt: string }> {
  const res = await fetch(`/api/v1/admin/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw await toApiError(res)
  const data = (await res.json()) as { id: string; name: string; role: 'admin' | 'member'; storageQuotaBytes: string; createdAt: string }
  return { ...data, storageQuotaBytes: Number(data.storageQuotaBytes) }
}

// --- MCP 个人访问令牌（SPEC §6.8 / §10.3） ---------------------------------

/**
 * 路径段带连字符只能走下标访问（同上面的 `MemesClient`）。类型**从 `AppType` 派生**，
 * 不手写请求 / 响应形状——api 改字段时这边要编译失败，那正是 Hono RPC 的全部价值。
 */
type AccessTokensClient = typeof api.api.v1['access-tokens']

/** `GET /access-tokens` 的列表项。列表**只回 `prefix`**，永远拿不到完整令牌。 */
export type AccessTokenItem = InferResponseType<AccessTokensClient['$get']>['items'][number]

/** `POST /access-tokens` 的响应。**`token` 只在这里出现一次**（SPEC §6.8）。 */
export type CreatedAccessToken = InferResponseType<AccessTokensClient['$post']>

/** 创建请求体（`name` 1–64 字；不传 `expiresInDays` = 永不过期）。 */
export type CreateAccessTokenInput = InferRequestType<AccessTokensClient['$post']>['json']

/**
 * 令牌列表（SPEC §6.8）。只返回未撤销未过期的，`createdAt desc`。
 *
 * 一次拉全量：每人最多 10 个，没有分页参数。**不要**按 `lastUsedAt` / `expiresAt` 在
 * 客户端再排一次——顺序是契约（`createdAt desc`），重排会让「最新建的在哪」漂掉。
 */
export async function fetchAccessTokens(): Promise<AccessTokenItem[]> {
  const res = await api.api.v1['access-tokens'].$get()
  if (!res.ok) throw await toApiError(res)
  const data = await res.json()
  return data.items
}

/**
 * 创建令牌（SPEC §6.8）。
 *
 * ⚠️ 返回的 `token` 是**完整令牌的唯一一次机会**：不写任何持久化（localStorage /
 * sessionStorage / URL 都不行），只允许存活在「令牌已创建」弹窗的 state 里。弹窗一关，
 * 那份 state 必须一起清掉，否则「只显示一次」就是假的。
 */
export async function createAccessToken(input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
  const res = await api.api.v1['access-tokens'].$post({ json: input })
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

/**
 * 撤销令牌（SPEC §6.8）：204，幂等，**立即生效**。
 *
 * `NOT_FOUND` 当成功处理：它意味着这个 id 已经不在有效列表里（别的标签页撤销过、
 * 或本地列表过期了），而调用方要的结果都是「让这一行消失」。把它当成错误弹出来，
 * 用户只会看到一个撤销不了的红条。
 */
export async function revokeAccessToken(id: string): Promise<void> {
  const res = await api.api.v1['access-tokens'][':id'].$delete({ param: { id } })
  if (res.ok) return

  const err = await toApiError(res)
  if (err.code === 'NOT_FOUND') return
  throw err
}

// --- MCP 内容范围设置（SPEC §6.9 / §10.3.1） -------------------------------

type McpSettingsClient = typeof api.api.v1.mcp

/** `{ allowAdult }`，默认 false。类型从 AppType 派生，不手写。 */
export type McpSettingsState = InferResponseType<McpSettingsClient['settings']['$get']>

/** 读 MCP 设置（cookie 会话；MCP 端点本身只读，不能改自己的设置）。 */
export async function fetchMcpSettings(): Promise<McpSettingsState> {
  const res = await api.api.v1.mcp.settings.$get()
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

/** 写 MCP 设置（SPEC §6.9）：只允许改 `allowAdult`，返回落库后的值。 */
export async function updateMcpSettings(allowAdult: boolean): Promise<McpSettingsState> {
  const res = await api.api.v1.mcp.settings.$put({ json: { allowAdult } })
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

// --- MCP 排除过滤器（SPEC §6.9 / §10.3.2） --------------------------------

type McpFilterClient = typeof api.api.v1.mcp.filter

/** 七个维度的排除值；缺省是空数组，`ratings` 恒为空（成人向由内容范围控制）。 */
export type McpFilterValues = InferResponseType<McpFilterClient['$get']>['excluded']

/** 读过滤器（cookie 会话）。 */
export async function fetchMcpFilter(): Promise<McpFilterValues> {
  const res = await api.api.v1.mcp.filter.$get()
  if (!res.ok) throw await toApiError(res)
  return (await res.json()).excluded
}

/** 写过滤器（SPEC §6.9）：整体替换，返回落库后的值。 */
export async function updateMcpFilter(excluded: McpFilterValues): Promise<McpFilterValues> {
  const res = await api.api.v1.mcp.filter.$put({ json: { excluded } })
  if (!res.ok) throw await toApiError(res)
  return (await res.json()).excluded
}
