import {
  countExpiredOAuthArtifacts,
  deleteExpiredOAuthArtifacts,
} from '../data/oauth.js'
import {
  countExpiredSearchSnapshots,
  deleteExpiredSearchSnapshots,
} from '../data/search-snapshots.js'
import { log } from '../logger.js'

/**
 * 定时清理（agents/rules/queue.md §6）。
 *
 * **这是那张清单上的第一条。** 在它之前 `api` 一个定时任务都没有——重算队列和打标队列
 * 的周期扫描是各自 worker 里的一个 `setInterval`，而「每小时删掉过期的导入批次」那几条
 * 从来没实现过。清理任务与 worker 的区别在于它**不消费队列**：没有待领取的任务、
 * 没有并发、没有重试，只是到点扫一遍表。
 *
 * 所以它也不需要 worker 那一套在途追踪。以后每加一个清理任务就往 `sweep()` 里加一行，
 * **不要每个任务各起一个 `setInterval`**：那样进程里会同时躺着五六个几乎不工作的定时器，
 * 而它们的异常处理、unref、停机收尾还要各写一遍。
 */

/**
 * 扫描间隔。快照的 TTL 是 30 分钟（`services/search-snapshot.ts`），5 分钟一扫意味着
 * 最多多留 5 分钟，而一次扫描就是一条走索引的 `delete`。
 */
const SWEEP_INTERVAL_MS = 5 * 60_000

let timer: ReturnType<typeof setInterval> | null = null
/** 在途的那一次扫描。停机时等它结束，免得它半路被 `exit` 掐掉。 */
let inFlight: Promise<void> | null = null

/**
 * 起定时清理。**无条件起，不看配置**：它不依赖任何外部通道（没有 embedding、
 * 没有视觉模型），起来的成本就是每 5 分钟一条 `delete`。
 */
export function startCleanupJob(options: { intervalMs?: number } = {}): void {
  if (timer !== null) return

  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS
  timer = setInterval(() => {
    inFlight = sweep()
  }, intervalMs)
  // `unref` 同两个 worker：它不该把进程按在事件循环里，停机由 shutdown.ts 负责
  timer.unref()

  log.info({ intervalMs }, '定时清理已启动')
}

/** 停机：不再排下一次扫描，等在途的那一次跑完。 */
export async function stopCleanupJob(): Promise<void> {
  if (timer === null) return
  clearInterval(timer)
  timer = null

  await inFlight
  inFlight = null
  log.info('定时清理已停止')
}

/**
 * 扫一遍。**异常只记日志，绝不让定时器挂掉**——理由同两个 worker 的 `sweepStale`：
 * 定时器挂掉之后没有任何东西会再触发它，表现是「快照表一直涨」，而那看起来像
 * 「清理功能没写」而不是「它某一次失败了」。
 */
async function sweep(): Promise<void> {
  try {
    // **先数、记日志、再删**（queue.md §6：先记日志再删，且要能 dry-run）。
    // 数出来是 0 就直接收工：空转的日志每 5 分钟一条，会把真正有内容的那几条淹掉
    const due = await countExpiredSearchSnapshots()
    if (due === 0) return

    log.info({ due }, '清理过期的检索快照')
    await deleteExpiredSearchSnapshots()
  } catch (error) {
    log.error({ err: error }, '清理过期检索快照失败，下轮再试')
  }

  /*
   * OAuth 的三类短命产物：待同意的 ticket（10 分钟）、授权码（5 分钟）、刷新令牌
   * （30 天）。它们在 `data/oauth.ts` 里各有一张表，**过期后多留 1 天才删**
   * （SPEC §5.10：给「刚过期」的请求留一次可解释的失败，而不是凭空 404）。
   *
   * 与上面分开 try：两件互不相关的事，一个失败了不该把另一个也跳过去。
   * `oauth_grants` 不在清理范围——撤销的 grant 是审计记录，只随用户删除级联。
   */
  try {
    const due = await countExpiredOAuthArtifacts()
    if (due > 0) {
      log.info({ due }, '清理过期的 OAuth 临时凭证')
      await deleteExpiredOAuthArtifacts()
    }
  } catch (error) {
    log.error({ err: error }, '清理过期 OAuth 凭证失败，下轮再试')
  }
}
