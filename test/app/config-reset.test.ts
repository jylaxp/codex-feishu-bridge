import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { writeBridgeConfigFile } from '../../src/app/config-file';
import { BridgeProcessLock } from '../../src/app/process-lock';

test('config reset classifies a malformed protocol catalog as reset required', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-protocol-'));
  try {
    writeFileSync(
      join(configHome, '.env'),
      'LARK_APP_ID=cli_1111111111111111\nLARK_APP_SECRET=secret\nBRIDGE_CONFIG_VERSION=2\n',
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
    assert.equal(inspection.preservesConfig, true);
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
    assert.equal(existsSync(join(configHome, '.env')), false);
    assert.doesNotMatch(readFileSync(join(configHome, 'config.toml'), 'utf8'), /cli_1111111111111111/);
    assert.match(
      readFileSync(join(configHome, 'channels', 'feishu', 'bots.json'), 'utf8'),
      /cli_1111111111111111/,
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config reset accepts a valid protocol catalog as current', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-valid-protocol-'));
  try {
    writeBridgeConfigFile(configHome, {
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      CODEX_BIN: '/codex',
    });
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

test('config reset treats residual .env next to config.toml as reset required', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-env-leftover-'));
  try {
    writeBridgeConfigFile(configHome, {
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      CODEX_BIN: '/codex',
    });
    writeFileSync(join(configHome, '.env'), 'LARK_APP_ID=cli_ffffffffffffffff\n', { mode: 0o600 });
    writeFileSync(
      join(configHome, 'bindings.json'),
      '{\n  "schemaVersion": 6,\n  "bindings": []\n}\n',
      { mode: 0o600 },
    );

    const inspection = inspectConfigReset(configHome);
    assert.equal(inspection.action, 'reset_required');
    assert.deepEqual(inspection.entriesToRemove, ['.env', 'bindings.json', 'config.toml']);

    const reset = resetConfigHome(configHome, { confirm: true });
    assert.equal(reset.action, 'already_current');
    assert.equal(existsSync(join(configHome, '.env')), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('config reset refuses to migrate a legacy .env symlink', { skip: process.platform === 'win32' }, () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-config-reset-env-symlink-'));
  const target = join(configHome, 'secret.env');
  try {
    writeFileSync(target, 'LARK_APP_ID=cli_0123456789abcdef\n', { mode: 0o600 });
    symlinkSync(target, join(configHome, '.env'));
    writeFileSync(
      join(configHome, 'bindings.json'),
      '{\n  "schemaVersion": 1,\n  "bindings": []\n}\n',
      { mode: 0o600 },
    );

    assert.throws(
      () => resetConfigHome(configHome, { confirm: true }),
      /config reset could not replace the configuration directory/,
    );
    assert.equal(existsSync(join(configHome, '.env')), true);
    assert.equal(existsSync(join(configHome, 'config.toml')), false);
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
    assert.equal(existsSync(join(configHome, 'config.toml')), true);
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
