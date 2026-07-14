# Codex Feishu Bridge 2

这是一个基于官方 `codex app-server` 的飞书实时桥。飞书文本消息被转换为 Codex thread/turn，App Server 的
`thread/*`、`turn/*`、`item/*` 事件驱动飞书 CardKit 卡片，命令和文件变更审批通过卡片按钮返回 App Server。

版本 2 是全新主链，不读取旧 JSON 会话、不访问 ChatGPT/Codex 私有数据库、不注入 Electron，也不依赖
Desktop IPC。飞书卡片是生产环境中确定可控的实时 UI；ChatGPT Desktop 页面同步必须通过独立验证命令实测。

## 数据流

```text
飞书 WebSocket 事件
  -> tenant/chat/user 白名单与 inbox 幂等
  -> /bind 从 thread/list 选择 ChatGPT 会话并持久绑定
  -> 先创建 CardKit 任务卡
  -> 只允许 thread/resume；未绑定时拒绝创建任务
  -> turn/start；同一 root 的运行中补充消息走 turn/steer
  -> App Server notification / approval request
  -> 内存事件归约 + SQLite durable state/outbox
  -> CardKit 完整卡片更新与 terminal finalize
```

核心保证：

- 初始卡片发送失败时不会启动模型。
- Bridge 从不替用户新建 ChatGPT 会话；每个飞书 chat 必须先显式选择已有会话。
- durable intake 完成后的重复飞书事件不会重复建 thread 或启动 turn；初始建卡跨网络崩溃不具备严格
  exactly-once，可能留下孤儿卡并需要人工对账。
- 当前版本只支持单实例部署，并且全局只允许一个写 turn；不同 root 按 durable 插入顺序等待，即使后到任务的
  CardKit 建卡先完成，也不能越过更早任务。
- mutating RPC 在 transport write 前记录真实 JSON-RPC ID；结果不确定时不盲目重发。
- commentary、reasoning summary、命令输出和 final answer 分区；raw reasoning 不落库、不进卡片。
- CardKit sequence 只在成功响应后推进，冲突时停止，不猜测下一序号。
- 审批令牌为随机一次性 token，绑定 tenant/chat/审批卡/epoch/decision/TTL。
- 任务取消令牌绑定 task，并在消费时校验 tenant/chat/任务卡及活动状态；它不绑定 epoch 或固定 TTL。

## 环境要求

- Node.js `24.18.0`，项目包含 `.nvmrc`。
- 本机可执行的 Codex CLI；当前发布只支持精确版本 `codex-cli 0.144.3` 及其已锁定 schema。
- 飞书自建应用已启用机器人、WebSocket 事件订阅和 CardKit/消息权限。
- `CODEX_CWD` 必须位于 `ALLOWED_WORKSPACE_ROOTS` 内。

```bash
nvm install
nvm use
npm ci
npm run check
```

## 配置

通过 systemd、launchd、容器 Secret 或其他服务管理器把配置注入进程环境。生产 CLI 不读取 `.env`，也不
支持 `--env`；项目根目录的 `.env.example` 仅是变量清单，不能存放真实凭证。所有白名单都必须显式配置，
空值会导致启动失败。

```dotenv
LARK_APP_ID=cli_0123456789abcdef
LARK_APP_SECRET=xxx
LARK_TENANT_KEY=tenant_key

ALLOWED_CHATS=oc_xxx
AUTHORIZED_USERS=ou_user_xxx
ALLOWED_APPROVERS=ou_approver_xxx

CODEX_BIN=/absolute/path/to/codex
CODEX_CWD=/absolute/path/to/project
ALLOWED_WORKSPACE_ROOTS=/absolute/path/to/project
BRIDGE_DATA_DIR=/absolute/path/to/private/bridge-data

# 默认 owned_stdio；如已验证 ChatGPT 与同一 app-server daemon，可切 managed_proxy。
APP_SERVER_MODE=owned_stdio
# managed_proxy 可选；不填时连接 Codex 默认控制 socket。
# APP_SERVER_SOCKET_PATH=/absolute/path/to/app-server.sock

MAX_TEXT_LENGTH=10000
CARD_UPDATE_INTERVAL_MS=1500
MAX_QUEUED_TASKS=100
```

