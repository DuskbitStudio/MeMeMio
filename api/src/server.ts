import { serve, type ServerType } from '@hono/node-server'
import { app } from './app.js'
import { db, waitForDatabase } from './data/db.js'
import { checkMigrations } from './data/migration-state.js'
import { env } from './env.js'
import { log } from './logger.js'
import { mcpApp } from './mcp/production.js'
import { assertRuntimeFilesPresent, WEB_DIST_DIR } from './paths.js'
import { startCleanupJob, stopCleanupJob } from './queue/cleanup.js'
import { startPersonVectorWorker, stopPersonVectorWorker } from './queue/person-vector-worker.js'
import { startReindexWorker, stopReindexWorker } from './queue/reindex-worker.js'
import { startTagWorker, stopTagWorker } from './queue/worker.js'
import { installProcessErrorHandlers, installShutdownHandlers } from './shutdown.js'
import { resumeInterruptedBatches } from './services/import.js'
import { assertR2Reachable } from './storage/r2.js'
import { vocabulary, vocabularySize } from './vocab.js'
import { mountWebDist } from './web-dist.js'

/**
 * 启动顺序（agents/rules/env-validation.md §3）：
 *
 *   1. 校验 env       → 失败则 exit(1)      ← import './env.js' 时就做完了
 *   2. 探活 R2        → 失败则 exit(1)
 *   3. 连数据库       → 失败则重试几次后 exit(1)
 *   4. 检查迁移版本   → 落后则打印提示并 exit(1)
 *   5. 起 HTTP，再起打标 worker
 *
 * 第 2 步在连库之前：它和第 1 步是同一件事的两半——「变量填了」和「填的能用」。
 * 校验能不能用必须放在启动，因为 R2 配错**在运行期完全不报错**（预签名是纯本地
 * 计算，假凭证照样签得出 200），理由写在 storage/r2.ts 的 `assertR2Reachable`。
 *
 * 第 4 步**只检查，不自动执行**。多副本时自动迁移会并发跑，而那种故障发生在
 * 启动瞬间，最难排查。执行走独立命令，见 docs/deployment.md §6。
 */
async function main(): Promise<void> {
  // 第一件事：把 unhandledRejection 兜住。再往后全是 async，越早挂上越少盲区
  installProcessErrorHandlers()

  assertRuntimeFilesPresent()

  log.info(
    { vocabVersion: vocabulary.version, vocabStatus: vocabulary.status, ...vocabularySize },
    '词表已加载',
  )

  // 没配默认模型不是错误，是产品要求的降级态。但必须说出来，否则「搜索为什么这么差」
  // 会变成一个查起来很贵的问题。见 agents/rules/env-validation.md §4。
  if (env.defaultVision === null) {
    log.warn({}, '未配置 DEFAULT_VISION_*：导入照常，但新图会停在 tagStatus = pending')
  }
  if (env.defaultEmbed === null) {
    log.warn({}, '未配置 DEFAULT_EMBED_*：搜索只走 OCR + 标签两路，响应会带 degraded: true')
  }

  await assertR2Reachable()

  await waitForDatabase()
  log.info({}, '数据库已连接')

  const migrations = await checkMigrations(db)
  if (!migrations.upToDate) {
    log.fatal(
      { applied: migrations.applied, expected: migrations.expected, pending: migrations.pending },
      '数据库迁移落后，拒绝启动',
    )
    process.stderr.write(
      `\n数据库迁移落后：已应用 ${migrations.applied} / ${migrations.expected} 条。\n`
        + `未应用：${migrations.pending.join(', ')}\n\n`
        + '迁移不会在启动时自动执行（docs/deployment.md §6）。请手动跑：\n'
        + '  本机   cd api && npm run migrate\n'
        + '  部署机 docker compose run --rm app node dist/migrate.js\n\n',
    )
    process.exit(1)
  }
  log.info({ applied: migrations.applied }, '迁移版本已是最新')

  if (!mountWebDist(app, WEB_DIST_DIR)) {
    log.info({ dir: WEB_DIST_DIR }, '没有 web 构建产物，只提供 API（开发态正常）')
  }

  const server = serve({ fetch: dispatchHttpRequest, port: env.port }, (info) => {
    log.info({ port: info.port, nodeEnv: env.nodeEnv }, 'HTTP 已启动')
    log.info({ path: '/mcp' }, 'MCP 端点已挂载（POST /mcp，Authorization: Bearer）')
  })

  // worker 在 HTTP 之后起：迁移检查已经过了，且它不影响接口可用性。
  // 没配 DEFAULT_VISION_* 时 worker 照样起——它自己会空转等待（不消费、不失败重试），
  // 配置好之后不需要重启进程就能开始补打标
  startTagWorker()

  // 重算 worker 是**另一个** worker，不是打标 worker 的一个分支（理由写在
  // queue/reindex-worker.ts 的文件头）。同样无条件起：没配 embedding 通道时它空转，
  // 管理员在界面上配好之后不用重启进程，重建就会自己开始动
  startReindexWorker()

  // 人物向量 worker 是**第三个** worker（SPEC §5.7.2：不挂在打标任务上，打标失败、
  // 没配视觉通道都不能连带人物）。同样无条件起：没配图片向量通道时它空转，
  // 管理员在界面上配好之后不用重启进程，新图和补算就会自己开始动
  startPersonVectorWorker()

  // 定时清理（queue.md §6）。目前只有一条：删过期的检索快照。它不消费队列，
  // 所以不是 worker，但同样无条件起——它不依赖任何外部通道
  startCleanupJob()

  // 续跑被上次退出打断的导入批次（SPEC §1.4 / 本任务 §9）。**不 await**：
  // 一批可能跑几分钟，启动不该等它，接口可用性也不该挂在它身上。
  // `resumeInterruptedBatches` 自己吞掉每一批的异常，这条 promise 不会 reject
  void resumeInterruptedBatches().catch((error: unknown) => {
    // 走到这里只可能是 listResumableBatches 那次查询就失败了（库刚起来，或者迁移
    // 刚好在这中间跑）。**不阻断启动**：接口本身还能用，下一次重启还会再扫一遍
    log.error({ err: error }, '扫描被中断的导入批次失败，启动继续')
  })

  installShutdownHandlers({
    closeServer: () => closeHttpServer(server),
    stopWorkers: () => [
      stopTagWorker(),
      stopReindexWorker(),
      stopPersonVectorWorker(),
      stopCleanupJob(),
    ],
    exit: (code) => process.exit(code),
  })
}

