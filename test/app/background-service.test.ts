import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runBackgroundCommand } from '../../src/app/background-service';

test('starts and reports the original PID/log based background layout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-background-'));
  const output: string[] = [];
  try {
    const report = await runBackgroundCommand('start', {
      configHome: root,
      entryPath: '/installed/dist/app/cli.js',
      output: { write: (chunk) => output.push(chunk) },
      spawnProcess: (() => ({ pid: process.pid, unref: () => undefined })) as never,
    }, {});

    assert.equal(report.running, true);
    assert.equal(report.pid, process.pid);
    assert.equal(readFileSync(join(root, 'bridge.pid'), 'utf8').trim(), String(process.pid));
    assert.equal(existsSync(join(root, 'logs', 'bridge_stdout.log')), true);
    assert.equal(existsSync(join(root, 'logs', 'bridge_stderr.log')), true);
    assert.match(output.join(''), /Bridge 已启动/);

    const status = await runBackgroundCommand('status', {
      configHome: root,
      output: { write: (chunk) => output.push(chunk) },
    }, {});
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.match(output.join(''), /Bridge 正在运行/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
