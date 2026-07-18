# Codex Feishu Bridge 2

一个本机、单用户的飞书控制桥：飞书的消息被投递到已绑定的 ChatGPT Desktop 会话；Desktop owner runtime 负责在 ChatGPT 页面执行和渲染，Bridge 将同一 turn 的状态实时投影为飞书 CardKit 卡片。

Bridge 不读取或修改 ChatGPT/Codex 数据库、不注入 Electron，也不保存 prompt、回复、推理、审批、队列或卡片状态。唯一跨重启文件是 `bindings.json`：它记录“当前飞书 chat 绑定到哪个 ChatGPT thread”及静态执行设置。

## 运行链路

```text
飞书消息/卡片操作
  -> tenant/chat/user allowlist
  -> bindings.json 取得精确 threadId
  -> ChatGPT Desktop follower IPC: start / steer / interrupt / approval
  -> Desktop thread-stream snapshot/patch (version 11)
  -> 内存任务状态 -> 原消息所在会话/话题中的 CardKit 卡片
```

App Server 只承担控制面：会话列表、创建/派生/归档、目标/压缩、技能/MCP 查询和账户窗口用量。它不执行飞书的模型 turn。

当前精确支持 `codex-cli 0.144.3` 和 `codex-cli 0.145.0-alpha.18`，其中 145 是当前优先升级版本。Bridge
启动时根据 `CODEX_BIN` 的精确版本和完整 experimental schema digest 自动选择 profile，并在 App Server
initialize 时再次核对实际版本；未知版本、未知 digest 或 144/145 交叉错配都会在 Desktop 和飞书连接前
失败。完整证据见 [App Server 支持矩阵](docs/app-server-support-matrix.md)，新增版本流程见
[App Server 升级运行手册](docs/app-server-upgrade-runbook.md)。

生产任务的 start/steer/interrupt、审批和 live event 始终由 ChatGPT Desktop IPC 负责，App Server 多版本
选择不会改变这条执行链。`managed_proxy` 模式的 initialize identity 只能佐证 proxy 自报版本，不能证明
socket 后 daemon 的完整 schema；操作员必须把远端 daemon 精确钉在已支持 profile。

## 安装方式

要求 Node.js `>=20.17.0 <21`，推荐通过项目 `.nvmrc` 使用已验证的 `20.20.1`，并且当前登录用户可以正常使用 ChatGPT Desktop。当前发布接入的是经过验证的 macOS Desktop IPC；Windows 适配后续单独接入。

### 方式 A：从 GitHub 全局安装（推荐）

```bash
npm install -g git+https://github.com/jylaxp/codex-feishu-bridge.git
```

安装完成后，终端会提供 `codex-feishu-bridge` 命令。

### 方式 B：从本地源码安装

```bash
nvm install
nvm use
npm ci
npm link
```

也可以使用 `npm install -g .` 代替 `npm link`。

### 方式 C：本地安装包

在源码目录打包：

```bash
npm pack
```

把生成的 `.tgz` 文件复制到目标机器，然后安装：

```bash
npm install -g ./codex-feishu-bridge-2.0.0.tgz
```

`.tgz` 包含 Bridge 编译产物；npm 会按标准包安装流程解析运行依赖，因此目标机器首次安装时需要能访问配置的 npm registry，或已经具备对应依赖缓存。

## 初始化与飞书扫码绑定

默认配置为 `~/.codex-feishu-bridge/.env`。`BRIDGE_CONFIG_HOME` 可改为当前机器的绝对路径；显式进程环境优先于 `.env`。请从 `.env.example` 复制并按机器实际路径填写，不要复制其他开发者的路径。

新用户可以直接运行前台或后台启动命令。若 Bridge 检测到飞书应用凭证为空或仍是占位值，会自动进入扫码注册流程：

```bash
codex-feishu-bridge run
# 或直接后台启动
codex-feishu-bridge start
```

也可以显式执行：

```bash
codex-feishu-bridge setup
```

