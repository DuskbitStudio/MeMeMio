import { createHash, randomBytes } from 'node:crypto'

/**
 * 访问令牌的生成 / 哈希 / 前缀（SPEC §10.3、§5.8）。
 *
 * **纯函数，不碰数据库、不认识 HTTP。** 这样令牌格式与哈希口径能被单测钉住——
 * 它们一旦变了，已签发的令牌会**全部失效**，而表现只是「所有客户端突然 401」。
 *
 * 格式：`mcp_` + base64url(32 随机字节)。前缀让 secret scanner 能认出来，
 * 32 字节保证不可猜测。只存 `sha256(token)` 十六进制与 `prefix`，**不存明文、不存密文**：
 * 令牌是强随机值，SHA-256 足够，而且它本来就不需要被读回来。
 */

/** secret scanner 认得出、且与其它凭证不混淆的前缀。 */
export const TOKEN_PREFIX = 'mcp_'

/** 随机部分 32 字节 = 256 位熵。SPEC §10.3 定死。 */
const RANDOM_BYTES = 32

/**
 * 完整令牌的字符数：`mcp_` 4 + base64url(32 字节) 43 = 47。
 *
 * base64 的公式是 `ceil(n / 3) * 4`，32 字节得 44 个字符，base64url 去掉一个 `=` 补位
 * 之后是 43。这里写死数字而不在抽查时现算：令牌形状是契约，改它等于让所有已签发令牌失效。
 */
const TOKEN_LENGTH = TOKEN_PREFIX.length + 43

/**
 * 形状判定。**只回答「像不像」，不查库、不判有效**：形状不对的请求连
 * `findActiveByHash` 都不必走，省一次查询；而形状对但库里没有，那是是否有效的问题。
 *
 * 校验用的正则必须是**整个匹配**（`^...$`）：`mcp_xxx/../` 这种拼接串不能漏进来。
 */
const TOKEN_RE = /^mcp_[A-Za-z0-9_-]{43}$/

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(RANDOM_BYTES).toString('base64url')}`
}

/**
 * 令牌的哈希。库里 `token_hash` 列存的就是它（十六进制小写，64 字符）。
 *
 * **不加密存的是有意的**（SPEC §5.8）：令牌一旦签发就不再需要被读回来，
 * 加密只会多一层密钥管理，而密钥泄漏时密文同样是「可解密的新凭证」。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 展示用的前缀：前 12 个字符（含 `mcp_`）。SPEC §10.3 / §6.8 */
export function prefixOf(token: string): string {
  return token.slice(0, 12)
}

/** 是否为合法形状的令牌（`mcp_` + 43 个 base64url 字符）。 */
export function isTokenShaped(token: string): boolean {
  return token.length === TOKEN_LENGTH && TOKEN_RE.test(token)
}
