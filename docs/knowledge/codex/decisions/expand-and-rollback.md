---
title: 应用回滚期间保留已扩展的预约数据
type: decision
status: accepted
project: equipment-booking-api
permalink: equipment-booking-api/codex/decisions/expand-and-rollback
sources:
  - src/database/pickup-location.migration.ts
  - src/booking/pickup-location.controller.ts
  - src/readiness.controller.ts
  - deploy/release.py
  - deploy/rehearse.py
  - docs/openapi.json
---

# 应用回滚期间保留已扩展的预约数据

员工在发布期间继续预约，管理员可以在新功能开放后填写领用地点。回滚时两类写入都已经成为业务事实。重建数据库或反向删除字段会丢失已登记的地点，也会破坏通知投递和人工重放的可追溯性。

## Observations

- [decision] 先用有锁等待上限的事务增加可空列。旧记录自然读为未设置，已有预约接口保留原响应形状。严格校验原 OpenAPI 的旧客户端由此可以贯穿整个发布窗口。
- [decision] 领用地点使用独立路由。公共入口在两个新版实例和 worker 就绪后开放，回滚时先关闭。管理员填写后，旧 API 和旧 worker 可继续在原库服务，再次升级仍能读回原值。
- [decision] 运行旧版应用镜像是常规回退路径。会删除仍有业务值的降级迁移须被拒绝。未来确需删除字段时，需要另行确认所有读写方及数据保留方式。

## Relations

- relates_to [[分别记录预约时段与实物交接]]