终端会显示飞书授权链接和二维码。用飞书扫码确认后，Bridge 自动创建自建应用、取得 `LARK_APP_ID` 和 `LARK_APP_SECRET`，并写入 `~/.codex-feishu-bridge/.env`。

`LARK_TENANT_KEY`、`ALLOWED_CHATS`、`AUTHORIZED_USERS`、`ALLOWED_APPROVERS` 默认都可以为空。机器人收到第一条单聊消息时，会自动把该租户、当前单聊和发送者保存为 owner/审批人，不需要用户先查询 Open ID，也不需要额外发送绑定指令。为了避免误开放，首次群聊消息不会自动认领。

如果使用已有飞书机器人，可以先生成手工配置骨架：

```bash
codex-feishu-bridge init
```

然后编辑 `~/.codex-feishu-bridge/.env`，填写已有的 `LARK_APP_ID` 和 `LARK_APP_SECRET`。

需要重新绑定机器人时：

```bash
codex-feishu-bridge rebind
# 或
codex-feishu-bridge setup --rebind
```

```dotenv
LARK_APP_ID=cli_0123456789abcdef
LARK_APP_SECRET=replace_me
LARK_TENANT_KEY=
ALLOWED_CHATS=
AUTHORIZED_USERS=
ALLOWED_APPROVERS=
# 是否按任务汇总审批卡：0 = 默认，每项审批各发一张卡；1 = 同一任务的全部审批汇总为一张卡。
APPROVAL_SUMMARY_MODE=0

# owned_stdio 由 Bridge 启动 CODEX_BIN；managed_proxy 需要操作员另行钉住远端 daemon。
APP_SERVER_MODE=owned_stdio
# 仅 managed_proxy 按需设置。
# APP_SERVER_SOCKET_PATH=/absolute/path/to/app-server.sock

CODEX_BIN=/absolute/path/to/codex
# 可省略；默认使用 ~/.codex-feishu-bridge
CODEX_CWD=/absolute/path/to/default/directory

# 旧配置语义继续保留
RATE_LIMIT_QUERY_INTERVAL_MS=300000
LOG_TO_FILE=false
LOG_FILE_PATH=bridge.log
ENABLE_AUTO_FILE_UPLOAD=false
ALLOWED_SHELL_COMMANDS=ls,pwd,git,find,cd
```

`CODEX_CWD` 只决定未单独绑定目录时的默认启动目录；省略时使用 `BRIDGE_CONFIG_HOME`（通常是 `~/.codex-feishu-bridge`）。每个 Codex 任务以 `dangerFullAccess` 启动，可以读取和修改本机任意路径，不再使用 `ALLOWED_WORKSPACE_ROOTS` 白名单。

`APPROVAL_SUMMARY_MODE=0`（或留空）时，保持原应用的审批投递方式：每次审批都会发出一张独立审批卡。设为 `1` 时，同一个任务只保留一张审批汇总卡；后续审批会更新到该卡中，每个审批区块仍独立显示命令、原因和三个操作按钮。无论哪种模式，任一审批作出选择后，该审批区块的全部按钮都会禁用。

`LOG_TO_FILE=true` 时，Bridge 写脱敏、轮转的运行日志；相对 `LOG_FILE_PATH` 位于 config-home 的 `logs/`，绝对路径按用户显式配置处理。日志不会记录 prompt、回复或 CardKit payload。`ENABLE_AUTO_FILE_UPLOAD=true` 时，最终回复中指向绝对本地路径的非图片 Markdown 文件会作为同一飞书话题的文件回复上传；文件数量、类型和大小校验仍然保留，该信息不会保存到 Bridge 文件。

持久业务数据只有 `.env` 和 `bindings.json`。Bridge 不创建 SQLite、WAL、任务历史或恢复队列。后台模式还会生成 `bridge.pid` 和 `logs/`，它们只用于进程管理与运行日志，不保存 prompt、模型回复、推理、工具输出或卡片 payload。Bridge 崩溃/重启、Desktop 断开或网络结果未知时，当前进程内任务直接停止跟踪且绝不自动重放，用户可在 ChatGPT Desktop 继续处理或重新从飞书发送。

## 启动方式

