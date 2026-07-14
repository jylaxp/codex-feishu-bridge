import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runDoctor } from '../../src/app/doctor';

test('doctor reports bindings without opening a Bridge SQLite database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-doctor-'));
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const codex = join(root, 'codex');
  mkdirSync(workspace);
  mkdirSync(configHome);
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(configHome, 'bindings.json'), '{"schemaVersion":1,"bindings":[]}');
  try {
    const report = await runDoctor({
      LARK_APP_ID: 'cli_0123456789abcdef', LARK_APP_SECRET: 'secret', LARK_TENANT_KEY: 'tenant',
      ALLOWED_CHATS: 'chat', AUTHORIZED_USERS: 'user', ALLOWED_APPROVERS: 'approver',
      CODEX_BIN: codex, CODEX_CWD: workspace, ALLOWED_WORKSPACE_ROOTS: workspace,
      BRIDGE_CONFIG_HOME: configHome,
    }, {
      verifyRuntimeContract: async () => ({ codexVersion: 'codex-cli test', schemaDigest: 'schema' }),
      nodeVersion: '24.18.0',
    });
    assert.equal(report.bindingCount, 0);
    assert.equal('sqliteVersion' in report, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
