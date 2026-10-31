import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_TTL_MS,
  createAuthorizationRequest,
  createOAuthClient,
  findAuthorizationCode,
  findGrant,
  findOAuthClient,
  findRefreshToken,
  issueRefreshedAccessToken,
  issueTokens,
  markAuthorizationCodeUsed,
  revokeGrant,
  revokeToken,
  rotateRefreshToken,
} from '../data/oauth.js'
import type { Db } from '../data/db.js'
import { isAppError } from '../lib/app-error.js'
import {
  MAX_REGISTERED_CLIENTS,
  buildRedirectUrl,
  checkRedirectUris,
  checkTokenEndpointAuthMethod,
  generateClientId,
  generateRefreshToken,
  generateTicket,
  hashSecret,
  isCodeChallengeShaped,
  parseScope,
  resolveResource,
  resourceIdentifier,
  sanitizeClientName,
  verifyPkce,
} from '../lib/oauth.js'
import { generateToken, hashToken, prefixOf } from '../lib/token.js'
import { log } from '../logger.js'
import { rateLimit } from '../middleware/rate-limit.js'
import { requestId, type RequestIdVariables } from '../middleware/request-id.js'
import type { OriginResolver } from './origin.js'

/**
 * OAuth 2.1 授权服务器（SPEC §10.10）。**协议端点**都挂在这里：
 *
 * | 方法 | 路径 | 规范 |
 * |---|---|---|
 * | GET | `/.well-known/oauth-protected-resource` | RFC 9728 根形式 |
 * | GET | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 按路径插入形式 |
 * | GET | `/.well-known/oauth-authorization-server` | RFC 8414 |
 * | POST | `/oauth/register` | RFC 7591（DCR，公户端） |
 * | GET | `/oauth/authorize` | RFC 6749 + PKCE + RFC 8707 |
 * | POST | `/oauth/token` | RFC 6749 §4.1.3 / §6 |
 * | POST | `/oauth/revoke` | RFC 7009 |
 *
 * 浏览器侧的四个 cookie 端点（同意/管理）**不在这里**——它们在
 * `routes/oauth.ts`，走 `/api/v1` 与项目错误信封。这里只产出协议规定的形状：
 *
 * - 失败一律是 **RFC 6749 §5.2 的 `{ error, error_description }`**，不是 SPEC §2 的信封
 *   （§10.10.5 明写「不返回项目错误信封」）。
 * - 响应**不带** `requestId` 字段（协议端点的 body 只放协议参数），排障靠响应头
 *   `X-Request-Id`。
 * - 这里**不 import `env.ts`**：origin 由 `deps.origin` 注入，与 `mcp/app.ts` 同一条
 *   依赖注入纪律。`oauth/production.ts` 负责把 `PUBLIC_ORIGIN` 接进来。
 *
 * ## 挂在哪里
 *
 * `src/server.ts` 按路径**先于 `mountWebDist`** 分流过来（任务文件里的坑 1）：
 * SPA 回退只跳过 `/api/`，`/.well-known/*` 与 `/oauth/*` 走不到它就会拿到 `index.html`，
 * 表现成「注册返回 200 但 JSON 解析失败」。`/oauth/consent` 不在这里——那是 web 的 SPA 路由。
 */

/** 注册限流（SPEC §10.10.2）：10 次/小时/IP、50 次/天/IP。 */
const REGISTER_PER_HOUR = 10
const REGISTER_PER_DAY = 50

/** 令牌端点限流（SPEC §10.10.5）：30 次/分钟/IP。 */
const TOKEN_PER_MINUTE = 30

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * 请求体上限。DCR 的 body 是几百字节，令牌端点是表单。
 * 这里不挂 `app.ts` 的全局上限（那是给导入清单算的 1 MiB），单独取一个小值。
 */
const MAX_BODY_BYTES = 64 * 1024

export type OAuthRateLimits = {
  registerPerHour: number
  registerPerDay: number
  tokenPerMinute: number
}

/**
 * 可注入的依赖。
 *
 * `db` 用接口类型而不是 `data/db.ts` 的默认实例：unit 测试可以传测试库句柄，
 * 生产组装在 `oauth/production.ts`。
 */