### 前台运行（调试）

```bash
codex-feishu-bridge run
```

源码开发时等价命令为：

```bash
npm run build
node dist/app/cli.js run
```

### 后台常驻运行

```bash
codex-feishu-bridge start
```

后台启动会写入：

- PID：`~/.codex-feishu-bridge/bridge.pid`
- 标准日志：`~/.codex-feishu-bridge/logs/bridge_stdout.log`
- 错误日志：`~/.codex-feishu-bridge/logs/bridge_stderr.log`

一个 config home 同时只允许一个 Bridge 进程。运行期获得带 PID/所有者校验的私有锁；配置重置也有独立锁，二者互斥。

## 维护方式

```bash
# 查看后台进程状态和日志位置
codex-feishu-bridge status

# 重启后台服务
codex-feishu-bridge restart

# 停止后台服务
codex-feishu-bridge stop

# 从 GitHub 全局更新并重启
codex-feishu-bridge update

# 强制重新安装当前版本并重启
codex-feishu-bridge update --force

# 检查本机配置、App Server protocol profile 和运行依赖
codex-feishu-bridge doctor
```

`doctor` 会生成配置 binary 的完整 experimental schema digest，并报告
`protocolProfileId`、`codexVersion`、`schemaDigest`、`appServerMode` 和
`appServerIdentityAssurance`。doctor 只做本机探测；正式启动还会用 initialize identity 核对实际 App Server
版本。`managed_proxy` 的 assurance 会明确显示为操作员信任的版本佐证，而不是远端 schema 证明。

实时查看日志：

```bash
tail -f ~/.codex-feishu-bridge/logs/bridge_stdout.log
tail -f ~/.codex-feishu-bridge/logs/bridge_stderr.log
```

旧版本数据结构升级使用显式重置，不迁移旧会话、任务或审批状态：

```bash
# 只查看将保留/删除什么，不写文件
codex-feishu-bridge config reset

# 仅在旧目录时执行：保留 .env 的注释、顺序、未知键，清空 bindings
codex-feishu-bridge config reset --confirm

# 当前已经是新结构时，只有明确 destructive 才会清空已有 bindings
codex-feishu-bridge config reset --confirm --destructive
```

重置会将 `.env` 中的 `BRIDGE_CONFIG_VERSION` 升级为 `2`，删除所有旧运行文件，并要求用户重新 `/bind`。

## 飞书完整指令

以下指令按原应用 README 和原 router 恢复；参数形式和别名均保留：

| 指令 | 行为 |
| --- | --- |
| `/help`、`/h`、`help`、`h` | 显示完整帮助卡片 |
| `/bind`、`/l`、`/list` | 按本地项目分组显示会话下拉列表；若聊天已有绑定，同时推送最近一条已完成历史记录 |
| `/ll` | 以 Table 表格显示会话名称和所属项目，并在卡片底部选择绑定；保留旧版尾随参数形式 |
| `/binding` | 显示当前精确绑定和“在 ChatGPT 中打开”按钮 |
| `/open` | 打开当前绑定的 ChatGPT Desktop 会话，不改变投递目标 |
| `/unbind` | 只解除当前飞书聊天的绑定，不归档 ChatGPT 会话 |
| `/new [名称]`、`/create [名称]` | 创建、命名、绑定并打开新会话；名称省略时自动生成 |
| `/fork [名称]`、`/branch [名称]` | 从当前会话派生、命名、绑定并打开新会话 |
| `/delete`、`/archive` | 归档当前 ChatGPT 会话并解除绑定 |
| `/cwd [路径]`、`/workspace [路径]` | 查询或修改当前绑定会话的工作目录；路径必须位于授权 workspace 内 |
| `/cmd [命令]`、`/run [命令]`、`/shell [命令]` | 在当前工作目录执行白名单命令 |
| `/goal [目标]` | 设置长期目标并立即启动执行 |
| `/goal` | 显示当前目标、状态、Token 和执行时长 |
| `/goal clear`、`/goal -c` | 清除当前目标 |
| `/usage`、`/quota` | 显示当前账户 7d 窗口用量和重置时间 |
| `/mcp` | 以状态卡显示 MCP 服务、认证和启用状态 |
| `/model` | 从本地模型缓存生成下拉选择卡 |
| `/model [名称]` | 直接设置之后新 turn 使用的模型 |
| `/personality [friendly\|pragmatic\|none]`、`/style [...]` | 查询或设置回复风格 |
| `/compact`、`/compress` | 请求压缩当前会话上下文 |
| `/plan [on\|off]` | 查询/切换计划模式；不带参数时切换当前状态 |
| `/status` | 显示会话名称、ID、CWD、模型、风格、计划模式、技能和目标 |
| `/skills` | 显示工作区技能并可下拉选择下一条消息使用的技能 |
| `@技能名称 [内容]` | 在普通消息中直接调用指定技能 |
| `/cancel`、`/stop` | 停止当前运行任务；任务卡“停止任务”按钮行为相同 |
| `/<白名单命令> [参数]` | 保留原 router 的未知 slash fallback，例如 `/pwd`；首命令仍必须在 `ALLOWED_SHELL_COMMANDS` 中 |

