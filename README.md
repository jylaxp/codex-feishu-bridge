# 🔌 Feishu-Codex Bridge (飞书-Codex 网桥)

飞书-Codex 网桥是一个本地桥接程序，用于将飞书机器人服务（Feishu Bot）桥接至本地的 Codex 桌面客户端或 App Server。

通过对 Codex 桌面端及其服务底层的反向工程与反编译分析，我们整理了完整的通信协议、私有套接字接口以及飞书高级 CardKit 消息卡片的实时流式渲染方案。

---

## 📦 安装与使用指南 (Installation & CLI Guide)

我们提供了全局命令行 CLI 工具，帮助您快速配置并以常驻守护进程的方式运行网桥：

### 1. 全局安装 (三种分发方式)

如果该网桥没有发布到 NPM 官方公开源，您可以通过以下三种方式进行全局安装和共享：

* **方式 A：通过 Git 仓库远程安装 (推荐，适合版本共享)**：
  如果您将源码提交到了 GitHub 或私有 Git 仓库，别人可以直接通过 Git 地址进行全局安装：
  ```bash
  npm install -g git+https://github.com/<您的用户名>/codex-feishu-bridge.git
  ```

* **方式 B：本地源码安装 (适合开发调试或局域网共享)**：
  如果您的朋友直接拿到了您的源码文件夹，可以在源码根目录（`bridge` 文件夹）下运行以下命令进行全局挂载链接：
  ```bash
  # 进入项目目录并挂载命令
  npm link
  ```
  *(或者也可以使用 `npm install -g .` 进行本地安装)*。

* **方式 C：离线包分发安装 (打包成 .tgz 压缩文件)**：
  如果您想离线发送一个安装包给朋友：
  1. 在您的源码根目录下运行：`npm pack`。这会生成一个类似 `codex-feishu-bridge-1.0.0.tgz` 的压缩包。
  2. 把这个 `.tgz` 文件发送给您的朋友，他们在终端运行如下命令即可全局安装：
     ```bash
     npm install -g ./codex-feishu-bridge-1.0.0.tgz
     ```

### 2. 初始化配置 (支持飞书扫码自动配置 🚀)

网桥提供了**免手动创建应用、免手动填秘钥**的极致体验，支持直接使用**飞书 App 扫码自动注册机器人**。

* **扫码自动配置（强烈推荐）**：
  1. 在空白目录中直接执行初始化：
     ```bash
     codex-feishu-bridge init
     ```
  2. **直接在前台启动网桥**以显示二维码：
     ```bash
     codex-feishu-bridge run
     ```
  3. 控制台检测到配置为空，会自动调用飞书 API 并在终端渲染出一个**授权二维码**：
     - 打开您手机上的飞书 App，扫描终端里的二维码并确认授权。
     - 授权通过后，系统会**自动在您的企业中创建对应的自建应用、开通机器人权限并订阅 WebSocket 长连接事件**。
     - 生成的 `LARK_APP_ID` 与 `LARK_APP_SECRET` 会**自动写入 `~/.codex-feishu-bridge/.env` 配置文件中**。
     - 终端显示 `Feishu WebSocket Client started` 即代表注册及连接成功。您可以按 `Ctrl + C` 终止前台进程，然后进入第三步使用后台常驻模式。

* **手动配置（备用）**：
  如果您想使用已有的自建应用，可以直接编辑生成的 `~/.codex-feishu-bridge/.env` 配置文件，填入您的飞书凭证：
  ```env
  LARK_APP_ID=YOUR_FEISHU_APP_ID
  LARK_APP_SECRET=YOUR_FEISHU_APP_SECRET
  ```

### 3. 运行网桥服务
* **后台常驻启动 (守护进程模式)**：
  ```bash
  codex-feishu-bridge start
  ```
  网桥会在后台静默运行，并自动生成 `~/.codex-feishu-bridge/bridge.pid`。所有的控制台日志将重定向至：
  - 标准日志：`tail -f ~/.codex-feishu-bridge/logs/bridge_stdout.log`
  - 错误日志：`tail -f ~/.codex-feishu-bridge/logs/bridge_stderr.log`

