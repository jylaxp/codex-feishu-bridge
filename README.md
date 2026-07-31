# Codex Feishu Bridge 2

一个本机、单用户的飞书控制桥：飞书的消息被投递到已绑定的 ChatGPT Desktop 会话；Desktop owner runtime 负责在 ChatGPT 页面执行和渲染，Bridge 将同一 turn 的状态实时投影为飞书 CardKit 卡片。

Bridge 不读取或修改 ChatGPT/Codex 数据库、不注入 Electron，也不保存 prompt、回复、推理、审批、队列或卡片状态。跨重启的业务文件只有根目录 `config.toml`、根目录 `bindings.json` 和渠道目录 `channels/<channel>/` 下的渠道配置：`config.toml` 记录进程配置，`bindings.json` 记录渠道端点到 ChatGPT thread 的绑定及聊天类型，`channels/feishu/bots.json` 记录飞书机器人配置，`channels/feishu/external-bots.json` 记录飞书群内可 @ 的外部机器人目录。

日常安装、绑定、群聊、多机器人协作和排障步骤见 [使用手册](docs/user-manual.zh-CN.md)。本文示例优先使用短命令
`cfb`；完整命令 `codex-feishu-bridge` 完全等价。

## 运行链路

```text
飞书文本、图片消息/卡片操作
  -> 机器人启用状态、显式 @ 和群策略检查
  -> bindings.json 按 channel/app/tenant/chat 取得精确 threadId
  -> ChatGPT Desktop follower IPC: start / steer / interrupt / approval
  -> Desktop thread-stream snapshot/patch (version 11)
  -> 内存任务状态 -> 发起渠道端点中的 CardKit 卡片
```

App Server 只承担控制面：会话列表、创建/派生/归档、目标/压缩、技能/MCP 查询和账户窗口用量。它不执行飞书的模型 turn。

当前精确支持 `codex-cli 0.144.3`、`codex-cli 0.145.0-alpha.18`、
`codex-cli 0.145.0-alpha.27`、`codex-cli 0.145.0-alpha.30` 和
`codex-cli 0.146.0-alpha.3`，其中 `0.146.0-alpha.3` 是当前优先版本。145 后续别名复用 schema
相同的 `.18` 协议适配器；`0.146.0-alpha.3` 使用自己的 schema digest，并在功能 smoke 验证后复用 145
adapter。Bridge
启动时根据 `CODEX_BIN` 的精确版本和完整 experimental schema digest 自动选择 profile，并在 App Server
initialize 时再次核对实际版本；未知版本、未知 digest 或跨 profile 错配都会在 Desktop 和飞书连接前
失败。完整证据见 [App Server 支持矩阵](docs/app-server-support-matrix.md)，新增版本流程见
[App Server 升级运行手册](docs/app-server-upgrade-runbook.md)。

生产任务的 start/steer/interrupt、审批和 live event 始终由 ChatGPT Desktop IPC 负责，App Server 多版本
选择不会改变这条执行链。`managed_proxy` 模式的 initialize identity 只能佐证 proxy 自报版本，不能证明
socket 后 daemon 的完整 schema；操作员必须把远端 daemon 精确钉在已支持 profile。

## 安装方式

要求 Node.js `>=20.17.0 <27`，即支持 Node.js 20.17+ 至 26.x。推荐通过项目 `.nvmrc` 使用默认开发版本
`20.20.1`；Node.js `20.20.1`、`21.7.3`、`22.22.3`、`23.11.1`、`24.18.0`、`25.6.0` 和
`26.5.0` 已通过完整测试。当前登录用户还需要能够正常使用 ChatGPT Desktop。当前发布接入的是经过验证的
macOS Desktop IPC；Windows 适配后续单独接入。

### 方式 A：从 GitHub 全局安装（推荐）

```bash
npm install -g git+https://github.com/jylaxp/codex-feishu-bridge.git
```