`/bind`、会话选择、模型选择、技能选择和打开按钮都限制 tenant/chat、授权用户、binding revision 和 10 分钟 TTL；过期卡片不能改变当前绑定。

飞书消息必须先显式绑定既有会话。普通任务通过 Desktop follower IPC 进入这个精确 thread：新 root 走 start，同 root 运行期间的补充消息走 steer，不同 root 排队。`@技能名称` 文本会原样保留并进入 Desktop runtime；当前 Desktop follower 协议没有独立的结构化 skill 字段，Bridge 不会猜测或重写技能内容。

会话可见性由 `ALLOWED_CHATS` 决定。首次安装时这些飞书内部 ID 都可以为空：第一个私聊机器人的用户会自动成为 owner，并绑定当前单聊。绑定后卡片会作为发起消息的 reply，始终留在原会话/原话题，而不是临时会话。群聊不会自动放开；需要先完成单聊 owner 绑定，再由 owner 显式允许群聊。

## 卡片和审批

任务卡保留原有 `🌌 Codex Remote Control` 流式布局、Prompt/metadata/推理过程/工具折叠面板/最终结果/统计页脚和固定 element ID。运行中显示 `▍` 光标；终态先关闭 streaming mode，再替换完整成功、失败或取消卡。页脚随 Desktop stream 和共享 TTL 的 account/rate-limit 查询更新模型、输入/输出 token、上下文、API 次数、7d reset 与 credits。

Desktop 请求 command/file approval 时，Bridge 在相同飞书 root 下发送独立审批卡。`accept`、`acceptForSession`、`decline`、`cancel` 只在 Desktop 允许时显示；操作后会将原审批卡替换为不可再点击的最终状态卡。审批或任务的 IPC 结果会区分“未发送、明确拒绝、结果未知”，未知结果绝不自动重试。

打开指定会话使用当前 Codex 文档保留的 `codex://threads/<threadId>` 兼容 deep link。只有用户显式执行 `/open` 或点击“在 ChatGPT 中打开”时才会导航；绑定、飞书消息投递和失败重试都不会自动打开或切换 ChatGPT 页面。导航失败不会改变 binding 或任务投递目标。Desktop follower router 返回 `no-client-found`、超时、连接丢失或其他拒绝结果时，Bridge 会直接将本次任务标记为失败，不自动导航且不自动重试。

## 验收

```bash
npm run check
git diff --check
```

`npm run check` 包含 typecheck、协议测试、应用构建和 package 检查。发布前还要用支持矩阵中的真实
App Server binary 执行 isolated `owned_stdio` smoke，并以真实飞书机器人和 ChatGPT Desktop 手工验证：
选择/重绑/解绑、`/open`、新 root + steer + interrupt、Desktop 页面实时显示、推理/工具/终态卡流式更新、
审批最终卡、7d 用量、Bridge/网络/ChatGPT 重启后的“不重放”边界，以及配置 reset 的
dry-run/confirm/destructive 三种路径。
