# Codex App Server 升级运行手册

本手册用于复核或登记新的 Codex App Server 版本。运行时兼容性只能由两件事决定：`codexVersion` 已登记，
或未知版本通过 Bridge 已用控制面的协议 smoke。schema 摘要不参与兼容判断，也不作为人工批准旁路。

## 1. 准备隔离环境

准备官方来源的目标 binary，并记录下载来源、平台和文件 SHA-256。所有真实 smoke 使用独立临时
`CODEX_HOME`，不得读取或修改用户现有 thread、binding 或任务状态。

先核对 binary identity：

```bash
/absolute/path/to/codex --version
shasum -a 256 /absolute/path/to/codex
```

版本输出必须是计划验证的精确 identity，例如 `codex-cli 0.146.0-alpha.9.2`。不要把 alpha、patch 或 build
metadata 归并成范围。

## 2. 审查协议面

schema 文件可以作为人工审查材料，但不再作为运行时兼容签名。需要审查时，可用仓库脚本采集代表性消息和
schema 文件数：

```bash
node scripts/capture-app-server-contract.mjs \
  --codex-bin /absolute/path/to/codex \
  --out /private/tmp/app-server-contract-NEW_VERSION \
  --distribution 'official distribution description'
```

人工审查重点是 Bridge 实际消费的方法是否仍保持合同：

- request 必填字段、字段类型和枚举是否变化；
- response 中 Bridge 消费字段是否新增、删除、改名或改变 nullability；
- 新增字段是否仅为可忽略的 additive extension；
- initialize `userAgent` 是否仍能用精确 SemVer 解析；
- RPC error envelope 是否改变。

当前自动 smoke 覆盖非模型控制面：`thread/list`、`thread/start`、`thread/name/set`、`thread/read`、
`thread/resume`、`thread/fork`、`thread/archive`、`thread/goal/set`、`thread/goal/get`、
`thread/goal/clear`、`skills/list`、`mcpServerStatus/list`，并探测 `account/rateLimits/read` 能力。
`turn/start` 和 `thread/compact/start` 可能触发模型或改变真实任务，不在自动 smoke 中执行，必须在专用测试账号和
thread 上另行验收。

## 3. 决定 adapter 边界

只有在两个条件同时成立时才复用共享 validator：

1. Bridge 实际消费的 response 字段语义完全一致；
2. request 差异只是当前调用不需要的可选 additive 字段。

即使复用 validator，每个 profile 也必须保留显式、可穷举的 adapter export 和 registry mapping，例如当前的
`src/app/codex/app-server-protocol-v144.ts`、`src/app/codex/app-server-protocol-v145.ts` 与
`adapterForAppServerProfile()`。

如果必填字段、类型、nullability、枚举或当前请求参数不同，必须实现专用 adapter/request mapper；不要在
业务服务中添加散落的版本判断，也不要把未审查的完整生成类型扩散到 Desktop IPC canonical model。

## 4. 登记或自动支持

已确认长期支持的版本可作为内置版本登记：

1. 在 `src/app/codex/app-server-protocol-registry.ts` 增加 profile（如需要新 adapter）；
2. 在 `src/app/codex/protocol-version-config.ts` 的内置支持列表增加 `codexVersion -> adapterProfileId`；
3. 增加或更新 fixture、support matrix 和测试证据；
4. 在 `adapterForAppServerProfile()` 增加穷举 mapping（如新增 profile）；
5. 为版本选择、未知版本 smoke 成功/失败、握手错配和 adapter 行为补测试。

如果只是 ChatGPT/Codex 临时升级，且协议 smoke 已通过，可以先让运行时自动写入 `auto_smoke`。这不会修改源码；
后续是否内置取决于发布评审。

## 5. 执行 isolated `owned_stdio` smoke

运行目标 binary 的隔离控制面 smoke：

```bash
CODEX_BIN=/absolute/path/to/codex codex-feishu-bridge compatibility
```