* **查看运行状态**：
  ```bash
  codex-feishu-bridge status
  ```

* **停止后台运行**：
  ```bash
  codex-feishu-bridge stop
  ```

* **前台调试启动 (Foreground)**：
  ```bash
  codex-feishu-bridge run
  ```

---

## ⚙️ 配置文件与存储说明 (Configuration & Storage Guide)

网桥的所有配置与日志均存储于用户主目录下的专属目录 `~/.codex-feishu-bridge/` 中：

* **配置文件路径**：`~/.codex-feishu-bridge/.env`
* **日志文件路径**：`~/.codex-feishu-bridge/logs/`

### 配置文件 `.env` 详细参数说明：

| 配置键名 | 说明 | 示例值 / 默认值 |
| :--- | :--- | :--- |
| `LARK_APP_ID` | 飞书开放平台自建应用的 App ID (或旧版 `APP_ID`) | `cli_aaa39297b9b95cc5` |
| `LARK_APP_SECRET` | 飞书开放平台自建应用的 App Secret (或旧版 `APP_SECRET`) | `UGSfPt0IZcwXAKp...` |
| `ALLOWED_APPROVERS` | 允许审批终端命令执行的飞书用户 Open ID 列表，用英文逗号分隔 | `ou_f490a33f34ee...` |
| `RATE_LIMIT_QUERY_INTERVAL_MS` | 5h/7d 剩余窗口用量的轮询刷新间隔时间（单位：毫秒） | `300000` (默认 5 分钟) |
| `CODEX_BIN` | 本地 Codex 命令行工具的绝对路径（用于桥接程序未在 PATH 时自动调起后台服务） | `/Applications/Codex.app/Contents/Resources/codex` |
| `LOG_TO_FILE` | 是否开启文件日志记录开关。设置为 `true` 时，普通的控制台输出将重定向至日志文件，保持标准输出整洁 | `false` (默认不开启) |
| `LOG_FILE_PATH` | 重定向日志文件的名称或绝对路径，开启文件日志后生效（默认保存在 `logs` 目录下） | `bridge.log` |

---

## 💬 飞书机器人交互指令说明 (Feishu Bot Interactive Commands)

在飞书聊天群或单聊中绑定会话后，直接发送日常对话即可与本地 Codex 交互推理。同时，网桥提供了丰富的快捷斜杠指令（Slash Commands）来辅助管理会话与状态：

| 快捷指令 | 功能说明 | 示例 / 参数 |
| :--- | :--- | :--- |
| `/help` 或 `/h` | 获取所有支持的快捷指令和使用帮助卡片 | `/help` |
| `/list` | 拉取本地 Codex 活跃会话列表，用于选择并绑定当前聊天 | `/list` |
| `/new [名称]` 或 `/create [名称]` | 快速在本地启动一个新会话并自动与当前聊天绑定 | `/new 我的新项目` |
| `/cwd [路径]` 或 `/workspace [路径]` | 查询或动态修改当前已绑定会话的工作目录 (CWD) | `/cwd /Users/workspace/project` |
| `/cmd [命令]` 或 `/run [命令]` | 在本地 macOS 的当前工作目录下执行经过安全过滤允许的命令 | `/cmd git status` |
| `/goal [目标内容]` | 为当前会话设定一个长期自主任务并自动开始执行 | `/goal 编写完整的单元测试` |
| `/goal` | 查询当前会话的任务目标内容、执行进度与消耗 | `/goal` |
| `/goal clear` 或 `/goal -c` | 清除当前会话的目标任务 | `/goal clear` |
| `/usage` 或 `/quota` | 获取当前账户的短期 (5h) / 长期 (7d) 窗口用量统计及下次重置刷新时间 | `/usage` |
| `/mcp` | 展示本地所有 MCP 服务及认证连接状态 | `/mcp` |
| `/personality [friendly\|pragmatic\|none]` | 设置或查询回复风格（friendly: 亲和, pragmatic: 务实, none: 默认） | `/personality pragmatic` |
| `/compact` 或 `/compress` | 压缩当前会话的上下文窗口（主动释放历史 Token） | `/compact` |
| `/fork [新名称]` | 派生复制当前会话，并将当前飞书群聊自动绑定至新派生的会话 | `/fork 分支测试` |
| `/plan [on\|off]` | 开启或关闭“计划模式”。开启后日常指令执行前必须由您审批计划 | `/plan on` |
| `/status` | 综合展示面板（包含会话名称、ID、当前 CWD、个性设定、计划模式及目标详情） | `/status` |
| `/skills` | 列出当前工作区下可用的所有技能（Skills） | `/skills` |
| `@技能名称 [输入内容]` | 在日常对话中通过提及调用特定的技能服务 | `@excel-parser 读取数据.xlsx` |
| `/delete` 或 `/archive` | 将当前聊天与 Codex 会话解绑，并在本地归档该会话 | `/delete` |