export type OAuthAppDeps = {
  db: Db
  /** 公开 origin（SPEC §10.10.1）。本文件里每一个绝对 URL 都由它派生。 */
  origin: OriginResolver
  /**
   * 读 cookie 会话，返回用户 id；未登录返回 null。
   *
   * **只有 `/oauth/authorize` 用它**，而且只用来决定「发 ticket 还是去登录」——
   * 这里不做任何权限判断。它是 `middleware/auth.ts` 的 `resolveSessionUser`，
   * 不是 `optionalAuth`（那个被刻意删掉过，见该文件）。
   */
  sessionUserId(request: Request): Promise<string | null>
  /** 全站客户端数上限（SPEC §10.10.2 允许实现自定，默认 5000）。 */
  maxClients?: number
  /** 仅供测试：把阈值调小来验 429。生产不要传。 */
  limits?: Partial<OAuthRateLimits>
}

type OAuthContext = Context<{ Variables: RequestIdVariables }>

/** RFC 6749 §5.2 的错误体。`error` 用 RFC 定义的短码，`error_description` 给人看。 */
type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  // 只在授权端点的 302 上出现（RFC 6749 §4.1.2.1），令牌端点不会回它
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'invalid_client_metadata'
  | 'temporarily_unavailable'
  | 'server_error'

function oauthError(
  c: OAuthContext,
  status: 400 | 413 | 429 | 500,
  error: OAuthErrorCode,
  description: string,
): Response {
  c.header('Cache-Control', 'no-store')
  return c.json({ error, error_description: description }, status)
}

/**
 * 302 回客户端的错误（RFC 6749 §4.1.2.1）。`state` 原样回传，`iss` 按 RFC 9207 带上。
 *
 * 只允许用在 `redirect_uri` 已与注册列表逐字匹配之后——调用方保证。
 */
function redirectError(
  c: OAuthContext,
  redirectUri: string,
  error: OAuthErrorCode,
  description: string,
  state: string | null,
  issuer: string,
): Response {
  const target = buildRedirectUrl(redirectUri, {
    error,
    error_description: description,
    state,
    iss: issuer,
  })
  c.header('Cache-Control', 'no-store')
  return c.redirect(target, 302)
}

/** 发现文档：允许跨域读（SPEC §10.10.7 的唯一 CORS 例外），缓存 5 分钟。 */
function discovery(c: OAuthContext, body: Record<string, unknown>): Response {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cache-Control', 'max-age=300')
  return c.json(body)
}

/** 表单体。Content-Type 不对返回 null —— RFC 6749 §4.1.3 要求 form-urlencoded。 */
async function readForm(c: OAuthContext): Promise<URLSearchParams | null> {
  const type = (c.req.header('content-type') ?? '').toLowerCase()
  if (!type.startsWith('application/x-www-form-urlencoded')) return null
  return new URLSearchParams(await c.req.text())
}

/**
 * 构造授权服务器子应用。路径用完整形式（`/oauth/token` 而不是相对挂载）：
 * `server.ts` 是按 pathname 直接 `fetch` 过来的，没有 `basePath`。
 */
