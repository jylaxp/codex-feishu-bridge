import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18 } from '../../src/app/codex/app-server-protocol-registry';
import { runDoctor } from '../../src/app/doctor';

test('doctor reports selected profile and managed proxy trust boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-doctor-profile-'));
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const codex = join(root, 'codex');
  mkdirSync(workspace);
  mkdirSync(configHome);
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  writeFileSync(join(configHome, 'bindings.json'), '{"schemaVersion":1,"bindings":[]}');
  let detectionCount = 0;
  try {
    const report = await runDoctor({
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      LARK_TENANT_KEY: 'tenant',
      ALLOWED_CHATS: 'chat',
      AUTHORIZED_USERS: 'user',
      ALLOWED_APPROVERS: 'approver',
      CODEX_BIN: codex,
      CODEX_CWD: workspace,
      BRIDGE_CONFIG_HOME: configHome,
      APP_SERVER_MODE: 'managed_proxy',
    }, {
      verifyRuntimeContract: async () => {
        detectionCount += 1;
        return {
          codexVersion: 'codex-cli 0.145.0-alpha.18',
          schemaDigest: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest,
          protocolProfile: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
        };
      },
      nodeVersion: '20.17.0',
    });

    assert.equal(detectionCount, 1);
    assert.equal(report.protocolProfileId, 'app-server-0.145.0-alpha.18');
    assert.equal(report.appServerMode, 'managed_proxy');
    assert.equal(
      report.appServerIdentityAssurance,
      'operator_trusted_managed_proxy',
    );
    assert.equal(report.schemaDigest, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest);
    assert.equal(report.bindingCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
