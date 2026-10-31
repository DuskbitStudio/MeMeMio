import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * OAuth 2.1 授权服务器的**纯函数**：凭证形态、PKCE 校验、注册参数清洗
 * （SPEC §10.10.2 / §10.10.3 / §10.10.9）。
 *
 * 与 `lib/token.ts` 同一条分工：这里不碰数据库、不认识 HTTP，只把「什么算合法」
 * 和「怎么生成」钉死。SQL 在 `data/oauth.ts`，协议流程在 `oauth/`。
 *
 * 四种凭证各用各的前缀，**互不混淆**是安全要求而不是美观要求：
 *
 * | 前缀 | 是什么 | 存法 |
 * |---|---|---|
 * | `mcp_` | 访问令牌（与 PAT 同形，走同一条校验链） | `access_tokens.token_hash` |
 * | `mmc_` | 客户端 id（公开值，不是秘密） | `oauth_clients.client_id` 明文 |
 * | `mmr_` | 刷新令牌 | `oauth_refresh_tokens.token_hash` |
 * | `mco_` | 授权码 | `oauth_authorization_codes.code_hash` |
 *
 * ticket 没有前缀：它只出现在一次 302 的查询串里，不经过任何「看形状猜类型」的分支。
 */

const RANDOM_BYTES = 32

export const CLIENT_ID_PREFIX = 'mmc_'
export const REFRESH_TOKEN_PREFIX = 'mmr_'
export const AUTHORIZATION_CODE_PREFIX = 'mco_'

/** base64url(32 字节) = 43 字符（44 去掉一个 `=` 补位）。 */
export const SECRET_BODY_LENGTH = 43

function randomBody(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url')
}

/** `sha256` 十六进制。**所有秘密列（码、ticket、刷新令牌）在库里都只有它。** */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBody()}`
}

export function generateRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${randomBody()}`
}

export function generateAuthorizationCode(): string {
  return `${AUTHORIZATION_CODE_PREFIX}${randomBody()}`
}

/** ticket：32 字节随机，原始 base64url。放 URL 里，所以**不得**再带 `/` `+` `=`。 */
export function generateTicket(): string {
  return randomBody()
}

const PREFIXED_SHAPE = (prefix: string): RegExp => new RegExp(`^${prefix}[A-Za-z0-9_-]{${SECRET_BODY_LENGTH}}$`)

const CLIENT_ID_RE = PREFIXED_SHAPE(CLIENT_ID_PREFIX)
const REFRESH_TOKEN_RE = PREFIXED_SHAPE(REFRESH_TOKEN_PREFIX)
const AUTHORIZATION_CODE_RE = PREFIXED_SHAPE(AUTHORIZATION_CODE_PREFIX)

export function isClientIdShaped(value: string): boolean {
  return CLIENT_ID_RE.test(value)
}

export function isRefreshTokenShaped(value: string): boolean {
  return REFRESH_TOKEN_RE.test(value)
}

export function isAuthorizationCodeShaped(value: string): boolean {
  return AUTHORIZATION_CODE_RE.test(value)
}

/** 授权码 / 刷新令牌的哈希**不吃形状判断**：形状不对的输入哈希出来查不到，结果一样。 */

// ── PKCE（RFC 7636，只认 S256） ─────────────────────────────────────

/** `code_challenge`：`base64url(sha256(verifier))`，恒为 43 字符。 */
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

/** `code_verifier`：43–128 字符，`[A-Za-z0-9._~-]`（RFC 7636 §4.1）。 */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

export function isCodeChallengeShaped(value: string): boolean {
  return CODE_CHALLENGE_RE.test(value)
}

export function isCodeVerifierShaped(value: string): boolean {
  return CODE_VERIFIER_RE.test(value)
}

/**
 * 校验 `code_verifier` 与存下的 `code_challenge`。
 *
 * 比较用 `timingSafeEqual`：两者都是定长十六进制，长度不等时直接 false——长度本身
 * 不是秘密（challenge 恒 43 字符）。
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!isCodeVerifierShaped(codeVerifier)) return false
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  const a = Buffer.from(computed)
  const b = Buffer.from(codeChallenge)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ── 客户端注册参数（SPEC §10.10.2） ─────────────────────────────────

export const CLIENT_NAME_MAX_LENGTH = 64
export const DEFAULT_CLIENT_NAME = '未命名应用'
export const MIN_REDIRECT_URIS = 1
export const MAX_REDIRECT_URIS = 10
/** 全局客户端数上限（SPEC §10.10.2 允许实现自定，默认 5000）。 */
export const MAX_REGISTERED_CLIENTS = 5000

export type RedirectUriCheck = { ok: true } | { ok: false; reason: string }

