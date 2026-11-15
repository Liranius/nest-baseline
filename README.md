# nest-baseline

## 项目简介

`nest-baseline` 是一个单包 NestJS HTTP 服务。应用代码和单元测试位于 `src/`，HTTP 端到端测试位于 `test/`。

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
```

初始化流程已使用 fnm 1.39.0 验证。项目支持 Node.js 24.22.2 及后续 24.x 版本。用 `node --version` 和 `pnpm --version` 核对当前版本。

### 依赖安装策略

`pnpm-workspace.yaml` 定义了安装策略。必需依赖必须支持当前 Node.js 版本。pnpm 可以自动安装缺失且版本兼容的 peer 依赖（对等依赖）。如果必需的 peer 依赖无法满足或存在版本冲突，安装会失败。

依赖安装脚本的允许列表初始为空。遇到未审核的依赖脚本时，pnpm 会在执行该脚本前让安装失败。新增或升级此类依赖时，检查已发布包中的脚本，并在 `allowBuilds` 中记录决定。已审核且需要执行脚本的包版本设为 `true`，允许安装但需跳过脚本的设为 `false`。在干净目录执行冻结安装，再运行 `pnpm run check` 验证。

## 运行 HTTP 服务

在仓库根目录运行 `pnpm run start` 启动本地服务。开发时可运行 `pnpm run start:dev`，文件变更后会重新构建并重启。HTTP 端口默认为 `3000`，可以通过服务进程的环境变量 `PORT` 覆盖。示例接口可以直接运行，无需数据库或凭据。在服务所在的终端按 Ctrl+C 停止服务。

### 生产构建冒烟验证

运行 `pnpm run build`。构建成功后，选用空闲端口启动编译后的 `dist/main.js`。下面的 PowerShell 示例使用端口 3100。

```powershell
$env:PORT = '3100'
pnpm run start:prod
```

在第二个 PowerShell 终端请求同一端口的根接口。

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:3100/ -TimeoutSec 2 | Select-Object StatusCode, Content
```

当 `GET /` 返回 HTTP `200` 且正文精确匹配 `Hello World!` 时，服务就绪。如果连接失败，可在启动后的 10 秒内重试。如果启动时报 `EADDRINUSE`，在两个终端改用同一空闲端口，重新启动并请求接口。验证结束后，无论成功还是失败，都在服务终端按 Ctrl+C，再确认端口已释放，可供下次启动使用。

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

在仓库根目录执行 `pnpm run check`。它依次运行 `format:check`、`lint`、`typecheck`、`test`、`test:e2e` 和 `build`，遇到第一项失败即停止。每一步也可以通过 `pnpm run <脚本名>` 单独运行。

Oxfmt 检查仓库中支持的文件，包括 Markdown 和 JSON，跳过锁文件、依赖目录和生成产物。Lint 覆盖应用、测试和根目录的两份 Vitest 配置。TypeScript 对包括测试在内的根项目执行类型检查，不生成文件。

质量检查保持源码原样。Vitest 可能在 `node_modules/` 下写入缓存，生产构建会生成 `dist/` 和 `tsconfig.build.tsbuildinfo`。需要写入格式化结果时，运行 `pnpm run format`。

### GitHub 合并检查

面向 `main` 的 PR 和推送到 `main` 的提交都会触发 CI。工作流从 `.node-version` 和 `package.json` 读取工具版本，在干净的 Ubuntu 环境中运行 `pnpm install --frozen-lockfile` 和 `pnpm run check`。检查失败时，在该次运行的 `Checks` 日志中查看首个失败步骤。[CI 工作流](.github/workflows/ci.yml)

配置 `main` 分支保护时，将 GitHub Actions 在 PR 上报告的 `Quality` 设为必需检查，并要求分支与 `main` 同步后再合并。在仓库设置中只启用 **Rebase and merge**。只有环境准备、依赖安装和项目检查均实际执行成功，`Quality` 才会通过。`main` 推送的汇总结果单独命名为 `CI result`。

## 基线维护

每次发布基线版本时，仓库维护者复查依赖的支持周期、检查规则的例外和仍在使用的临时方案。安全公告或工具链升级影响项目时，提前复查。升级时记录原因，运行项目检查，并验证受影响的实际行为。[质量检查](#质量检查)

### 属性初始化与显式 any 检查

- 根目录 `tsconfig.json` 启用了 `strict`。`strictPropertyInitialization` 继承该设置，生产构建也继承根配置。对于必须有值的实例属性，TypeScript 会检查它是否在声明处或构造函数中完成初始化。单独验证可运行 `pnpm run typecheck`。
- Oxlint 将 `typescript/no-explicit-any` 设为 `error`。在应用、测试或根目录的 Vitest 配置中显式使用 `any` 会使 `pnpm run lint` 失败。对于类型未知的外部输入，可先用 `unknown` 接收，再校验并收窄类型。

变更依赖注入方式、接入缺少类型声明的库，或升级 TypeScript、Oxlint 后，重新运行对应的检查。确需引入例外时，将范围限定到受影响的位置，记录诊断信息、保留原因、维护人和复查条件。

## 格式与 Git 约定

文件使用 UTF-8 编码、LF 换行和两个空格缩进。Windows 批处理文件（`.cmd`、`.bat`）检出时使用 CRLF。编辑器保留 Markdown 行末用于强制换行的空格。TypeScript 使用 100 列格式化宽度、单引号和分号。

Git 忽略私有的 `.env`、`.env.local` 以及各环境的本地覆盖文件，例如 `.env.staging.local`。可共享的配置示例写在 `.env.example` 中。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