---

## 🛠️ 第一部分：反向工程与底层通信原理 (Core Communication Channels)

网桥与本地 Codex 主要通过以下两条底层数据通道交互：

```
                    +------------------------------------+
                    |        Feishu Bot Platform         |
                    +-----------------+------------------+
                                      | (WebSocket Stream)
                                      v
                    +------------------------------------+
                    |        codex-feishu-bridge         |
                    +----+--------------------------+----+
                         |                          |
                         | (WebSocket over UDS)     | (Length-Prefixed TCP)
                         v                          v
  +--------------------------------------+  +------------------------------------+
  |          Codex App Server            |  |         Codex Desktop App          |
  | (Socket: ~/.codex/app-server-control)|  |   (Socket: /tmp/codex-ipc/*)       |
  +--------------------------------------+  +------------------------------------+
```

### 1. Codex App Server 通道：WebSocket over UDS
当 Codex 运行时，会在本地创建 Unix Domain Socket：
- **UDS 路径**：`~/.codex/app-server-control/app-server-control.sock`
- **协议层**：基于 UDS 运行的 **WebSocket** 协议（标准 HTTP 握手升级）。
- **数据格式**：标准 JSON-RPC 2.0。

#### 连接握手机制
网桥首先通过 Node.js 原生 `net.createConnection` 建立连接，然后使用 `ws` 库对其进行包装握手：
```typescript
this.ws = new WebSocket('ws://codex-app-server/', {
  perMessageDeflate: false,
  createConnection: () => net.createConnection(socketPath)
});
```
连接成功后，必须立即发送 `initialize` 方法完成握手：
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "feishu-bridge", "version": "1.0.0" },
    "capabilities": { "experimentalApi": true }
  }
}
```

#### 常用 RPC 方法列表
* **`thread/list`**：检索未归档的活跃会话。
* **`thread/start`**：创建新的 Codex 会话。
* **`thread/name/set`**：设置会话名。
* **`thread/fork`**：基于已有会话派生新分支。
* **`thread/archive`**：归档解绑会话。
* **`thread/compact/start`**：手动整理并压缩当前上下文窗口。
* **`thread/goal/set`** / **`thread/goal/clear`** / **`thread/goal/get`**：长期任务目标模式的操作接口。
* **`skills/list`**：检索当前工作区下所有可用技能的声明。
* **`turn/interrupt`**：中断或取消当前正在运行的任务 (Active Turn)。

---

### 2. Codex Desktop IPC 通道：Length-Prefixed TCP over UDS
为了实现在桌面上与 Codex 前端 UI 实时同步，网桥会探测并连接到 Codex 桌面端的私有 IPC 管道。
- **UDS 路径**：探测系统临时目录下的 `/tmp/codex-ipc/ipc-*.sock` 或 `/tmp/codex-ipc/ipc.sock`。
- **协议**：裸 TCP Unix 套接字（不含 HTTP/WebSocket 协议头）。
- **帧封装规范（Length-Prefixed Buffer）**：
  为避免 TCP 字节流传输时的粘包与断包问题，每一帧必须由 **4 字节定长头部** + **UTF-8 JSON 数据体** 构成。**头部表示数据体的字节长度，且必须采用当前主机 CPU 的字节序（Endianness）写入**：
  ```
  +-----------------------------------+-----------------------------------+
  |  Length Header (4-Byte UInt32)    |  JSON Content (UTF-8 Bytes)       |
  +-----------------------------------+-----------------------------------+
  ```
  - **组包发送（Node.js）**：
    ```typescript
    const msgBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
    const lenBuffer = Buffer.alloc(4);
    if (os.endianness() === 'LE') {
      lenBuffer.writeUInt32LE(msgBuffer.length, 0);
    } else {
      lenBuffer.writeUInt32BE(msgBuffer.length, 0);
    }
    const sendPacket = Buffer.concat([lenBuffer, msgBuffer]);
    client.write(sendPacket);
    ```
  - **拆包解析**：读取前 4 字节取得长度 `expectedLen`，等待缓冲区累积满 `expectedLen` 长度的数据后截取并进行 `JSON.parse`。

#### 桌面端握手与命令交互
1. **客户端注册 (initialize)**：
   建立连接后，向 IPC 写入首个包进行初始化注册：
   ```json
   {
     "type": "request",
     "requestId": "<uuid>",
     "method": "initialize",
     "params": { "clientType": "vscode" }
   }
   ```
   握手成功会返回包含专属 `clientId` 的成功响应。
2. **触发自主执行 (startTurn / startRemoteControlTurn)**：
   网桥发出执行请求时，会发送以下结构的控制帧：
   ```json
   {
     "type": "request",
     "requestId": "<uuid>",
     "method": "startTurn",
     "params": {
       "threadId": "会话 ID",
       "cwd": "执行的工作目录",
       "input": [{ "type": "text", "text": "用户提问/Goal描述" }],
       "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": ["工作目录路径"] }
     }
   }
   ```

---

## 🎨 第二部分：飞书 CardKit 2.0 核心 API 与流式更新机制

飞书网桥全面升级为了 Lark CardKit 2.0 消息卡片，以达成高美观度与流式打字机渲染效果。

### 1. 获取 Tenant Access Token
调用飞书 Open API 之前，需使用机器人的凭证换取 Token：
- **请求地址**：`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- **Body 格式 (JSON)**：
  ```json
  {
    "app_id": "cli_xxxxxxxx",
    "app_secret": "xxxxxxxxxxxxxxxx"
  }
  ```