安装完成后，终端会提供短命令 `cfb`；完整命令 `codex-feishu-bridge` 仍保留兼容。

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
npm install -g ./codex-feishu-bridge-2.1.0.tgz
```

`.tgz` 包含 Bridge 编译产物；npm 会按标准包安装流程解析运行依赖，因此目标机器首次安装时需要能访问配置的 npm registry，或已经具备对应依赖缓存。

## 初始化、迁移与机器人配置

默认配置为 `~/.codex-feishu-bridge/config.toml`。`BRIDGE_CONFIG_HOME` 可改为当前机器的绝对路径；显式进程环境优先于 `config.toml`。旧版本 `.env` 只作为一次性自动迁移来源：如果 `config.toml` 不存在但 `.env` 存在，Bridge 会先生成 `config.toml`，随后删除旧 `.env`；一旦 `config.toml` 存在，`.env` 就不再参与运行。

当前正式配置结构如下。根目录只保存 Bridge 进程配置和跨渠道绑定；飞书机器人凭证、外部机器人目录等渠道私有数据放在
`channels/feishu/` 下。后续增加企业微信等渠道时，会使用同级目录，例如 `channels/wecom/`。

```text
~/.codex-feishu-bridge/
  config.toml
  bindings.json
  channels/
    feishu/
      bots.json
      external-bots.json
```

新用户可以直接运行前台或后台启动命令。若 Bridge 检测到还没有任何飞书机器人配置，会自动进入扫码注册流程：

```bash
cfb run
# 或直接后台启动
cfb start
```

也可以显式执行：

```bash
cfb setup
```

终端会显示飞书授权链接和二维码。用飞书扫码确认后，Bridge 自动创建自建应用、取得飞书 `appId` 和 `appSecret`，并写入 `~/.codex-feishu-bridge/channels/feishu/bots.json`。`config.toml` 只保存 Bridge 进程级配置，不保存飞书机器人凭证。

机器人记录里的 `tenantKey`、`allowedChats`、`authorizedUsers`、`allowedApprovers` 默认都可以为空。机器人收到第一条单聊消息时，会自动把该租户、当前单聊和发送者保存为 owner/审批人，不需要用户先查询 Open ID，也不需要额外发送绑定指令。为了避免误开放，首次群聊消息不会自动认领。

如果使用已有飞书机器人，可以导入已有应用凭证：

```bash
cfb bot import --app-id cli_xxx --app-secret SECRET
```

导入后凭证同样写入 `channels/feishu/bots.json`。可以用 `cfb init` 生成 `config.toml` 的进程级配置骨架，但不要把飞书凭证写入 `config.toml`。

升级旧安装时，通常无需手工迁移：启动、`doctor`、`status` 或 `config migrate` 发现 `config.toml` 不存在且 `.env` 存在时，会先从旧 `.env` 自动生成 `config.toml`。如果要立即物化旧单机器人为 `channels/feishu/bots.json` 并升级已有绑定，可以执行：

```bash
cfb config migrate
```

迁移会生成或更新 `~/.codex-feishu-bridge/channels/feishu/bots.json`，并把已有聊天绑定升级为 `channel + appId + tenantKey + chatId` 格式。旧 `.env` 不再作为 fallback；如果目录里还残留该文件，Bridge 会在加载或生成 `config.toml` 后清理它。发布版正式迁移只支持旧单聊版本的 `.env`；开发期根目录 `lark-bots.json`、`external-bots.json` 不作为用户升级输入。

需要新增、刷新、停用或移除机器人时：

```bash
cfb bot add
cfb bot rebind --app-id cli_xxx
cfb bot disable --app-id cli_xxx
cfb bot enable --app-id cli_xxx
cfb bot remove --app-id cli_xxx --confirm
```

```toml
# Codex Feishu Bridge process configuration.
# Channel credentials are stored under channels/<channel>/, not in this file.
schemaVersion = 1

[approval]
summaryMode = false

[appServer]
mode = "owned_stdio"
# socketPath = "/absolute/path/to/app-server.sock"

[codex]
bin = "/absolute/path/to/codex"
cwd = "/absolute/path/to/default/directory"
allowedShellCommands = ["ls", "pwd", "git", "find", "cd"]

[card]
maxTextLength = 10000
updateIntervalMs = 1500

[queue]
maxQueuedTasks = 100

[usage]
rateLimitQueryIntervalMs = 300000

[logging]
toFile = false
filePath = "bridge.log"

