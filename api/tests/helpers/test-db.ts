import { createDb } from '../../src/data/db.js'
import { requireDatabaseUrl, testDatabaseUrl } from './db-url.js'

/**
 * 测试连的是**真 Postgres**（api/agents/rules/testing.md §1）。
 * pgvector / pg_trgm / bit_count / FOR UPDATE SKIP LOCKED 全都 mock 不出来。
 *
 * 用的是独立的 <库名>_test 库，不是开发库 —— 测试会清表。
 *
 * ⚠️ 这个文件会经由 db.ts 拉进 src/env.ts，只能在 setupFiles 之后被 import，
 *    也就是只能被测试文件 import。global-setup 用 db-url.ts。
 */

export function createTestDb() {
  return createDb(testDatabaseUrl(requireDatabaseUrl()))
}

/**
 * 每个用例自己清理，不靠用例之间的执行顺序（testing.md §2）。
 * 不加 RESTART IDENTITY 是因为主键是 uuid。
 *
 * ⚠️ **新建表必须加进这张清单。** 漏了不会报错——只是上一个用例的残留数据会漏到
 *    下一个用例里，表现为「单独跑绿、整批跑红」这种最难查的失败。
 *    `embed_config` / `runtime_config` 是全站单例表，残留一行就会让下一个用例
 *    以为 embedding / 运行参数已经配好了。
 */
export async function truncateAll(sql: ReturnType<typeof createTestDb>['sql']): Promise<void> {
  await sql`
    truncate table
      person_vector_jobs, person_rejections, meme_subjects, persons, series,
      tag_jobs, reindex_jobs, import_items, import_batches, search_snapshots, sessions,
      access_tokens, user_mcp_settings,
      user_favorites, user_ai_configs, config_tests, embed_config, image_embed_config,
      runtime_config, invite_codes, memes, users
    cascade
  `
}
