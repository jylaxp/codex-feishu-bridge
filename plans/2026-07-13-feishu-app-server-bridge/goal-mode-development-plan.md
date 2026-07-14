# 飞书 App Server 实时桥目标模式开发计划

日期：2026-07-13
状态：implemented，真实飞书与 Desktop 页面验收待执行
分支：`chatgpt-v2`
实施前基线：`f41396b` / `app-server-v2-baseline-20260713`

## 1. 目标

建立一条全新的生产主链：用户先在飞书通过 `/bind` 显式选择当前工作区的既有 ChatGPT thread；之后文本消息经过权限与幂等校验，仅通过 `thread/resume + turn/start/steer` 进入该会话。Codex App Server 负责执行智能体循环，Bridge 以 App Server 事件流驱动飞书 CardKit 的过程、审批和最终结果。

ChatGPT 页面实时同步作为独立 capability 验证：只有同 runtime 的正向、反向 nonce 实验通过后，才能声明页面实时同步；失败不会影响飞书主链，也不得回退到 Desktop IPC、ChatGPT SQLite、Electron 注入、Noise relay 或 deep-link 强刷。

## 2. 需求清单

### R1. Clean-slate 生产入口

新生产入口不得直接或传递依赖旧 `src/index.ts`、`src/adapter.ts`、旧 `src/codex/*` dispatcher/history/client、JSON session、commands、Desktop IPC、injector 或 media 自动上传链路。

### R2. 飞书安全入站

仅接受 SDK 验证后的文本消息。tenant、chat、user allowlist 必须配置且 fail closed；机器人、未知身份、未知群、空文本和超长文本不进入 App Server。

### R3. 持久化幂等

使用新的 Bridge SQLite 数据库，不迁移任何旧 JSON 或 ChatGPT/Codex 数据库。tenant 作用域内的
event/message ID 唯一，durable intake 完成后的重复投递不得重复建 turn。未绑定消息必须持久化为拒绝，之后即使完成绑定，同一飞书事件重投也不得执行。初始 CardKit 创建在
跨网络超时或进程崩溃时不承诺 exactly-once，可能留下孤儿卡并需要人工对账。

运行中补充消息必须把 inbox 原文与 PREPARED steer intent 原子持久化。只有可证明未写入 transport 的 intent
允许恢复发送；SENT 但结果未知时不得重放。

### R4. Root 与 thread 绑定

`(tenant_key, chat_id)` 保存用户显式选择的 ChatGPT thread 和单调 revision；解绑保留 tombstone，旧选择卡不能 ABA 重放。新 root 捕获当时的 chat binding，`(tenant_key, chat_id, root_message_id)` 固定该 thread。顶层消息用自身 message ID 作为 root；同 root 运行中补充消息使用 `turn/steer(expectedTurnId)`，空闲时启动新 turn。

### R5. 官方 App Server 客户端

客户端完成 `initialize -> initialized`，严格区分 response、server-initiated request、notification；生产默认由 Bridge 持有 stdio App Server，也允许显式选择 managed proxy 做 UI capability 实验。

### R6. 工作区与执行权限

`thread/list` 只列出管理员配置 `CODEX_CWD` 下的会话；点击后再次读取并把 canonical workspace 持久化，执行与恢复都使用该路径且必须落在允许根目录内。首期单 Bridge 只允许一个写 turn；sandbox 为 `workspace-write`，approval policy 为 `on-request`，reviewer 为 `user`。

### R7. 事件事实源

`thread/*`、`turn/*`、`item/*`、`error` 和 server request 是运行态唯一事实源。delta 通过 item ID 关联 lifecycle；commentary/reasoning summary、command output 和 final answer 必须分区。

### R8. CardKit 实时投影

收到合法任务后先创建并发送初始卡，再启动模型。普通 delta 1–2 秒合并，审批、错误、中断和完成立即投影；每张卡只有一个 writer，projection revision 与 CardKit sequence 分离，terminal 只 finalize 一次。

### R9. 内容安全

卡片只展示脱敏后的 prompt、commentary、reasoning summary、工具/命令摘要、最终答案和稳定错误；不展示 raw CoT，不读取或上传模型输出中出现的本地文件路径。

### R10. 审批与取消

