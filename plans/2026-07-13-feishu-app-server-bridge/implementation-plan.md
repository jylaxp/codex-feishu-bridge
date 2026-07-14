# 飞书 App Server 实时桥实施方案

日期：2026-07-13
状态：implemented，真实飞书与 Desktop 页面验收待执行

## 1. 运行时基线

- Node.js：`24.18.0`，内置 SQLite `3.53.1`。
- Codex：配置的绝对 `CODEX_BIN`，当前开发机 CLI 为 `codex-cli 0.144.3`。
- 协议证据：`CODEX_BIN app-server generate-ts --experimental` 与 `generate-json-schema --experimental`。
- 飞书：`@larksuiteoapi/node-sdk` WebSocket EventDispatcher + CardKit OpenAPI。

## 2. 生产依赖图

```text
Lark WS Event
  -> MessageIntake
  -> BridgeStore (inbox/task/binding)
  -> CardProjector initial card
  -> TaskOrchestrator
  -> AppServerClient (stdio)
  -> EventReducer
  -> BridgeStore (task/item/outbox)
  -> OutboxWorker
  -> CardKit
```

新入口位于 `src/app/main.ts`。禁止 import 旧 `index/adapter/injector/codex dispatcher/history/client/core state/storage/commands/feishu media`。

进程启动先在私有数据目录获取 `bridge.lock`。锁恢复使用独立恢复互斥文件，并校验 regular file、所有者、
权限、PID 存活与锁身份；不能证明安全时 fail closed，避免同一 SQLite/CardKit writer 被两个进程同时驱动。

## 3. 模块边界

```text
src/app/
  main.ts                 composition root
  config.ts               pure env parsing and validation
  preflight.ts            Node/binary/workspace/schema checks
  task-orchestrator.ts    thread/turn business workflow
  approval-service.ts     server request and card action workflow
  recovery-service.ts     epoch, resume, reconcile
src/app/codex/
  app-server-client.ts    child transport and JSON message router
  protocol.ts             generated-schema-aligned narrow types
  event-reducer.ts        pure lifecycle reduction
src/app/db/
  database.ts             open, pragmas, transaction, migration
  schema.ts               versioned schema
  repositories.ts         typed persistence operations
src/app/lark/
  client.ts               SDK and token client
  intake.ts               authorization and event normalization
  event-server.ts         EventDispatcher wiring
src/app/cards/
  sanitizer.ts            output boundary
  layouts.ts              pure CardKit JSON
  cardkit-client.ts       HTTP/SDK adapter
  projector.ts            projection coalescing
  outbox-worker.ts        single writer and retries
src/app/domain.ts         immutable domain contracts
```

## 4. App Server 合同

连接状态：`DISCONNECTED -> CONNECTING -> INITIALIZING -> READY -> CLOSED/FAILED`。

握手：

1. 发送 `initialize` request，capabilities 明确设置 `experimentalApi`、`requestAttestation=false`。
2. 等待成功 response。
3. 发送无 id 的 `initialized` notification。
4. 只有 READY 后才允许业务 RPC。

消息分类：

- `id` 且无 `method`：response/error。
- `id` 且有 `method`：server-initiated request。
- 无 `id` 且有 `method`：notification。
- 其他：protocol error，记录脱敏诊断并丢弃。

核心请求严格按当前 schema：

- `thread/list/read`：仅用于飞书 `/bind` 会话选择和点击后的存在性复核。
- `thread/resume`：threadId + 相同安全配置，禁止 history/path 注入。
- `turn/start`：`input=[{type:'text', text, text_elements:[]}]`、clientUserMessageId、cwd、workspaceWrite policy。
- `turn/steer`：threadId、expectedTurnId、同样的 text input。
- `turn/interrupt`：threadId、turnId。

## 5. 数据模型

使用 `node:sqlite` `DatabaseSync`，配置 foreign keys、WAL、FULL synchronous、busy timeout、defensive mode、禁止 extension。

表：`meta`、`inbox_event`、`chat_thread_binding`、`thread_binding`、`task`、`task_item`、`rpc_intent`、`approval`、`card_outbox`。

关键事务：