/**
 * 单个 `redirect_uri` 的合法性。
 *
 * 规则（SPEC §10.10.2）：必须是 `https://`，或 `http://localhost` / `http://127.0.0.1`
 * （任意端口、允许路径）；**不允许 fragment**。其余整项拒绝，不做「修正后接受」——
 * 授权时要做逐字匹配，现在改一个字，等于让客户端在授权时拿到一个它没注册过的值。
 */
export function checkRedirectUri(raw: string): RedirectUriCheck {
  if (raw === '') return { ok: false, reason: '不能是空字符串' }
  // URL 解析会把 `https://x/#a` 的 hash 单独拿出来，但 spec 禁止的是任何 fragment，
  // 用户信息（`user@`）也一样会改变回跳目标，一并拒绝
  if (raw.includes('#')) return { ok: false, reason: '不能包含 fragment' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '不是合法 URL' }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: '不能包含用户信息' }
  }
  if (url.hostname === '') return { ok: false, reason: '缺少主机名' }

  if (url.protocol === 'https:') return { ok: true }

  // `http://` 只豁免回环地址：浏览器里跑在本机的客户端（桌面/CLI 的本地回调）
  if (url.protocol === 'http:') {
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return { ok: true }
    return { ok: false, reason: 'http:// 只允许 localhost 或 127.0.0.1' }
  }

  return { ok: false, reason: '必须是 https:// 或 http://localhost' }
}

export type RedirectUrisCheck =
  | { ok: true; redirectUris: string[] }
  | { ok: false; reason: string }

/** `redirect_uris` 整组校验：1–10 项、逐项合法。**保留原顺序与原文**（授权时逐字匹配）。 */
export function checkRedirectUris(value: unknown): RedirectUrisCheck {
  if (!Array.isArray(value)) return { ok: false, reason: 'redirect_uris 必须是数组' }
  if (value.length < MIN_REDIRECT_URIS || value.length > MAX_REDIRECT_URIS) {
    return { ok: false, reason: `redirect_uris 必须有 ${MIN_REDIRECT_URIS}–${MAX_REDIRECT_URIS} 项` }
  }

  const uris: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, reason: 'redirect_uris 的每一项必须是字符串' }
    const check = checkRedirectUri(item)
    if (!check.ok) return { ok: false, reason: `redirect_uri "${item}" 不合法：${check.reason}` }
    uris.push(item)
  }
  return { ok: true, redirectUris: uris }
}

/**
 * 应用名清洗：去控制字符、去首尾空白、截断到 64 **码点**，空则用缺省名。
 * 不做信任判断——所有 DCR 客户端在同意页上一律标为未验证。
 */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_CLIENT_NAME
  const cleaned = raw.replace(/\p{Cc}/gu, '').trim()
  if (cleaned === '') return DEFAULT_CLIENT_NAME
  const codePoints = [...cleaned]
  return codePoints.length > CLIENT_NAME_MAX_LENGTH
    ? codePoints.slice(0, CLIENT_NAME_MAX_LENGTH).join('')
    : cleaned
}

/** 只接受 `none`（缺省即 `none`）；返回 null 表示不支持的方法。 */
export function checkTokenEndpointAuthMethod(raw: unknown): 'none' | null {
  if (raw === undefined || raw === null) return 'none'
  return raw === 'none' ? 'none' : null
}

// ── 授权请求参数（SPEC §10.10.3） ───────────────────────────────────

/** v1 唯一的 scope（SPEC §10.10.3）。 */
export const READ_SCOPE = 'mememio:read'

/**
 * scope 校验：缺省即 `mememio:read`；只接受它一个，未知值整体拒绝。
 *
 * 不「过滤掉未知的、保留认识的」：那会让客户端以为拿到了更多权限。
 * 空白分隔的多值里只要有一个不认识就拒。
 */
export function parseScope(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return READ_SCOPE
  const parts = raw.trim().split(/\s+/)
  if (parts.length !== 1 || parts[0] !== READ_SCOPE) return null
  return READ_SCOPE
}

/** `resource` 必须逐字等于 `<origin>/mcp`；缺省按资源标识符处理。 */
export function resolveResource(raw: string | null, origin: string): string | null {
  const expected = resourceIdentifier(origin)
  if (raw === null || raw === '') return expected
  return raw === expected ? expected : null
}

export function resourceIdentifier(origin: string): string {
  return `${origin}/mcp`
}

/**
 * 回跳地址：在客户端注册过的 `redirect_uri` 上追加查询参数。
 *
 * **用 `URL` 而不是字符串拼 `?`/`&`**：注册的地址可能已经带查询串或非空路径，
 * 手拼会产出 `...?a=1?code=...` 这种客户端解析不了的东西。
 * 这个函数只接受已经在注册列表里逐字匹配过的值（调用方保证）。
 */
export function buildRedirectUrl(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/** 同意页只展示回跳主机，不展示完整 URL（SPEC §6.10）。 */
export function hostOf(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    // 走到这里说明库里存了一个注册时已校验过的值——按防御处理，不抛
    return ''
  }
}
