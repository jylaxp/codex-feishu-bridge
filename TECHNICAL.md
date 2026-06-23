# Codex-Feishu Bridge 技术实现与架构方案

本项目是一个用于连接飞书机器人（Feishu Bot）与本地 Codex Desktop 客户端或 App Server 的桥接服务。本技术文档详细介绍了网桥的底层通信原理、API 设计、交互逻辑以及核心的流式卡片渲染方案。

---

## 🔬 核心技术内幕 (Core Technical Architecture)

### 1. 底层通信通道 (Core Communication Channels)

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

#### A. Codex App Server 通道：WebSocket over UDS
当 Codex 运行时，会创建 Unix Domain Socket：
- **UDS 路径**：`~/.codex/app-server-control/app-server-control.sock`
- **协议层**：基于 UDS 运行的 **WebSocket** 协议（标准 HTTP 握手升级）。
- **数据格式**：标准 JSON-RPC 2.0。

##### 连接握手机制
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

##### 常用 RPC 方法列表
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

#### B. Codex Desktop IPC 通道：Length-Prefixed TCP over UDS
为了实现在桌面上与 Codex 前端 UI 实时同步，网桥会探测并连接到 Codex 桌面端的私有 IPC 管道。
- **UDS 路径**：探测系统临时目录下的 `/tmp/codex-ipc/ipc-*.sock` 或 `/tmp/codex-ipc/ipc.sock`。
- **协议**：裸 TCP Unix 套接字（不含 HTTP/WebSocket 协议头）。
- **帧封装规范（Length-Prefixed Buffer）**：
  为避免 TCP 字节流传输时的粘包与断包问题，每一帧由 **4 字节定长头部** + **UTF-8 JSON 数据体** 构成。**头部表示数据体的字节长度，且必须采用当前主机 CPU 的字节序（Endianness）写入**：
  ```
  +-----------------------------------+-----------------------------------+
  |  Length Header (4-Byte UInt32)    |  JSON Content (UTF-8 Bytes)       |
  +-----------------------------------+-----------------------------------+
  ```
  - **组包发送 (Node.js)**：
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

##### 桌面端握手与命令交互
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
2. **触发自主执行 (startTurn)**：
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

### 2. 飞书 CardKit 2.0 实时流式更新

飞书网桥全面升级为了 Lark CardKit 2.0 消息卡片，以达成高美观度与流式打字机渲染效果。

#### A. 获取 Tenant Access Token
调用飞书 Open API 之前，需使用机器人的凭证换取 Token：
- **请求地址**：`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- **Body 格式 (JSON)**：
  ```json
  {
    "app_id": "cli_xxxxxxxx",
    "app_secret": "xxxxxxxxxxxxxxxx"
  }
  ```

#### B. 创建 CardKit 卡片并发送
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

#### C. CardKit 2.0 流式修改 (PUT 接口)
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
    - `codex_process`：流式输出网桥捕获的本地 Shell 执行日志。
    - `codex_output`：流式渲染最终生成的 markdown 代码与回答。
    - `codex_footer`：更新最终的消耗 Token 和执行状态（完成/被拒等）。

---

### 3. 任务取消与中断机制

为了能让飞书用户在遇到失控的任务时能够及时损，网桥集成了任务的中断和取消控制。

#### A. 飞书端控制指令
在与网桥绑定的会话中，发送以下指令可立即中止当前任务：
* `/cancel`
* `/stop`

> [!NOTE]
> 如果此时网桥正处于异步触发阶段（`threadToActiveTurnId` 保存的依然是暂时的 `temp-` ID），系统会提示“任务正在启动中，请在几秒后任务开始运行后再输入 `/cancel` 取消”。

#### B. 底层中断通信 (turn/interrupt)
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

### 4. 系统指令与技能 (Skills) 调用机制

#### A. 系统控制指令
用户可以直接在飞书群聊中发送以 `/` 开头的指令来控制会话状态与配置，网桥在后台拦截这些指令后，通过特定的 JSON-RPC 向本地 App Server 通讯，并以 CardKit 卡片返回状态。

部分代表性核心逻辑：
* **`/plan`**：切换“计划模式”。开启后，后续下发的所有 Turn 执行都会携带 `collaborationMode: "plan"` 参数，强制 LLM 在修改代码前先写方案进行人工审批。
* **`/compact`**：手动触发上下文整理压缩（调用 `thread/compact/start`），精简令牌占用并保持会话流畅。
* **`/fork [新分支名称]`**：派生复制当前会话（调用 `thread/fork`），成功后飞书群聊将无缝绑定到新的派生会话上。

#### B. 技能提及与调用（@提及技能）
网桥在后台实现了自动提取和映射 Codex 原生技能的能力：
* **提及语法**：`@<技能名称> <实际 prompt>`（例如：`@excel-parser 读取数据.xlsx`）。
* **匹配机制**：
  网桥会在接收消息时，在后台通过 `skills/list` 接口获取该项目下所有 Skills，对 `@` 后的名称进行忽略大小写和连字符的模糊匹配。
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
          "name": "excel-parser",
          "path": "/absolute/path/to/skill"
        },
        {
          "type": "text",
          "text": "读取数据.xlsx"
        }
      ]
    }
  }
  ```

---

## 🛠️ 开发与复刻指引 (Development Guide)

如果其他开发者希望复刻本项目，实现完全一致的 Codex-飞书联动效果，可按照以下步骤进行：

### 第一步：开启本地通讯代理
1. 连接本地 `~/.codex/app-server-control/app-server-control.sock`。
2. 发送握手包 `initialize` 激活 RPC 服务。
3. 连接到桌面端临时套接字 `/tmp/codex-ipc/ipc.sock`，并发送 `clientType: 'vscode'` 注册，确保可以获取桌面前台的控制句柄。

### 第二步：注册飞书事件监听与 WebSocket 长连接
1. 在飞书开放平台创建一个企业自建应用，在“事件与回调”页面中将订阅方式设置为 **“使用长连接接收事件/回调”**。
2. 使用官方 `@larksuiteoapi/node-sdk` 的 `lark.ws.Client`，配置 `appId` 与 `appSecret`，启动长连接。
3. 注册 `im.message.receive_v1` 事件，过滤并拦截带有斜杠前缀的命令，将其引流至对应的逻辑处理器。

### 第三步：发送状态卡片与启动 Turn 执行
1. 当用户 @机器人 发送日常开发请求时，首先调用 `POST /cardkit/v1/cards` 创建一个包含 `codex_prompt`、`codex_reasoning`、`codex_output` 等组件的**初始化空白交互卡片**。
2. 调用 `POST /im/v1/messages` 发送此卡片。
3. 通过桌面 IPC 或 App Server WebSocket，调用 `startTurn` RPC 指令启动 turn。
4. 订阅来自 Codex 的流式返回块（监听 `thread-stream-state-changed` 广播事件）。
5. 每次收到新的文本块，追加到当前文本后面，并调用 `PUT /cardkit/v1/cards/{cardId}/elements/{elementId}/content` 修改卡片，传入累加的 `sequence` 值。
6. 当 AI 结束 Turn，更新 `codex_footer` 状态并落盘存储。