- `/bind`：选择已有 ChatGPT thread，按 tenant + chat 持久化；不自动创建 thread。
- 新 root 入站：先幂等写 inbox；未绑定则持久化拒绝。已绑定时读取 chat binding，固定 thread/workspace 到 root 后写 task 草稿；网络调用在事务外。
- steer 入站：inbox 原文 + PREPARED RPC intent 原子写入；只有可证明尚未写 transport 的 intent 可恢复发送。
- RPC：prepare intent；发送前 mark SENT；response 后 RESOLVED；timeout/exit 后 UNKNOWN。
- 事件：task/item reduction + projection revision + outbox。
- 审批：approval + task awaiting + outbox；点击使用 CAS + response intent。
- 重连：epoch + stale approvals + active task recovering。

## 6. 任务状态

`RECEIVED -> CARD_CREATING -> STARTING -> RUNNING -> AWAITING_APPROVAL -> COMPLETING -> SUCCEEDED/FAILED/INTERRUPTED`

异常分支：`QUEUED`、`DISPATCH_UNKNOWN`、`RECOVERING`、`NEEDS_REVIEW`、`DELIVERY_DELAYED`。

终态不可逆。迟到 delta 可记录诊断，但不能改回 RUNNING 或追加到已 finalize 卡片。

## 7. Event reducer

- `turn/started`：正常只接受已由 `turn/start` response 持久化的 turn。response 竞态窗口内的通知按 threadId + turnId 有界暂存，只有精确 turnId 持久化后才回放；同 thread 外部 turn 永不归属。
- `item/started`：创建 item，保存类型和 agent phase。
- `item/agentMessage/delta`：先写 item buffer；phase 未知时不提升为 final。
- `item/completed agentMessage`：以 completed item 的 phase 和完整 text 覆盖；`final_answer` 才进入 final 区。
- `item/reasoning/summaryTextDelta`：进入可展示 reasoning summary。
- `item/reasoning/textDelta`：默认不投影，避免 raw CoT。
- `item/commandExecution/outputDelta`：仅保留脱敏、限长 tail。
- `item/completed commandExecution`：投影命令和限长输出摘要；file change 首期只处理审批，不展示 diff。
- `error`：记录 retry 状态；不可恢复错误进入 FAILED。
- `turn/completed`：以 turn.status 收敛并触发 terminal barrier。

## 8. CardKit

初始卡固定区域：输入、当前状态、过程、工具、最终结果、页脚、取消按钮。

投影路径：reducer 只更新 DB/投影状态；projector 每 1–2 秒 coalesce；outbox worker 按 card ID 串行发送。审批、错误、中断、完成使用立即 outbox。

CardKit 首次更新使用 sequence `1`，之后严格递增；replace/finalize 都带稳定幂等 UUID。任务卡 JSON 本地
限制为 29 KiB。终态 outbox 先关闭 `streaming_mode`，成功后再替换最终卡，两个步骤分别持久化检查点。

sequence 仅在成功响应后递增。sequence 冲突不盲目递增，对应 outbox 标记为
`FAILED/CARD_SEQUENCE_CONFLICT` 并停止发送。当前不自动创建替代卡，需人工对账。

## 9. 安全

- allowlist 空值启动失败。
- `CODEX_BIN` 必须绝对、可执行；spawn 不经过 shell。
- cwd 每次执行前 realpath 验证。
- action token 256-bit 随机值，DB 存 SHA-256。
- 所有外部文本经过 sanitizer：secret、绝对敏感路径、ANSI/control、CardKit markup、长度。
- 不打印凭证、完整 callback 或完整 prompt。
- 不读取/上传模型输出中的本地路径。
- 飞书 SDK logger 丢弃原始 HTTP/Axios 参数，只输出固定脱敏诊断。
- `MAX_QUEUED_TASKS` 和飞书 handler 并发上限共同限制内存与持久化积压。
- waiting task 按 SQLite durable 插入顺序调度；`CARD_CREATING` 也参与 FIFO 屏障，后完成建卡的早期任务不会
  被后到任务越过。建卡失败会释放屏障并启动下一个已就绪任务。
- 飞书 WebSocket 只有 SDK `onReady` 后才完成启动；ready 后的终止错误通过 runtime failure 通道触发 CLI
  受控停机和非零退出。

## 10. ChatGPT UI capability

验证器只允许本机管理员显式运行，固定使用 managed proxy 和配置的 `CODEX_CWD`。不传 thread 时列出候选；
传入明确 thread 后以 read-only sandbox resume 并追加 nonce turn。evidence JSON 记录 thread/turn/nonce、收到的
事件方法和完成状态，只证明 Bridge 事件流；Desktop 页面仍需人工确认同一 nonce。验证器不创建 scratch
thread、不自动读取页面，也不修改生产健康状态。