export function createOAuthApp(deps: OAuthAppDeps): Hono<{ Variables: RequestIdVariables }> {
  const maxClients = deps.maxClients ?? MAX_REGISTERED_CLIENTS
  const limits: OAuthRateLimits = {
    registerPerHour: deps.limits?.registerPerHour ?? REGISTER_PER_HOUR,
    registerPerDay: deps.limits?.registerPerDay ?? REGISTER_PER_DAY,
    tokenPerMinute: deps.limits?.tokenPerMinute ?? TOKEN_PER_MINUTE,
  }

  const originOf = (c: OAuthContext): string => deps.origin(c.req.raw)

  // ── 发现文档 ────────────────────────────────────────────────────

  function resourceMetadata(c: OAuthContext): Response {
    const origin = originOf(c)
    return discovery(c, {
      resource: resourceIdentifier(origin),
      authorization_servers: [origin],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Mememio',
    })
  }

  function authorizationServerMetadata(c: OAuthContext): Response {
    const origin = originOf(c)
    return discovery(c, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // ⚠️ 缺了它，合规客户端会**直接拒绝发起授权**（SPEC §10.10.7 点名）
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
    })
  }

  // ── 端点实现 ────────────────────────────────────────────────────

  /**
   * DCR（RFC 7591 / SPEC §10.10.2）。**只发 `client_id`，永远没有 `client_secret`。**
   *
   * 未知字段忽略（RFC 7591 对客户端的宽容要求）；`grant_types` / `response_types`
   * 按 RFC 7591 §3.2.1 用服务端实际支持的值回显，不照抄客户端发来的值。
   */
  async function register(c: OAuthContext): Promise<Response> {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return oauthError(c, 400, 'invalid_client_metadata', '请求体必须是 JSON')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return oauthError(c, 400, 'invalid_client_metadata', '请求体必须是 JSON 对象')
    }
    const body = raw as Record<string, unknown>

    if (checkTokenEndpointAuthMethod(body['token_endpoint_auth_method']) === null) {
      return oauthError(
        c,
        400,
        'invalid_client_metadata',
        '只支持 token_endpoint_auth_method = "none"（公户端，不下发 client_secret）',
      )
    }

    const redirects = checkRedirectUris(body['redirect_uris'])
    if (!redirects.ok) {
      return oauthError(c, 400, 'invalid_client_metadata', redirects.reason)
    }

    const row = await createOAuthClient(
      {
        clientId: generateClientId(),
        clientName: sanitizeClientName(body['client_name']),
        redirectUris: redirects.redirectUris,
      },
      maxClients,
      deps.db,
    )

    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        client_id: row.clientId,
        client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
        client_name: row.clientName,
        redirect_uris: row.redirectUris,
        token_endpoint_auth_method: 'none' as const,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    )
  }

  /**
   * 授权请求（RFC 6749 §4.1.1 / SPEC §10.10.3）。
   *
   * **两种错误出口不能混**：
   * - `client_id` / `redirect_uri` 不合法 → `400` JSON，**绝不重定向**（防开放重定向：
   *   未注册的值一旦进了 `Location`，这个端点就成了任意跳转器）。
   * - 两者都合法之后 → `302` 回 `redirect_uri`，带 `error` / `state` / `iss`。
   */
  async function authorize(c: OAuthContext): Promise<Response> {
    const origin = originOf(c)
    const params = new URL(c.req.url).searchParams
    const state = params.get('state')

    const clientId = params.get('client_id')
    if (clientId === null || clientId === '') {
      return oauthError(c, 400, 'invalid_request', '缺少 client_id')
    }
    const client = await findOAuthClient(clientId, deps.db)
    if (client === null) {
      return oauthError(c, 400, 'invalid_request', 'client_id 未注册')
    }

    // 逐字匹配：不补末尾斜杠、不做前缀匹配（SPEC §10.10.3）
    const redirectUri = params.get('redirect_uri')
    if (redirectUri === null || !client.redirectUris.includes(redirectUri)) {
      return oauthError(c, 400, 'invalid_request', 'redirect_uri 与注册值不一致')
    }

    // 以下错误已经能安全地重定向回客户端
    if (params.get('response_type') !== 'code') {
      return redirectError(c, redirectUri, 'unsupported_response_type', '只支持 response_type=code', state, origin)
    }

    const codeChallenge = params.get('code_challenge')
    if (codeChallenge === null || !isCodeChallengeShaped(codeChallenge)) {
      return redirectError(c, redirectUri, 'invalid_request', 'code_challenge 缺失或不是 43 字符 base64url', state, origin)
    }
    // 缺省也拒绝：RFC 7636 允许缺省为 plain，但 plain 在本服务不安全，且 SPEC 只认 S256
    if (params.get('code_challenge_method') !== 'S256') {
      return redirectError(c, redirectUri, 'invalid_request', 'code_challenge_method 只接受 S256', state, origin)
    }

    const scope = parseScope(params.get('scope'))
    if (scope === null) {
      return redirectError(c, redirectUri, 'invalid_scope', `只支持 scope=${OAUTH_SCOPE}`, state, origin)
    }

    const resource = resolveResource(params.get('resource'), origin)
    if (resource === null) {
      return redirectError(c, redirectUri, 'invalid_target', `resource 必须是 ${resourceIdentifier(origin)}`, state, origin)
    }

    // OIDC 不在范围（§10.9）：不接受 nonce，也就不假装理解它
    if (params.has('nonce')) {
      return redirectError(c, redirectUri, 'invalid_request', '不接受 nonce（不支持 OIDC）', state, origin)
    }

    const userId = await deps.sessionUserId(c.req.raw)
    if (userId === null) {
      /*
       * ⚠️ 已知的契约张力（已上报总管，等 SPEC 对齐，**不要**在本文件里自创「无主 ticket」）：
       *
       *   SPEC §10.10.3 写的是 `302 到 /login?next=/oauth/consent?ticket=...`，但
       *   SPEC §5.10 要求 `oauth_authorization_requests.user_id` 非空——未登录时没有
       *   `user_id`，也就不存在 ticket 行；而且 §6.10 的「换一个账号打开同一条链接 →
       *   NOT_FOUND」正是靠这个绑定。
       *
       * 这里发 `next=/oauth/authorize?<原查询串>`：登录后回到本端点，由那一刻的会话
       * 签发 ticket——仍然绑定 `user_id`、单次使用、10 分钟。安全性质一条不少，
       * 只有 `next` 的字面值不同。
       */
      const login = new URL('/login', origin)
      login.searchParams.set('next', `/oauth/authorize?${params.toString()}`)
      c.header('Cache-Control', 'no-store')
      return c.redirect(login.toString(), 302)
    }

    const ticket = generateTicket()
    await createAuthorizationRequest(
      {
        ticketHash: hashSecret(ticket),
        clientId: client.clientId,
        userId,
        redirectUri,
        codeChallenge,
        resource,
        scope,
        state,
        expiresAt: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
      },
      deps.db,
    )

    // 302 到 SPA 的同意页（§10.10.3）：api 不渲染任何 HTML
    const consent = new URL('/oauth/consent', origin)
    consent.searchParams.set('ticket', ticket)
    c.header('Cache-Control', 'no-store')
    return c.redirect(consent.toString(), 302)
  }

  /** 令牌端点（RFC 6749 §4.1.3 / §6 / SPEC §10.10.5）。只认公户端。 */
  async function token(c: OAuthContext): Promise<Response> {
    const form = await readForm(c)
    if (form === null) {
      return oauthError(c, 400, 'invalid_request', '请求体必须是 application/x-www-form-urlencoded')
    }

    const clientId = form.get('client_id')
    if (clientId === null || clientId === '') {
      return oauthError(c, 400, 'invalid_request', '缺少 client_id')
    }
    const client = await findOAuthClient(clientId, deps.db)
    if (client === null) {
      return oauthError(c, 400, 'invalid_client', 'client_id 未注册')
    }

    switch (form.get('grant_type')) {
      case 'authorization_code':
        return exchangeCode(c, client.clientName, form)
      case 'refresh_token':
        return refresh(c, client, form)
      default:
        return oauthError(c, 400, 'unsupported_grant_type', '只支持 authorization_code / refresh_token')
    }
  }

  /** 授权码换令牌。顺序有讲究：**PKCE 校验在标记已用之前**，verifier 错了不烧码。 */
  async function exchangeCode(
    c: OAuthContext,
    clientName: string,
    form: URLSearchParams,
  ): Promise<Response> {
    const code = form.get('code')
    const redirectUri = form.get('redirect_uri')
    const verifier = form.get('code_verifier')
    if (code === null || code === '' || redirectUri === null || verifier === null) {
      return oauthError(c, 400, 'invalid_request', '缺少 code / redirect_uri / code_verifier')
    }

    const row = await findAuthorizationCode(hashSecret(code), deps.db)
    if (row === null) return oauthError(c, 400, 'invalid_grant', '授权码无效或已过期')

    // 重放：码已经兑换过 → 拒绝，并**撤销整条 grant**（怀疑泄漏，§10.10.4）
    if (row.usedAt !== null) {
      await revokeGrant(row.grantId, row.userId, deps.db)
      return oauthError(c, 400, 'invalid_grant', '授权码已被使用')
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return oauthError(c, 400, 'invalid_grant', '授权码已过期')
    }
    if (row.clientId !== form.get('client_id')) {
      return oauthError(c, 400, 'invalid_grant', '授权码不属于该客户端')
    }
    if (row.redirectUri !== redirectUri) {
      return oauthError(c, 400, 'invalid_grant', 'redirect_uri 与发码时不一致')
    }

    const resource = form.get('resource')
    if (resource !== null && resource !== '' && resource !== row.resource) {
      return oauthError(c, 400, 'invalid_grant', 'resource 与发码时不一致')
    }

    if (!verifyPkce(verifier, row.codeChallenge)) {
      return oauthError(c, 400, 'invalid_grant', 'code_verifier 不匹配')
    }

    // 并发兑换只有一个请求能改到行；没抢到的那一个按重放处理
    if (!(await markAuthorizationCodeUsed(row.codeHash, deps.db))) {
      await revokeGrant(row.grantId, row.userId, deps.db)
      return oauthError(c, 400, 'invalid_grant', '授权码已被使用')
    }

    const accessToken = generateToken()
    const refreshToken = generateRefreshToken()
    const now = Date.now()

    const issued = await issueTokens(
      {
        userId: row.userId,
        name: clientName,
        prefix: prefixOf(accessToken),
        tokenHash: hashToken(accessToken),
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
        grantId: row.grantId,
        refreshTokenHash: hashSecret(refreshToken),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
      deps.db,
    )
    // 兑换过程中 grant 被撤销（并发）：不签发新的令牌
    if (!issued) return oauthError(c, 400, 'invalid_grant', '授权已被撤销')

    return tokenResponse(c, accessToken, refreshToken)
  }

  /** 刷新：30 天滑动 + 每次旋转；旧令牌复用即撤销整条 grant（§10.10.5）。 */
  async function refresh(
    c: OAuthContext,
    client: { clientId: string; clientName: string },
    form: URLSearchParams,
  ): Promise<Response> {
    const raw = form.get('refresh_token')
    if (raw === null || raw === '') {
      return oauthError(c, 400, 'invalid_request', '缺少 refresh_token')
    }

    const row = await findRefreshToken(hashSecret(raw), deps.db)
    if (row === null) return oauthError(c, 400, 'invalid_grant', '刷新令牌无效')

    // 归属先于旋转：拿别人的 client_id 来刷，不该触发（也不该掩盖）复用检测
    const grant = await findGrant(row.grantId, deps.db)
    if (grant === null || grant.clientId !== client.clientId) {
      return oauthError(c, 400, 'invalid_grant', '刷新令牌不属于该客户端')
    }

    const newRefresh = generateRefreshToken()
    const now = Date.now()
    const rotated = await rotateRefreshToken(
      {
        oldHash: row.tokenHash,
        newHash: hashSecret(newRefresh),
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
      deps.db,
    )
    if (rotated.status === 'reused') {
      return oauthError(c, 400, 'invalid_grant', '刷新令牌已被使用，授权已撤销')
    }
    if (rotated.status === 'invalid') {
      return oauthError(c, 400, 'invalid_grant', '刷新令牌无效或已过期')
    }

    const accessToken = generateToken()
    const issued = await issueRefreshedAccessToken(
      {
        userId: grant.userId,
        name: client.clientName,
        prefix: prefixOf(accessToken),
        tokenHash: hashToken(accessToken),
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
        grantId: rotated.grantId,
      },
      deps.db,
    )
    if (!issued) return oauthError(c, 400, 'invalid_grant', '授权已被撤销')

    return tokenResponse(c, accessToken, newRefresh)
  }

  /**
   * 撤销（RFC 7009 / SPEC §10.10.6）。**未知令牌一律 200**（防探测）。
   *
   * `token_type_hint` 只是提示，这里忽略：两种令牌的前缀与哈希域不同，
   * 同一个字符串最多命中一处，按哪个桶先找没有区别。
   */
  async function revoke(c: OAuthContext): Promise<Response> {
    const form = await readForm(c)
    if (form === null) {
      return oauthError(c, 400, 'invalid_request', '请求体必须是 application/x-www-form-urlencoded')
    }
    const token = form.get('token')
    if (token === null || token === '') {
      return oauthError(c, 400, 'invalid_request', '缺少 token')
    }

    const hash = hashSecret(token)
    const clientId = form.get('client_id')
    await revokeToken(
      { accessTokenHash: hash, refreshTokenHash: hash, clientId: clientId === '' ? null : clientId },
      deps.db,
    )

    c.header('Cache-Control', 'no-store')
    return c.body(null, 200)
  }

  /** 令牌响应：`no-store` + `Pragma: no-cache` 是契约的一部分（§10.10.5）。 */
  function tokenResponse(c: OAuthContext, accessToken: string, refreshToken: string): Response {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: OAUTH_SCOPE,
      refresh_token: refreshToken,
    })
  }

  const app = new Hono<{ Variables: RequestIdVariables }>()
    .use('*', requestId)
    .use(
      '*',
      bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => oauthError(c, 413, 'invalid_request', '请求体过大'),
      }),
    )
    .get('/.well-known/oauth-protected-resource', (c) => resourceMetadata(c))
    .get('/.well-known/oauth-protected-resource/mcp', (c) => resourceMetadata(c))
    .get('/.well-known/oauth-authorization-server', (c) => authorizationServerMetadata(c))
    .post(
      '/oauth/register',
      rateLimit({ name: 'oauth-register-hour', limit: limits.registerPerHour, windowMs: HOUR_MS }),
      rateLimit({ name: 'oauth-register-day', limit: limits.registerPerDay, windowMs: DAY_MS }),
      (c) => register(c),
    )
    .get('/oauth/authorize', (c) => authorize(c))
    .post(
      '/oauth/token',
      rateLimit({ name: 'oauth-token', limit: limits.tokenPerMinute, windowMs: 60_000 }),
      (c) => token(c),
    )
    .post('/oauth/revoke', (c) => revoke(c))

  /**
   * 协议端点不套 `/api/v1` 的错误信封。`AppError` 只会在限流或数据层不变量上出现：
   * - `RATE_LIMITED` → 429 + `Retry-After`（RFC 6749 的 `temporarily_unavailable`）
   * - `INTERNAL` → 500 `server_error`
   * - 其余 → 400 `invalid_request`（它们都是「这次请求不合法」）
   */
  app.onError((err, c) => {
    const requestId = c.get('requestId')

    if (isAppError(err)) {
      if (err.code === 'RATE_LIMITED') {
        for (const [name, value] of Object.entries(err.headers ?? {})) c.header(name, value)
        log.warn({ requestId, path: c.req.path, code: err.code }, err.message)
        return oauthError(c, 429, 'temporarily_unavailable', err.message)
      }
      if (err.code === 'INTERNAL') {
        log.error({ requestId, err, path: c.req.path }, 'oauth: internal error')
        return oauthError(c, 500, 'server_error', '服务器内部错误')
      }
      log.warn({ requestId, path: c.req.path, code: err.code }, err.message)
      return oauthError(c, 400, 'invalid_request', err.message)
    }

    // 原始 message 只进日志：数据库与 SDK 的报错里可能带连接串
    log.error({ requestId, err, path: c.req.path }, 'oauth: unhandled error')
    return oauthError(c, 500, 'server_error', '服务器内部错误')
  })

  /**
   * 未知的 `/.well-known/*` 回 404 JSON，**不回 SPA 的 index.html**（任务文件坑 1）。
   *
   * 不用项目信封：这里没有 `/api/v1` 的请求作用域，协议端点也不产出它；
   * 给一个最小 JSON 让客户端的解析失败变成「404」而不是「200 但内容是 HTML」。
   */
  app.notFound((c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ error: 'not_found', error_description: '没有这个接口' }, 404)
  })

  return app
}

/** 授权码有效期（供 `routes/oauth.ts` 与测试共用，避免两处各写一个数）。 */
export const CODE_TTL_MS = AUTHORIZATION_CODE_TTL_MS