[files]
enableAutoFileUpload = false
```

`codex.cwd` 只决定未单独绑定目录时的默认启动目录；省略时使用 `BRIDGE_CONFIG_HOME`（通常是 `~/.codex-feishu-bridge`）。每个 Codex 任务以 `dangerFullAccess` 启动，可以读取和修改本机任意路径，不再使用旧的 workspace 白名单。

`approval.summaryMode=false` 时，保持原应用的审批投递方式：每次审批都会发出一张独立审批卡。设为 `true` 时，同一个任务只保留一张审批汇总卡；后续审批会更新到该卡中，每个审批区块仍独立显示命令、原因和三个操作按钮。无论哪种模式，任一审批作出选择后，该审批区块的全部按钮都会禁用。

`logging.toFile` 是全部运行日志的总开关。设为 `false` 时，INFO、WARN、ERROR 以及飞书 SDK 运行日志均不写文件、也不输出到标准输出；设为 `true` 时，Bridge 将脱敏日志写入轮转文件。相对 `logging.filePath` 位于 config-home 的 `logs/`，绝对路径按用户显式配置处理。日志不会记录 prompt、回复或 CardKit payload。CLI 命令结果（例如 `status`、`doctor`）属于用户请求的输出，不受日志开关影响。`files.enableAutoFileUpload=true` 时，最终回复中指向绝对本地路径的非图片 Markdown 文件会作为同一飞书话题的文件回复上传；文件数量、类型和大小校验仍然保留，该信息不会保存到 Bridge 文件。

飞书可发送 JPG、PNG 或 WebP 图片给已绑定会话，也支持一条 `post` 富文本中的文字和多张图片。单独发送图片时，Bridge 只在内存中暂存消息资源引用，允许继续发送图片；下一条普通文字会作为任务描述，与当前批次一次性提交。图片回执卡片提供“提交图片”和“取消”按钮，不使用短时间窗口；`/image-run` 与 `/image-cancel` 仅作为兼容入口保留。一个任务最多 8 张图片，每张不超过 20 MB；提交时才下载并校验真实文件头，然后以 `localImage` 输入交给 ChatGPT Desktop。Bridge 同时最多下载 2 张图片，进程内图片临时文件总量最多 256 MB。任务结束、Desktop 断开或 Bridge 停止时会删除进程专用临时文件及未提交批次。使用已有机器人时，需要为应用开通读取消息资源所需的 `im:message:readonly` 权限。

持久业务数据只有根目录 `config.toml`、根目录 `bindings.json` 和 `channels/<channel>/` 下的渠道配置。当前飞书渠道使用 `channels/feishu/bots.json` 和 `channels/feishu/external-bots.json`；发布版升级只从旧单聊版本 `.env` 自动迁移到该结构。Bridge 不创建 SQLite、WAL、任务历史或恢复队列。后台模式还会生成 `bridge.pid`、`runtime-health.json` 和 `logs/`；健康快照只记录连接状态、协议标识和任务计数，不保存 prompt、模型回复、推理、工具输出或卡片 payload。Bridge 崩溃/重启、Desktop 断开或网络结果未知时，当前进程内任务直接停止跟踪且绝不自动重放，用户可在 ChatGPT Desktop 继续处理或重新从飞书发送。

## 启动方式

### 前台运行（调试）

```bash
cfb run
```

源码开发时等价命令为：

```bash
npm run build
node dist/app/cli.js run
```

### 后台常驻运行

```bash
cfb start
```

后台启动始终写入 PID：

- PID：`~/.codex-feishu-bridge/bridge.pid`

仅当 `logging.toFile=true` 时，后台进程才创建并追加：

- 标准日志：`~/.codex-feishu-bridge/logs/bridge_stdout.log`
- 错误日志：`~/.codex-feishu-bridge/logs/bridge_stderr.log`

一个 config home 同时只允许一个 Bridge 进程。运行期获得带 PID/所有者校验的私有锁；配置重置也有独立锁，二者互斥。

## 维护方式

```bash
# 查看后台进程状态和日志位置
cfb status
cfb status --json

# 重启后台服务
cfb restart

# 停止后台服务
cfb stop

# 从 GitHub 全局更新并重启
cfb update

# 强制重新安装当前版本并重启
cfb update --force

# 检查本机配置、App Server protocol profile 和运行依赖
cfb doctor

# 查看本机 ChatGPT App、Codex CLI、binary 和 schema 版本
cfb version
cfb version --json

