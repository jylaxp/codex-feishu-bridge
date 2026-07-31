# Codex Feishu Bridge 使用手册

本文面向 Bridge 操作员、机器人 owner 和群聊使用者，说明如何安装、启动、绑定会话、使用单聊/群聊、多机器人协作，以及如何排查常见问题。

命令示例默认使用短命令 `cfb`。`cfb` 与 `codex-feishu-bridge` 完全等价。

## 1. 适用范围

- Bridge 是本机单用户服务：飞书消息进入本机 Bridge，再投递到本机 ChatGPT/Codex 运行面。
- 默认配置目录是 `~/.codex-feishu-bridge`。
- 当前已验证的 Desktop-attached 执行路径是 macOS。
- 群聊协作协议本身不依赖 macOS；跨平台群聊应优先使用 App Server stable 路由。
- Windows Desktop-attached 执行在 native named-pipe 探测完成前保持不可用。
- Bridge 不保存 prompt、模型回复、推理、审批内容、卡片 payload 或任务恢复队列。

## 2. 核心概念

| 概念 | 说明 |
| --- | --- |
| Bridge 进程 | 本机后台服务，负责飞书事件、绑定、卡片投递和 Codex/ChatGPT 控制。 |
| 配置目录 | 默认 `~/.codex-feishu-bridge`，保存 `config.json`、`lark-bots.json`、`bindings.json`、`external-bots.json`、PID、health 和日志。 |
| appId | 飞书应用 ID，也是 Bridge 识别一个机器人配置的唯一标识。 |
| 绑定 | 一个飞书聊天绑定到一个 ChatGPT 会话。群聊绑定精确到 `appId + tenantKey + chatId`。 |
| owner/admin | 能进行绑定、解绑、模型、CWD、访问策略和审批操作的管理用户。 |
| 普通任务 | 用户或机器人在群里显式 `@机器人` 后发起的自然语言任务。 |
| bot-to-bot handoff | 一个机器人在最终答案中声明交接，Bridge 发送真实飞书 `@目标机器人` 消息触发目标机器人继续处理。 |

## 3. 安装

### 3.1 从 GitHub 安装

```bash
npm install -g git+https://github.com/jylaxp/codex-feishu-bridge.git
```

安装后可以使用：

```bash
cfb --help
codex-feishu-bridge --help
```

### 3.2 从源码安装

```bash
nvm install
nvm use
npm ci
npm link
```

### 3.3 从本地包安装

```bash
npm pack
npm install -g ./codex-feishu-bridge-2.1.0.tgz
```

## 4. 初始化

### 4.1 新机器人扫码注册

首次运行可直接启动。若没有飞书应用凭证，Bridge 会自动进入扫码注册流程：

```bash
cfb start
```

也可以显式执行：

```bash
cfb setup
```

扫码后 Bridge 会把飞书应用凭证写入：

```text
~/.codex-feishu-bridge/lark-bots.json
```

`config.json` 只保存 Bridge 进程级配置，不保存飞书机器人凭证。

### 4.2 使用已有机器人

导入已有应用凭证：

```bash
cfb bot import --app-id cli_xxx --app-secret SECRET
```

凭证会写入 `~/.codex-feishu-bridge/lark-bots.json`。`cfb init` 只用于生成 `config.json` 进程级配置骨架；不要把飞书 `appId`、`appSecret` 手工写入 `config.json`。

### 4.3 迁移已有单聊机器人

如果旧安装已经有 `.env`，新版本发现 `config.json` 不存在时会自动从 `.env` 生成 `config.json`，随后删除旧 `.env`。要立即把旧单聊机器人和已有绑定物化到多机器人结构，执行：

```bash
cfb config migrate
```

这会把旧机器人物化到 `lark-bots.json`，并尽量获取机器人 open ID、名称和启用状态。已有绑定会同步升级为 `appId + tenantKey + chatId` 格式，已绑定群也会同步加入该机器人的 `allowedChats`。

## 5. 启停和状态

前台调试：

```bash
cfb run
```

后台启动：

```bash
cfb start
```

重启：

```bash
cfb restart
```

停止：

```bash
cfb stop
```

查看状态：

```bash
cfb status
cfb status --json
```

