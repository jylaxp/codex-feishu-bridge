# 飞书 App Server 实时桥前后端开发计划

## 1. 开发边界

“前端”是飞书 CardKit；“后端”是本机 Bridge、SQLite、App Server client。没有独立 Web 页面。

本期只接受文本任务。旧命令、旧 session、附件和 ChatGPT 私有 API 不兼容、不迁移。

## 2. 后端任务

| Task | Files | 验收 |
| --- | --- | --- |
| 配置与 preflight | `src/app/config.ts`, `src/app/preflight.ts` | allowlist/cwd/binary/Node/Lark App ID fail closed |
| 数据库 | `src/app/db/*` | migration、WAL、约束、CAS、重开通过 |
| App Server client | `src/app/codex/app-server-client.ts`, `protocol.ts` | 握手与三类消息分流通过 |
| Task 编排 | `src/app/task-orchestrator.ts` | root/thread、start/steer/interrupt、durable FIFO、队列上限与 steer 恢复正确 |
| reducer | `src/app/codex/event-reducer.ts` | item phase、reasoning summary、terminal 正确 |
| 审批/恢复 | `approval-service.ts`, `recovery-service.ts` | 四种决策、token/CAS/epoch/UNKNOWN/reconcile 正确 |

## 3. CardKit 任务

| Task | Files | 验收 |
| --- | --- | --- |
| 纯布局 | `src/app/cards/layouts.ts` | loading/running/approval/final/error 可读 |
| sanitizer | `src/app/cards/sanitizer.ts` | secret/path/ANSI/control/markup 被处理 |
| CardKit client | `src/app/cards/cardkit-client.ts` | timeout、错误分类、sequence/UUID/settings 严格 |
| projector/outbox | `projector.ts`, `outbox-worker.ts` | 1–2 秒合并、29 KiB 上限、单 writer、terminal barrier |
| action handler | `src/app/lark/event-server.ts` | cancel/approval 权限、token、幂等 |

## 4. 接口契约

飞书消息规范化为：

```ts
interface InboundTextMessage {
  tenantKey: string;
  eventId: string;
  messageId: string;
  chatId: string;
  rootMessageId: string;
  senderOpenId: string;
  text: string;
  createdAtMs: number;
}
```

Card action 只允许：

```ts
{ action: 'approval' | 'cancel', token: '<opaque>' }
```

卡片不得携带 threadId、turnId、cwd、RPC request id 或 decision 之外的权威上下文；decision 由 token 对应的服务端记录决定。

## 5. 联调顺序

1. Mock App Server + fake CardKit 完成端到端测试。
2. 本机真实 owned-stdio App Server 在配置 workspace 验证握手和只读 `thread/list`。
3. 飞书测试群验证 WebSocket `onReady` 后启动、卡片、四种审批决策和取消。
4. managed-proxy nonce turn + Bridge 事件证据 + ChatGPT Desktop 页面人工观察。

## 6. 页面验收

- 初始卡先于模型执行出现。
- 过程区不会挤掉最终结果区。
- 审批按钮窄屏可用，已处理后不可重复点击。
- running/recovering/delayed/terminal 均有文字状态，不只靠颜色。
- 长内容被截断但不会产生本地文件上传。
