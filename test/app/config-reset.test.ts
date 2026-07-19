import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectConfigReset, resetConfigHome } from '../../src/app/config-reset';
import {
  PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME,
  ProtocolVersionConfigStore,
} from '../../src/app/codex/protocol-version-config';
import { BridgeProcessLock } from '../../src/app/process-lock';

test('config reset classifies a malformed protocol catalog as reset required', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-protocol-'));
  try {
    writeFileSync(
      join(configHome, '.env'),
      'LARK_APP_ID=cli_0123456789abcdef\nBRIDGE_CONFIG_VERSION=2\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(configHome, 'bindings.json'),
      '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n',
      { mode: 0o600 },
    );
    writeFileSync(join(configHome, 'protocol-versions.json'), '{', { mode: 0o600 });

    const inspection = inspectConfigReset(configHome);
    assert.equal(inspection.action, 'reset_required');
    assert.equal(inspection.preservesEnv, true);
    assert.deepEqual(
      inspection.entriesToRemove,
      ['.env', 'bindings.json', 'protocol-versions.json'],
    );
    assert.throws(
      () => resetConfigHome(configHome),
      /config reset requires explicit confirmation/,
    );
    assert.equal(readFileSync(join(configHome, 'protocol-versions.json'), 'utf8'), '{');

    const reset = resetConfigHome(configHome, { confirm: true });
    assert.equal(reset.action, 'already_current');
    assert.equal(existsSync(join(configHome, 'protocol-versions.json')), false);
    assert.match(readFileSync(join(configHome, '.env'), 'utf8'), /LARK_APP_ID=cli_0123456789abcdef/);
    assert.match(readFileSync(join(configHome, '.env'), 'utf8'), /BRIDGE_CONFIG_VERSION=2/);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config reset accepts a valid protocol catalog as current', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-valid-protocol-'));
  try {
    writeFileSync(
      join(configHome, 'bindings.json'),
      '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n',
      { mode: 0o600 },
    );
    new ProtocolVersionConfigStore(configHome).loadOrCreate();

    const inspection = inspectConfigReset(configHome);
    assert.equal(inspection.action, 'already_current');
    assert.deepEqual(inspection.entriesToRemove, []);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config reset fails closed while protocol catalog mutation is in progress', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-protocol-lock-'));
  const protocolLock = new BridgeProcessLock(configHome, {
    lockFileName: PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME,
  });
  try {
    writeFileSync(
      join(configHome, 'bindings.json'),
      '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n',
      { mode: 0o600 },
    );
    writeFileSync(join(configHome, 'protocol-versions.json'), '{', { mode: 0o600 });
    protocolLock.acquire();

    assert.throws(
      () => resetConfigHome(configHome, { confirm: true }),
      /Protocol version inspection or approval must finish/,
    );
    assert.equal(readFileSync(join(configHome, 'protocol-versions.json'), 'utf8'), '{');
  } finally {
    protocolLock.release();
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config reset establishes and cleans inner locks when config home is initially absent', () => {
  const parent = mkdtempSync(join(tmpdir(), 'bridge-config-reset-missing-parent-'));
  const configHome = join(parent, 'missing-config');
  try {
    const reset = resetConfigHome(configHome, { confirm: true });

    assert.equal(reset.action, 'already_current');
    assert.equal(existsSync(join(configHome, 'bindings.json')), true);
    assert.equal(existsSync(join(configHome, 'bridge.lock')), false);
    assert.equal(
      existsSync(join(configHome, PROTOCOL_VERSION_CONFIG_LOCK_FILE_NAME)),
      false,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
