---
title: 分别记录预约时段与实物交接
type: decision
status: accepted
project: nest-baseline
permalink: nest-baseline/codex/decisions/physical-handover
sources:
  - src/database/handover.migration.ts
  - src/booking/lifecycle.ts
  - src/booking/handovers.controller.ts
  - src/booking/handovers.service.ts
  - src/booking/reservations.service.ts
  - docs/openapi.json
  - test/integration/stage2.test.mjs
  - test/integration/upgrade.test.mjs
---

# 分别记录预约时段与实物交接

两家公司可以把同一台设备预约在相邻时段。到达后一时段的开始时间，上一位借用人可能仍持有设备。管理员必须先登记归还，才能办理下一次交付。员工看到的预约日历则继续兑现既有的时段承诺。

## Observations

- [decision] 用预约行保存计划时段，用借还行保存管理员实际办理的时间和身份。提前归还保留原预约时段。若凭计划结束时间自动释放实物，逾期时两位借用人会同时持有有效的领用凭据。
- [decision] PostgreSQL 部分唯一索引限制一台设备至多一笔未归还记录。检查领用资格时取加锁后的数据库时刻，首次领用须在左闭右开时段内。
- [decision] 同一预约的领用和归还各有一张可重放的凭据。业务变更和审计事件同事务提交，审计保存当时的操作者、时间和前后状态。阶段 1 缺少交接历史，升级仅记录此后可核实的事件。

## Relations

- relates_to [[用 PostgreSQL 约束共享设备的时段与预约重试]]
