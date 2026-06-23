# Codex-Feishu Bridge 技术实现与架构方案

本项目是一个用于连接飞书机器人（Feishu Bot）与本地 Codex Desktop 客户端或 App Server 的桥接服务。本技术文档详细介绍了网桥的底层通信原理、系统生命周期设计、运维管理以及核心的流式卡片渲染与交互界面方案。

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
* **`initialize`**：连接初始化握手，用于声明客户端标识（如 `feishu-bridge`）以及所需的能力。
* **`thread/list`**：检索未归档的活跃会话。
* **`thread/start`**：创建新的 Codex 会话。
* **`thread/resume`**：断线重连或重新挂载活跃会话状态，激活流式事件订阅。
* **`thread/name/set`**：设置会话名。
* **`thread/fork`**：基于已有会话派生新分支。
* **`thread/archive`**：归档解绑会话。
* **`thread/compact/start`**：手动整理并压缩当前上下文窗口。
* **`thread/goal/set`** / **`thread/goal/clear`** / **`thread/goal/get`**：长期任务目标模式的操作接口。
* **`turn/start`**：在指定会话（Thread）中启动一次执行任务（Turn），传入 Prompt、CWD 及计划协作模式。
* **`turn/interrupt`**：中断或取消当前正在运行的任务 (Active Turn)。
* **`account/rateLimits/read`**：查询账户使用额度和配额消耗情况（包含短期/长期窗口已用量及重置时间）。
* **`skills/list`**：检索当前工作区下所有可用技能的声明。
* **`mcpServerStatus/list`**：检索当前会话绑定的 MCP（Model Context Protocol）服务器列表、启用状态及认证状态。

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
  网桥会在接收消息时，在后台通过 `skills/list` 接口获取该项目下所有 Skills，对 `@` 后的名称进行忽略大小写 and 连字符的模糊匹配。
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

## 🛠️ 系统生命周期与运维管理 (Lifecycle & Maintenance)

### 1. 同步前置初始化
为了避免后台守护进程（Detached）由于缺失配置或权限问题在后台静默崩溃，网桥 CLI 主进程在执行 `start`、`run` 和 `init` 命令的第一步，均会通过 `ensureLogDir()` 同步执行配置和目录初始化：
* 自动创建专属的工作目录 `~/.codex-feishu-bridge/` 与 `logs/`。
* 如果 `.env` 配置文件不存在，则同步写入默认配置模板。

### 2. 凭证清理与冲突解决机制
当自动注册飞书机器人启动时，由于环境变量可能残留有占位符（如 `YOUR_FEISHU_APP_ID`）或者因 CRLF 换行符与多余空格产生的异常格式，系统在调用飞书注册 API 之前，实现了以下加固逻辑：
* **白边去除 (Trimming)**：对加载的凭证自动执行 `.trim()` 以滤除可能的 `\r` 换行符。
* **安全删除环境变量**：在检测到需要走“自动注册”时，主动从 `process.env` 中 `delete` 掉空的或占位符环境变量，防止干扰飞书 SDK 的内部配置读取。

### 3. 应用凭据安全重置 (rebind)
网桥提供了 `rebind` 命令行工具。该命令能够通过正则表达式定位并精确清除 `.env` 中的凭证项，将其恢复至默认占位符，同时保留用户自定义的其余环境变量（如 `CODEX_BIN` 等），避免直接删除 `.env` 导致自定义配置丢失。

### 4. 精细化日志流管理 (LOG_TO_FILE)
网桥支持通过 `LOG_TO_FILE` 开关控制是否写 info 日志：
* 当 `LOG_TO_FILE=true`：将普通日志（INFO/WARN）写入本地日志文件，不再输出到控制台。
* 当 `LOG_TO_FILE=false`：不写入普通日志，并且不在控制台输出。
* **错误日志 (ERROR)**：不受此开关控制，在任何情况下均会同时写入日志文件并输出到控制台（stderr）。

