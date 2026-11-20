---
title: 从预约快照恢复并按事件核对公司收件
type: decision
status: accepted
project: nest-baseline
permalink: nest-baseline/codex/decisions/recover-bookings-and-reconcile-deliveries
sources:
  - deploy/recovery.compose.yaml
  - deploy/recovery_store.py
  - deploy/recovery_drill.py
  - deploy/verify-recovery.mjs
  - src/notifications/receiver.ts
---

# 从预约快照恢复并按事件核对公司收件

一次投递可以发生在备份完成之后。恢复后，发件箱可能仍认为该事件待发，公司的收件系统已经登记成功。重建主库时要保留接收方在故障时的实际进度，才能验证重新投递对业务的影响。

## Observations

- [decision] 应用数据库使用完整的逻辑备份。归档和逐表核对清单共享同一快照；恢复到空卷，再以旧预约、原幂等键及交接凭据核对可用性。快照后的新增预约通过源端审计与快照 ID 差集定位。
- [decision] 公司收件数据保存在独立实例。恢复后的 worker 继续使用原事件 ID 和订阅。发送端的成功应答、公司收件箱的行数和公司状态是否再次更新，分别说明传输结果与业务结果。
- [decision] 开放入口和启用投递前，用只读连接验证迁移与原订阅密钥。HTTP 就绪探针能确认订阅存在，解密校验还能发现备份以外的密钥配置错误。恢复后重新播种或生成订阅会掩盖这类问题。

## Relations

- relates_to [[预约通知按版本更新公司状态]]
- relates_to [[应用回滚期间保留已扩展的预约数据]]
