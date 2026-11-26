---
title: 基线的 HTTP 入口显式使用 NodeAdapter
type: decision
status: accepted
decided: '2026-11-26'
project: nest-baseline
permalink: nest-baseline/codex/decisions/node-http-adapter
sources:
  - AGENTS.md
  - src/main.ts
  - src/notifications/receiver.ts
  - test/app.e2e-spec.ts
  - test/integration/maintenance.test.mjs
---

# 基线的 HTTP 入口显式使用 NodeAdapter

设备预约 API、两个公司的 Webhook 接收端和端到端测试原先都依赖 Nest 12 的 Express 默认值。保留 Express 可以沿用框架默认配置。基线选择显式指定适配器，使开发、生产和测试运行同一套 HTTP 实现，也符合 Nest 从 v12.3 起对新应用的建议。[Nest 适配器选型](https://docs.nestjs.com/http/performance#choosing-an-adapter)

## Observations

- [decision] HTTP 入口和端到端测试显式创建 `NodeAdapter`。通知 worker 使用独立的 Nest 应用上下文。
- [constraint] 发布代理用 `HEAD /` 判断可否接流量，接收端用原始请求体验签。迁移须保留这两项行为和原有 HTTP 错误响应。
- [measurement] 预约请求包含数据库事务和设备锁。评估吞吐与延迟使用相同数据库和固定预约负载。
