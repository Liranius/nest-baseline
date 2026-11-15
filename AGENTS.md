# AGENTS.md

## 项目入口

在仓库根目录执行命令。Node 版本见 [.node-version](.node-version)，pnpm 版本和项目命令见 [package.json](package.json)。安装步骤见 [README](README.md#项目初始化)。

服务从 [src/main.ts](src/main.ts) 启动，模块在 [src/app.module.ts](src/app.module.ts) 装配。单元测试与源码相邻，HTTP 端到端测试位于 [test/](test/)。

## 工作约定

- 开工前核对目标、验收条件、当前分支以及已暂存和未暂存的差异。保留已有改动，同一位置的修改发生冲突时先协调。
- 以当前代码、测试、配置和已确认的需求为准。只完成已授权的修改及必要配套，额外发现单独报告。缺失信息影响正确性、兼容性或范围时再澄清。用户要求逐项审查时，在约定的节点停下。
- 目录、命令或工程约定变化时，同步更新对应说明。有意保留临时方案、检查例外或推迟已知问题时，就近用 `TODO:` 记录原因、影响和解除条件。同一问题保留一份主要记录，未知信息标为待确认。[基线维护](README.md#基线维护)

## 验证要求

交付前运行 `pnpm run check`，该命令只读检查源码。使用 `pnpm run format` 写入格式修复后，复核实际差异。[质量检查](README.md#质量检查)

- 文档改动核对命令、路径和链接，并用 `git diff --check` 检查差异。
- 改变接口行为时，用测试覆盖受影响的请求和响应。修复缺陷时验证原问题和相关回归。影响启动或构建产物时，从生产入口验证就绪、响应和停止。[生产构建冒烟验证](README.md#生产构建冒烟验证)
- 依赖改动用干净目录执行 `pnpm install --frozen-lockfile`。类型、Lint 或安装策略改动既要验证正常项目通过，也要验证代表性违规会被拦截。
- 检查失败时先核对诊断并定位原因，保留有效测试和严格检查。确需调整规则、排除范围或测试断言时，说明依据和影响。遇到环境阻塞时，记录失败证据并继续可以独立运行的检查。

## 审查与交接

对照需求、最终差异和实际检查结果复核行为、兼容性及范围，更新变化或已解决的 `TODO:`。交付时说明改动原因、相关工具版本、命令和退出状态，列出未验证的事项及原因。另有独立审查时，单列其结果。

中断或交接时记录分支、工作区改动、验证结果、未解决事项和下一步。恢复工作时重新核对工作区。

## NestJS 开发约定

本项目使用的 NestJS 版本可能比你熟悉的版本更新。查阅当前版本的文档时，可从按章节列出 Markdown 页面的[文档索引](https://docs.nestjs.com/llms.txt)进入。

引入第三方库或自行实现功能前，先检查 Nest 提供的官方包。

| 功能                   | 官方包和文档                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库                 | [TypeORM（`@nestjs/typeorm`）](https://docs.nestjs.com/data/typeorm.md)、[Drizzle（`@nestjs/drizzle`）](https://docs.nestjs.com/data/drizzle.md)、[MongoDB（`@nestjs/mongoose`）](https://docs.nestjs.com/data/mongodb.md)、[Sequelize（`@nestjs/sequelize`）](https://docs.nestjs.com/data/sequelize.md)                                       |
| API 和通信             | [OpenAPI（`@nestjs/swagger`）](https://docs.nestjs.com/openapi/introduction.md)、[GraphQL（`@nestjs/graphql`）](https://docs.nestjs.com/graphql/quick-start.md)、[WebSocket 网关（`@nestjs/websockets`）](https://docs.nestjs.com/websockets/gateways.md)、[微服务（`@nestjs/microservices`）](https://docs.nestjs.com/microservices/basics.md) |
| 身份与访问             | [登录（`@nestjs/authentication`）](https://docs.nestjs.com/security/authentication.md)、[授权（`@nestjs/authorization`）](https://docs.nestjs.com/security/authorization.md)、[限流（`@nestjs/throttler`）](https://docs.nestjs.com/security/rate-limiting.md)                                                                                  |
| 应用基础设施           | [配置（`@nestjs/config`）](https://docs.nestjs.com/application/configuration.md)、[缓存（`@nestjs/cache-manager`）](https://docs.nestjs.com/data/caching.md)、[健康检查（`@nestjs/terminus`）](https://docs.nestjs.com/reliability/terminus.md)、[应用内事件（`@nestjs/event-emitter`）](https://docs.nestjs.com/application/events.md)         |
| 邮件、存储和翻译       | [邮件（`@nestjs/mail`）](https://docs.nestjs.com/application/mail.md)、[文件与 S3 存储（`@nestjs/storage`）](https://docs.nestjs.com/application/file-storage.md)、[国际化（`@nestjs/i18n`）](https://docs.nestjs.com/application/i18n.md)                                                                                                      |
| 重试、超时和熔断       | [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience.md)                                                                                                                                                                                                                                                                       |
| 幂等与可靠投递         | [幂等键（`@nestjs/idempotency`）](https://docs.nestjs.com/reliability/idempotency.md)、[事务发件箱（`@nestjs/outbox`）](https://docs.nestjs.com/reliability/outbox.md)、[收发 Webhook（`@nestjs/webhooks`）](https://docs.nestjs.com/http/webhooks.md)                                                                                          |
| 队列和定时任务         | [队列（`@nestjs/bullmq`）](https://docs.nestjs.com/application/queues.md)、[任务调度（`@nestjs/schedule`）](https://docs.nestjs.com/application/task-scheduling.md)                                                                                                                                                                             |
| 分布式协调和长时工作流 | [锁与单实例定时任务（`@nestjs/locks`）](https://docs.nestjs.com/reliability/locks.md)、[可持续数天的工作流（`@nestjs/workflows`）](https://docs.nestjs.com/reliability/workflows.md)                                                                                                                                                            |
| AI 和 MCP              | [语言模型、工具与智能体（`@nestjs/ai`）](https://docs.nestjs.com/ai/overview.md)、[MCP 服务（`@nestjs/mcp`）](https://docs.nestjs.com/mcp/overview.md)                                                                                                                                                                                          |

请求校验可使用 Zod、Valibot、ArkType 等遵循 Standard Schema 的库。把 `StandardSchemaValidationPipe` 与 `@Body({ schema })` 或 `@Param('id', { schema })` 配合使用即可，无需定义类或提供装饰器元数据。使用 `class-validator` 时，通过 `ValidationPipe` 校验。[校验文档](https://docs.nestjs.com/application/validation.md)

Nest 的性能文档将 `@nestjs/platform-node` 提供的 `NodeAdapter` 列为最快的 HTTP 适配器，吞吐量高于 Fastify。[HTTP 性能文档](https://docs.nestjs.com/http/performance.md)

Nest 的包仅提供 ESM，本项目也使用 ESM。相对导入路径以 `.js` 结尾，获取当前目录用 `import.meta.dirname`。测试由 Vitest 运行，创建模拟函数用 `vi.fn()`。
