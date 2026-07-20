import assert from 'node:assert/strict';
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBackgroundCommand } from '../../src/app/background-service';

test('background service ignores process output and does not create log files when logging is off', async () => {
  for (const source of [undefined, 'LOG_TO_FILE=false\n', 'LOG_TO_FILE=invalid\n']) {
    const root = mkdtempSync(join(tmpdir(), 'bridge-background-log-off-'));
    try {
      if (source !== undefined) {
        writeFileSync(join(root, '.env'), source, { mode: 0o600 });
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
    writeFileSync(join(root, '.env'), 'LOG_TO_FILE=true\n', { mode: 0o600 });
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
    assert.match(output.join(''), /标准日志:/);
    assert.match(output.join(''), /错误日志:/);
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