`compatibility` 与正式启动使用同一规则：如果版本尚未支持，会启动隔离 `owned_stdio` App Server 跑 Bridge 已用
控制面 smoke；smoke 通过后自动写入 `protocol-versions.json`，来源为 `auto_smoke`，结论为“兼容”。smoke 失败
或握手身份不一致时返回“不兼容”，不得用 schema 摘要、版本范围或手工批准绕过。

正式 `start`/`restart` 每次执行 runtime 兼容检查时都会向 `ALLOWED_CHATS` 中经飞书确认的 p2p 单聊发送卡片：
开始时提示“开始检查兼容性”，runtime 探测完成后流式更新同一张卡片，结束时明确提示“兼容性通过，可以继续使用”
或“兼容性不通过，当前版本不能使用”；未知版本进入 smoke 时会先更新为“协议兼容性检查中”。卡片投递失败只记录
日志，不替代协议判定。

`--approve` 已废弃；兼容性不能人工按签名批准，只能由已登记版本或协议 smoke 通过来放行。

## 6. 验证 Desktop IPC 不变量

App Server 升级不得改变生产 turn owner。运行独立 Desktop 回归：

```bash
npm run build:test
node --test dist-test/test/app/desktop-ipc-regression.test.js
```

确认 start/steer/interrupt、approval、live event、内存队列和“不恢复、不重放”仍由 Desktop IPC 路径处理，
App Server control plane 不参与生产 turn 执行。

## 7. 执行发布门禁

先查看候选 binary 的本机版本和兼容结论：

```bash
CODEX_BIN=/absolute/path/to/codex codex-feishu-bridge version --json
CODEX_BIN=/absolute/path/to/codex codex-feishu-bridge compatibility
```

`version` 只探测并记录版本与 binary SHA-256，不执行协议 smoke。`compatibility` 和正式启动会按需要自动 smoke。

然后执行完整仓库门禁：

```bash
npm run check
git diff --check
```

后台运行时还应核对进程和三个连接面的实时状态：

```bash
codex-feishu-bridge status --json
```

健康结果必须同时显示 App Server、Desktop IPC 和飞书为 ready；PID 存活但 worker 不存活或健康快照不属于
当前 supervisor 时，不得判为 READY。健康文件只保存协议标识、连接状态和计数，不保存任务内容。

发布证据还应记录真实 `owned_stdio` smoke、必要的飞书/Desktop E2E，以及当前版本在
`docs/app-server-support-matrix.md` 中的状态。

## 8. `managed_proxy` 验证

先用 `owned_stdio` 完成控制面证明，再验证 `managed_proxy`。后者的本地 `CODEX_BIN` 只能证明本机探测到的
版本；socket 后 daemon 的 initialize identity 只能佐证其自报版本。操作员必须自行钉住远端 daemon 的来源和版本。

## 9. 发布与回滚

注册前，未知版本不能仅靠签名、版本范围或人工确认放行；必须由协议 smoke 或完整 profile 注册证明。完成全部
门禁后再更新支持矩阵和 release notes；Git tag 只表示发布声明，不参与运行时检测。

回滚步骤：

```bash
codex-feishu-bridge stop
# 将 CODEX_BIN 恢复为支持矩阵中的上一精确版本
codex-feishu-bridge doctor
codex-feishu-bridge start
```

回滚不清空 `.env` 或 `bindings.json`，也不重新绑定。Bridge 重启时当前内存任务会停止跟踪；不得恢复、补发
或重放旧 turn。若 doctor 不能选中上一 profile，不要启动服务，先恢复与矩阵一致的官方 binary。

飞书短时断网恢复属于同一进程内的投影补发：Bridge 只重发尚未确认的最新 CardKit 状态，不重新执行 turn。
进程退出或 supervisor 拉起新 worker 后，仍然不恢复旧任务或旧卡片投影。