检查配置和运行依赖：

```bash
cfb doctor
```

查看本机 Codex/ChatGPT App Server 兼容性：

```bash
cfb version
cfb compatibility
```

当 `compatibility` 显示 schema 相同但精确版本尚未批准时，需要操作员审查后执行：

```bash
cfb compatibility --approve
```

## 6. 单聊使用

### 6.1 首次认领

首次私聊机器人时，Bridge 会自动把当前用户记录为 owner/admin/审批人。首次群聊不会自动认领。

### 6.2 绑定会话

私聊机器人发送：

```text
/bind
```

或：

```text
/list
```

在卡片下拉列表中选择一个 ChatGPT 会话。绑定后普通消息会投递到该会话。

### 6.3 常用私聊命令

| 命令 | 用途 |
| --- | --- |
| `/bind`、`/list` | 选择并绑定 ChatGPT 会话。 |
| `/binding` | 查看当前绑定。 |
| `/new [名称]` | 创建并绑定新会话。 |
| `/fork [名称]` | 从当前会话派生新会话。 |
| `/open` | 在 ChatGPT 中打开当前绑定会话。 |
| `/model [名称]` | 查询或设置模型。 |
| `/cwd [路径]` | 查询或设置当前绑定会话的工作目录。 |
| `/status` | 查看当前绑定、模型、CWD、技能和目标状态。 |
| `/cancel`、`/stop` | 停止当前任务。 |

## 7. 群聊使用

### 7.1 把机器人加入群

在飞书中把应用机器人邀请进目标群。

谁邀请机器人进群不是 Bridge 的授权条件。只要飞书群权限允许，普通成员可以邀请一个或多个机器人进群；这些机器人可以来自不同 owner 或团队。

### 7.2 owner 在群里绑定会话

owner 在群里发送：

```text
@机器人 /bind
```

在卡片里选择一个 ChatGPT 会话。绑定成功后，该群中显式 `@当前机器人` 的普通消息会进入这个会话。

### 7.3 群成员发起普通任务

群成员发送：

```text
@机器人 帮我排查这个问题
```

群聊任务只支持普通消息，不支持命令。非 owner 和机器人发送者不能执行 `/bind`、`/model`、`/cwd`、解绑、访问策略调整、审批等管理动作。

### 7.4 外部群成员

MVP 默认允许外部群成员 `@机器人` 发起普通任务。

关闭当前群的外部成员任务入口：

```text
@机器人 /external off
```

恢复：

```text
@机器人 /external on
```

查询：

```text
@机器人 /external
```

### 7.5 群协作状态

查询当前群的机器人协作状态：

```text
@机器人 /collab
```

MVP 中 `/collab` 只读，不维护 source-target 授权列表。

## 8. 多机器人管理

### 8.1 添加机器人

```bash
cfb bot add
```

该命令会显示一个飞书 QR code。扫码后 Bridge 自动创建一个 bot 记录，获取机器人身份和名称，并使用飞书 `appId` 作为机器人标识。

不需要传 `--key`，也不需要手工命名机器人。

### 8.2 导入已有应用机器人

```bash
cfb bot import --app-id cli_xxx --app-secret replace_me
```

Bridge 会探测机器人 identity/name，并按 `appId` 写入结构化配置。

### 8.3 查看机器人

```bash
cfb bot list
cfb bot list --json
cfb bot doctor
```

重点看：

- `enabled`
- `botOpenId`
- `displayName`
- `allowGroupBotMentions`
- `groupBindingCount`
- `groupBotMentionReadyCount`

### 8.4 禁用或启用机器人

禁用：

```bash
cfb bot disable --app-id cli_xxx
```

启用：

```bash
cfb bot enable --app-id cli_xxx
```

禁用后的本地机器人不会接收任务、命令、审批或卡片副作用。如果飞书仍然投递事件，Bridge 可以返回不可用原因。

### 8.5 重新扫码绑定某个机器人

```bash
cfb bot rebind --app-id cli_xxx
```

rebind 只允许刷新同一个 `appId` 的凭证。如果扫码返回另一个 `appId`，那就是一个新机器人，应使用 `cfb bot add` 添加。

### 8.6 移除机器人