处理当前 schema 中的 command/file approval request。按钮使用一次性 opaque token，DB 只存 hash，绑定
tenant/chat/card/approval/connection epoch/decision/TTL；开放 `accept`、`acceptForSession`、`decline`、
`cancel`。`acceptForSession` 还必须由 App Server 声明为可用决策；未识别 request fail closed。

### R11. 外部副作用状态

mutating RPC 发送前写 durable intent；响应不确定进入 `UNKNOWN`，禁止盲目重发。CardKit 通过 durable outbox 有界重试，429/5xx 不阻塞 App Server reader。

### R12. 断线恢复

连接使用 epoch。断线使 pending RPC 失败、旧审批 stale、活动任务进入 recovering；恢复后通过 `thread/resume` 和 snapshot reconciliation 收敛，不依赖事件 offset 或历史轮询作为实时源。

### R13. ChatGPT 页面 capability gate

提供独立验证器执行 thread list/resume、nonce turn/start 和事件监听。验证器只证明 Bridge 能看到同一 turn 的
事件流，Desktop 页面是否出现相同 nonce 由人工观察确认。实验不读取生产 DB、不由飞书触发，也不修改生产
健康状态。

### R14. 运行时合同与 doctor

协议类型和 fixture 来自配置的 `CODEX_BIN`。doctor 输出 binary path、CLI version、schema digest、Node/SQLite 能力、cwd/allowlist 和数据库健康；PATH 与目标 binary 漂移必须显式失败或告警。

### R15. CardKit 产品合同

保留且只承诺四项飞书能力：任务卡创建、执行过程实时展示、审批/取消交互、最终结果和终态展示。不承担旧命令、旧 session、旧附件、旧 ChatGPT 私有交互兼容。

## 3. 范围边界

本期必须完成：`/bind`、`/binding`、`/unbind`、文本消息、chat/root/thread 绑定、turn start/steer/interrupt、事件 reducer、CardKit、审批、SQLite 幂等/intent/outbox、重连恢复、doctor、UI capability 验证器。

本期不做：旧 JSON 迁移、绑定命令之外的 slash commands、skills、附件、自动文件上传、用户任意设置 cwd/model、远程公网 WebSocket、多实例 lease、旧 Desktop/ChatGPT 私有接口兼容。

## 4. 阶段拆分

### 阶段 1：协议、配置与数据基础

状态：completed

- T1：新配置、preflight、Node 24 运行时门禁。
- T2：`node:sqlite` 数据库、schema、repositories。
- T3：stdio/managed-proxy App Server client、握手和消息分流。
- T4：标准测试 runner、mock transport、架构隔离测试。

退出标准：配置 fail closed；数据库事务/WAL/约束通过；response/request/notification 分流通过；新入口 import graph 无旧模块。

### 阶段 2：最小垂直闭环

状态：completed

- T5：飞书文本 intake、授权、root 解析和 inbox 幂等。
- T6：TaskOrchestrator 的显式 thread resume、turn start/steer；禁止自动 thread/start。
- T7：item lifecycle reducer 与投影状态。
- T8：CardKit 初始卡、合并刷新和 terminal finalize。

退出标准：合法事件重放三次只产生一个模型任务和一张卡；commentary/final 不串区；初始卡失败时不启动模型；两个 root 不串线。

### 阶段 3：审批与可靠性

状态：completed

- T9：command/file approval、opaque token、审批人权限和 CAS。
- T10：取消、RPC intent、UNKNOWN、connection epoch。
- T11：outbox worker、sequence、429/5xx、terminal barrier。
- T12：重连、thread/resume、snapshot reconciliation、排队恢复。

退出标准：双击/过期/跨群/旧 epoch 不发送 response；未知结果不重复 turn；重启后同卡收敛；迟到事件不逆转终态。

### 阶段 4：页面验证、切换与收官

状态：implemented，真实飞书和 Desktop 页面验收 pending

- T13：独立 ChatGPT UI sync validator 与证据报告。
- T14：切换 package 入口，生产包排除旧 IPC/injector/JSON session。
- T15：README、部署、doctor、全量测试、代码审核和验收。

退出标准：生产启动只走新链；`npm pack --dry-run` 无旧实现；UI capability 结论有证据；所有验收标准逐条记录。

## 5. 依赖分析与重排

