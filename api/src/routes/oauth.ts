import { Hono } from 'hono'
import { AppError } from '../lib/app-error.js'
import {
  buildRedirectUrl,
  generateAuthorizationCode,
  hashSecret,
  hostOf,
} from '../lib/oauth.js'
import { isUuid } from '../lib/uuid.js'
import {
  AUTHORIZATION_CODE_TTL_MS,
  OAUTH_SCOPE,
  approveAuthorization,
  consumeAuthorizationRequest,
  findAuthorizationRequest,
  findOAuthClient,
  listGrants,
  revokeGrant,
  type GrantListItem,
} from '../data/oauth.js'
import { requireAuth, type AuthVariables } from '../middleware/auth.js'
import { asJsonObject, jsonBody } from '../middleware/json-body.js'
import { toIsoSeconds, toIsoSecondsOrNull } from '../serialize/meme.js'
import type { OriginResolver } from '../oauth/origin.js'

/**
 * `/api/v1/oauth/*` —— OAuth 授权管理的浏览器侧端点（SPEC §6.10、§10.10.4）。
 *
 * **与 `oauth/app.ts` 的分工是凭证，不是主题**：
 *
 * | | 谁调 | 认什么凭证 |
 * |---|---|---|
 * | `oauth/app.ts`（`/oauth/*`、`/.well-known/*`） | MCP 客户端，机器 | 无会话；参数里自带一切 |
 * | 本文件（`/api/v1/oauth/*`） | 浏览器同意页 | **只有 cookie 会话**，不接受任何 Bearer |
 *
 * §6.10 明确要求这四个端点连**自己签发的访问令牌**也不认：令牌泄露不能变成
 * 「替受害者批准一条新授权」的通道。`requireAuth` 只读 cookie，天然的隔离——
 * 不要为了「方便测试」在这里加 Bearer 分支。
 *
 * ⚠️ 路由必须**链式**注册（`.use().get().post().delete()`），断开链条 Hono RPC 就推不出
 *    类型了，`web` 侧会安静地退化成 any（`app.ts` 顶部同一条约定）。
 *    工厂本身也**不写返回类型注解**（`: Hono<{ Variables: AuthVariables }>`）：那会把 Schema
 *    泛型钉成默认的 `BlankSchema`，链式注册推出的路由表一并丢掉——与断开链条是同一个效果。
 *
 * ## 为什么是工厂不是常量
 *
 * `redirectTo` 要带 `iss`（RFC 9207，§10.10.9 第 4 条），而 issuer 来自公开 origin。
 * origin 的解析规则与 `oauth/app.ts` 是同一份（`origin.ts`），所以由 `app.ts` 注入，
 * 本文件不读 env。
 */
