/**
 * 公开 origin 的解析（SPEC §10.10.1）。
 *
 * 授权服务器签发的每一个绝对 URL（`issuer`、`resource`、各端点、401 里的
 * `resource_metadata`、同意结束后的回跳）都从它派生。来源只有两个：
 *
 * 1. 配了 `PUBLIC_ORIGIN` 就用它——**生产唯一正确的用法**；
 * 2. 没配则由 `Host` + `X-Forwarded-Proto` 推导——只服务本机开发。
 *
 * 第 2 条允许被**整体替换**（`createOAuthApp({ origin })`），理由有两条：
 * 测试里的 `app.request()` 没有 socket、Host 也是任意值，真实推导在那种环境下
 * 没有意义；而把它做成 env 读取，`oauth/` 子应用就认识 env 了，那正是
 * `mcp/app.ts` 刻意避免的事（依赖注入，单测不连库）。
 *
 * ⚠️ 推导**不信任 `X-Forwarded-Host`**：反代改 `Host` 是显式配置的，而 XFH 可以被
 *    客户端带着进来（取决于反代是否覆写），用它生成 token_endpoint 等于让请求方
 *    决定我们把令牌发到哪。协议头只看 `X-Forwarded-Proto`（它的值只影响 scheme）。
 */

export type OriginResolver = (request: Request) => string

/**
 * 从请求推导 origin。
 *
 * - scheme：`X-Forwarded-Proto`（反代 TLS 终止时）→ 否则按 `url.protocol`。
 *   只认 `http` / `https`，其它值忽略——`javascript:` 之类塞进来只会产生一个坏 URL。
 * - host：`Host` 头。缺失时退回 URL 里的 host（Hono 的 `app.request('/x')` 会给
 *   `localhost`），两者都空才退回 `localhost`。
 * - 结果**不带末尾 `/`**。
 */
export function resolveOriginFromRequest(request: Request): string {
  const url = new URL(request.url)

  const forwardedProto = request.headers.get('x-forwarded-proto')?.trim().toLowerCase()
  const proto = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : url.protocol === 'http:' || url.protocol === 'https:'
      ? url.protocol.slice(0, -1)
      : 'https'

  const host = request.headers.get('host')?.trim() || url.host || 'localhost'
  return `${proto}://${host}`
}

/**
 * 生产用的解析器：配了 `PUBLIC_ORIGIN` 就固定用它，否则按请求推导。
 *
 * 固定值让「反代后推导错」这一类问题消失——那类错的表现是客户端拿到一个连不上的
 * `token_endpoint`，离根因很远（`lib/env.ts` 的校验与 `.env.example` 的注释同此说法）。
 */
export function createOriginResolver(publicOrigin: string | null): OriginResolver {
  if (publicOrigin === null) return resolveOriginFromRequest
  return () => publicOrigin
}