# 只读检查协议兼容性；第一行固定为“兼容”或“不兼容”
cfb compatibility
cfb compatibility --json
```

首次执行 `run`、`start`、`doctor`、`version` 或 `compatibility` 时，如果配置不存在，Bridge 会把内置支持
目录写入 `~/.codex-feishu-bridge/protocol-versions.json`。后续启动读取该文件，再检测当前本机版本。文件同时
记录最近一次 ChatGPT App/Codex 版本、binary SHA-256、完整 schema digest 和兼容结论，不包含 prompt、结果或
凭证。

精确版本和 digest 已在配置目录中时可以启动；版本尚未列入、但完整 schema digest 与已支持合同相同时，
`compatibility` 返回“兼容”并标记 `upgrade_available`，Bridge 仍拒绝启动，直到操作员审查后明确执行：

```bash
cfb compatibility --approve
```

`--approve` 只允许加入 schema 已匹配的精确版本，不接受未知 schema，也不会修改源码或 `package.json`。

`doctor` 会生成配置 binary 的完整 experimental schema digest，并报告
`protocolProfileId`、`codexVersion`、`schemaDigest`、`appServerMode`、
`appServerIdentityAssurance`、当前平台和 bot 协作就绪摘要。doctor 只做本机探测；正式启动还会用
initialize identity 核对实际 App Server 版本。`managed_proxy` 的 assurance 会明确显示为操作员信任的版本佐证，
而不是远端 schema 证明。当前 Desktop-attached 执行只声明 macOS 支持；Windows 在 native named-pipe probe
和 owner/session attestation 完成前会保持 not ready。

`logging.toFile=true` 时可实时查看后台输出日志：

```bash
tail -f ~/.codex-feishu-bridge/logs/bridge_stdout.log
tail -f ~/.codex-feishu-bridge/logs/bridge_stderr.log
```

`config reset` 不是日常升级入口，只用于配置目录损坏、旧目录无法自动升级或需要明确清空绑定时的恢复操作。
它只迁移 `config.toml` 或旧 `.env` 中的进程/机器人配置，不迁移会话、任务、审批或运行状态。

```bash
# 只查看将保留/删除什么，不写文件
cfb config reset

# 仅在旧目录或损坏目录时执行：迁移配置，清空 bindings
cfb config reset --confirm

