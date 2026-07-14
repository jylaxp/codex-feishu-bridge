import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigurationError } from '../../src/app/config';
import { loadBridgeEnvironment } from '../../src/app/config-file';

test('loads the private Bridge .env while preserving explicit process overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-env-file-'));
  try {
    const configHome = join(root, 'config');
    mkdirSync(configHome);
    writeFileSync(join(configHome, '.env'), [
      '# bridge configuration',
      'LARK_APP_ID=cli_0123456789abcdef',
      'LARK_APP_SECRET="secret value"',
      'CODEX_CWD=/from-file',
      'EMPTY=',
      '',
    ].join('\n'));

    const baseEnvironment = {
      BRIDGE_CONFIG_HOME: configHome,
      CODEX_CWD: '/from-process',
    };
    const loaded = loadBridgeEnvironment(baseEnvironment);

    assert.equal(loaded.LARK_APP_SECRET, 'secret value');
    assert.equal(loaded.CODEX_CWD, '/from-process');
    assert.equal(loaded.EMPTY, '');
    assert.deepEqual(baseEnvironment, {
      BRIDGE_CONFIG_HOME: configHome,
      CODEX_CWD: '/from-process',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a symlinked Bridge .env instead of following it', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-env-file-'));
  try {
    const configHome = join(root, 'config');
    const target = join(root, 'target.env');
    mkdirSync(configHome);
    writeFileSync(target, 'LARK_APP_SECRET=secret\n');
    symlinkSync(target, join(configHome, '.env'));

    assert.throws(
      () => loadBridgeEnvironment({ BRIDGE_CONFIG_HOME: configHome }),
      ConfigurationError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