---

## 🎭 界面交互与细节设计 (User Interface & UX Details)

### 1. 统一 24 小时制时间格式 (formatDateTime24h)
为彻底杜绝不同操作系统/终端区域语言环境下 locale 默认输出 12 小时制带 AM/PM 的混乱现象，网桥设计并导出了统一的日期格式化辅助函数：
```typescript
export function formatDateTime24h(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}
```
该函数已被应用在审批卡片时间戳、使用量统计卡片重置时间以及目标任务时间戳格式化等所有与用户交互的输出中。

### 2. 会话列表分组与字典序排序
`/list` 导出的会话卡片菜单下拉选项中，列表采用以下排序组合算法：
* **全局会话置顶**：所有的全局会话默认强制排列在列表首部（格式为 `🌐 会话名称 (全局)`），其内部以会话名称进行排序。
* **项目会话按字典序排序**：
  * **第一层**：按照项目 basename 目录别名对项目整体进行排序。
  * **第二层**：对处于相同项目底下的会话，按其会话名进行字典序排序。
* 排序基于 JavaScript 原生的 `localeCompare('zh-CN', { numeric: true })` 实现，完美支持英文按字母、中文按拼音以及数字混合排列的字典序升序。

### 3. 下拉菜单展示优化与截断防护
* **展示策略（会话名称置前）**：由于飞书移动端等客户端下拉菜单的显示宽度受限，如果将项目名称放在最前面（如 `📁 项目名 ➜ 会话主题`），会导致关键的会话主题在视觉上被排在后面的 ellipsis (`...`) 截断。因此，网桥采取了**会话主题置前，项目名称置后作为元数据括号包裹**的呈现方案（如 `💬 会话主题 (📁 项目名)`），确保用户能第一眼辨识出会话内容。
* **100 字符上限限制**：飞书官方 `select_static` 下拉选项对 label 的最大长度有着严格 of **100 字符限制**。为了防止选项总长度超出导致飞书接口报错，代码会对拼接后的字符串进行安全截断，即超出 100 字符的部分自动处理为 `...` 后缀。

### 4. 表格视图会话列表 (Table Component)
为了彻底解决飞书移动端下拉选项因物理宽度受限被强制截断、用户无法阅读会话全名的体验痛点，网桥额外实现了以表格视图（Table Component）呈现会话列表的 `/ll` 指令：
* **结构呈现**：基于飞书 CardKit 2.0 原生的 `table` 组件构建，拥有“序号 (col_idx)”、“会话名称 (col_name)”与“所属项目 (col_project)”三列。由于 `table` 单元格支持高度自适应与文字折行，会话全名能够无损完整展示。
* **数字索引交互**：飞书原生 `table` 单元格中不支持直接内嵌交互式按钮或行点击。网桥在表格下方配置了一个简短的 `select_static` 下拉选择菜单，以 `#序号 ➜ 会话名` 进行精简展示，使用户可以通过数字索引对应快速选中要绑定的会话，彻底绕开了飞书长文本截断问题。

---

## 🔌 与 Codex 交互接口与 Token 统计方案

在日常消息交互、`/usage` 轮询以及命令执行结果卡片组装中，网桥与 Codex 建立了紧密的接口交互与 Token 指标解析方案。

### 1. 账户使用量与配额获取 (Account Rate Limits / Usage)
* **RPC 方法**：`account/rateLimits/read`
* **交互路径**：通过 UDS WebSocket 通道，发送标准的 JSON-RPC 2.0 请求。
* **参数**：无。
* **数据结构与降级解析**：
  网桥会根据 Codex App Server 返回的使用量响应进行深度解析，支持新老版本的数据降级获取：
  ```javascript
  const codexLimits = res?.rateLimitsByLimitId?.codex || res?.rateLimits;
  ```
  从中提取并为用户卡片渲染以下关键指标：
  * **计划类型 (`planType`)**：例如 `pro` 或 `free`。
  * **短期用量窗口 (`primary`)**：对应 5h 的使用量。解析其 `usedPercent`（已用百分比）与 `resetsAt`（秒级重置时间戳，用于 24 小时制转换）。
  * **长期用量窗口 (`secondary`)**：对应 168h（7d）的使用量。解析其 `usedPercent` 与 `resetsAt` 时间戳。
  * **积分点数余额 (`credits`)**：如果账户有剩余积分，显示其 `balance`。

