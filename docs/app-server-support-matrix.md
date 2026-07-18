# Codex App Server 支持矩阵

Bridge 只支持经过完整 experimental schema、握手身份和控制面回归验证的精确协议档案。运行时事实源是
`src/app/codex/app-server-protocol-registry.ts`；本表用于发布和运维核对，不参与协议选择。

## 当前支持范围

| 状态 | Protocol profile | 精确 CLI identity | Full experimental schema SHA-256 | Schema 文件数 | 真实验证来源 | Bridge 发布状态 |
| --- | --- | --- | --- | ---: | --- | --- |
| 兼容基线 | `app-server-0.144.3` | `codex-cli 0.144.3` | `3b1af113954376a68d0d2382190f4bde6ca58c02a5c9a5cfebcd01f1747e79e7` | 337 | 官方 `@openai/codex@0.144.3` npm darwin-arm64 包；binary SHA-256 `718724d7221cf1298071ca92411cb74caa8422809154150cedca7b569a4518e3`；isolated `owned_stdio` initialize/thread-list smoke | 已支持；基线 tag `v0.144.3` |
| 当前优先版本 | `app-server-0.145.0-alpha.18` | `codex-cli 0.145.0-alpha.18` | `7a5aaea66a649faae713d43313289ddd79b4883086c10875f9031a56ec00bd5c` | 341 | ChatGPT.app bundled Codex；binary SHA-256 `a2bc3f63b0d7ce5c065ae070e16d964fa71192bf6ceb8da82d2315227d55a6bf`；isolated `owned_stdio` initialize/thread-list smoke | 已支持；版本匹配 tag 待正式发布门禁通过后创建 |

验证日期：2026-07-18。可审计证据位于：

- `test/fixtures/app-server/0.144.3/manifest.json`
- `test/fixtures/app-server/0.144.3/schema-comparison.json`
- `test/fixtures/app-server/0.145.0-alpha.18/manifest.json`
- `test/app/runtime-contract.test.ts`
- `test/app/app-server-client.test.ts`
- `test/app/app-server-control-plane.test.ts`

## 协议选择规则

启动时，Bridge 对配置的 `CODEX_BIN` 执行一次精确探测：

1. 读取 `codex --version`；
2. 执行 `codex app-server generate-json-schema --experimental`；
3. 对完整 schema 文件集合和规范化 JSON 内容计算 SHA-256；
4. 以 `CLI version + full schema digest` 精确选择唯一 profile；
5. 启动 App Server 后，再用 initialize `userAgent` 核对同一精确版本。

`0.145.0-alpha.18` 是当前升级优先版本，但不存在“优先版本 fallback”。已知版本配未知 digest、未知版本配已知
digest、144/145 cross-match、未注册 alpha 或握手版本不一致都会在 READY 前 fail closed。Bridge 不使用
`^0.145`、`>=0.144` 或“同 minor 即兼容”等 SemVer range 猜测 experimental 协议兼容性。

## 已验证控制面

除 initialize/initialized 握手外，两个 profile 都覆盖以下 15 个 Bridge 实际使用的方法：

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

## `managed_proxy` 证据边界

`owned_stdio` 由同一个 `CODEX_BIN` 生成完整 schema 并启动 child，因此 full digest 与握手版本共同约束实际
进程。`managed_proxy` 的本地 `CODEX_BIN` 探测不能证明 socket 后远端 daemon 的完整 schema；initialize
握手只能佐证其自报版本。使用 `managed_proxy` 时，操作员必须自行把远端 daemon 精确钉在本表对应 profile，
Bridge 不会为远端虚构或推导 schema digest。