### 2. 创建 CardKit 卡片并发送
飞书消息卡片采用两步发送法：
1. **第一步：向飞书云端后台创建卡片实例**
   - **请求地址**：`POST https://open.feishu.cn/open-apis/cardkit/v1/cards`
   - **Headers**：`Authorization: Bearer <tenant_access_token>`
   - **Body (JSON)**：
     ```json
     {
       "type": "card_json",
       "data": "{\"schema\":\"2.0\",\"config\":{\"wide_screen_mode\":true},\"header\":{\"template\":\"blue\",\"title\":{\"tag\":\"plain_text\",\"content\":\"卡片标题\"}},\"body\":{\"elements\":[{\"tag\":\"div\",\"element_id\":\"codex_output\",\"text\":{\"tag\":\"lark_md\",\"content\":\"卡片初始内容\"}}]}}"
     }
     ```
     *注意：`data` 字段为经过转义的卡片 Schema JSON 字符串。*
   - **返回值**：成功将获得 `data.card_id`。
2. **第二步：通过 IM 消息发送卡片**
   - **请求地址**：`POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
   - **Body (JSON)**：
     ```json
     {
       "receive_id": "飞书群聊/单聊 ID",
       "msg_type": "interactive",
       "content": "{\"type\":\"card\",\"data\":{\"card_id\":\"c_xxxxxxx\"}}"
     }
     ```

### 3. CardKit 2.0 核心优势：动态流式修改（PUT 接口）
当 Codex 在运行并进行思维链（CoT）推理、执行 Shell 命令或流式输出代码时，网桥**无需**重复发送新卡片，而是利用 CardKit 的 `PUT` 接口，依据页面组件 ID 在原地实时修改内容。这就是**打字机式流式响应**的底层原理：
- **请求地址**：`PUT https://open.feishu.cn/open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content`
- **Headers**：`Authorization: Bearer <tenant_access_token>`
- **Body (JSON)**：
  ```json
  {
    "content": "更新后的 Markdown 内容或日志文本",
    "sequence": 12
  }
  ```
