# Codex App Server 支持矩阵

Bridge 只支持经过完整 experimental schema、握手身份和控制面回归验证的精确协议档案。代码内的
`src/app/codex/app-server-protocol-registry.ts` 是首次启动种子；运行时事实源是 config home 下的
`protocol-versions.json`。本表用于发布和运维核对，不参与协议选择。

## 当前支持范围

| 状态 | Protocol profile | 精确 CLI identity | Full experimental schema SHA-256 | Schema 文件数 | 真实验证来源 | Bridge 发布状态 |
| --- | --- | --- | --- | ---: | --- | --- |
| 兼容基线 | `app-server-0.144.3` | `codex-cli 0.144.3` | `3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7` | 337 | 官方 `@openai/codex@0.144.3` npm darwin-arm64 包；binary SHA-256 `718724d7221cf1298071ca92411cb74caa8422809154150cedca7b569a4518e3`；isolated `owned_stdio` initialize/thread-list smoke | 已支持；基线 tag `v0.144.3` |
| 145 协议基线 | `app-server-0.145.0-alpha.18` | `codex-cli 0.145.0-alpha.18` | `7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c` | 341 | ChatGPT.app bundled Codex；已验证 binary SHA-256 `a2bc3f63...a6bf` 与 `55893252...27c6`；后者来自 App `26.715.31925` build `5551`；isolated `owned_stdio` smoke | 已支持；作为 145 adapter 基线保留 |
| 已支持别名 | `app-server-0.145.0-alpha.18` | `codex-cli 0.145.0-alpha.27` | `7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c` | 341 | ChatGPT.app `26.715.70719` build `5650`；binary SHA-256 `d1c9c5d2...0227f`；完整 schema 与 `.18` 相同；isolated `owned_stdio` control-plane smoke | 已内置支持；复用 145 adapter |
| 已支持别名 | `app-server-0.145.0-alpha.18` | `codex-cli 0.145.0-alpha.30` | `7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c` | 341 | ChatGPT.app `26.715.71837` build `5702`；binary SHA-256 `9de41fd6...02`；完整 schema 与 `.18` 相同；isolated `owned_stdio` control-plane smoke | 已内置支持；复用 145 adapter |
| 已支持别名 | `app-server-0.145.0-alpha.18` | `codex-cli 0.146.0-alpha.3` | `8535b3371e916d0ea4f2bc62c28a7236323d5f37fd7652184098c90d256c738f` | 347 | ChatGPT.app `26.721.30844` build `5813`；binary SHA-256 `01b89e3c...519`；schema 新增 app/audio/search 相关未用面；isolated non-model control-plane smoke 与真实绑定 `thread/read`/`thread/resume` smoke | 已内置支持；功能验证后复用 145 adapter |
| 已支持别名 | `app-server-0.145.0-alpha.18` | `codex-cli 0.146.0-alpha.3.1` | `8535b3371e916d0ea4f2bc62c28a7236323d5f37fd7652184098c90d256c738f` | 347 | ChatGPT.app `26.721.41059` build `5848`；binary SHA-256 `6d8be49e49751554df16572369e636cbe02c84b208cad3dc35528c846eeca223`；完整 schema 与 `0.146.0-alpha.3` 相同；运行期兼容检查结论为“兼容” | 已内置支持；复用 145 adapter |
| 当前自动验证版本 | `app-server-0.145.0-alpha.18` | `codex-cli 0.146.0-alpha.9.2` | `9db7ac39730e01ec6942886fba92f02c992ac0c18d9d39d748e2f0065c980961` | 349 | ChatGPT.app `26.727.51351` build `6119`；binary SHA-256 `d96ae1ca1ff6fc8587842fa04c92d3ee4d31651a811c2f89b65fcfd9c28473e2`；isolated non-model control-plane smoke 已验证 Bridge 使用方法 | 未内置；启动或 `compatibility` 遇到该 exact version/digest 时通过协议 smoke 自动写入 `auto_smoke` 支持 |

验证日期：2026-08-01。可审计证据位于：

- `test/fixtures/app-server/0.144.3/manifest.json`
- `test/fixtures/app-server/0.144.3/schema-comparison.json`
- `test/fixtures/app-server/0.145.0-alpha.18/manifest.json`
- `test/fixtures/app-server/0.145.0-alpha.18/artifacts.json`
- `test/app/runtime-contract.test.ts`
- `test/app/app-server-client.test.ts`
- `test/app/app-server-control-plane.test.ts`

## 协议选择规则

启动时，Bridge 对配置的 `CODEX_BIN` 执行一次精确探测：

1. 读取 `codex --version`；
2. 执行 `codex app-server generate-json-schema --experimental`；
3. 对完整 schema 文件集合和规范化 JSON 内容计算 SHA-256；
4. 从 `protocol-versions.json` 以 `CLI version + full schema digest` 精确选择唯一已支持版本；
5. 如果当前 exact version/digest 尚未支持，启动隔离 `owned_stdio` App Server 跑 Bridge 已用控制面协议 smoke；
6. smoke 通过后以 `auto_smoke` 来源写入当前 exact version/digest 和 adapter，并继续启动；
7. smoke 失败、握手版本不一致或控制面响应不满足 Bridge 消费字段时返回“不兼容”并 fail closed。

首次启动缺少配置文件时，Bridge 将上述内置版本写入配置；后续 Bridge 发布新增内置版本时，启动会把缺失的
内置项合并进已落盘目录，并保留人工批准、自动 smoke 和运维修改的记录。这里的 digest 是 runtime identity 和审计证据，
不是要求所有功能兼容版本必须与 adapter 基线 schema 完全相同；只要该精确版本和 digest 已经经过 Bridge 已用
控制面 smoke 验证，就可以复用现有 adapter。允许同一 `codexVersion` 因平台或打包差异存在多个已验证
schema digest；判断支持的是 `codexVersion + schemaDigest` 这一 exact pair，不是版本字符串本身。
Bridge 不使用 `^0.145`、`>=0.144` 或“同 minor 即兼容”等 SemVer range 猜测 experimental 协议兼容性。

## 已验证控制面

除 initialize/initialized 握手外，两个 adapter profile 及其已列入别名都覆盖以下 15 个 Bridge 实际使用的方法：

- `thread/list`
- `thread/read`
- `thread/resume`
- `thread/start`
- `thread/fork`
- `thread/name/set`
- `thread/archive`
- `thread/goal/get`
- `thread/goal/set`
- `thread/goal/clear`
- `thread/compact/start`
- `skills/list`
- `mcpServerStatus/list`
- `account/rateLimits/read`
- `turn/start`（仅实验 UI sync validator）

App Server 只负责这些控制面操作。飞书生产任务的 start/steer/interrupt、审批和 live event 仍由
ChatGPT Desktop IPC 执行；App Server profile 变化不会放宽 Desktop IPC 的独立版本门禁。
当前 Desktop IPC 合同为 `desktop-ipc-state-v11-following-v1`，与 App Server profile 和 ChatGPT App
产物证据分别判断。

## `managed_proxy` 证据边界

`owned_stdio` 由同一个 `CODEX_BIN` 生成完整 schema 并启动 child，因此 full digest 与握手版本共同约束实际
进程。`managed_proxy` 的本地 `CODEX_BIN` 探测不能证明 socket 后远端 daemon 的完整 schema；initialize
握手只能佐证其自报版本。使用 `managed_proxy` 时，操作员必须自行把远端 daemon 精确钉在本表对应 profile，
Bridge 不会为远端虚构或推导 schema digest。