```bash
cfb bot remove --app-id cli_xxx --confirm
```

移除会删除该 bot 的本地配置和相关绑定记录。

## 9. MVP 多机器人协作

MVP 目标很简单：

- 人可以 `@机器人`。
- 机器人可以 `@机器人`。
- 机器人可以 `@普通成员`。
- Bridge 侧不增加复杂权限模型。
- 唯一响应控制是目标机器人是否存在、启用、已绑定当前群，并且群机器人 @ 响应开关为 on。

机器人记录默认：

```json
{
  "allowGroupBotMentions": true
}
```

已物化到 `lark-bots.json` 的 bot 也需要：

```json
{
  "allowGroupBotMentions": true
}
```

### 9.1 准备同群多机器人

1. 用 `cfb bot add` 或 `cfb bot import` 添加每个机器人。
2. 在飞书把这些机器人都邀请到同一个群。它们不需要属于同一个 owner，也不需要由同一个群成员邀请；普通成员可以按群权限邀请一个或多个机器人。
3. 每个机器人自己的 owner 分别对该机器人执行：

```text
@机器人A /bind
@机器人B /bind
```

每个机器人可以绑定不同 ChatGPT 会话，也可以绑定同一个会话。同一个会话会按 thread ID 串行执行。机器人之间可以在同一个群里通过真实飞书 `@目标机器人` 消息相互协作。

### 9.2 外部机器人自动发现

如果一个群里还有其他 owner 或其他 Bridge 实例管理的机器人，当前 Bridge 不需要拿到对方 app secret。当前 bot 在收到群消息、被拉进群、完成群绑定，或 Bridge 启动后发现已有群绑定时，会尝试调用飞书“获取群内机器人列表”接口，记录同群外部机器人的 open ID 和名称。

记录文件：

```text
~/.codex-feishu-bridge/external-bots.json
```

记录粒度是 `sourceAppId + tenantKey + chatId + externalBotOpenId`。同一个外部机器人在不同群、或被不同本地 bot 发现，会保留独立记录。

已经在群里的历史机器人不会收到过去的“机器人进群”事件。升级后处理方式是：

- 如果群绑定是新版本创建的，Bridge 重启时会基于绑定里的 `chatType=group` 自动回填外部机器人目录。
- 如果群绑定来自旧版本，历史 `bindings.json` 没有 `chatType`，Bridge 无法仅凭本地文件判断它是不是群聊；在该群里再次 `@当前机器人`，或重新执行一次 `@当前机器人 /bind`，即可触发刷新并补齐目录。
- 未绑定的群不会在启动时回填；先在群里 `@机器人 /bind` 绑定会话。

发现目录只解决“源机器人可以发送真实 `@外部机器人` 消息”。外部机器人是否响应，仍取决于它自己的飞书应用权限、Bridge 版本、运行状态、群绑定和群机器人 @ 响应开关。

### 9.3 触发 bot-to-bot handoff

源机器人最终答案中需要包含 `cfb-handoff` directive。Bridge 会额外发一条真实飞书 `text` 消息，内容就是 `@目标机器人 要处理的事情`。目标机器人收到后按普通任务处理。

示例：

````text
```cfb-handoff
target: Order Bot
task: 请继续排查订单创建失败的原因
reason: 搜索侧已确认库存结果正常，需要订单域判断
context: requestId=req-123, traceId=trace-456
expected: 给出订单域结论和下一步处理建议
```
````

注意：

- 卡片里展示出来的 `@` 只用于阅读，不会触发目标机器人。
- 只有真实飞书 text/post 消息里的 `@目标机器人` 才能触发目标机器人。
- 目标机器人收到 bot sender 消息后只能执行普通任务，不能执行管理命令或审批。
- 目标机器人如果不是当前 Bridge 的本地 bot，必须先出现在 `external-bots.json` 发现目录里；否则源机器人无法拿到可用于真实 @ 的 open ID。

### 9.4 bot @ 普通成员

Bridge 的飞书发送层支持真实 `@普通成员` 消息，但需要有目标成员的 open ID。MVP 不做“模型输出姓名后自动查通讯录/群成员匹配”的复杂解析链路。

适合用作通知或升级，例如：

