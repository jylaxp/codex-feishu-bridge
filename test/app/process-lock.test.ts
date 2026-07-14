import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BridgeProcessLock,
  BridgeProcessLockError,
} from '../../src/app/process-lock';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-process-lock-'));
}

test('allows one live owner and releases ownership for the next process', () => {
  const directory = temporaryDirectory();
  const first = new BridgeProcessLock(directory, {
    pid: 101,
    token: 'first-owner-token-0001',
    isProcessAlive: () => true,
  });
  const second = new BridgeProcessLock(directory, {
    pid: 202,
    token: 'second-owner-token-0002',
    isProcessAlive: () => true,
  });

  first.acquire();
  assert.throws(() => second.acquire(), BridgeProcessLockError);
  first.release();
  second.acquire();
  second.release();
});

test('reclaims only a trusted lock whose owner is provably absent', () => {
  const directory = temporaryDirectory();
  const lockPath = join(directory, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: 303,
    token: 'stale-owner-token-0003',
    startedAt: '2026-07-13T00:00:00.000Z',
  }), { encoding: 'utf8', mode: 0o600 });
  const replacement = new BridgeProcessLock(directory, {
    pid: 404,
    token: 'replacement-token-0004',
    isProcessAlive: (pid) => pid !== 303,
  });

  replacement.acquire();
  assert.equal(existsSync(join(directory, 'bridge.lock.recovery')), false);
  replacement.release();
});

test('fails closed while another process owns stale-lock recovery mutex', () => {
  const directory = temporaryDirectory();
  const lockPath = join(directory, 'bridge.lock');
  const stalePayload = JSON.stringify({
    pid: 606,
    token: 'stale-owner-token-0006',
    startedAt: '2026-07-13T00:00:00.000Z',
  });
  writeFileSync(lockPath, stalePayload, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(join(directory, 'bridge.lock.recovery'), 'recovery-in-progress', {
    encoding: 'utf8',
    mode: 0o600,
  });
  const contender = new BridgeProcessLock(directory, {
    pid: 707,
    token: 'contender-token-0007',
    isProcessAlive: () => false,
  });

  assert.throws(() => contender.acquire(), BridgeProcessLockError);
  assert.equal(readFileSync(lockPath, 'utf8'), stalePayload);
});

test('fails closed for symlink and group-readable lock files', () => {
  const symlinkDirectory = temporaryDirectory();
  const targetPath = join(symlinkDirectory, 'target');
  writeFileSync(targetPath, '{}', { encoding: 'utf8', mode: 0o600 });
  symlinkSync(targetPath, join(symlinkDirectory, 'bridge.lock'));
  assert.throws(
    () => new BridgeProcessLock(symlinkDirectory).acquire(),
    BridgeProcessLockError,
  );

  const modeDirectory = temporaryDirectory();
  const lockPath = join(modeDirectory, 'bridge.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: 505,
    token: 'unsafe-owner-token-0005',
    startedAt: '2026-07-13T00:00:00.000Z',
  }), { encoding: 'utf8', mode: 0o600 });
  chmodSync(lockPath, 0o644);
  assert.throws(
    () => new BridgeProcessLock(modeDirectory).acquire(),
    BridgeProcessLockError,
  );
});