# 当前已经是新结构时，只有明确 destructive 才会清空已有 bindings
cfb config reset --confirm --destructive
```

重置会生成当前结构的 `config.toml` 和空 `bindings.json`，删除旧运行文件，并要求用户重新 `/bind`。

## 飞书聊天指令

以下指令是私聊控制面和单聊绑定会话的完整指令。群聊 MVP 只识别 owner/admin 发出的
`/bind`、`/l`、`/list`、`/ll`、`/external` 和 `/collab`；其他群聊 slash 命令不会进入管理控制面，也不会作为普通任务执行。群聊普通任务必须显式 `@当前机器人` 后发送自然语言文本。

| 指令 | 行为 |
| --- | --- |
| `/help`、`/h`、`help`、`h` | 显示完整帮助卡片 |
| `/bind`、`/l`、`/list` | 按本地项目分组显示会话下拉列表；若聊天已有绑定，同时推送最近一条已完成历史记录 |
| `/ll` | 以 Table 表格显示会话名称和所属项目，并在卡片底部选择绑定；保留旧版尾随参数形式 |
| `/binding` | 显示当前精确绑定和“在 ChatGPT 中打开”按钮 |
| `/external [on\|off]` | 查询或调整当前群的外部群成员 @ 策略；默认 on，只允许 owner/admin 在群内操作 |
| `/collab` | 查询当前群的机器人协作状态；MVP 只读，不维护 source-target 授权策略 |
| `/open` | 打开当前绑定的 ChatGPT Desktop 会话，不改变投递目标 |
| `/unbind` | 只解除当前飞书聊天的绑定，不归档 ChatGPT 会话 |
| `/new [名称]`、`/create [名称]` | 创建、命名、绑定并打开新会话；名称省略时自动生成 |
| `/fork [名称]`、`/branch [名称]` | 从当前会话派生、命名、绑定并打开新会话 |
| `/delete`、`/archive` | 归档当前 ChatGPT 会话并解除绑定 |
| `/cwd [路径]`、`/workspace [路径]` | 查询或修改当前绑定会话的工作目录；路径必须是本机绝对路径 |
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
| `/image-run` | 不再等待任务描述，立即提交当前待处理图片 |
| `/image-cancel` | 清除当前会话中尚未提交的图片批次 |
| `/cancel`、`/stop` | 停止当前运行任务；任务卡“停止任务”按钮行为相同 |
| `/<白名单命令> [参数]` | 保留原 router 的未知 slash fallback，例如 `/pwd`；首命令仍必须在 `codex.allowedShellCommands` 中 |

`/bind`、会话选择、模型选择、技能选择和打开按钮都限制聊天、授权用户、binding revision 和 10 分钟 TTL；过期卡片不能改变当前绑定。

飞书消息必须先显式绑定既有会话。普通任务通过 Desktop follower IPC 进入这个精确 thread：新 root 走 start，同 root 运行期间的补充消息走 steer，不同 root 排队。`@技能名称` 文本会原样保留并进入 Desktop runtime；当前 Desktop follower 协议没有独立的结构化 skill 字段，Bridge 不会猜测或重写技能内容。

会话可见性由机器人记录里的 `allowedChats` 决定。首次安装时这些飞书内部 ID 都可以为空：第一个私聊机器人的用户会自动成为 owner，并绑定当前单聊。绑定后卡片会作为发起消息的 reply，始终留在原会话/原话题，而不是临时会话。群聊需要先由 owner/admin 在群里 `@机器人 /bind` 绑定会话；绑定后普通群成员显式 `@` 当前机器人即可发起普通任务。外部群成员默认允许发起普通任务，Bridge 不校验其 sender tenant 或用户白名单；需要关闭时由 owner/admin 在对应群里发送 `@机器人 /external off`，恢复时发送 `@机器人 /external on`。

多个机器人在同一群协作时，不要求这些机器人由同一个 owner 管理，也不要求由同一个群成员邀请进群；飞书群内的普通成员可以按群权限邀请一个或多个机器人。Bridge 不把“谁拉进群”作为授权条件，每个机器人仍由它自己的 owner/admin 管理，并且每个机器人都必须先在该群绑定会话，确认机器人 @ 响应开关为 on。MVP 默认开放：
人可以 @ 机器人，机器人可以 @ 机器人，机器人也可以 @ 人；Bridge 不校验 tenant_key、成员白名单、bot sender
白名单或 source-target grant。模型可以在最终答案中发出 `cfb-handoff` directive，Bridge 会把源机器人结果继续用
卡片展示，并额外发送一条真实飞书 `post` 消息 @ 目标机器人；如果 `post` 被飞书拒绝，会降级发送 `text`
@ 消息。卡片中的 `@` 只用于展示，不作为自动触发路径。目标机器人收到的 bot sender 消息只能进入普通任务，
不能执行 `/bind`、`/model`、`/cwd`、审批或其他管理命令。同一个群里不同机器人可以绑定不同 ChatGPT 会话，
也可以绑定同一会话；同一会话继续按 thread ID 串行。Windows/macOS 都可以使用飞书协作协议；实际执行
runner 当前以 macOS Desktop-attached 为已验证路径，跨平台群协作应优先使用 App Server stable 路由，
Windows Desktop-attached 在 native probe 完成前保持不可用。

多渠道配置从目录结构上预留：飞书配置位于 `channels/feishu/`，未来企业微信可放入 `channels/wecom/`。根目录 `bindings.json` 按 `channel + appId + tenantKey + chatId` 记录“渠道端点订阅哪个 ChatGPT thread”。因此飞书和企业微信可以绑定不同 thread，也可以绑定同一个 thread；同一个 thread 的执行仍由统一 scheduler 串行。真正把同一个 thread 的运行卡片同时推送到多个渠道，需要 renderer/channel adapter 的 fan-out 层按 `threadId -> bindings[]` 生成多份渠道投递计划；当前 Feishu CardKit 运行路径只保证发起渠道端点的卡片投递，跨渠道 fan-out 是下一阶段的渲染抽象层工作。

外部 owner 或外部 Bridge 实例管理的机器人不需要导入本机 `channels/feishu/bots.json`。Bridge 会在群消息、机器人进群事件、群绑定成功和新版本群绑定启动回填后尝试调用飞书群内机器人列表接口，按 `sourceAppId + tenantKey + chatId` 记录外部机器人的 open ID 和名称到 `~/.codex-feishu-bridge/channels/feishu/external-bots.json`，供后续真实 `@外部机器人` 使用。该能力需要 `im:chat.members:read` 权限；旧版本历史绑定没有 `chatType` 时，下一次收到该聊天明确 `chat_type` 的事件会自动回填，群里重新 `@当前机器人` 即可触发发现目录刷新。发现目录只提供可 @ 身份，不保证外部 bot 已绑定、已运行或会响应。

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