`BRIDGE_DATA_DIR`、`logs`、`tmp` 会被设为 `0700`，主 SQLite 文件设为 `0600`。WAL/SHM 由私有目录
保护；服务管理器的 Secret、进程环境和重定向 stdout 日志权限由部署侧负责。应用只创建新的 `bridge.db`，
不迁移旧 JSON 状态。

当前没有多实例 lease。进程会在 `BRIDGE_DATA_DIR` 获取带所有者和存活 PID 校验的独占锁；每个飞书应用及
数据目录同时只能运行一个 Bridge 进程。禁止 PM2 cluster、systemd 多副本或 Kubernetes `replicas > 1`。

`managed_proxy` 只启动 `codex app-server proxy`，不会创建 daemon。使用前必须在同一系统用户下执行：

```bash
codex app-server daemon start
codex app-server daemon version
```

## 启动与检查

```bash
npm run build
node dist/app/cli.js doctor
node dist/app/cli.js run
```

也可以全局安装后运行：

```bash
codex-feishu-bridge doctor
codex-feishu-bridge run
```

`doctor` 会验证：

- Node 和内置 SQLite 版本；
- `CODEX_BIN` 的真实路径、版本和可执行权限；
- 当前 CLI 生成的 App Server JSON schema digest；
- cwd/allowed roots、白名单数量和数据库 migration；
- 当前选择的 `owned_stdio` 或 `managed_proxy` 模式。

输出中的 `failedOutboxCount` 必须为 `0`；非零代表至少一张卡已进入需人工对账的 fail-stop 状态。

飞书 WebSocket 的 `start()` 只有收到 SDK `onReady` 后才算成功。SDK 在 ready 后报告终止错误时，CLI 会先
完成受控停机再以失败退出，交给 systemd/launchd 等服务管理器重启，避免“进程存活但已不收消息”。

## ChatGPT 页面同步验证

App Server 可以确定驱动本 Bridge 和飞书 UI，但官方合同没有保证外部客户端追加 turn 后，已经打开的
ChatGPT Desktop 页面一定实时刷新。因此页面同步不作为未验证的生产承诺。

先列出当前 workspace 最近的 task：

```bash
codex-feishu-bridge validate-ui-sync
```

再对明确选择的测试 task 追加 nonce turn：

```bash
codex-feishu-bridge validate-ui-sync \
  --thread THREAD_ID
```

无 `--thread` 时，验证器只输出 `threadId`、`status`、`updatedAt`，不会输出会话名称、内容预览或本地路径。
验证器只使用 managed proxy，不读取生产 Bridge 数据库。输出会证明 Bridge 是否收到该 turn 的事件流，并把
Desktop 页面结论标记为 `manual_verification_required`。只有在页面中也看到同一 nonce 后，才能将部署配置切换
为 `APP_SERVER_MODE=managed_proxy` 并声明同 runtime 页面同步。

## 飞书产品行为

首次使用先在飞书中发送：

```text
/bind      列出最近 8 个 ChatGPT 会话并选择绑定
/binding   查看当前绑定
/unbind    解除绑定
```

`/bind` 只列出 `CODEX_CWD` 下最近 8 个会话；卡片不展示内容预览、完整 thread ID 或绝对路径。选择按钮使用
绑定 tenant/chat/operator、10 分钟过期的 HMAC token；绑定与解绑都会推进持久化 revision，旧选择卡不能在
解绑后重新生效。未绑定时普通消息会先持久化为拒绝再收到选择卡，不会调用 `thread/start`，也不会因事件重投
在稍后意外执行。重新绑定只影响
之后的新 root；已有 root 下的补充消息继续原任务，避免把运行中上下文切到另一个会话。

