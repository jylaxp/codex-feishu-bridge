import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigResetError,
  inspectConfigReset,
  resetConfigHome,
} from '../../src/app/config-reset';

function withLegacyHome(callback: (home: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'config-reset-'));
  const home = join(root, '.codex-feishu-bridge');
  mkdirSync(join(home, 'app-server-v2'), { recursive: true });
  mkdirSync(join(home, 'backups'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, '.env'), '# preserved\nLARK_APP_ID=cli_example\nUNKNOWN_KEY=value\n');
  writeFileSync(join(home, 'sessions.json'), '{"legacy":true}');
  writeFileSync(join(home, 'approvals.json'), '{}');
  writeFileSync(join(home, 'pushed_turns.json'), '[]');
  writeFileSync(join(home, 'bridge.db'), 'sqlite');
  try {
    callback(home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('dry run lists legacy entries without modifying them', () => {
  withLegacyHome((home) => {
    const report = inspectConfigReset(home);
    assert.equal(report.action, 'reset_required');
    assert.ok(report.entriesToRemove.includes('sessions.json'));
    assert.ok(report.entriesToRemove.includes('bridge.db'));
    assert.equal(existsSync(join(home, 'sessions.json')), true);
  });
});

test('confirmed reset preserves only .env and creates an empty bindings file', () => {
  withLegacyHome((home) => {
    const report = resetConfigHome(home, { confirm: true });
    assert.equal(report.action, 'already_current');
    assert.deepEqual(report.entriesToRemove, []);
    const env = readFileSync(join(home, '.env'), 'utf8');
    assert.match(env, /# preserved/);
    assert.match(env, /UNKNOWN_KEY=value/);
    assert.match(env, /BRIDGE_CONFIG_VERSION=2/);
    assert.equal(readFileSync(join(home, 'bindings.json'), 'utf8').includes('"bindings": []'), true);
    assert.equal(existsSync(join(home, 'sessions.json')), false);
    assert.equal(existsSync(join(home, 'bridge.db')), false);
    assert.equal(existsSync(join(home, 'app-server-v2')), false);
  });
});

test('requires confirmation and refuses a live Bridge lock', () => {
  withLegacyHome((home) => {
    assert.throws(() => resetConfigHome(home), ConfigResetError);
    writeFileSync(join(home, 'bridge.lock'), 'live');
    assert.throws(() => resetConfigHome(home, { confirm: true }), /Bridge must be stopped/);
  });
});
