import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import { generateToken, hashToken, prefixOf } from '../lib/token.js'
import { isUuid } from '../lib/uuid.js'
import { createAccessToken, listActiveTokens, revokeAccessToken } from '../data/access-tokens.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { asJsonObject, jsonBody } from '../middleware/json-body.js'
import { toIsoSeconds, toIsoSecondsOrNull } from '../serialize/meme.js'

/**
 * `/api/v1/access-tokens` —— MCP 个人访问令牌的管理端点（SPEC §6.8、§10.3）。
 *
 * **三个端点全部要求 cookie 会话**，不接受 Bearer：令牌是给 MCP 客户端用的，
 * 管理令牌仍然走浏览器。也没有管理员视图——任何人只能看、建、撤销自己的令牌。
 *
 * 完整令牌只在 `POST` 的响应里出现一次（`Cache-Control: no-store`），
 * 列表只回 `prefix`。这是三条硬边界里「API Key 不出响应」的同构要求（§10.3）。
 *
 * ⚠️ 路由必须**链式**注册（`.use().post().get().delete()`），断开链条 Hono RPC 就推不出
 *    类型了，`web` 侧会安静地退化成 any（`app.ts` 顶部同一条约定）。
 */

/** `name` 的字数上限（SPEC §6.8 的 1–64 字）。 */
const NAME_MAX_LENGTH = 64

/** `expiresInDays` 的合法区间（SPEC §6.8）。 */
const EXPIRES_MIN_DAYS = 1
const EXPIRES_MAX_DAYS = 3650

export type CreateAccessTokenBody = {
  name: string
  /** 不传 = 永不过期。 */
  expiresInDays?: number
}

/** 列表项（SPEC §6.8）。**不含 `token` / `tokenHash` / `userId`。** */
export type AccessTokenItem = {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export type AccessTokenListResponse = { items: AccessTokenItem[] }

/** 创建响应（SPEC §6.8）：`token` 只在这里出现一次。 */
export type CreatedAccessToken = {
  id: string
  name: string
  prefix: string
  token: string
  createdAt: string
  expiresAt: string | null
}

/**
 * 请求体校验。字段规则来自 SPEC §6.8：
 * `name` 去首尾空白后 1–64 字（**不要求唯一**——两台设备同名是正常的）；
 * `expiresInDays` 可选正整数 1–3650，不传 = 永不过期。
 *
 * 长度按**码点**算（`[...name].length`），与 `lib/naming.ts` 同口径：一个 emoji 在 JS 里
 * 是两个 UTF-16 单元，按码点算才和输入框里数出来的字一致。
 */
function parseCreateBody(raw: unknown): CreateAccessTokenBody {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'expiresInDays') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }

  if (typeof body['name'] !== 'string') {
    throw new AppError('VALIDATION_FAILED', 'name 必须是字符串')
  }
  const name = body['name'].trim()
  if (name === '') throw new AppError('VALIDATION_FAILED', 'name 不能为空')
  if ([...name].length > NAME_MAX_LENGTH) {
    throw new AppError('VALIDATION_FAILED', `name 最多 ${NAME_MAX_LENGTH} 个字`)
  }

  const rawDays = body['expiresInDays']
  if (rawDays === undefined) return { name }

  if (
    typeof rawDays !== 'number'
    || !Number.isInteger(rawDays)
    || rawDays < EXPIRES_MIN_DAYS
    || rawDays > EXPIRES_MAX_DAYS
  ) {
    throw new AppError(
      'VALIDATION_FAILED',
      `expiresInDays 必须是 ${EXPIRES_MIN_DAYS}–${EXPIRES_MAX_DAYS} 的整数`,
    )
  }

  return { name, expiresInDays: rawDays }
}

function toItem(row: {
  id: string
  name: string
  prefix: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}): AccessTokenItem {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: toIsoSeconds(row.createdAt),
    lastUsedAt: toIsoSecondsOrNull(row.lastUsedAt),
    expiresAt: toIsoSecondsOrNull(row.expiresAt),
  }
}

export const accessTokenRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireAuth)

  /**
   * POST /api/v1/access-tokens —— 创建。响应 `201` + `Cache-Control: no-store`。
   *
   * 上限 10 个**有效**令牌的判定与插入在数据层同一个事务里（`createAccessToken`），
   * 不在这里先数一遍——并发下那会多放进来一个。
   */
  .post('/', jsonBody<CreateAccessTokenBody>(parseCreateBody), async (c) => {
    const user = c.get('currentUser')
    const body = c.req.valid('json')

    // 完整令牌只在这里生成一次，之后库里只有哈希与前缀
    const token = generateToken()
    const expiresAt = body.expiresInDays === undefined
      ? null
      : new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)

    const row = await createAccessToken({
      userId: user.id,
      name: body.name,
      prefix: prefixOf(token),
      tokenHash: hashToken(token),
      expiresAt,
    })

    // 完整令牌只在这一次响应里出现。no-store 是契约的一部分（SPEC §6.8）
    c.header('Cache-Control', 'no-store')
    const created: CreatedAccessToken = {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      token,
      createdAt: toIsoSeconds(row.createdAt),
      expiresAt: toIsoSecondsOrNull(row.expiresAt),
    }
    return c.json(created, 201)
  })

  /** GET /api/v1/access-tokens —— 只返回未撤销且未过期的，`createdAt desc`。 */
  .get('/', async (c) => {
    const rows = await listActiveTokens(c.get('currentUser').id)
    const response: AccessTokenListResponse = { items: rows.map(toItem) }
    return c.json(response)
  })

  /**
   * DELETE /api/v1/access-tokens/{id} —— `204`，**幂等**（已撤销的再调仍是 204）。
   *
   * 不存在 / 不属于本人一律 `NOT_FOUND`，不区分——区分了就是一条探测别人令牌 id 的通道。
   * 路径参数先判 uuid 形状：不判的话 `eq(id, 'abc')` 会撞 Postgres 的 22P02，
   * 表现成 500 而不是 404（与 `routes/persons.ts` 的 `requirePersonId` 同一条理由）。
   */
  .delete('/:id', async (c) => {
    const raw = c.req.param('id')
    if (!isUuid(raw)) throw new AppError('NOT_FOUND', '令牌不存在')

    await revokeAccessToken(raw, c.get('currentUser').id)
    return c.body(null, 204)
  })
