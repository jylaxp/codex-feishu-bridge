import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LarkScopeConfigStore } from '../../src/app/lark/scope-config-store';

test('persists learned Lark tenant and private chat scope while preserving env content', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-scope-store-'));
  try {
    const configHome = join(root, 'config');
    mkdirSync(configHome);
    writeFileSync(join(configHome, '.env'), [
      '# bridge env',
      'LARK_APP_ID=cli_aaaabbbbccccdddd',
      'LARK_TENANT_KEY=',
      'ALLOWED_CHATS=',
      'AUTHORIZED_USERS=',
      'ALLOWED_APPROVERS=',
      'CUSTOM_KEY=custom',
      '',
    ].join('\n'));

    new LarkScopeConfigStore(configHome).save({
      tenantKey: 'tenant-test',
      allowedChats: 'oc_private',
      authorizedUsers: 'ou_owner',
      allowedApprovers: 'ou_owner',
    });

    const env = readFileSync(join(configHome, '.env'), 'utf8');
    assert.match(env, /^# bridge env$/m);
    assert.match(env, /^CUSTOM_KEY=custom$/m);
    assert.match(env, /^LARK_TENANT_KEY=tenant-test$/m);
    assert.match(env, /^ALLOWED_CHATS=oc_private$/m);
    assert.match(env, /^AUTHORIZED_USERS=ou_owner$/m);
    assert.match(env, /^ALLOWED_APPROVERS=ou_owner$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
