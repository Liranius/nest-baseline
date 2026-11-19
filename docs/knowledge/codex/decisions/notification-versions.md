---
title: 预约通知按版本更新公司状态
type: decision
status: accepted
project: equipment-booking-api
permalink: equipment-booking-api/codex/decisions/notification-versions
sources:
  - src/notifications/notifications.ts
  - src/notifications/module.ts
  - src/notifications/receiver.ts
  - src/database/notifications.migration.ts
  - test/integration/stage3.test.mjs
---

# 预约通知按版本更新公司状态

同一预约的确认可能仍在重试，取消已先送达。公司接收端可以马上显示取消，稍后恢复失败的确认投递仍能保留完整记录。如果要求确认先送达，取消将一直等待人工处置前一笔失败。

## Observations

- [decision] 确认与取消分别携带版本 1 和 2。接收端在同一 PostgreSQL 事务中按事件 ID 登记收件并以较高版本更新预约，重放和乱序均保留最新状态。
- [decision] 预约、审计与通知发件箱使用同一个 TypeORM 事务。独立 worker 负责公司签名与投递，每轮最多五次，耗尽后的人工重放保留原 ID、尝试历史和操作者。
- [decision] 阶段 2 存量预约从升级后的下一次变更开始通知。取消可以是接收方看到的第一条消息。

## Relations

- relates_to [[用 PostgreSQL 约束共享设备的时段与预约重试]]
