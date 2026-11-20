---
title: 用 PostgreSQL 约束共享设备的时段与预约重试
type: decision
status: accepted
project: nest-baseline
permalink: nest-baseline/codex/decisions/reservation-consistency
sources:
  - docs/openapi.json
  - src/database/initial.migration.ts
  - src/database/maintenance.migration.ts
  - src/booking/maintenance.controller.ts
  - test/integration/maintenance.test.mjs
  - src/booking/reservations.service.ts
  - src/security/identity.ts
  - test/integration/stage1.test.mjs
---

同一设备由多家公司共享。员工查到的空闲时段可能已被另一个实例的请求占用，客户端也可能在服务提交预约后丢失响应。

阶段 0–1 采用本地账号和短期 Bearer 令牌。TypeORM 管理连接、实体和事务，显式 SQL 迁移建立 PostgreSQL 的左闭右开时间范围排斥约束，所有组织共用同一条占用规则。员工身份从通过验签的请求推导。

预约行同时保存员工、幂等键和原始时段。请求在同一事务中按员工和键串行检查重试，再为设备创建预约。进程内锁只能协调一个实例。取消改变状态并释放时段，保留原预约行，以便重放成功请求时继续返回原 ID。两个实例以 HTTP 和数据库最终状态验收这些约束。

维护排期和有效预约共用设备占用视图。两类写入都在 READ COMMITTED 下先锁定同一设备，再检查另一类时段；各自的 GiST 排斥约束处理同类重叠。取消维护保留创建和撤销记录。旧预约的成功重试先读取原回执，即使同一时段后来改为维护也返回原 ID。

选择本地认证让客户端可以从空环境完成验收。设备领用与归还的后续决定见 [[分别记录预约时段与实物交接]]。公司通知的投递及乱序处理见 [[预约通知按版本更新公司状态]]。外部身份服务仍属后续范围。
