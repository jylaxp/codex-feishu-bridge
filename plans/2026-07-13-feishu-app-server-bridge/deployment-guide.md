# 飞书 App Server 实时桥部署指南

日期：2026-07-13
状态：implemented，真实飞书显式会话绑定验收待执行

## 1. 发布基线

- Node.js：精确使用 `24.18.0`，项目根目录包含 `.nvmrc`。
- Codex：当前发布只支持 `codex-cli 0.144.3` 及锁定的 App Server schema digest。
- 构建产物：`dist/app/**`。
- 回滚基线：`f41396b` / `app-server-v2-baseline-20260713`。
- 本地状态：管理员显式配置的 `BRIDGE_DATA_DIR`；没有默认数据目录。

当前版本只支持单实例。每个飞书应用及 `BRIDGE_DATA_DIR` 同时只能运行一个 Bridge 进程；禁止 PM2
cluster、systemd 多副本或 Kubernetes `replicas > 1`。进程会在数据目录持有 `bridge.lock`；若发现锁内 PID
仍存活、锁文件所有者/权限异常、符号链接或无法安全判断的恢复竞争，启动会 fail closed。数据库唯一约束和
outbox lease 不能替代完整的多实例协调。

## 2. 配置

必填：

- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_TENANT_KEY`
- `ALLOWED_CHATS`
- `AUTHORIZED_USERS`
- `ALLOWED_APPROVERS`
- `CODEX_BIN`：Codex CLI 的绝对可执行路径
- `BRIDGE_DATA_DIR`：绝对私有数据目录

可选：

- `APP_SERVER_MODE=owned_stdio|managed_proxy`，默认 `owned_stdio`
- `APP_SERVER_SOCKET_PATH`：managed proxy 的自定义控制 socket
- `CODEX_CWD`：可选默认目录；省略时使用 `~/.codex-feishu-bridge`。任务使用整机访问模式
- `MAX_TEXT_LENGTH`：`1000..20000`，默认 `10000`
- `CARD_UPDATE_INTERVAL_MS`：`1000..2000`，默认 `1500`
- `MAX_QUEUED_TASKS`：`1..1000`，默认 `100`，达到上限后新 root 拒绝进入队列

当前没有 `BRIDGE_LOG_LEVEL` 或 `APP_SERVER_TRANSPORT` 配置。生产 CLI 只读取进程环境，不读取 `.env`，也不
支持 `--env`。应通过 systemd、launchd、容器 Secret 或其他服务管理器注入变量；项目根目录的
`.env.example` 仅是变量清单，不能写入真实凭证。

### App Server 模式

`owned_stdio` 由 Bridge 启动并持有独立 `codex app-server --stdio`，是默认生产模式。

`managed_proxy` 仅启动 `codex app-server proxy`，要求同一系统用户下已有运行中的 daemon：

```bash
codex app-server daemon start
codex app-server daemon version
```

只有完成 Desktop 页面 nonce 验收后，才能将 `managed_proxy` 宣称为页面同步模式。

## 3. 数据库与权限

没有外部数据库、MySQL DDL、菜单 SQL 或角色 SQL。Bridge 使用新的本地 SQLite `bridge.db`，不读取旧
`sessions.json`、`approvals.json`、`pushed_turns.json` 或 ChatGPT/Codex 私有数据库。

当前 schema 为 v5：

| 版本 | 内容 |
| --- | --- |
| v1 | 八张业务表、约束、索引和基础状态机 |
| v2 | decision-bound 审批 token；升级时旧 pending 审批 fail closed 为 `STALE` |
| v3 | 任务取消 token hash 与恢复查询索引 |
| v4 | inbox 保存待投递文本，并为 steer intent 增加恢复索引 |
| v5 | 飞书 chat 到 ChatGPT thread 的显式绑定；持久化 workspace；revision tombstone 防旧卡重放；多个 root 可共享同一 thread |

数据库打开时自动按顺序迁移，较旧二进制不能打开更新版本 schema。应用将数据、`logs`、`tmp` 目录设为
`0700`，主 DB 文件设为 `0600`；WAL/SHM 由私有目录保护。服务管理器 Secret、进程环境以及重定向产生的
stdout 日志权限、轮转和保留策略由部署侧负责。

数据库包含用户 prompt、脱敏的过程/结果投影和有限工具输出尾部，属于敏感业务数据。它不保存飞书/应用
凭证、action token 明文、原始 callback 或 raw CoT。备份、复制、诊断导出和销毁都必须按敏感数据处理。

`doctor` 会打开并迁移它所配置的 `bridge.db`，不是纯只读命令。因此升级已有数据目录前必须先停服务并做
一致性备份；运行时/协议预检可以先把 `BRIDGE_DATA_DIR` 临时覆盖为新的 scratch 目录。

## 4. 部署顺序

1. 执行 `nvm use`，确认 Node 为 `24.18.0`。
2. 执行 `npm ci && npm run check`。
3. 使用 scratch `BRIDGE_DATA_DIR` 运行 doctor，先验证 Node、Codex 版本、schema digest、cwd 和白名单。
4. 停止已有 Bridge，确认没有第二个实例。
5. 对整个生产数据目录做一致性备份，保留 DB/WAL/SHM；首次 clean-slate 启动可跳过备份。
6. 使用生产配置运行 doctor；此步会创建或迁移目标 `bridge.db` 到 v5。
7. 由服务管理器注入生产环境变量后，启动 `node dist/app/cli.js run`。
8. 在飞书测试群先执行 `/bind` 选择会话，再验证文本、重复投递、审批、拒绝、取消、重启恢复和终态卡。
9. 执行 `/binding` 核对默认绑定；在旧 root 中执行时同时核对其固定目标。Desktop 当前页面不参与路由。

## 5. 验收

- doctor 返回 `ok=true`，Codex/Node/schema digest 与发布合同完全一致。
- `failedOutboxCount=0`；非零必须先对账对应 CardKit 卡片。
- 合法消息先产生初始卡，再启动一个 turn；durable 重投不重复启动 thread/turn。
- 未绑定的普通消息持久化为拒绝且不启动 turn；绑定后重投同一 eventId 也不得执行。
- `/bind` 全局列出最近 8 个非归档 CLI/Desktop 会话，点击后再次读取确认；来源 cwd 不授予文件权限，后续
  任务和恢复固定使用经过预检的 `CODEX_CWD`。
- 非授权 tenant/chat/user、机器人、非文本和超长输入 fail closed。
- `accept`、`acceptForSession`、`decline`、`cancel`，以及非审批人、双击、过期、跨群和旧 runtime token
  行为正确。
- commentary、reasoning summary、命令输出和 final answer 不串区，raw reasoning 不落卡。
- terminal 卡稳定；CardKit sequence 从 1 严格递增，终态 close-streaming 与 final replace 均可恢复。
- 日志不含 secret、完整 prompt、原始 callback、raw CoT 或原始 SDK HTTP 参数。

初始 CardKit 创建跨网络超时或进程崩溃没有严格 exactly-once 保证，可能产生孤儿卡或停在
`CARD_CREATING`，需要人工对账。

## 6. 故障处置边界

- `CARD_SEQUENCE_CONFLICT`：outbox fail-stop，不猜测 N+1，不自动建替代卡；原卡可能保持旧内容，需要人工
  对账 CardKit 当前状态。
- `failedOutboxCount > 0`：根据 outbox 错误码对账；CardKit 冲突和永久错误不会自动清零。任务卡 JSON 本地
  限制为 29 KiB，避免触碰官方 30 KB 上限。
- `DISPATCH_UNKNOWN`：为避免重复执行而占住全局执行槽。重启可再次触发有完整 thread/turn 身份的 snapshot
  reconciliation；身份不完整时不得直接重发或手工改 DB，应保留现场并核对 App Server thread。
- `bridge.lock.recovery` 遗留：先确认没有 Bridge 或同数据目录恢复进程，再核验文件为当前用户所有、权限
  `0600` 且记录的 PID 不存活。无法证明安全时不要删除；保留现场后人工处理。
- managed proxy 连接失败：不回退 Desktop IPC 或私有数据库；生产继续使用 owned stdio。Desktop 当前页面
  不作为本版本的绑定或路由来源。

## 7. 回滚

回滚到实施前标签时，停止新进程并恢复旧启动命令。旧实现不读取新 `bridge.db`，新链期间的任务状态不会迁回
旧 JSON。

若未来回滚到较早的 App Server Bridge 二进制，必须停止进程并恢复该版本迁移前的完整数据目录备份；禁止让
旧二进制直接打开 v5。已经发送的飞书消息、CardKit 更新和 Codex turn 都是外部副作用，文件回滚不能撤销。