export const createOAuthRoutes = (origin: OriginResolver) => {
  /**
   * 同源校验（§10.10.9 第 7 条）：cookie 是跨站请求会自带的凭证，
   * 没有这一步，任意网页都能替用户 POST 一次「允许」。
   *
   * 两条链取「有没有」而不是「都在才算」：
   * - `Origin` 存在就必须**逐字**等于本站 origin。`Origin: null`（沙箱 iframe）不等于
   *   任何值，因此被拒——它正是跨站场景之一。
   * - `Origin` 缺失时看 `Sec-Fetch-Site`：存在就必须是 `same-origin` / `none`。
   *   `none` 是地址栏直达与书签，浏览器用它表示「用户自己发起的导航」。
   *
   * 两者都缺失（curl、集成测试、老浏览器）放行：这条防线防的是「浏览器替第三方发请求」，
   * 而能自己发 HTTP 请求的一方本来就握着 cookie，拦它不增加任何安全，只让脚本化变难。
   */
  const requireSameOrigin = (request: Request, expectedOrigin: string): void => {
    const requestOrigin = request.headers.get('origin')
    if (requestOrigin !== null) {
      if (requestOrigin !== expectedOrigin) {
        throw new AppError('FORBIDDEN', '跨站提交被拒绝')
      }
      return
    }

    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      throw new AppError('FORBIDDEN', '跨站提交被拒绝')
    }
  }

  return new Hono<{ Variables: AuthVariables }>()
    .use('*', requireAuth)

    /**
     * GET /api/v1/oauth/authorize/{ticket} —— 同意页要展示的信息。
     *
     * 不消费 ticket：刷新页面必须还能看。真正消费在 POST。
     * ticket 无效 / 过期 / 已用 / 属于别人 → 同一个 `NOT_FOUND`：区分了就成了一条
     * 探测别人待批授权的通道。
     */
    .get('/authorize/:ticket', async (c) => {
      const user = c.get('currentUser')
      const request = await findAuthorizationRequest(hashSecret(c.req.param('ticket')), user.id)
      if (request === null) throw new AppError('NOT_FOUND', '授权请求不存在或已过期')

      const client = await findOAuthClient(request.clientId)
      if (client === null) throw new AppError('NOT_FOUND', '授权请求不存在或已过期')

      return c.json({
        clientName: client.clientName,
        clientId: client.clientId,
        // 只给主机名（§6.10）：完整 URL 带路径时可能夹带客户端私有的标识，页面也用不上
        redirectHost: hostOf(request.redirectUri),
        scope: request.scope,
        expiresAt: toIsoSeconds(request.expiresAt),
      })
    })

    /**
     * POST /api/v1/oauth/authorize/{ticket} —— 允许或拒绝。
     *
     * 响应里的 `redirectTo` 是**服务端拼好的完整回跳地址**，前端只做 `location.assign`。
     * 让前端拼 `code=` / `state=` 等于把授权码交给一段可能被 XSS 的代码。
     *
     * ## 两种决定的消费顺序不一样，是刻意的
     *
     * - **approve**：先建 grant 与码，再消费 ticket。上限 20 条时 `approveAuthorization`
     *   抛 `VALIDATION_FAILED`，ticket 还活着——用户撤销一条旧授权后重试，不用重走
     *   整条授权流程（客户端那边是一条 302 链，用户回不去）。
     *   反过来若先消费，这个「提示先撤销」的分支就变成了死路。
     * - **deny**：没有要写的东西，直接消费。消费不到就是重放 → `NOT_FOUND`。
     *
     * approve 若在「已建 grant」与「消费 ticket」之间被并发抢先，会把刚建的 grant 撤掉再
     * 报 `NOT_FOUND`：否则一条没人会用的授权就那样留在列表里，还占着 20 条的名额。
     */
    .post('/authorize/:ticket', jsonBody<DecisionBody>(parseDecisionBody), async (c) => {
      const request = c.req.raw
      requireSameOrigin(request, origin(request))

      const user = c.get('currentUser')
      const ticketHash = hashSecret(c.req.param('ticket'))
      const body = c.req.valid('json')

      // 先读一次：批准路径要用到它，而消费发生在那之后（见上面注释）
      const pending = await findAuthorizationRequest(ticketHash, user.id)
      if (pending === null) throw new AppError('NOT_FOUND', '授权请求不存在或已过期')

      const client = await findOAuthClient(pending.clientId)
      if (client === null) throw new AppError('NOT_FOUND', '授权请求不存在或已过期')

      const redirectTo = (params: Record<string, string | null>): string =>
        buildRedirectUrl(pending.redirectUri, { ...params, state: pending.state, iss: origin(request) })

      if (body.decision === 'deny') {
        await consumeAuthorizationRequest(ticketHash, user.id)
        return c.json({
          redirectTo: redirectTo({ error: 'access_denied', error_description: '用户拒绝了授权' }),
        })
      }

      // 码的明文只活在这几行里：写库的是哈希，回跳 URL 里是明文，之后没人能再读出它
      const code = generateAuthorizationCode()
      const approved = await approveAuthorization({
        clientId: pending.clientId,
        userId: user.id,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scope: OAUTH_SCOPE,
        codeHash: hashSecret(code),
        codeExpiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      })

      const consumed = await consumeAuthorizationRequest(ticketHash, user.id)
      if (consumed === null) {
        // 并发的另一次提交先消费了 ticket。刚建的 grant 没人会拿到码，撤掉
        await revokeGrant(approved.grantId, user.id)
        throw new AppError('NOT_FOUND', '授权请求不存在或已过期')
      }

      return c.json({ redirectTo: redirectTo({ code }) })
    })

    /**
     * GET /api/v1/oauth/grants —— 已连接应用。
     *
     * **不带任何令牌列，连前缀都不给**（§6.10）：用户按应用名与回跳主机识别授权，
     * 不按令牌串识别。这一条与 `/api/v1/access-tokens` 不同——那里列表回 `prefix`。
     */
    .get('/grants', async (c) => {
      const rows = await listGrants(c.get('currentUser').id)
      return c.json({ items: rows.map(toGrantItem) })
    })

    /**
     * DELETE /api/v1/oauth/grants/{id} —— `204`，**幂等**。
     *
     * 已撤销的再调仍是 204；不存在 / 不属于本人 → `NOT_FOUND`（同 `/access-tokens`：
     * 区分了就成了一条探测别人 grant id 的通道）。
     * 先判 uuid 形状，否则 `eq(id, 'abc')` 撞 Postgres 22P02 变成 500。
     */
    .delete('/grants/:id', async (c) => {
      const raw = c.req.param('id')
      if (!isUuid(raw)) throw new AppError('NOT_FOUND', '授权不存在')

      await revokeGrant(raw, c.get('currentUser').id)
      return c.body(null, 204)
    })
}

/** POST 的请求体（§6.10）：**恰好**这一个字段。 */
export type DecisionBody = { decision: 'approve' | 'deny' }

export type ConsentInfo = {
  clientName: string
  clientId: string
  redirectHost: string
  scope: string
  expiresAt: string
}

export type GrantItem = {
  id: string
  clientName: string
  clientId: string
  /** 批准时那条回跳的主机名（§6.10），不是 `redirect_uris[0]` 的主机名。 */
  redirectHost: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

export type GrantListResponse = { items: GrantItem[] }

function parseDecisionBody(raw: unknown): DecisionBody {
  const body = asJsonObject(raw)
  for (const key of Object.keys(body)) {
    if (key !== 'decision') {
      throw new AppError('VALIDATION_FAILED', `无法识别的字段：${key}`)
    }
  }
  const decision = body['decision']
  if (decision !== 'approve' && decision !== 'deny') {
    throw new AppError('VALIDATION_FAILED', 'decision 只能是 approve 或 deny')
  }
  return { decision }
}

function toGrantItem(row: GrantListItem): GrantItem {
  return {
    id: row.id,
    clientName: row.clientName,
    clientId: row.clientId,
    redirectHost: hostOf(row.redirectUri),
    createdAt: toIsoSeconds(row.createdAt),
    lastUsedAt: toIsoSecondsOrNull(row.lastUsedAt),
    expiresAt: toIsoSecondsOrNull(row.expiresAt),
  }
}
