# 从预约 ID 排查并重放公司通知

预约确认和取消通过签名 HTTP POST 发送到所属公司的预配置端点。API、worker、两个公司接收端分别运行。准备 PostgreSQL、生成并保存环境变量、执行冻结安装和迁移的命令见[本地初始化](booking-setup.md#准备数据库)。

从阶段 2 升级时，先停止旧进程，按锁文件安装依赖并构建，设置通知密钥和 URL，再运行 `pnpm run db:migrate`、`pnpm run notifications:configure`。已有预约保留原状态，今后第一次取消时发送版本 2。发送方 API 和 worker 共用数据库及 `NOTIFICATION_ENCRYPTION_KEY`。两个回环 HTTP 地址用于本地演练，设置 `NOTIFICATIONS_LOCAL=1` 开启。端点配置命令可重复运行，接收端临时停机期间也可以完成配置。

## 准备接收端和 worker

每家公司使用自己的 `RECEIVER_COMPANY`、`RECEIVER_SECRET`、`RECEIVER_DATABASE_URL` 和 `PORT`。示例让两个接收端共用本地 PostgreSQL 服务，收件箱和预约状态分别存储在 `company_a_receiver` 和 `company_b_receiver`。也可为两个接收端分别提供 PostgreSQL 数据库。签名覆盖消息 ID、时间戳和原始请求体。

以下 PowerShell 示例在已经设置初始化环境变量的终端执行。API 在另一终端运行。本次先启动 B 接收端，稍后启动 A，以便复现重放。各进程均从独立仓库根目录启动。

```powershell
$node = (Get-Command node).Source
$env:RECEIVER_DATABASE_URL = $env:DATABASE_URL
$env:RECEIVER_COMPANY = 'B'
$env:RECEIVER_SECRET = $env:WEBHOOK_SECRET_B
$env:PORT = '46102'
pnpm run receiver:migrate
$receiverB = Start-Process $node -ArgumentList 'dist/notifications/receiver.js' -PassThru -WindowStyle Hidden

$env:RECEIVER_COMPANY = 'A'
$env:RECEIVER_SECRET = $env:WEBHOOK_SECRET_A
$env:PORT = '46101'
pnpm run receiver:migrate
New-Item -ItemType Directory -Force .tmp | Out-Null
$worker = Start-Process $node -ArgumentList 'dist/notifications/process.js','worker' -RedirectStandardOutput .tmp/worker.log -PassThru -WindowStyle Hidden
```

## 定位一次投递失败

用 A 员工预约一个空闲时段，记录预约 ID，然后切换到管理员。以下示例使用随机幂等键。

```powershell
$env:BOOKING_LOGIN = 'employee-a'
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_A
$equipment = '30000000-0000-4000-8000-000000000001'
$start = [DateTimeOffset]::UtcNow.AddHours(1)
$from = $start.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$to = $start.AddMinutes(15).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$created = node clients/employee.mjs reserve $equipment $from $to ([guid]::NewGuid().ToString()) | ConvertFrom-Json
if ($created.status -ne 201) { throw $created.body.code }
$id = $created.body.id
$env:BOOKING_LOGIN = 'lab-admin'
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_ADMIN
node clients/admin.mjs notifications $id
```

查询结果包含 `eventId`、目标组织、版本、投递 ID、累计尝试数、最近错误、下次尝试时间及各次 HTTP 结果。首次查询可能显示 `queued`，代表已提交、等待转为投递。端点停机时，worker 按指数退避重试。等待版本 1 显示 `failed`、`failureReason=exhausted` 和 5 次尝试，再记录该投递的 ID。

```powershell
$lookup = node clients/admin.mjs notifications $id | ConvertFrom-Json
$failed = $lookup.body | Where-Object { $_.version -eq 1 -and $_.failureReason -eq 'exhausted' }
if (-not $failed) { throw '等待五次尝试耗尽后再执行此步骤' }
$receiverA = Start-Process $node -ArgumentList 'dist/notifications/receiver.js' -PassThru -WindowStyle Hidden
$env:BOOKING_LOGIN = 'employee-a'
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_A
node clients/employee.mjs cancel $id
$env:BOOKING_LOGIN = 'lab-admin'
$env:BOOKING_PASSWORD = $env:SEED_PASSWORD_ADMIN
node clients/admin.mjs notifications $id
```

等待版本 2 的取消通知显示 `succeeded`，然后重放版本 1。管理员收到 `202` 表示已开始新一轮投递。重复重放活跃或已成功的投递返回 `409 DELIVERY_NOT_EXHAUSTED`。

```powershell
node clients/admin.mjs replay $failed.deliveryId
node clients/admin.mjs notifications $id
Select-String -Path .tmp/worker.log -SimpleMatch $failed.eventId
```

恢复后版本 1 显示 `succeeded`，事件 ID 与原记录一致。`history` 保留原先五次失败和本轮成功，`replays` 列出操作的管理员及时间。在 A 的接收数据库执行下列 SQL，传入预约 ID，可核对最终版本与状态。

```sql
SELECT reservation_id, version, status FROM company_a_receiver.reservations
WHERE reservation_id = '<预约 ID>'::uuid;
```

应得到版本 `2` 和 `cancelled`。worker 的 JSON 日志按事件 ID 关联投递，每五秒输出 `pending`（等待投递数量）、`oldestPendingMs`（最早等待时间）及 `exhausted`（耗尽数量）。结束示例时回收当前终端启动的进程。

```powershell
$receiverA, $receiverB, $worker | Where-Object { $_ -and -not $_.HasExited } | Stop-Process
```

自动化复验使用两个真实 API 进程、独立 worker 和两个接收端，包含发送进程重启、接收后丢失应答及错误签名。设置 `TEST_DATABASE_URL` 后运行 `pnpm run check`。
