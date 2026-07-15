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

## 安装

```bash
nvm install
nvm use
npm ci
npm run check
```

要求 Node.js `>=24.18.0 <25`、当前用户可连接的 ChatGPT Desktop，以及已经配置机器人/WebSocket/CardKit 权限的飞书自建应用。当前发布只接入经 fixture 验证的 macOS Desktop IPC；Windows 适配将在独立协议探测完成后接入。

## 配置

默认配置为 `~/.codex-feishu-bridge/.env`。`BRIDGE_CONFIG_HOME` 可改为当前机器的绝对路径；显式进程环境优先于 `.env`。请从 `.env.example` 复制并按机器实际路径填写，不要复制其他开发者的路径。

```dotenv
LARK_APP_ID=cli_0123456789abcdef
LARK_APP_SECRET=replace_me
LARK_TENANT_KEY=tenant_key
ALLOWED_CHATS=oc_xxx
AUTHORIZED_USERS=ou_user_xxx
ALLOWED_APPROVERS=ou_user_xxx

CODEX_BIN=/absolute/path/to/codex
CODEX_CWD=/absolute/path/to/project
ALLOWED_WORKSPACE_ROOTS=/absolute/path/to/project

# 旧配置语义继续保留
RATE_LIMIT_QUERY_INTERVAL_MS=300000
LOG_TO_FILE=false
LOG_FILE_PATH=bridge.log
ENABLE_AUTO_FILE_UPLOAD=false
ALLOWED_SHELL_COMMANDS=ls,pwd,git,find,cd
```

`LOG_TO_FILE=true` 时，Bridge 写脱敏、轮转的运行日志；相对 `LOG_FILE_PATH` 位于 config-home 的 `logs/`，绝对路径按用户显式配置处理。日志不会记录 prompt、回复或 CardKit payload。`ENABLE_AUTO_FILE_UPLOAD=true` 时，最终回复中指向授权 workspace 内的非图片本地 Markdown 文件会作为同一飞书话题的文件回复上传；该信息不会保存到 Bridge 文件。

配置目录只允许 `.env` 和 `bindings.json`。它不创建 SQLite、WAL、任务历史或恢复队列。Bridge 崩溃/重启、Desktop 断开或网络结果未知时，当前进程内任务直接停止跟踪且绝不自动重放，用户可在 ChatGPT Desktop 继续处理或重新从飞书发送。

## 启动与检查

```bash
npm run build
node dist/app/cli.js doctor
node dist/app/cli.js run
```

一个 config home 同时只允许一个 Bridge 进程。运行期获得带 PID/所有者校验的私有锁；配置重置也有独立锁，二者互斥。

旧版本升级使用显式重置，不迁移旧会话、任务或审批状态：

```bash
# 只查看将保留/删除什么，不写文件
codex-feishu-bridge config reset

# 仅在旧目录时执行：保留 .env 的注释、顺序、未知键，清空 bindings
codex-feishu-bridge config reset --confirm

# 当前已经是新结构时，只有明确 destructive 才会清空已有 bindings
codex-feishu-bridge config reset --confirm --destructive
```

重置会将 `.env` 中的 `BRIDGE_CONFIG_VERSION` 升级为 `2`，删除所有旧运行文件，并要求用户重新 `/bind`。

## 飞书命令

`/bind`、`/l`、`/list`、`/ll`（含旧版尾随参数）均显示会话选择卡；`/ll` 是表格视图。`/binding` 显示当前绑定，`/open` 打开精确的已绑定会话，`/unbind` 解除绑定。绑定卡和打开卡都限制 tenant/chat、授权用户、revision、10 分钟 TTL；打开卡只能使用一次。

还支持：

- `/help`、`/h`、`help`、`h`
- `/status`、`/usage`、`/quota`
- `/model`、`/personality`、`/style`、`/plan`、`/cwd`、`/workspace`
- `/new`、`/create`、`/fork`、`/branch`、`/delete`、`/archive`
- `/goal`、`/compact`、`/compress`、`/mcp`、`/skills`
- `/cancel`、`/stop`，以及任务卡的“停止任务”按钮
- `/cmd`、`/run`、`/shell` 与旧 router 的未知 slash fallback（首命令必须在 `ALLOWED_SHELL_COMMANDS` 白名单中）

飞书消息必须先显式绑定既有会话。普通任务通过 Desktop follower IPC 进入这个精确 thread：新 root 走 start，同 root 运行期间的补充消息走 steer，不同 root 排队。`@技能名称` 文本会原样保留并进入 Desktop runtime；当前 Desktop follower 协议没有独立的结构化 skill 字段，Bridge 不会猜测或重写技能内容。

会话可见性由 `ALLOWED_CHATS` 决定。卡片会作为发起消息的 reply，始终留在原会话/原话题，而不是临时会话。

## 卡片和审批

任务卡保留原有 `🌌 Codex Remote Control` 流式布局、Prompt/metadata/推理过程/工具折叠面板/最终结果/统计页脚和固定 element ID。运行中显示 `▍` 光标；终态先关闭 streaming mode，再替换完整成功、失败或取消卡。页脚随 Desktop stream 和共享 TTL 的 account/rate-limit 查询更新模型、输入/输出 token、上下文、API 次数、7d reset 与 credits。

Desktop 请求 command/file approval 时，Bridge 在相同飞书 root 下发送独立审批卡。`accept`、`acceptForSession`、`decline`、`cancel` 只在 Desktop 允许时显示；操作后会将原审批卡替换为不可再点击的最终状态卡。审批或任务的 IPC 结果会区分“未发送、明确拒绝、结果未知”，未知结果绝不自动重试。

打开指定会话使用当前 Codex 文档保留的 `codex://threads/<threadId>` 兼容 deep link。导航只使用已持久绑定的精确 thread ID，失败不会改变 binding 或任务投递目标。若 Desktop follower router 返回 `no-client-found`（明确表示该 thread 尚未有页面 owner，未执行 turn），Bridge 会自动打开该绑定会话，并在短暂等待后限次重试；超时、连接丢失或其他拒绝结果绝不自动重试。

## 验收

```bash
npm run typecheck:app
npm run test:app
npm run build:app
npm run check:package
```

发布前还要以真实飞书机器人和 ChatGPT Desktop 手工验证：选择/重绑/解绑、`/open`、新 root + steer + interrupt、Desktop 页面实时显示、推理/工具/终态卡流式更新、审批最终卡、7d 用量、Bridge/网络/ChatGPT 重启后的“不重放”边界，以及配置 reset 的 dry-run/confirm/destructive 三种路径。
