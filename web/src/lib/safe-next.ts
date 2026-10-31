/**
 * `?next=` 的**唯一出口**：登录成功后的回跳地址只从这里来。
 *
 * 两处调用：`features/auth/LoginForm.tsx`（登录成功后）与 `routes/login.tsx`
 * （已经登录的人再打开登录页）。两处各写一份判据的话，改了一处漏一处，
 * 而这一处的漏洞是**开放重定向**：`/login?next=//evil.com` 会在
 * 「刚输完密码、最不设防」那一刻把人送到外站。
 *
 * ⚠️ **不能直接交给 `navigate()` 了事。** `history.pushState` 对跨源 URL 抛
 * `SecurityError`，而 `@remix-run/router` 的 `push` 只对 `DataCloneError` 往外抛，
 * 其余一律退回 `window.location.assign(url)`（`router.cjs.js` 的 `push`）——
 * 也就是说「看起来是站内跳转」的那一次可能真的离开本站。
 *
 * 判据是**白名单**，不是黑名单：只放行「以单个 `/` 开头的站内路径」。
 *
 * | 输入 | 结果 | 为什么 |
 * |---|---|---|
 * | `/settings#mcp` | 放行 | 正常的站内跳转，这条要保住的是它 |
 * | `//evil.com` | 拒绝 | 协议相对 URL，浏览器当跨源 |
 * | `/\evil.com` | 拒绝 | 浏览器把 `\` 归一成 `/`，与上一条等价 |
 * | `http:` / `javascript:` | 拒绝 | 不以 `/` 开头；`javascript:` 交给 `assign` 会执行 |
 * | `/\t/evil.com` | 拒绝 | **URL 解析会剥掉制表符与换行**，剥完就是 `//evil.com` |
 *
 * 最后一条 2026-10-31 补上（MCP OAuth 任务的开放重定向面）：正则的「第二个字符
 * 不是 `/` 或 `\`」看不见被编码或夹在中间的控制字符，`string.replace(/[\t\n\r]/g, '')`
 * 之后它才现形。控制字符没有任何正当用途，所以直接整项拒绝，不做剥离后再判。
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/'
  if (CONTROL_CHARS.test(raw)) return '/'
  return /^\/(?![/\\])/.test(raw) ? raw : '/'
}