/**
 * `serve()` 的入口分流：`/mcp` 与 `/api/v1` **并列**，两套中间件栈互不影响。
 *
 * 为什么在这里分而不是把 MCP 挂进 `app.ts`：`web` 通过 `AppType` 消费 api 的类型，
 * `app.ts` 的 import 图会整个进入 web 的 typecheck，而 MCP SDK 带 Node 类型与自己的一套
 * wire 类型（`agents/rules/mcp.md §1`）。放在这里还有一个附带好处：`/mcp` 不需要项目
 * 错误信封、CORS、静态产物回退，也不受全局 `bodyLimit` 影响——它有自己的那一套。
 *
 * **只认精确的 `/mcp`**（SPEC §10.2：地址固定带 /mcp 路径）。`/mcp/` 或 `/mcp/x`
 * 落到 `app.fetch`，由它回 404 —— 不做「宽容匹配」：多一个能进来的路径就多一份要维护的行为。
 */
function dispatchHttpRequest(request: Request): Response | Promise<Response> {
  if (new URL(request.url).pathname === '/mcp') return mcpApp.fetch(request)
  return app.fetch(request)
}

/**
 * 关掉 HTTP 服务：**停收新连接，并掐掉还挂着的**。
 *
 * `close()` 的回调只在所有连接断开后才触发，而 SSE 的 15 秒心跳和 HTTP keep-alive
 * 都会让连接一直挂着——所以那个回调**不能**用来串收尾（`src/shutdown.ts` 的文件头
 * 讲了它是怎么把停机拖过 10 秒预算的）。`closeAllConnections()` 是那把快刀：
 * 在途请求会被掐断，但停机时这比「留着连接慢慢等」划算——客户端本来就要能处理
 * 断线重连（SPEC §1.4 的快照补齐就是这个用途）。
 *
 * 返回值直接丢掉，不 await 也不看回调：`shutdownOnce` 只管有没有把口子关上，
 * 不管连接层什么时候真的空掉。
 */
function closeHttpServer(server: ServerType): void {
  server.close()
  // `ServerType` 那个联合里有 http2 的那几个（TLS 部署用），而 http2 的连接归 session
  // 管、没有这个方法。这里实际起的是 http1 服务，`in` 收窄一下比断言干净
  if ('closeAllConnections' in server) server.closeAllConnections()
}

main().catch((error: unknown) => {
  log.fatal({ err: error }, '启动失败')
  process.stderr.write(`\n启动失败：${error instanceof Error ? error.message : String(error)}\n\n`)
  process.exit(1)
})
