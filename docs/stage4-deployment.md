# 阶段 4 · 部署、迁移与回滚

本地预发布环境复现两家公司的设备预约服务。员工始终访问同一个 HAProxy 入口。此次发布给已确认、尚未领用的预约增加领用地点。公开地点接口前，两个 API 和通知 worker 都要完成升级。运行结果见[阶段 4 验收记录](booking-acceptance.md#阶段-4--滚动升级回滚与再发布)。

## 从提交构建并执行整场演练

在 WSL Ubuntu 或 Linux 中，从仓库根目录执行。需要 Git、Python 3.10+、Docker 和 Compose v2，首次构建需要访问镜像仓库和 npm。构建脚本从 Git 提交提取源码、锁文件和契约，在同一份 Dockerfile 中冻结安装。每个版本的 API、worker 和迁移任务使用同一个运行镜像。旧客户端镜像另外保留阶段 3 的 HTTP 客户端和契约校验器。

```sh
git fetch origin tag booking-drill-v1 tag booking-drill-v2
python3 -B deploy/build.py booking-drill-v1 --client
python3 -B deploy/build.py booking-drill-v2
python3 -B deploy/rehearse.py --output .tmp/stage4-run.json
```

脚本创建专用 Compose 项目、数据库卷和私有临时目录，同时启动两个 API、一个 worker、两个公司接收端和持续发送请求的旧客户端。成功时输出 JSON 汇总及同名 JSONL 逐请求记录。以退出码和最终的 `Acceptance passed` 判断结果。结束时回收该场演练使用的容器、网络、数据库卷和临时凭据。两个版本的镜像保留在本机，可重复使用。

## 逐步执行发布

手动环境的控制目录需位于 Linux 文件系统中，初始化时路径应尚未存在。每套环境有独立的数据库、JWT 密钥、通知加密密钥和两组 Webhook 密钥，它们在应用版本切换期间持续使用。`status` 返回公开入口、两个 API 的准入状态及三个应用容器的实际镜像 ID。

```sh
state="/tmp/booking-stage4-$(date +%s)-$$"
python3 -B deploy/release.py init --state "$state" --old booking-drill-v1 --new booking-drill-v2
python3 -B deploy/release.py status --state "$state"
python3 -B deploy/release.py upgrade --state "$state"
python3 -B deploy/release.py rollback --state "$state"
python3 -B deploy/release.py status --state "$state"
python3 -B deploy/release.py redeploy --state "$state"
```

| 步骤              | 放行条件与失败处理                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 迁移              | 单次任务对 `reservations` 增加可空的 `pickup_location`。事务对 DDL 锁最多等待 350 ms。失败会停止发布，旧实例继续接单。解除占锁事务后重试同一命令。                                                                                                        |
| API               | 代理先摘掉一个实例，等待活跃会话归零，另一实例继续服务。容器的停止宽限期为 15 秒。旧版以真实登录和设备列表验证准入，新版的 `GET /health/ready` 检查数据库、必需迁移和公司通知订阅。HAProxy 通过两版共有的 `HEAD /` 继续探测。未通过的候选保留在流量之外。 |
| 混合版本          | 第一台新版准入后保持至少 60 秒的双版本窗口。旧客户端沿用原响应结构。通过新版实例直连端口可定向检查地点接口，公共入口此时返回 503。                                                                                                                        |
| worker 与功能开放 | 第二台新版准入后替换 worker，校验镜像 ID 和就绪日志。随后开放独立的地点读写路由。演练分别在前进和回退前暂停 worker，留下已提交、可由接任者继续投递的通知。                                                                                                |
| 回滚              | 先关闭地点入口，逐个恢复旧 API 镜像，最后恢复同版 worker。保留数据库卷、迁移记录、地点及通知审计。旧客户端可读写升级期间创建的预约。                                                                                                                      |
| 再发布            | 使用已记录的同一新版镜像，重跑迁移检查和逐实例准入；重新开放入口后比对先前登记的地点。                                                                                                                                                                    |

遇到候选未就绪时，通过 `status` 检查另一实例是否仍为 `UP`，再修复配置并重试发布或执行回滚。代理按容器当前地址重新准入；如果另一实例也不可用，控制器会停止摘流。容器的直连端口和代理入口仅绑定本机回环地址，接收端与 worker 共享代理容器的网络命名空间以使用阶段 3 的本地回调地址。运行时通过私有 Unix socket 更新准入和地点入口。[HAProxy 实例状态](https://www.haproxy.com/documentation/haproxy-runtime-api/reference/set-server/) · [HAProxy 运行时 ACL](https://www.haproxy.com/documentation/haproxy-runtime-api/reference/add-acl/)

完成手动验证并确认可以清除该环境的数据后，执行以下命令。它会删除本次手动环境的卷及控制目录。去掉 `--purge` 可保留数据库卷和凭据。

```sh
python3 -B deploy/release.py down --state "$state" --purge
```
