# api 规则索引

| 何时必读 | 文件 |
|---|---|
| 新增文件、不确定代码该放哪 | [project-structure.md](project-structure.md) |
| 写任何代码 | [code-style.md](code-style.md) |
| 碰 SQL、迁移、`memes` 读写、向量 | [database.md](database.md) |
| 碰 AI 调用、测试连接、降级 | [ai-providers.md](ai-providers.md) |
| 碰上传、抽帧、缩放、哈希 | [image-pipeline.md](image-pipeline.md) |
| 碰搜索、RRF、HyDE | [retrieval.md](retrieval.md) |
| 碰打标队列、定时任务 | [queue.md](queue.md) |
| 碰错误返回、日志、密钥 | [error-handling.md](error-handling.md) |
| 碰环境变量、启动流程 | [env-validation.md](env-validation.md) |
| 碰 MCP 端点、访问令牌、MCP 工具 | [mcp.md](mcp.md) |
| 写测试 | [testing.md](testing.md) |

按条件读正文，已完整读过且未变化的不重复读取。不一次加载全部。

**三条硬边界（[总管入口](../../AGENTS.md) §5）的实现全在 [database.md](database.md) 和 [error-handling.md](error-handling.md)。** 动到 `memes` 或配置接口时这两份必读。