- **核心规约 (Sequence & Elements)**：
  - `sequence`: 必须是针对当前卡片实例单调递增的整数（网桥维护一个累加器 `sequence++`）。若收到无序或小序号的 `sequence`，飞书云端会自动丢弃，防止高并发时客户端渲染抖动。
  - 常用动态组件 `element_id`：
    - `codex_prompt`：展示当前 Turn 的任务输入。
    - `codex_reasoning`：流式渲染 AI 推理过程（CoT 思维链）。
    - `codex_process`：流式打字机输出网桥捕获的本地 Shell 执行日志。
    - `codex_output`：流式渲染最终生成的 markdown 代码与回答。
    - `codex_footer`：更新最终的消耗 Token 和执行状态（完成/被拒等）。

---

## 🚀 第三部分：从零实现一个一模一样的网桥 (Step-by-Step Guide)

如果其他开发者希望复刻本项目，实现完全一致的飞书-Codex 联动效果，可按照以下步骤进行：

### 第一步：开启本地通讯代理
1. 连接本地 `~/.codex/app-server-control/app-server-control.sock`，或直接使用 `spawn('codex', ['app-server', '--listen', 'stdio://'])` 作为子进程管道。
2. 发送握手包 `initialize` 激活 RPC 服务。
3. 连接到桌面端临时套接字 `/tmp/codex-ipc/ipc.sock`，并发送 `clientType: 'vscode'` 注册，确保可以获取桌面前台的控制句柄。

### 第二步：注册飞书事件监听与 WebSocket 长连接
1. 在飞书开放平台创建一个企业自建应用，在“事件与回调”页面中将订阅方式设置为 **“使用长连接接收事件/回调”**。
2. 使用官方 `@larksuiteoapi/node-sdk` 的 `lark.ws.Client`，配置 `appId` 与 `appSecret`，启动长连接。
3. 注册 `im.message.receive_v1` 事件，过滤并拦截带有 `/goal`、`/cwd`、`/plan` 等斜杠前缀的命令，将其引流至对应的逻辑处理器。

### 第三步：发送状态卡片与启动 Turn 执行
1. 当用户 @机器人 发送日常开发请求时，首先调用 `POST /cardkit/v1/cards` 创建一个包含 `codex_prompt`、`codex_reasoning`、`codex_output` 等组件的**初始化空白交互卡片**。
2. 调用 `POST /im/v1/messages` 发送此卡片。
3. 通过桌面 IPC 或 App Server WebSocket，调用 `startTurn` RPC 指令启动 turn。
4. 订阅来自 Codex 的流式返回块（通过 `thread-stream-state-changed` 广播事件或 websocket 消息监听）。
5. 每次收到新的文本块，追加到当前文本后面，并调用 `PUT /cardkit/v1/cards/{cardId}/elements/{elementId}/content` 修改卡片，传入累加的 `sequence` 值。
6. 当 AI 结束 Turn，更新 `codex_footer` 状态并落盘存储。

---

## 🛑 第四部分：任务取消与中断机制 (Task Cancellation)

为了能让飞书用户在遇到失控的任务（如代码写错、陷入死循环、或者需要中途拦截）时能够及时止损，网桥集成了任务的中断和取消控制。