```text
@张三 请确认订单字段口径。
```

## 10. 飞书权限检查

机器人需要至少能接收：

- 单聊消息事件。
- 群内 `@bot` 消息事件。
- 群内包含机器人发送者的 `@bot` 消息事件，用于 bot-to-bot 协作。
- 获取群内机器人列表权限 `im:chat.members:read`，用于外部机器人自动发现。

如果要发送和处理图片，还需要读取消息资源相关权限，例如 `im:message:readonly`。

建议同时订阅“机器人进群”和“机器人被移出群”事件。飞书的机器人进群事件主要推给进群的机器人，不能覆盖“其它机器人后来加入当前群”的所有场景，所以 Bridge 仍会在后续群消息中刷新群机器人目录。

如果机器人被拉进群后无响应，优先检查：

1. 飞书应用是否启用事件订阅。
2. 机器人是否有群内 `@bot` 消息事件权限。
3. bot-to-bot 场景是否有“包含机器人发送者的 @ 机器人事件”权限。
4. 外部机器人协作是否有 `im:chat.members:read` 权限。
5. Bridge 是否正在运行。
6. 当前群是否已经由 owner 绑定。
7. 目标机器人是否启用。
8. `allowGroupBotMentions` 是否为 `true`。

## 11. 推荐测试流程

### 11.1 基础健康

```bash
cfb status --json
cfb doctor
cfb bot list
```

期望：

- `lark.state=ready`
- `appServer.state=ready`
- `doctor.ok=true`
- `enabledBotCount >= 1`
- 测试 bot 的 `allowGroupBotMentions=true`

如果整体 `status=degraded` 但 `lark` 和 `appServer` 都是 ready，需要看 degraded 是否只来自 Desktop route。群聊 stable route 通常不受 Desktop route unknown 阻塞。

### 11.2 单聊

1. 私聊机器人发送任意消息，确认 owner 自动认领。
2. 发送 `/bind`，绑定一个会话。
3. 发送 `hello`，确认飞书收到任务卡片和最终结果。

### 11.3 群聊

1. 把机器人拉进群。
2. owner 在群里发送 `@机器人 /bind`。
3. 选择会话。
4. 群成员发送 `@机器人 hello`。
5. 确认结果卡片回复到群里原消息或原话题下。

### 11.4 外部群成员

1. 外部群成员发送 `@机器人 hello`。
2. 默认应响应。
3. owner 发送 `@机器人 /external off`。
4. 外部群成员再次 `@机器人`，应不再响应普通任务。
5. owner 发送 `@机器人 /external on` 恢复。

### 11.5 bot-to-bot

1. 群里至少有两个 Bridge 管理的机器人。
2. 每个机器人都已经在当前群 `/bind`。
3. `cfb bot list` 显示目标机器人 `机器人@=on`。
4. 源机器人产生 `cfb-handoff` directive。
5. 群里应出现一条真实 `@目标机器人` 消息。
6. 目标机器人应把该消息作为普通任务处理。

## 12. 常见问题

### 12.1 群里 `@机器人 /bind` 没响应

检查：

- 发送者是不是 owner/admin。
- 飞书应用是否订阅群内 `@bot` 事件。
- Bridge 是否 `cfb status --json` 显示 running。
- 机器人是否已经被本地禁用。
- 事件是否发给了当前机器人，而不是群里另一个同名或相似名称机器人。

### 12.2 普通群成员 `@机器人` 没响应

检查：

- 当前群是否已经绑定。
- 群消息是否显式 `@当前机器人`。
- 不是发送给另一个机器人。
- 如果是外部成员，当前群是否执行过 `/external off`。

### 12.3 其他机器人 `@当前机器人` 没响应

检查：

```bash
cfb bot list
cfb doctor
```

重点看：

- `allowGroupBotMentions=true`
- `groupBotMentionReadyCount > 0`
- 目标机器人已绑定当前群
- 目标机器人没有被 disable
- 飞书应用有“包含机器人发送者的 @ 机器人事件”权限

### 12.4 机器人返回“不可用”原因

这通常说明 Bridge 识别到了本地 bot record，但该 bot disabled、未绑定当前群、缺少 open ID、执行路由未就绪或关闭了群机器人 @ 响应。

