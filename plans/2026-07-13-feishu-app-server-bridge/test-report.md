# 飞书 App Server 实时桥测试报告

日期：2026-07-14
环境：macOS / Node 24.18.0 / npm 11.16.0 / codex-cli 0.144.3
状态：显式会话绑定自动化门禁通过；生产数据迁移与飞书 `/bind` 实机验收进行中

## 1. 结论

新 `src/app` 生产链通过类型检查、190 个自动化测试、构建、发布包检查、doctor、真实 owned-stdio App
Server turn，以及飞书单聊文本输入到 CardKit 终态的基础闭环。当前版本要求用户先在飞书执行 `/bind`，从
全局最近的既有 ChatGPT 交互会话中显式选择并持久绑定；后续消息固定进入该会话，不读取或跟随 Desktop 当前
页面。执行权限始终由配置的 `CODEX_CWD` 控制，不继承会话历史 cwd。未执行的审批、工具流和故障恢复实机
用例仍保持未验收状态。

## 2. 自动化门禁

| 范围 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| 全部门禁 | `npm run check` | PASS | typecheck、190/190 tests、build、pack dry-run 均通过 |
| 发布包 | `npm run check:package` | PASS | 139 files，172.3 kB（unpacked 819.1 kB）；仅 `dist/app`、README、env inventory |
| 架构隔离 | `test/app/architecture.test.ts` | PASS | 新入口不 import 旧 IPC/injector/session/media；package 仅发布新图 |
| 格式 | `git diff --check` 与 `git diff --cached --check` | PASS | 最终改动无 whitespace error |

`check:package` 通过无 shell 的 Node 子进程调用当前 npm，并固定使用系统临时目录中的隔离 cache，避免本机
历史 `~/.npm` cache 所有权影响发布门禁。

## 3. 关键测试覆盖

| 领域 | 已验证行为 |
| --- | --- |
| App Server | initialize/initialized、三类 JSON-RPC 分流、UTF-8 分片、严格版本、timeout/exit/write UNKNOWN、旧 epoch 隔离、SIGKILL 收口 |
| 会话绑定 | `/bind` 全局最近交互会话、点击复核、来源 cwd 与执行权限解耦、HMAC token、单调 revision/tombstone、防 ABA 重放、`/binding`、幂等 `/unbind` |
| 入站与编排 | tenant/chat/user fail closed、durable 幂等、初始卡先行、绑定 thread 的 resume/start/steer/queue/cancel、固定安全执行 workspace、队列硬上限 |
| 事件归属 | `turn/start` 响应前的早到事件有界缓冲；仅精确 `threadId + turnId` 可认领，同 thread 外部 turn 不串入 |
| 崩溃恢复 | PREPARED 可证明未发送才恢复；SENT/UNKNOWN 不重放；resume/snapshot、pending cancel、terminal 重投影 |
| 审批 | `accept`、`acceptForSession`、`decline`、`cancel`；权限、作用域、TTL、旧 epoch、双击与 UNKNOWN |
| CardKit | sequence 从 1 严增、稳定 UUID、429/5xx 有界重试、冲突 fail-stop、终态双检查点、29 KiB 限制 |
| 内容安全 | SDK 参数丢弃、secret/DSN/路径/ANSI/CommonMark 脱敏、raw reasoning 丢弃、reducer 总量上限 |
| 生命周期 | 单进程锁、恢复互斥、App Server 重连、飞书 WS ready gate、ready 后终止触发 CLI 停机失败 |

## 4. 本机真实运行验证

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| doctor | PASS | `ok=true`，Node 24.18.0，SQLite 3.53.1，schema v5，failedOutboxCount=0 |
| Codex 合同 | PASS | binary 为本机 0.144.3，schema digest `3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7` |
| owned-stdio full turn | PASS | `gpt-5.6-sol` 真实调用成功；飞书任务建立 thread/turn 并返回最终文本 |
| managed daemon | NOT RUN | `codex app-server daemon version` 返回 connection refused；未擅自启动用户 daemon |
| 飞书显式选择会话 | PENDING | 新版本启动后在 Codex Control Bot 执行 `/bind` 并核对持久绑定 |
| 真实飞书 WebSocket/CardKit | BASIC PASS | 单聊任务 `f1ab1d54` 为 SUCCEEDED，sequence=4，3 条 outbox 全部 DELIVERED |

## 5. 上线前仍需执行

1. 在 Codex Control Bot 执行 `/bind`，选择目标会话；确认 `/binding` 与任务卡展示同一目标指纹。
2. 继续运行重复投递、四种审批、取消、重启恢复、CardKit 429/5xx 与 sequence conflict 验收。
3. 确认 CardKit 首次 sequence=1、最终 close-streaming 后 replace、`failedOutboxCount=0`。

## 6. 已知外部一致性边界

初始 CardKit 创建、审批卡创建与本地 SQLite 提交跨两个系统，无法取得分布式事务；极端网络超时/进程崩溃
可能留下孤儿卡。实现通过稳定 UUID、durable intent/outbox、UNKNOWN 和人工对账降低重复副作用，但不声明
跨系统 exactly-once。