### 1. 飞书端控制指令
在与网桥绑定的会话中，发送以下指令可立即中止当前任务：
* `/cancel`
* `/stop`

> [!NOTE]
> 如果此时网桥正处于异步触发阶段（`threadToActiveTurnId` 保存的依然是暂时的 `temp-` ID），系统会友好地提示“任务正在启动中，请在几秒后任务开始运行后再输入 `/cancel` 取消”。

### 2. 底层通讯机制 (turn/interrupt)
当网桥拦截到取消指令时，会通过 UDS WebSocket 通道向 Codex App Server 触发 `turn/interrupt` 请求：
* **RPC 方法**：`turn/interrupt`
* **请求 Params**：
  ```json
  {
    "threadId": "当前绑定的会话 ID",
    "turnId": "当前活跃任务的 turn.id"
  }
  ```

App Server 在成功终止任务后会广播 `turn/completed` 事件，其中参数 `params.turn.status` 将会是 `interrupted`。网桥接收到此事件后会：
1. 立即清除该会话的活动 Turn ID 映射；
2. 在卡片执行日志中追加记录 `[System]: Turn was manually interrupted/canceled by the user.`；
3. 将该任务卡片的 header template 修改为中性灰 (`grey`)，并将卡片标题设为 **`🛑 Codex 执行已取消`**，以向群成员清晰地传达任务已被人工打断的信息。

---

## 🎯 第五部分：系统指令与技能 (Skills) 调用机制 (System Commands & Skills)

为了提供与 Codex 官方客户端完全一致的高级操作体验，网桥支持了丰富的系统指令拦截以及原生的技能 (Skills) 调用逻辑。

### 1. 系统控制指令
用户可以直接在飞书群聊中发送以 `/` 开头的指令来控制会话状态与配置，网桥在后台拦截这些指令后，通过特定的 JSON-RPC 向本地 App Server 通讯，并以 CardKit 卡片返回状态：

* **`/status`**：综合状态面板，一目了然展示当前绑定的会话 ID、CWD 工作区路径、当前设定的回复风格、是否开启计划模式等。
* **`/plan`**：切换“计划模式”。开启后，后续下发的所有 Turn 执行都会携带 `collaborationMode: "plan"` 参数，强制 LLM 在修改代码前先写方案进行人工审批。
* **`/personality [friendly|pragmatic|none]`**：设定会话的回复风格（亲和、务实或默认），选项会自动持久化到本地的 `sessions.json`。
* **`/compact`**：手动触发上下文整理压缩（调用 `thread/compact/start`），精简令牌占用并保持会话流畅。
* **`/fork [新分支名称]`**：派生复制当前会话（调用 `thread/fork`），成功后飞书群聊将无缝绑定到新的派生会话上。
* **`/skills`**：列出当前项目工作区下所有的可用 Skills。
* **`/mcp`**：实时拉取并渲染当前绑定的所有 MCP 服务的运行状况及 OAuth 认证入口。

### 2. 技能提及与调用（@提及技能）
网桥在后台实现了自动提取和映射 Codex 原生技能的能力：
* **提及语法**：`@<技能名称> <实际 prompt>`（例如：`@Ce Debug 为什么我的项目有类型报错`）。
* **匹配机制**：
  网桥会在接收消息时，在后台通过 `skills/list` 接口获取该项目下声明的所有 Skills，对 `@` 后的名称进行忽略大小写和连字符的模糊匹配。
* **RPC 协议组装**：
  一旦匹配成功，网桥会重构 `input` 数组，将技能的 `name` 和 `path` 作为结构化对象推入 `input` 中，并剥离掉文本中的 mentions 标志：
  ```json
  {
    "method": "turn/start",
    "params": {
      "threadId": "...",
      "input": [
        {
          "type": "skill",
          "name": "Ce Debug",
          "path": "/absolute/path/to/skill"
        },
        {
          "type": "text",
          "text": "为什么我的项目有类型报错"
        }
      ]
    }
  }
  ```
