import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readRuntimeHealth,
  RuntimeHealthPublisher,
  RuntimeHealthStore,
  type RuntimeHealthSnapshot,
} from '../../src/app/runtime-health';
import { runBackgroundCommand } from '../../src/app/background-service';

test('runtime health is atomic, content-free, and readable by status', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-health-'));
  try {
    const snapshot: RuntimeHealthSnapshot = {
      schemaVersion: 1,
      pid: 123,
      supervisorPid: 122,
      updatedAt: '2026-07-19T00:00:00.000Z',
      status: 'ready',
      appServer: {
        state: 'ready',
        protocolContractId: 'app-server-0.145.0-alpha.18',
        schemaDigest: 'a'.repeat(64),
        artifactSha256: 'b'.repeat(64),
      },
      desktop: {
        state: 'READY',
        epoch: 7,
        contractId: 'desktop-ipc-state-v11-following-v1',
      },
      lark: { state: 'ready', reconnectCount: 2, connectedAtMs: 1 },
      tasks: { active: 1, queued: 2, pendingCardDeliveries: 0 },
    };
    const store = new RuntimeHealthStore(root);

    store.write(snapshot);

    assert.deepEqual(readRuntimeHealth(root), snapshot);
    const raw = readFileSync(store.filePath, 'utf8');
    assert.doesNotMatch(raw, /prompt|finalAnswer|cardPayload|reasoning/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime health publisher coalesces bursty task updates', async () => {
  let publishes = 0;
  const publisher = new RuntimeHealthPublisher(() => {
    publishes += 1;
  }, 1);

  for (let index = 0; index < 100; index += 1) {
    publisher.request();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(publishes, 1);

  publisher.flush();
  assert.equal(publishes, 2);
});

test('background status rejects health from a dead supervised worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-dead-worker-health-'));
  try {
    writeFileSync(join(root, 'bridge.pid'), `${process.pid}\n`);
    new RuntimeHealthStore(root).write({
      schemaVersion: 1,
      pid: 2_147_483_647,
      supervisorPid: process.pid,
      updatedAt: '2026-07-19T00:00:00.000Z',
      status: 'ready',
      appServer: {
        state: 'ready',
        protocolContractId: 'app-server-0.145.0-alpha.18',
        schemaDigest: 'a'.repeat(64),
        artifactSha256: 'b'.repeat(64),
      },
      desktop: {
        state: 'READY',
        epoch: 7,
        contractId: 'desktop-ipc-state-v11-following-v1',
      },
      lark: { state: 'ready', reconnectCount: 0, connectedAtMs: 1 },
      tasks: { active: 0, queued: 0, pendingCardDeliveries: 0 },
    });

    const report = await runBackgroundCommand('status', {
      configHome: root,
      output: { write: () => undefined },
    });
    assert.equal(report.running, true);
    assert.equal(report.health, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
