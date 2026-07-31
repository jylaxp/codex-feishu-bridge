import assert from 'node:assert/strict';
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBackgroundCommand, type ProcessSnapshot } from '../../src/app/background-service';
import { writeBridgeConfigFile } from '../../src/app/config-file';

test('background service ignores process output and does not create log files when logging is off', async () => {
  for (const loggingEnabled of [undefined, false]) {
    const root = mkdtempSync(join(tmpdir(), 'bridge-background-log-off-'));
    try {
      if (loggingEnabled !== undefined) {
        writeBridgeConfigFile(root, { LOG_TO_FILE: `${loggingEnabled}` });
      }
      const spawned = recordingSpawn();
      const output: string[] = [];

      const report = await runBackgroundCommand('start', {
        configHome: root,
        spawnProcess: spawned.spawnProcess,
        output: { write: (chunk) => output.push(String(chunk)) },
      }, {});

      assert.equal(report.loggingEnabled, false);
      assert.deepEqual(spawned.options?.stdio, ['ignore', 'ignore', 'ignore']);
      assert.equal(existsSync(join(root, 'logs')), false);
      assert.match(output.join(''), /Bridge 正在启动后台服务/);
      assert.match(output.join(''), /日志: 已关闭/);
      assert.doesNotMatch(output.join(''), /标准日志|错误日志/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('background service captures process output only when file logging is enabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-background-log-on-'));
  try {
    writeBridgeConfigFile(root, { LOG_TO_FILE: 'true' });
    const spawned = recordingSpawn();
    const output: string[] = [];

    const report = await runBackgroundCommand('start', {
      configHome: root,
      spawnProcess: spawned.spawnProcess,
      output: { write: (chunk) => output.push(String(chunk)) },
    }, {});

    assert.equal(report.loggingEnabled, true);
    const stdio = spawned.options?.stdio as readonly unknown[];
    assert.equal(stdio[0], 'ignore');
    assert.equal(typeof stdio[1], 'number');
    assert.equal(typeof stdio[2], 'number');
    assert.equal(existsSync(join(root, 'logs', 'bridge_stdout.log')), true);
    assert.equal(existsSync(join(root, 'logs', 'bridge_stderr.log')), true);
    assert.match(output.join(''), /Bridge 正在启动后台服务/);
    assert.match(output.join(''), /标准日志:/);
    assert.match(output.join(''), /错误日志:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('background restart logs both stop and start lifecycle phases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-background-restart-log-'));
  try {
    const entryPath = '/opt/codex-feishu-bridge/dist/app/cli.js';
    const alive = new Set([100]);
    const spawned = recordingSpawn();
    const output: string[] = [];
    writeFileSync(join(root, 'bridge.pid'), '100\n', { mode: 0o600 });

    const report = await runBackgroundCommand('restart', {
      configHome: root,
      entryPath,
      spawnProcess: spawned.spawnProcess,
      listProcesses: () => [],
      isProcessAlive: (pid) => alive.has(pid),
      killProcess: (pid, signal) => {
        if (pid === 100 && signal === 'SIGTERM') {
          alive.delete(pid);
        }
      },
      delay: async () => undefined,
      output: { write: (chunk) => output.push(String(chunk)) },
    }, {});

    assert.equal(report.running, true);
    assert.match(output.join(''), /Bridge 正在停止后台服务，旧 PID: 100/);
    assert.match(output.join(''), /Bridge 正在启动后台服务/);
    assert.match(output.join(''), /Bridge 已重启，PID: 2000000000/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('background stop terminates every same-entry Bridge supervisor and worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-background-stop-all-'));
  try {
    const entryPath = '/opt/codex-feishu-bridge/dist/app/cli.js';
    const alive = new Set([100, 101, 200, 201, 300, 400]);
    const signals: Array<{ readonly pid: number; readonly signal: string | number | undefined }> = [];
    writeFileSync(join(root, 'bridge.pid'), '100\n', { mode: 0o600 });

    const output: string[] = [];
    const report = await runBackgroundCommand('stop', {
      configHome: root,
      entryPath,
      listProcesses: () => [
        processInfo(100, 1, `/usr/local/bin/node ${entryPath} supervise`),
        processInfo(101, 100, `/usr/local/bin/node ${entryPath} run`),
        processInfo(200, 1, `/usr/local/bin/node ${entryPath} supervise`),
        processInfo(201, 200, `/usr/local/bin/node ${entryPath} run`),
        processInfo(300, 1, '/usr/local/bin/node /opt/other-bridge/dist/app/cli.js supervise'),
        processInfo(400, 1, `rg ${entryPath} run`),
      ],
      isProcessAlive: (pid) => alive.has(pid),
      killProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') {
          alive.delete(pid);
        }
      },
      delay: async () => undefined,
      output: { write: (chunk) => output.push(String(chunk)) },
    }, {});

    assert.equal(report.running, false);
    assert.deepEqual(signals, [
      { pid: 100, signal: 'SIGTERM' },
      { pid: 200, signal: 'SIGTERM' },
      { pid: 101, signal: 'SIGTERM' },
      { pid: 201, signal: 'SIGTERM' },
    ]);
    assert.equal(alive.has(300), true);
    assert.equal(alive.has(400), true);
    assert.equal(existsSync(join(root, 'bridge.pid')), false);
    assert.match(output.join(''), /Bridge 正在停止后台服务，旧 PID: 100/);
    assert.match(output.join(''), /Bridge 后台服务已停止/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('background stop sweeps same-entry Bridge processes when pid file is stale', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-background-stop-stale-'));
  try {
    const entryPath = '/opt/codex-feishu-bridge/dist/app/cli.js';
    const alive = new Set([200, 201]);
    const signals: Array<{ readonly pid: number; readonly signal: string | number | undefined }> = [];
    writeFileSync(join(root, 'bridge.pid'), '100\n', { mode: 0o600 });

    const report = await runBackgroundCommand('stop', {
      configHome: root,
      entryPath,
      listProcesses: () => [
        processInfo(100, 1, `/usr/local/bin/node ${entryPath} supervise`),
        processInfo(200, 1, `/usr/local/bin/node ${entryPath} supervise`),
        processInfo(201, 200, `/usr/local/bin/node ${entryPath} run`),
      ],
      isProcessAlive: (pid) => alive.has(pid),
      killProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') {
          alive.delete(pid);
        }
      },
      delay: async () => undefined,
      output: { write: () => undefined },
    }, {});

    assert.equal(report.running, false);
    assert.deepEqual(signals, [
      { pid: 200, signal: 'SIGTERM' },
      { pid: 201, signal: 'SIGTERM' },
    ]);
    assert.equal(existsSync(join(root, 'bridge.pid')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function recordingSpawn(): {
  readonly spawnProcess: typeof spawn;
  readonly options: SpawnOptions | undefined;
} {
  const recording: { options: SpawnOptions | undefined } = { options: undefined };
  const spawnProcess = ((_command: string, _args: readonly string[], options: SpawnOptions) => {
    recording.options = options;
    return { pid: 2_000_000_000, unref: () => undefined } as ChildProcess;
  }) as typeof spawn;
  return {
    spawnProcess,
    get options() {
      return recording.options;
    },
  };
}

function processInfo(pid: number, ppid: number, command: string): ProcessSnapshot {
  return { pid, ppid, command };
}