未知或已移除的机器人一般保持静默，因为 Bridge 没有可信本地 runtime。对外部机器人，如果自动交接提示“未找到目标机器人”，先确认 `external-bots.json` 是否已经记录该群里的目标机器人；没有记录时，在当前群里再次 `@源机器人` 触发一次刷新，或检查应用是否已开通 `im:chat.members:read`。

### 12.5 `status` 是 degraded

先看 degraded 的具体轴：

```bash
cfb status --json
```

- `lark.state=ready` 表示飞书事件通道可用。
- `appServer.state=ready` 表示 App Server 控制面可用。
- `statusReasons` 会列出具体原因，例如 `desktop_route_unverified` 表示刚启动或重连后还没有验证绑定会话路由。
- `desktop.routeState=unknown` 表示 Desktop IPC 已连接，但绑定的 ChatGPT 会话路由还没验证成功；Bridge 会在启动和绑定创建后主动做一次非侵入式 route probe。
- `desktop.routeState=unavailable` 表示至少一个绑定会话当前没有可投递的 Desktop owner，需要打开/恢复对应 ChatGPT 会话或等待 route recovery。

### 12.6 卡片里有 `@目标机器人` 但目标机器人没被触发

卡片里的 `@` 只是展示文本，不是飞书真实 mention。bot-to-bot 必须发送真实飞书 `text` 或 `post` 消息里的 `@目标机器人`。

### 12.7 同一个会话被多个机器人绑定会不会并发冲突

不会并发写同一个 ChatGPT thread。Bridge 按 `threadId` 串行调度，同一个 thread 同时只能有一个 active turn。

## 13. 运维清单

日常检查：

```bash
cfb status --json
cfb doctor
cfb bot list
```

重启：

```bash
cfb restart
```

看日志：

```bash
tail -f ~/.codex-feishu-bridge/logs/bridge_stdout.log
tail -f ~/.codex-feishu-bridge/logs/bridge_stderr.log
```

注意：只有 `logging.toFile=true` 时才写日志文件。

更新：

```bash
cfb update
```

强制重装当前版本：

```bash
cfb update --force
```

配置重置 dry-run：

```bash
cfb config reset
```

确认重置旧配置：

```bash
cfb config reset --confirm
```

清空当前版本绑定需要显式 destructive：

```bash
cfb config reset --confirm --destructive
```

## 14. 安全边界

- Bridge 不保存 prompt、回复、推理、审批、队列或卡片 payload。
- 运行日志应保持脱敏，不记录任务内容。
- 群聊普通任务默认开放，但群管理、模型、CWD、解绑和审批仍只允许 owner/admin。
- bot sender 只能发起普通任务，不能执行管理动作。
- 审批只能由管理员处理。
- `files.enableAutoFileUpload=true` 会上传最终回复中引用的本地文件，启用前需要确认组织策略。
- Codex 任务以本机 owner 权限执行，具备本机文件访问能力，生产使用前应明确机器隔离和账号边界。

## 15. 快速命令索引

| 场景 | 命令 |
| --- | --- |
| 初始化配置 | `cfb setup` |
| 前台运行 | `cfb run` |
| 后台启动 | `cfb start` |
| 重启 | `cfb restart` |
| 停止 | `cfb stop` |
| 状态 | `cfb status --json` |
| 诊断 | `cfb doctor` |
| 添加机器人 | `cfb bot add` |
| 导入机器人 | `cfb bot import --app-id cli_xxx --app-secret SECRET` |
| 迁移旧机器人 | `cfb config migrate` |
| 查看机器人 | `cfb bot list` |
| 禁用机器人 | `cfb bot disable --app-id cli_xxx` |
| 启用机器人 | `cfb bot enable --app-id cli_xxx` |
| 移除机器人 | `cfb bot remove --app-id cli_xxx --confirm` |
| 私聊绑定 | `/bind` |
| 群聊绑定 | `@机器人 /bind` |
| 群聊任务 | `@机器人 任务内容` |
| 外部成员关闭 | `@机器人 /external off` |
| 外部成员开启 | `@机器人 /external on` |
| 群协作状态 | `@机器人 /collab` |