`ALLOWED_CHAT_IDS` 同时是卡片可见性的信任边界：群成员可以看到该群内的绑定标题、任务过程和最终结果。若群成员
不应看到这些信息，应使用与机器人的单聊或单独的受控群，不要把该群加入 allowlist。

一条新 root 消息会创建任务卡，包含：

- 用户输入；
- 当前任务状态；
- commentary 与可展示 reasoning summary；
- 命令/工具输出尾部；
- final answer；
- 取消按钮。

运行中同 root 的新消息通过 `turn/steer(expectedTurnId)` 追加。不同 root 在已有写 turn 时进入队列。

App Server 发出 command/file approval request 时，Bridge 发送独立审批卡：

- 批准一次：`accept`
- 本会话批准：`acceptForSession`
- 拒绝：`decline`
- 取消：`cancel`

`acceptForSession` 只在 App Server 的 `availableDecisions` 包含它时展示，并要求点击者同时属于
`ALLOWED_APPROVERS`。Bridge 不缓存或扩大 App Server 的会话授权范围。除会话绑定命令外，首期不处理附件、
模型/cwd 动态选择或自动本地文件上传。

CardKit 更新从 sequence `1` 开始且严格递增；每次 replace/finalize 都带 1–64 字节的幂等 UUID。任务卡
JSON 在本地限制为 29 KiB，为官方 30 KB 上限保留传输余量。终态先关闭 streaming mode，再替换最终卡；
两个成功检查点都写入 SQLite，重启后不会猜测 sequence。

CardKit sequence 冲突会 fail-stop：对应 outbox 记录标记为 `FAILED/CARD_SEQUENCE_CONFLICT`，不会猜测
下一个序号，也不会自动创建替代卡；原卡可能保持旧内容，需要人工对账。

## 持久化与恢复

SQLite 表：

- `inbox_event`
- `chat_thread_binding`
- `thread_binding`
- `task`
- `task_item`
- `rpc_intent`
- `approval`
- `card_outbox`
- `meta`

数据库启用 foreign keys、WAL、FULL synchronous、busy timeout、defensive mode，并禁止加载 extension。
当前 schema 为 v5；`chat_thread_binding` 保存飞书 chat 当前选中的 ChatGPT thread，root binding 保存任务
首次使用时捕获的选择；`inbox_event.payload_text` 仅为尚未确认送达的 `turn/steer` 提供崩溃恢复。数据库会保存
任务 prompt、脱敏后的展示摘要和工具输出尾部，因此整个 `BRIDGE_DATA_DIR` 必须按敏感业务数据管理；凭证、
action token 明文、原始飞书 callback 和 raw CoT 不入库。

App Server 断开后旧 epoch 审批会失效，活动任务进入 `RECOVERING`；重连使用 `thread/resume` 的 snapshot
收敛状态。无法证明身份或结果的任务进入 `NEEDS_REVIEW`，不会自动重发 turn。

对于运行中补充消息，Bridge 在同一事务中写入 inbox、明文 payload 和 PREPARED steer intent。只有能证明
从未写入 transport 的 PREPARED intent 才会在本进程内恢复发送；已标记 SENT 但无结果的 intent 进入
UNKNOWN，禁止盲目重放。排队任务可直接取消，重启恢复也会把对应 inbox 收敛到终态。

## 开发与验收

```bash
npm run typecheck:app
npm run test:app
npm run build:app
npm pack --dry-run
```

新生产代码仅位于 `src/app/`。架构测试禁止其 import 旧 `src/index.ts`、adapter、Desktop IPC、injector、旧
session/history/storage/media 模块。实施计划、部署说明、测试报告和代码审查报告位于
`plans/2026-07-13-feishu-app-server-bridge/`。
