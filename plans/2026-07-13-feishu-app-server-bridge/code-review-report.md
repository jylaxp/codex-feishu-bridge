# 飞书 App Server 实时桥代码 Review 报告

日期：2026-07-14
Review 范围：`chatgpt-v2` 相对基线 `f41396b` 的完整实现
状态：P0/P1 已清零；显式会话绑定自动化通过，外部联调项保留为未验证

## 1. 结论

实现采用 clean-slate 生产图，只保留官方 Codex App Server、飞书 SDK/CardKit 和新的 SQLite durable state。
三路最终审查覆盖架构/生命周期、数据一致性、权限/内容安全；发现的高置信 P1 均已修复并补回归测试。
产品路由不依赖 Desktop 当前页面：用户在飞书 `/bind` 选择一次既有 ChatGPT 会话，Bridge 持久保存目标并将
后续消息固定发送到该会话。

## 2. 开发前阻断项及处理

| 级别 | 原风险 | 处理结果 |
| --- | --- | --- |
| P0 | 带 id 的 server request 被误判 response，且缺失 `initialized` | 新 App Server client 严格分流并完成握手 |
| P0 | allowlist 空值放行、cwd fallback、完整 prompt 日志 | 配置/preflight/intake fail closed，日志边界重写 |
| P0 | 可重放审批、无 epoch/decision/CAS | decision-bound hash token、权限/epoch/TTL/CAS |
| P0 | CardKit sequence 仅内存、冲突盲增、异常吞掉 | durable 单 writer outbox、严格 sequence、冲突 fail-stop |
| P0 | 模型 Markdown 可触发本地文件读取/上传 | 新图不依赖 media，展示边界阻断本地路径和 Markdown 激活 |
| P1 | 旧入口混合 command/session/IPC/deep-link/DB patch | package 与架构测试只暴露 `src/app` 新入口 |

## 3. 最终审查发现及修复

| 级别 | 发现 | 修复与验证 |
| --- | --- | --- |
| P1 | ready 后飞书 WebSocket 终止会静默失联 | runtime failure 通道触发 CLI drain/stop/非零退出；补 ready 后终止测试 |
| P1 | SDK/卡片边界遗漏带凭据 URI 和紧凑/带空格绝对路径 | 增加 PostgreSQL/HTTP/Redis URI、Unix/Windows/quoted path 脱敏测试 |
| P1 | reclaimed 旧 projection 在 CardKit 已成功、DB ACK 前崩溃时会错误 supersede | 仅首次未发送 claim 可 supersede；reclaim 使用同 UUID 重放并 ACK |
| P1 | CardKit response body 读取断流被当永久错误 | 转为 `NETWORK_RETRYABLE`，稳定 UUID 有界重试 |
| P1 | supervisor stop 与 deferred reconnect 竞态可遗留新 child | generation cancel、reconnect stop gate、active reconnect 后最终 stop |
| P1 | child 只等 exit，异步 spawn error/kill false 可永久挂停机 | `exit/close` 双边界、SIGTERM/SIGKILL 双有界等待、明确失败 |
| P2 | task/turn/source inbox 分步提交存在崩溃不一致 | dispatch/steer/failure/recovery 使用 `BEGIN IMMEDIATE` 原子收敛并检查 CAS |
| P2 | 并发 CardKit 建卡可让后到 root 先执行 | `CARD_CREATING` 纳入 durable FIFO；更早任务失败后显式释放队列 |
| P1 | bind/unbind 后旧选择卡可能发生 ABA 重放 | 绑定保留 tombstone 与单调 revision；token 绑定 revision 并补回归测试 |
| P1 | 未绑定消息在后续绑定后可能因飞书重投被执行 | 入站事件持久化为 `REJECTED`，同 eventId 后续始终幂等拒绝 |
| P1 | thread workspace 与固定 `CODEX_CWD` 不一致时可能错误执行 | `/bind` 只列当前工作区；点击后校验并持久化 canonical workspace，执行/恢复均使用绑定值 |
| P1 | `turn/start` 响应前收到事件可能丢失或串到同 thread 的其他 turn | 使用有界早到缓冲，持久化返回的 turnId 后仅按精确 threadId + turnId drain |
| P2 | 旧 root 仍固定旧 thread，但 `/binding` 与任务卡不显示覆盖关系 | `/binding` 显示默认绑定与当前 root 固定目标；每张任务卡显示实际目标指纹 |
| P2 | `/unbind` 重投可能清除后来建立的新绑定 | 命令纳入 durable inbox 幂等，重复 eventId 不产生第二次副作用 |

数据审查提出的“v3 非空行迁移后重投正文兼容”未实施：用户已明确本次不考虑兼容，且新生产链不迁移旧
Bridge 状态。schema migration 仅用于本版本内部演进和测试，不承诺旧产品数据接入。

## 4. 安全与架构复核

- 鉴权：tenant/chat/user/approver 均显式白名单，空列表启动失败。
- 审批/取消：卡片只有 opaque token；DB 只存 hash；绑定 tenant/chat/card/runtime/decision/TTL/操作者权限。
- 执行：绝对 `CODEX_BIN`、spawn 无 shell、cwd realpath allowlist、子进程环境最小白名单。
- 内容：不投影 raw CoT；secret/DSN/path/ANSI/control/CommonMark 在 CardKit 边界处理；SDK 原始 HTTP 参数丢弃。
- 资源：文本、reducer、命令 tail、卡 JSON、handler 并发、等待队列和 RPC/HTTP timeout 均有硬上限。
- 状态：单进程锁、durable RPC intent、UNKNOWN 不重放、CardKit outbox 和 terminal 双检查点。

## 5. 剩余风险与接受理由

- 初始任务卡/审批卡的外部创建与 SQLite 提交没有分布式事务，极端崩溃可能留下孤儿卡；使用 UUID、hash
  token、UNKNOWN 和人工对账控制影响，不能声明跨系统 exactly-once。
- `CARD_SEQUENCE_CONFLICT` 无 CardKit 权威读接口可安全自动修复，保持 fail-stop 并通过 doctor 暴露
  `failedOutboxCount`。
- `bridge.lock.recovery` 无法证明安全时故意拒绝自动删除；部署文档提供人工核验流程。
- 当前产品不读取 Desktop 当前页面，也不以页面自动刷新作为路由条件；绑定对象由飞书 `/bind` 显式选择。
- 真实飞书权限、CardKit 错误码和页面可见性需要指定测试应用/群完成外部验收。
- CardKit 初始或终态永久投递失败仅由 durable outbox、日志和 doctor 暴露，没有额外文本消息兜底；保持
  fail-stop，需按部署手册人工对账。

## 6. Review 门禁

- `src/app` import graph 和发布包无旧 IPC/injector/session/media 主链。
- 所有 P0/P1 有对应实现或测试证据，无未处理高置信阻断项。
- `npm run check`、pack dry-run、doctor、真实 owned-stdio smoke 结果见 `test-report.md`。
- 实现保持未提交，便于用户审阅；实施前基线 commit/tag 已独立保留。
