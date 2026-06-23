# 🔌 Codex-Feishu Bridge (Codex-飞书网桥)

Codex-飞书网桥 (Codex-Feishu Bridge) 是一个本地桥接程序，用于将飞书机器人服务（Feishu Bot）桥接至本地的 Codex 桌面客户端或 App Server。

通过对 Codex 桌面端及其服务底层的深入分析，网桥实现了飞书高级 CardKit 消息卡片的实时流式渲染与后台服务自动化绑定。若您对底层的通信协议、私有套接字接口与数据帧封装细节感兴趣，请参阅独立的 [技术实现与架构方案文档 (TECHNICAL.md)](./TECHNICAL.md)。

---

## 📖 目录
- [🔌 Codex-Feishu Bridge (Codex-飞书网桥)](#-codex-feishu-bridge-codex-飞书网桥)
  - [📖 目录](#-目录)
  - [📦 安装与使用指南](#-安装与使用指南)
    - [1. 全局安装](#1-全局安装)
    - [2. 初始化配置 (支持飞书扫码自动配置 🚀)](#2-初始化配置-支持飞书扫码自动配置-)
    - [3. 运行网桥服务](#3-运行网桥服务)
  - [⚙️ 配置文件与存储说明](#️-配置文件与存储说明)
    - [工作目录结构](#工作目录结构)
    - [配置文件 `.env` 详细参数说明](#配置文件-env-详细参数说明)
  - [💬 飞书机器人交互指令说明](#-飞书机器人交互指令说明)
  - [🔬 架构与底层协议原理](#-架构与底层协议原理)

---

## 📦 安装与使用指南

我们提供了全局命令行 CLI 工具，帮助您快速配置并以常驻守护进程的方式运行网桥。

### 1. 全局安装

如果该网桥没有发布到 NPM 官方公开源，您可以通过以下三种方式进行全局安装 and 共享：

* **方式 A：通过 Git 仓库远程安装 (推荐，适合版本共享)**
  如果您将源码提交到了 GitHub 或私有 Git 仓库，其他人可以直接通过 Git 地址进行全局安装：
  ```bash
  npm install -g git+https://github.com/jylaxp/codex-feishu-bridge.git
  ```

* **方式 B：本地源码安装 (适合开发调试)**
  在源码根目录（`bridge` 文件夹）下运行以下命令进行全局挂载链接：
  ```bash
  # 进入项目目录并挂载命令
  npm link
  ```
  *(或者也可以使用 `npm install -g .` 进行本地安装)*。

* **方式 C：离线包分发安装 (打包成 .tgz 压缩文件)**
  如果您想离线发送一个安装包给他人：
  1. 在源码根目录下运行：`npm pack`。这会生成一个类似 `codex-feishu-bridge-1.0.0.tgz` 的压缩包。
  2. 将该 `.tgz` 文件发送给目标电脑，在终端运行如下命令即可全局安装：
     ```bash
     npm install -g ./codex-feishu-bridge-1.0.0.tgz
     ```

### 2. 初始化配置 (支持飞书扫码自动配置 🚀)

网桥提供了**免手动创建应用、免手动填秘钥**的极致体验，支持直接使用**飞书 App 扫码自动注册机器人**。

> [!TIP]
> **全自动模式**：在全新的部署环境中，您可以**直接执行启动命令 `codex-feishu-bridge run`**。网桥会自动检测并同步在用户目录中生成所需的配置文件，并立即渲染出扫码注册二维码。您并不强制需要先运行 `init` 命令。

* **扫码自动配置一站式启动（最方便）**：
  1. 直接在前台启动网桥以触发自动初始化和渲染二维码：
     ```bash
     codex-feishu-bridge run
     ```
  2. 控制台检测到配置为空或为占位符时，会自动调用飞书 API 并在终端渲染出一个**授权二维码**：
     - 打开您手机上的飞书 App，扫描终端里的二维码并确认授权。
     - 授权通过后，系统会**自动在您的企业中创建对应的自建应用、开通机器人权限并订阅 WebSocket 长连接事件**。
     - 生成的正式 `LARK_APP_ID` 与 `LARK_APP_SECRET` 会**自动写入并覆盖 `~/.codex-feishu-bridge/.env` 配置文件**。
     - 终端显示 `Feishu WebSocket Client started` 即代表注册及连接成功。您可以按 `Ctrl + C` 终止前台进程，然后使用后台常驻模式。

* **使用已有机器人（手动配置）**：
  如果您想使用已有的自建应用，而不是注册新应用：
  1. 运行初始化命令生成空白配置文件模板：
     ```bash
     codex-feishu-bridge init
     ```
  2. 编辑生成的 `~/.codex-feishu-bridge/.env` 配置文件，填入您已有的飞书凭证和白名单限制：
     ```env
     LARK_APP_ID=您的飞书应用AppID
     LARK_APP_SECRET=您的飞书应用AppSecret
     ALLOWED_APPROVERS=批准者OpenID列表（以逗号分隔）
     ```
  3. 配置完成后，直接运行后台启动命令即可：
     ```bash
     codex-feishu-bridge start
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

* **重新绑定飞书应用凭证 (Rebind Credentials)**：
  ```bash
  codex-feishu-bridge rebind
  ```
  该命令会安全重置 `~/.codex-feishu-bridge/.env` 中的 `LARK_APP_ID` 和 `LARK_APP_SECRET` 凭证为初始状态，并保留您在配置文件中自定义的其他任何环境变量。重置后，下次启动网桥时会再次展示自动注册机器人的授权二维码。

---

## ⚙️ 配置文件与存储说明

### 工作目录结构

网桥的所有配置、运行数据库与日志均存储于用户主目录下的专属目录 `~/.codex-feishu-bridge/` 中：

* **配置文件**：`~/.codex-feishu-bridge/.env`
* **运行数据库**：包括以下文件，全部安全隔绝在此目录中，避免污染项目代码目录：
  - `sessions.json`：会话绑定关系数据库。
  - `approvals.json`：本地命令执行审批单。
  - `pushed_turns.json`：防重历史卡片推送列表。
* **日志输出**：`~/.codex-feishu-bridge/logs/`

### 配置文件 `.env` 详细参数说明

| 配置键名 | 说明 | 示例值 / 默认值 |
| :--- | :--- | :--- |
| `LARK_APP_ID` | 飞书开放平台自建应用的 App ID | `cli_aaa39297b9b95cc5` |
| `LARK_APP_SECRET` | 飞书开放平台自建应用的 App Secret | `UGSfPt0IZcwXAKp...` |
| `ALLOWED_APPROVERS` | 允许审批终端命令执行的飞书用户 Open ID 列表，用英文逗号分隔 | `ou_f490a33f34ee...` |
| `RATE_LIMIT_QUERY_INTERVAL_MS` | 5h/7d 剩余窗口用量的轮询刷新间隔时间（单位：毫秒） | `300000` (默认 5 分钟) |
| `CODEX_BIN` | 本地 Codex 命令行工具的绝对路径（用于辅助调起后台服务） | `/Applications/Codex.app/Contents/Resources/codex` |
| `LOG_TO_FILE` | 是否写 info 日志 | `false` (默认不开启) |
| `LOG_FILE_PATH` | 日志文件名或绝对路径。 | `bridge.log` |
| `ENABLE_AUTO_FILE_UPLOAD` | 自动上传本地文件（如 `/tmp/data.csv`）至飞书 | `false` (默认关闭以保护隐私) |

### 自动图片与文件上传支持
网桥内置了强大的**资源过滤与静默上传引擎**：
- **图片自动上传**：当 Codex 返回了本地生成的图片（如 `![](/private/tmp/ui.png)`），网桥会自动静默将其作为合法 `image_key` 上传至飞书并完美内嵌在 CardKit 卡片中。
- **普通文件自动提取**：对于常规数据文件（如 `.csv`, `.pdf`），网桥同样可以在配置 `ENABLE_AUTO_FILE_UPLOAD=true` 授权后，于后台任务完成时自动提取路径并上传发送至飞书聊天框，方便一键下载。

---

## 💬 飞书机器人交互指令说明

在飞书聊天群或单聊中绑定会话后，直接发送日常对话即可与本地 Codex 交互推理。同时，网桥提供了丰富的快捷斜杠指令（Slash Commands）来辅助管理会话与状态：

| 快捷指令 | 功能说明 | 示例 / 参数 |
| :--- | :--- | :--- |
| `/help` 或 `/h` | 获取所有支持的快捷指令 and 使用帮助卡片 | `/help` |
| `/list` | 拉取并展示所有活跃的 Codex 会话列表，支持中英字典序排序，全局会话置顶 | `/list` |
| `/ll` | 以表格（Table）视图展示活跃会话列表，可折行展示会话全名以防截断，提供序号选择绑定 | `/ll` |
| `/new [名称]` 或 `/create [名称]` | 快速在本地启动一个新会话并自动与当前聊天绑定 | `/new 我的新项目` |
| `/cwd [路径]` 或 `/workspace [路径]` | 查询或动态修改当前已绑定会话的工作目录 (CWD) | `/cwd /Users/workspace/project` |
| `/cmd [命令]` 或 `/run [命令]` | 在本地 macOS 的当前工作目录下执行经过安全过滤允许的命令 | `/cmd git status` |
| `/goal [目标内容]` | 为当前会话设定一个长期自主任务并自动开始执行 | `/goal 编写完整的单元测试` |
| `/goal` | 查询当前会话的任务目标内容、执行进度与消耗 | `/goal` |
| `/goal clear` 或 `/goal -c` | 清除当前会话的目标任务 | `/goal clear` |
| `/usage` 或 `/quota` | 获取当前账户的短期 (5h) / 长期 (168h) 窗口用量统计及 24 小时制重置刷新时间 | `/usage` |
| `/mcp` | 展示本地所有 MCP 服务及认证连接状态 | `/mcp` |
| `/model` 或 `/model [名称]` | 交互式选择或直接设定当前会话使用的大模型（如 o3-mini 等） | `/model o3-mini` |
| `/personality [friendly\|pragmatic\|none]` | 设置或查询回复风格（friendly: 亲和, pragmatic: 务实, none: 默认） | `/personality pragmatic` |
| `/compact` 或 `/compress` | 压缩当前会话的上下文窗口（主动释放历史 Token） | `/compact` |
| `/fork [新名称]` | 派生复制当前会话，并将当前飞书群聊自动绑定至新派生的会话 | `/fork 分支测试` |
| `/plan [on\|off]` | 开启或关闭“计划模式”。开启后日常指令执行前必须由您审批计划 | `/plan on` |
| `/status` | 综合展示面板（包含会话名称、ID、当前 CWD、个性设定、计划模式及目标详情） | `/status` |
| `/skills` | 列出当前工作区下可用的所有技能（Skills） | `/skills` |
| `@技能名称 [输入内容]` | 在日常对话中通过提及调用特定的技能服务 | `@excel-parser 读取数据.xlsx` |
| `/delete` 或 `/archive` | 将当前聊天与 Codex 会话解绑，并在本地归档该会话 | `/delete` |

---

## 🔬 架构与底层协议原理

为了方便二次开发、复刻与学习网桥底层与本地 Codex 桌面客户端、App Server 通信的实现细节，我们准备了独立的详细架构与技术设计文档。

请参阅：
* **[技术实现与架构方案文档 (TECHNICAL.md)](./TECHNICAL.md)**：包含 UDS 套接字通信机制、定长帧处理（Length-Prefixed Buffer）的 Node.js 源码片段、飞书 CardKit 2.0 异步局部 PUT 渲染流实现方案、中断机制以及技能映射流程。
