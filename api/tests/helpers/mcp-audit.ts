import type { Db } from '../../src/data/db.js'
import { insertMcpCallLog } from '../../src/data/mcp-call-logs.js'
import type { McpAuditDeps } from '../../src/mcp/server.js'

/**
 * 测试用的审计接缝（`mcp/server.ts` 的 `McpAuditDeps`）。
 *
 * 连库的用例传 `db`，得到的是**真的写行**——"调用一次就有一行"这类断言要它。
 * 不连库的 unit 用例（`src/mcp/app.test.ts`）不传 `db`，写操作变空转。
 *
 * `onError` 默认收集到 `errors` 里而不是打印：用例要断言的是「写失败时请求仍然成功」，
 * 顺带还能验 `requestId` / `tokenId` 有没有被带出来。
 */
export function createTestAudit(
  db?: Db,
): McpAuditDeps & { errors: { error: unknown; meta: { requestId: string; tokenId: string } }[] } {
  const errors: { error: unknown; meta: { requestId: string; tokenId: string } }[] = []
  return {
    errors,
    write: db === undefined ? async () => {} : (entry) => insertMcpCallLog(entry, db),
    onError: (error, meta) => {
      errors.push({ error, meta })
    },
  }
}