### 2. Token 使用量统计与提取方案 (Token Usage Extraction)
为了统计每个 Turn 实际消耗的 LLM Tokens，网桥实现了一套高兼容性的新老两代 Token 属性解析逻辑。

#### A. 新版 Token 统计方案 (Explicit `tokenUsage` Object)
新版 Codex 返回的消息参数（如在 `turn/completed` 事件，或专门的 `thread/tokenUsage/updated` 通知中）会携带一个显式的 `tokenUsage` 属性结构体。网桥会直接对其进行映射提取：
* **单次请求消耗**：读取 `tokenUsage.last.inputTokens`（提示词 Tokens）和 `tokenUsage.last.outputTokens`（回复 Tokens）。
* **当前上下文大小**：优先读取 `tokenUsage.last.totalTokens`；若没有，则读取整轮会话上下文的累积占用总量 `tokenUsage.total.totalTokens`。
* **模型上下文极限**：读取 `tokenUsage.modelContextWindow` 以确定该模型的最大上下文窗口限制。
* **所用模型名**：读取 `params.model`。

#### B. 老版/备用 Token 统计方案 (Recursive Semantic Search)
如果 Codex 事件参数中缺失显式的 `tokenUsage` 对象，网桥会自动对接收的 `params` 参数对象启动**最大深度为 8 层的深度优先递归搜索**。在递归过程中，通过键名的语义匹配进行指标降级抓取：
* **输入 Token 数 (Prompt Tokens)**：匹配 `"input_tokens"`, `"inputTokens"`, `"prompt_tokens"`, `"promptTokens"`, `"tokens_in"`, `"tokensIn"`。
* **输出 Token 数 (Completion Tokens)**：匹配 `"output_tokens"`, `"outputTokens"`, `"completion_tokens"`, `"completionTokens"`, `"tokens_out"`, `"tokensOut"`。
* **总上下文 Token 数 (Total Tokens)**：匹配 `"context_tokens"`, `"contextTokens"`, `"context_used_tokens"`, `"contextUsedTokens"`, `"total_tokens"`, `"totalTokens"`。
* **模型上下文极限 (Context Limit)**：匹配 `"context_length"`, `"contextLength"`, `"context_window"`, `"contextWindow"`, `"modelContextWindow"`, `"max_context_tokens"`, `"maxContextTokens"`。
* **请求调用次数 (API Calls)**：匹配 `"api_calls"`, `"apiCalls"`, `"api_requests"`, `"apiRequests"`, `"request_count"`, `"requestCount"`。
* **模型名称 (Model Name)**：匹配 `"model"`, `"model_name"`, `"modelName"`, `"model_id"`, `"modelId"`, `"toModel"`。

#### C. Token 统计数据的实时更新与补录机制
* **实时更新**：在 WebSocket 监听的所有流式或单步状态变更事件（如 `turn/step/completed`）中，网桥会自动执行 `extractStatsFromParams` 将提取的最新数据实时合并到本地的 `turn.stats` 状态，并更新卡片。
* **延迟补录 (`thread/tokenUsage/updated` 广播事件)**：
  部分 Token 统计信息在 Codex 引擎刚完成时可能会有几秒的计算延迟。网桥注册了专门的 `thread/tokenUsage/updated` UDS 长连接通知广播：当后台监听到此通知且会话已经停止运行时，会立刻异步将补录的最新 Token 数据再次写入飞书最终卡片，以确保展示的 Token 消耗数据 100% 准确。

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
