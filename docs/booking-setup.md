# 本地运行与验收

从仓库根目录完成 [Node 和 pnpm 初始化](../README.md#项目初始化)，使用 PostgreSQL 18。维护的 HTTP 接口与错误码见 [OpenAPI 3.1 契约](openapi.json)。业务端口默认为 3000。

## 准备数据库

以下示例在 Windows PowerShell 7 运行 Node，在 WSL Ubuntu 运行 Docker Compose。Linux 或 macOS 可以直接在仓库目录调用 `docker compose`。数据库只绑定回环地址。dev 使用持久卷，test 使用独立的临时服务；测试数据库账号需要创建临时数据库的权限。

在本地密码管理器中保存新生成的开发凭据，重启已有开发库时使用相同的数据库密码与签名密钥。两个实例共享 `DATABASE_URL` 与 `JWT_SECRET`。种子命令使用三个各自不同的 12 至 256 字符密码，通过对应环境变量提供。种子仅初始化缺失记录。

```powershell
function New-LocalSecret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) }
$env:BOOKING_DB_PASSWORD = New-LocalSecret
$env:JWT_SECRET = New-LocalSecret
$env:SEED_PASSWORD_A = New-LocalSecret
$env:SEED_PASSWORD_B = New-LocalSecret
$env:SEED_PASSWORD_ADMIN = New-LocalSecret
$env:BOOKING_DEV_PORT = '55431'
$env:BOOKING_TEST_PORT = '55432'
$env:WSLENV = ($env:WSLENV + ':BOOKING_DB_PASSWORD:BOOKING_DEV_PORT:BOOKING_TEST_PORT').Trim(':')
wsl -d Ubuntu -- docker compose --profile dev --profile test up -d --wait
$env:DATABASE_URL = "postgresql://booking:$($env:BOOKING_DB_PASSWORD)@127.0.0.1:$($env:BOOKING_DEV_PORT)/booking_dev"
$env:TEST_DATABASE_URL = "postgresql://booking:$($env:BOOKING_DB_PASSWORD)@127.0.0.1:$($env:BOOKING_TEST_PORT)/booking_test"
pnpm run build
pnpm run db:migrate
pnpm run db:seed
pnpm run start:prod
```

首次初始化后即可使用 `pnpm run start:dev`。端口被占用时改用空闲宿主端口后重启相应 Compose 服务并更新连接串。连接串中的特殊字符需要 URL 编码，上面的随机值使用十六进制。普通应用启动只连接数据库，迁移由单独命令执行。

## 使用客户端

在具备相同种子密码的第二个终端运行。客户端默认访问 `http://127.0.0.1:3000`，可用 `BOOKING_API_URL` 覆盖。员工端默认以 `employee-a` 登录，管理端默认为 `lab-admin`。切换为员工 B 时同时设置 `BOOKING_LOGIN=employee-b` 及该账号的密码。

```powershell
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_A
node clients/employee.mjs list
$equipment = '30000000-0000-4000-8000-000000000001'
$from = '2030-03-01T10:00:00Z'
$to = '2030-03-01T11:00:00Z'
node clients/employee.mjs availability $equipment $from $to
$created = node clients/employee.mjs reserve $equipment $from $to first-booking | ConvertFrom-Json
node clients/employee.mjs get $created.body.id
node clients/employee.mjs cancel $created.body.id
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_ADMIN
node clients/admin.mjs inspect $from $to
```

预约创建请求的身份来自 Bearer 令牌。时间包含时区，可精确到毫秒。取消后使用新键重新预约；旧键重放仍得到原预约 ID，查询原 ID 可见已取消状态。

## 运行检查

`pnpm run check` 包括格式、Lint、类型检查、单元测试、HTTP 冒烟、构建及两阶段业务集成验收。完整检查只需测试库连接串 `TEST_DATABASE_URL`；测试进程自行生成登录密码和签名密钥。连接串必须指向数据库名以 `_test` 结尾的专用控制库。每个场景在同一 PostgreSQL 服务中新建随机命名的数据库，重复迁移与填充种子、启动两个独立进程，最后停止进程并删除自己创建的数据库。

构建后可运行 `pnpm run test:booking` 单独复验。HTTP 客户端的响应状态与结构按 OpenAPI 校验；故障用例使用真实 HTTP 代理在上游提交后丢弃响应。阶段证据见[验收记录](booking-acceptance.md)。

停止开发服务后，可运行以下命令回收容器。开发数据保存在命名卷中。

```powershell
wsl -d Ubuntu -- docker compose --profile dev --profile test down
```
