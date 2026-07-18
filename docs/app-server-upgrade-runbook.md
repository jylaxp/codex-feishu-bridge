# Codex App Server 升级运行手册

本手册用于增加一个新的精确 App Server profile。App Server experimental API 不提供跨版本兼容承诺；每个
新版本都必须重新采集、审查、注册和验证，不能只修改版本正则或扩大 SemVer range。

## 1. 准备隔离环境

准备官方来源的目标 binary，并记录下载来源、平台和文件 SHA-256。所有真实 smoke 使用独立临时
`CODEX_HOME`，不得读取或修改用户现有 thread、binding 或任务状态。

先核对 binary identity：

```bash
/absolute/path/to/codex --version
shasum -a 256 /absolute/path/to/codex
```

版本输出必须是计划注册的精确 identity，例如 `codex-cli 0.145.0-alpha.18`。不要把 alpha、patch 或 build
metadata 归并成范围。

## 2. 采集完整 experimental schema

使用仓库脚本在临时目录采集版本、完整 schema digest、schema 文件数和代表性消息：

```bash
node scripts/capture-app-server-contract.mjs \
  --codex-bin /absolute/path/to/codex \
  --out /private/tmp/app-server-contract-NEW_VERSION \
  --distribution 'official distribution description'
```

脚本实际执行：

```bash
/absolute/path/to/codex app-server generate-json-schema \
  --experimental \
  --out /private/tmp/app-server-schema-NEW_VERSION
```

Digest 必须覆盖生成目录中的全部 schema 相对路径和规范化 JSON 内容，而不是只计算 Bridge 当前使用的
文件。目标输出中的 `manifest.json` 是评审输入；不要手工填写 digest。若要记录真实握手 identity，先完成
isolated `owned_stdio` initialize，再用一个新的空输出目录重新采集并增加：

```bash
node scripts/capture-app-server-contract.mjs \
  --codex-bin /absolute/path/to/codex \
  --out /private/tmp/app-server-contract-NEW_VERSION-with-handshake \
  --distribution 'official distribution description' \
  --server-user-agent 'REAL_INITIALIZE_USER_AGENT'
```

## 3. 审查 15 个已用方法

分别为当前已支持版本和目标版本生成 schema，再逐项审查以下 15 个方法的 Params、Response 和相关
Notification 定义：

```text
thread/list
thread/read
thread/resume
thread/start
thread/fork
thread/name/set
thread/archive
thread/goal/get
thread/goal/set
thread/goal/clear
thread/compact/start
skills/list
mcpServerStatus/list
account/rateLimits/read
turn/start
```

最小审查内容：

- request 必填字段、字段类型和枚举是否变化；
- response 中 Bridge 消费字段是否新增、删除、改名或改变 nullability；
- 新增字段是否仅为可忽略的 additive extension；
- `turn/start` 相关生命周期 notification 是否改变；
- initialize `userAgent` 是否仍能用精确 SemVer 解析；
- RPC error envelope 是否改变。

把结论保存为目标 fixture 附近的 comparison 证据。当前 144/145 示例是
`test/fixtures/app-server/0.144.3/schema-comparison.json`。

## 4. 决定 adapter 边界

只有在两个条件同时成立时才复用共享 validator：

1. 15 个方法中 Bridge 实际消费的 response 字段语义完全一致；
2. request 差异只是当前调用不需要的可选 additive 字段。

即使复用 validator，每个 profile 也必须保留显式、可穷举的 adapter export 和 registry mapping，例如当前的
`src/app/codex/app-server-protocol-v144.ts`、`src/app/codex/app-server-protocol-v145.ts` 与
`adapterForAppServerProfile()`。

如果必填字段、类型、nullability、枚举或当前请求参数不同，必须实现专用 adapter/request mapper；不要在
业务服务中添加版本判断，也不要把未审查的完整生成类型扩散到 Desktop IPC canonical model。

## 5. 注册 profile 和 fixture

按以下顺序落地：

1. 在 `src/app/codex/contract.ts` 增加精确 full schema digest；
2. 在 `src/app/codex/app-server-protocol-registry.ts` 增加 exact version/profile；
3. 增加 `test/fixtures/app-server/NEW_VERSION/manifest.json`、代表性消息和控制面响应；
4. 在 `adapterForAppServerProfile()` 增加穷举 mapping；
5. 为 version/digest、cross-match、握手错配、adapter 和 15 方法补测试。

任何一步缺少真实 binary 证据，都只能保留为待验证实现，不能加入“支持”矩阵。

## 6. 执行 isolated `owned_stdio` smoke

运行目标 binary 的 initialize/initialized 与隔离控制面 smoke。现有双版本测试支持显式 binary 路径：

```bash
CODEX_144_BIN=/absolute/path/to/codex-0.144.3 \
CODEX_145_BIN=/absolute/path/to/codex-0.145.0-alpha.18 \
npm run test:protocol
```

测试使用临时 `CODEX_HOME` 和临时 workspace，并验证 initialize `userAgent` 中的版本与选中 profile 完全一致。
当前 smoke 会在专用 thread 上验证 list/start/name/read/resume/fork/archive、goal set/get/clear、skills 和 MCP
status；不得操作用户 binding。`account/rateLimits/read` 在隔离未认证环境中允许以稳定能力不可用结果结束。
`thread/compact/start` 会触发模型操作，不在自动 smoke 中执行，必须在已授权的专用测试账号和 thread 上另行验收。

## 7. 验证 Desktop IPC 不变量

App Server 升级不得改变生产 turn owner。运行独立 Desktop 回归：

```bash
npm run build:test
node --test dist-test/test/app/desktop-ipc-regression.test.js
```

确认 start/steer/interrupt、approval、live event、内存队列和“不恢复、不重放”仍由 Desktop IPC 路径处理，
App Server control plane 不参与生产 turn 执行。

## 8. 执行发布门禁

先让 doctor 对候选 binary 给出 exact profile、version、digest 和 mode：

```bash
CODEX_BIN=/absolute/path/to/codex codex-feishu-bridge doctor
```

然后执行完整仓库门禁：

```bash
npm run check
git diff --check
```

`npm run check` 已包含 typecheck、协议测试、应用构建和 package 检查。发布证据还应记录真实
`owned_stdio` smoke、必要的飞书/Desktop E2E，以及当前版本在
`docs/app-server-support-matrix.md` 中的状态。

## 9. `managed_proxy` 验证

先用 `owned_stdio` 完成完整 schema 和控制面证明，再验证 `managed_proxy`。后者的本地 `CODEX_BIN`
version+digest 只能选择操作员声明的 profile；socket 后 daemon 的 initialize identity 只能佐证版本，不能证明
其完整 schema。操作员必须独立钉住远端 binary 及 digest，Bridge 不会从 userAgent 推导远端 digest。

## 10. 发布与回滚

注册前，未知版本、未知 digest 和 version/digest cross-match 必须继续 fail closed。完成全部门禁后再更新支持
矩阵和 release notes；Git tag 只表示发布声明，不参与运行时检测。

回滚步骤：

```bash
codex-feishu-bridge stop
# 将 CODEX_BIN 恢复为支持矩阵中的上一精确版本
codex-feishu-bridge doctor
codex-feishu-bridge start
```

回滚不清空 `.env` 或 `bindings.json`，也不重新绑定。Bridge 重启时当前内存任务会停止跟踪；不得恢复、补发
或重放旧 turn。若 doctor 不能选中上一 profile，不要启动服务，先恢复与矩阵一致的官方 binary。
