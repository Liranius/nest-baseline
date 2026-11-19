# equipment-booking-api

## 项目简介

共享实验室设备预约 API，从 nest-baseline 的 a2cd2af 派生。员工可查询共享设备、预约、取消和查看本人交接进度。管理员按预约办理领用、归还并查阅审计记录。预约确认和取消还会异步通知所属公司，支持按预约排查和重放。[通知演练](docs/notifications.md)

业务测试使用 PostgreSQL、两个独立 API 进程、通知 worker 和两个公司的 HTTP 接收端。管理员可为尚未领用的有效预约登记领用地点。阶段 4 在同一个 HAProxy 入口持续接单，演练两个 API 和 worker 的升级、回滚与再发布。[部署操作](docs/stage4-deployment.md) · [验收记录](docs/booking-acceptance.md)

## 项目初始化

安装 fnm 并在当前 shell 中启用它。使用 PowerShell 时，可在当前会话运行下面的命令，也可以把它加入 PowerShell 配置文件。[fnm 安装说明](https://github.com/Schniz/fnm#installation)

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

在仓库根目录安装并切换到 `.node-version` 指定的 Node.js 版本，然后安装项目固定版本的 pnpm，按锁文件恢复依赖。

```bash
fnm install
fnm use
npm install --global pnpm@12.4.2
pnpm install --frozen-lockfile
pnpm run hooks:install
```

初始化流程已使用 fnm 1.39.0 验证。项目支持 Node.js 24.22.2 及后续 24.x 版本。用 `node --version` 和 `pnpm --version` 核对当前版本。

### 依赖安装策略

`pnpm-workspace.yaml` 定义了安装策略。必需依赖必须支持当前 Node.js 版本。pnpm 可以自动安装缺失且版本兼容的 peer 依赖（对等依赖）。如果必需的 peer 依赖无法满足或存在版本冲突，安装会失败。

遇到未审核的依赖脚本时，pnpm 会在执行该脚本前让安装失败。新增或升级此类依赖时，检查已发布包中的脚本，并在 `allowBuilds` 中记录决定。已审核且需要执行脚本的包版本设为 `true`，允许安装但需跳过脚本的设为 `false`。Lefthook 的安装脚本只负责注册 Git 钩子，本项目跳过该脚本，由开发者在本地克隆中显式运行 `pnpm run hooks:install`。在干净目录执行冻结安装，再运行 `pnpm run check` 验证。

## 运行 HTTP 服务

按[本地运行与验收](docs/booking-setup.md)准备开发数据库、迁移、种子和签名密钥，再运行 `pnpm run start:dev` 或编译后启动。服务未设置 `PORT` 时监听 3000，支持 0 至 65535 的十进制端口；0 由系统分配，非法值使启动失败。公开接口见 [OpenAPI 契约](docs/openapi.json)。

### 生产构建冒烟验证

完成数据库初始化后运行 `pnpm run build`、`pnpm run start:prod`，等待日志输出实际监听地址。访问 `GET /` 应返回 200 和 `Hello World!`。使用员工客户端登录并列出设备可核对数据库连接、认证与业务路由。使用 Ctrl+C 停止服务，确认端口释放。

## 运行测试

```bash
# 单元测试
pnpm run test

# HTTP 端到端测试
pnpm run test:e2e

# 测试覆盖率
pnpm run test:cov
```

`test:e2e` 自行启动和关闭 Nest 测试应用，通过 Supertest 验证 `GET /`。要覆盖编译后的入口文件和 `start:prod` 命令，按上面的生产构建冒烟步骤验证。

## 质量检查

按[本地运行与验收](docs/booking-setup.md)提供测试数据库后，在仓库根目录执行 `pnpm run check`。它依次运行 `format:check`、`lint`、`typecheck`、`test`、`test:e2e`、`build` 和 `test:booking`，遇到第一项失败即停止。每一步也可以通过 `pnpm run <脚本名>` 单独运行。

Oxfmt 检查仓库中支持的文件，包括 Markdown 和 JSON，跳过锁文件、依赖目录、生成产物和原样保留的第三方技能。Lint 覆盖应用、测试、项目脚本、HTTP 客户端和根目录的两份 Vitest 配置。TypeScript 对包括测试在内的根项目执行类型检查，不生成文件。

质量检查保持源码原样。Vitest 可能在 `node_modules/` 下写入缓存，生产构建会生成 `dist/` 和 `tsconfig.build.tsbuildinfo`。需要写入格式化结果时，运行 `pnpm run format`。

### GitHub 合并检查

面向 `main` 的 PR 和推送到 `main` 的提交都会触发 CI。工作流从 `.node-version` 和 `package.json` 读取工具版本，在干净的 Ubuntu 环境中运行 `pnpm install --frozen-lockfile` 和 `pnpm run check`；测试由本工作流的独立 PostgreSQL 18 服务支持。检查失败时，在该次运行的 `Checks` 日志中查看首个失败步骤。[CI 工作流](.github/workflows/ci.yml)

配置 `main` 分支保护时，将 GitHub Actions 在 PR 上报告的 `Quality` 设为必需检查，并要求分支与 `main` 同步后再合并。在仓库设置中只启用 **Rebase and merge**。只有环境准备、依赖安装和项目检查均实际执行成功，`Quality` 才会通过。`main` 推送的汇总结果单独命名为 `CI result`。

## 基线维护

每次发布基线版本时，仓库维护者复查依赖的支持周期、检查规则的例外和仍在使用的临时方案。安全公告或工具链升级影响项目时，提前复查。升级时记录原因，运行项目检查，并验证受影响的实际行为。[质量检查](#质量检查)

升级依赖的主版本时，单独提交 PR，说明升级理由、破坏性变更和适配范围。同步受影响的版本声明、锁文件、CI 配置、文档及例外记录，并在 PR 中记录 `pnpm run check` 和受影响行为（包括失败路径）的验证结果。

仓库维护者收到 Dependabot 告警后，核查依赖在服务、构建或 CI 中的实际用途。对 critical 和 high 告警，在下一个工作日结束前完成初次影响判断。其他告警在下次基线发布前复核。

若 PR 引入或扩大了已确认可触达的 high 或 critical 风险，维护者在修复、移除依赖或记录有效缓解措施后再合并。在告警或相关 PR 中记录责任人、决定和依据；暂缓项另记复查日期。在到期、发布基线、修复版本可用或依赖用途变化时复查。合并时由维护者执行这项审查，GitHub 的自动必需检查为 `Quality`。

Dependabot 每周检查 CI 工作流引用的 GitHub Actions，有可用更新时提出 PR。维护者审查版本和固定的提交 SHA，决定采用的更新须通过 `Quality` 后合并。[Dependabot 配置](.github/dependabot.yml)

### 属性初始化与显式 any 检查

- 根目录 `tsconfig.json` 启用了 `strict`。`strictPropertyInitialization` 继承该设置，生产构建也继承根配置。对于必须有值的实例属性，TypeScript 会检查它是否在声明处或构造函数中完成初始化。单独验证可运行 `pnpm run typecheck`。
- Oxlint 将 `typescript/no-explicit-any` 设为 `error`。在应用、测试或根目录的 Vitest 配置中显式使用 `any` 会使 `pnpm run lint` 失败。对于类型未知的外部输入，可先用 `unknown` 接收，再校验并收窄类型。

变更依赖注入方式、接入缺少类型声明的库，或升级 TypeScript、Oxlint 后，重新运行对应的检查。确需引入例外时，将范围限定到受影响的位置，记录诊断信息、保留原因、维护人和复查条件。

## 格式与 Git 约定

文件使用 UTF-8 编码、LF 换行和两个空格缩进。Windows 批处理文件（`.cmd`、`.bat`）检出时使用 CRLF。编辑器保留 Markdown 行末用于强制换行的空格。TypeScript 使用 100 列格式化宽度、单引号和分号。

Git 忽略私有的 `.env`、`.env.local` 以及各环境的本地覆盖文件，例如 `.env.staging.local`。可共享的配置示例写在 `.env.example` 中。

### 提交前检查

在项目的 Node 和 pnpm 环境中提交。安装钩子后，`git commit` 会先用 Oxlint 修复暂存的 `src/`、`test/`、`scripts/`、`clients/` 文件和根目录两份 Vitest 配置，再用 Oxfmt 格式化它支持的暂存文件。两步顺序执行，修复结果自动重新暂存。遇到无法修复的错误时提交会停止，可用 `git diff --cached` 复核暂存结果，用 `git diff` 查看保留的未暂存改动。[Lefthook 配置](lefthook.yml)

同一文件部分暂存时，Lefthook 会临时隐藏未暂存的修改。若恢复这些修改时与自动修复冲突，提交会中止。核对两份差异，手工整理冲突行，再用 `git add -p` 选择本次要提交的内容。

暂存格式、Lint、TypeScript、测试、构建或依赖配置的变更时，钩子还会运行完整的 `pnpm run check`，覆盖项目级类型感知 Lint、类型检查、测试和构建。CI 在每个 PR 上独立运行同一命令。[质量检查](#质量检查)

提交 PR 前按逻辑整理本地历史。一个完整变更可归为一个提交，值得独立审查或回退的步骤可分为多个提交。每个保留的提交应可构建并带上对应测试。合并方式见 [GitHub 合并检查](#github-合并检查)。

## 项目知识

在当前 Git worktree 中使用 Basic Memory 保存工程决策和排障结论。安装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后运行 `pnpm knowledge:setup`，再用 `pnpm knowledge:doctor` 检查项目路径、MCP 和 SessionStart。普通安装、测试和 CI 可以独立运行。配置位置、日常命令和验收范围见[项目知识指南](docs/project-knowledge.md)。

## 许可证

本项目自有代码采用 [MIT 许可证](LICENSE)。知识工具所用参考实现、官方技能及派生模板的来源与许可证见[第三方说明](THIRD_PARTY_NOTICES.md)。
