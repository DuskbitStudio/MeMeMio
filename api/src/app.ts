import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { AppError } from './lib/app-error.js'
import { onError, onNotFound } from './middleware/error.js'
import { requestId, type RequestIdVariables } from './middleware/request-id.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { adminRoutes } from './routes/admin.js'
import { embedConfigRoutes, imageEmbedConfigRoutes, visionConfigRoutes } from './routes/config.js'
import { memesRoutes } from './routes/memes.js'
import { accessTokenRoutes } from './routes/access-tokens.js'
import { mcpSettingsRoutes } from './routes/mcp-settings.js'
import { personsRoutes } from './routes/persons.js'
import { seriesRoutes } from './routes/series.js'
import { importRoutes } from './routes/imports.js'
import { MAX_FILES_PER_BATCH } from './data/imports.js'

/**
 * Hono 应用本体。静态文件托管在 server.ts 里挂，这样测试不需要先构建 web。
 *
 * ⚠️ 路由必须**链式**注册（.use().route().route()），断开链条 Hono RPC 就推不出类型了，
 *    web 侧会安静地退化成 any。这是那条「改字段名 web 编译失败」保证的前提。
 */

/**
 * 请求体上限，全局。
 *
 * **图片字节永远不经过 api**（浏览器预签名直传 R2，SPEC §6.2.1），所以这里收到的
 * 全是 JSON，最大的合法请求体是导入的清单：`POST /imports` 和
 * `POST /imports/{id}/commit` 各带最多 `MAX_FILES_PER_BATCH`（1000）个条目，
 * 每个条目是文件名（真实文件名 ≤255 字节）+ 暂存键（前缀 + uuid + 文件名 ≈ 300 字节）
 * + JSON 外壳，实测每条约 0.6 KiB。**按每条 1 KiB 算就是 1000 KiB**，取它做上限。
 *
 * ⚠️ **服务端没有对文件名长度单独设限**（`parseUploadBody` 只挡路径分隔符和重名），
 *    所以这个上限是**对「我方客户端会发出什么」的判断，不是从某个字段推导出来的**：
 *    清单超过 1 MiB 时，要么客户端在批量上算错了，要么这是垃圾请求。真要为它找一个
 *    硬依据，那该是给文件名加一个长度上限——那是另一件事，不要拿这个常数代替它。
 *
 * ⚠️ **默认的 onError 会抛 `HTTPException(413)`**，它不是 AppError，落到
 *    `onError` 里会被当成未捕获异常变成 500 —— 错误信封只有一个出口
 *    （agents/rules/error-handling.md §1），所以这里换成 AppError。
 *    码用的是 `VALIDATION_FAILED`（SPEC §2.2/§2.3 里没有「请求体过大」这一条，
 *    不为一次超限去加错误码；`QUOTA_EXCEEDED` 说的是存储配额，不是这个）。
 */
const MAX_BODY_BYTES = MAX_FILES_PER_BATCH * 1024

export const app = new Hono<{ Variables: RequestIdVariables }>()
  .use('*', requestId)
  .use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new AppError('VALIDATION_FAILED', '请求体过大')
      },
    }),
  )
  .route('/api/v1/health', healthRoutes)
  .route('/api/v1/auth', authRoutes)
  .route('/api/v1/admin', adminRoutes)
  // 配置是两个路由组，因为权限不同：视觉是本人，embedding 是管理员（SPEC §6.5）。
  // 权限由中间件表达，一个组只挂一套——理由写在 routes/config.ts 的文件头
  .route('/api/v1/config/vision', visionConfigRoutes)
  .route('/api/v1/config/embed', embedConfigRoutes)
  .route('/api/v1/config/image-embed', imageEmbedConfigRoutes)
  .route('/api/v1/persons', personsRoutes)
  .route('/api/v1/series', seriesRoutes)
  .route('/api/v1/memes', memesRoutes)
  // MCP 的个人访问令牌（SPEC §6.8）。**管理端点走 cookie 会话**，与 `/mcp` 的
  // Bearer 是两种凭证；这里挂进来不会把 MCP SDK 带进 web 的类型图——
  // `/mcp` 子应用在 server.ts 分流，见 agents/rules/mcp.md §1
  .route('/api/v1/access-tokens', accessTokenRoutes)
  // MCP 内容范围设置（SPEC §6.9）。与 `/mcp` 端点无关：这是浏览器 cookie 会话，
  // `/mcp` 仍在 server.ts 分流、只读
  .route('/api/v1/mcp', mcpSettingsRoutes)
  .route('/api/v1/imports', importRoutes)

app.onError(onError)
app.notFound(onNotFound)

/** web 通过它消费接口类型，没有生成步骤（SPEC §0.2）。 */
export type AppType = typeof app