硬依赖：T1 -> T2/T3；T2+T3 -> T5/T6/T7；T7 -> T8/T9；T2+T3+T8/T9 -> T10/T11/T12；T3 -> T13；全部 -> T14/T15。

重排原因：先锁定运行时和 durable state，避免飞书网络链路建立在错误协议或不可恢复状态上；CardKit 初始卡必须早于模型执行；页面同步实验与生产主链隔离，不能阻塞飞书闭环。

## 6. 测试计划

### 任务级

- 配置：缺失 allowlist、越界 cwd、非绝对 binary、Node 版本不符。
- DB：migration、事务回滚、WAL 重开、唯一约束、审批 CAS、outbox claim。
- App Server：握手顺序、notification-before-response、server request、timeout、exit、late generation。
- Reducer：phase、item lifecycle、command tail、terminal、迟到事件。
- CardKit：sanitize、coalesce、sequence、retry、terminal barrier。

### 阶段级

- 飞书事件 -> inbox -> 初始卡 -> thread/turn -> streamed events -> 最终卡。
- approval request -> 卡片 -> 合法/非法点击 -> RPC response -> 继续执行。
- 断线/重启 -> resume/reconcile -> outbox 收敛。

### 整体

执行 typecheck、unit、contract、integration、architecture、build、pack dry-run。真实飞书/ChatGPT 依赖不可用时记录为 blocked，不伪造通过。

## 7. 部署和数据库计划

无外部数据库和线上 DDL。首次启动创建新的本地 `bridge.db`；schema 只通过版本化 migration 演进，不读取旧 JSON。配置、权限、目录和回滚详见 `deployment-guide.md`。

## 8. 验收标准

- AC1：基线标签可回滚，实施改动与基线可明确区分。
- AC2：新生产入口和传递依赖不包含 hard-ban 旧模块。
- AC3：合法文本重放三次只创建一个 inbox/task/turn；未绑定事件重投永不执行；初始卡跨崩溃 exactly-once 不作承诺。
- AC4：未知 tenant/chat/user、机器人和非文本 fail closed。
- AC5：cwd 越界、symlink 逃逸、缺失 allowlist 时启动或执行失败。
- AC6：App Server 严格完成 initialize/initialized，并正确分流三类消息。
- AC7：reasoning summary/commentary 与 final answer 不串流；raw reasoning 不进入卡片。
- AC8：CardKit 更新 1–2 秒合并、单 writer、sequence 单调、terminal 一次。
- AC9：审批按钮抗篡改、双击、过期、跨群和旧 epoch；未授权用户不能审批。
- AC10：RPC UNKNOWN 不自动重发，重连后 snapshot/outbox 最终收敛。
- AC11：日志和错误卡不含 secret、Authorization、raw callback、raw CoT、完整 prompt 或完整敏感路径；私有
  SQLite 明确保存任务 prompt、脱敏投影和有限工具输出，但不保存凭证、action token 明文、raw callback 或
  raw CoT。
- AC12：Node 24.18.0 下 clean install、build、test、pack 验证通过。
- AC13：ChatGPT 页面同步结论来自 managed-proxy nonce turn、Bridge 事件证据与 Desktop 人工观察；未执行时
  明确标记 unverified。
- AC14：部署文档、测试报告、Review 报告与最终代码一致。

## 9. 风险与处理

- ChatGPT 页面不订阅同 runtime：降级为飞书实时，禁止私有兼容回退。
- App Server schema 漂移：运行时 schema digest + contract fixture + doctor 阻断。
- CardKit 无权威 sequence：对应 outbox fail-stop 为 `CARD_SEQUENCE_CONFLICT`，不做盲目 N+1 猜测；当前
  不自动创建替代卡，需要人工对账。
- App Server/飞书跨系统 exactly-once 不可得：durable intent + UNKNOWN + 人工/快照对账。
- 同步 SQLite 阻塞事件循环：delta 内存合并后批量事务写入，不逐 token 落库。

## 10. 开发前审核结论

2026-07-13：架构、数据和安全三路评审通过，前提是采用 clean-slate、Node 24.18.0 内置 SQLite、stdio 单一稳定主 transport、CardKit 唯一实时产品 UI，并将 ChatGPT 页面同步隔离为 capability 实验。步骤 1–7 已完成，可以进入编码。
