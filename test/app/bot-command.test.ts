import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeMigratedBindingAllowedChats } from '../../src/app/bot-command';
import type { ChatThreadBinding } from '../../src/app/binding-store';

test('config migrate includes existing bindings in the migrated bot chat allowlist', () => {
  const merged = mergeMigratedBindingAllowedChats(
    ['oc_private'],
    [
      binding('cli_0123456789abcdef', 'oc_private'),
      binding('cli_0123456789abcdef', 'oc_group'),
      binding('cli_abcdefabcdef1234', 'oc_other_bot_group'),
    ],
    'cli_0123456789abcdef',
  );

  assert.deepEqual(merged, ['oc_private', 'oc_group']);
});

function binding(appId: string, chatId: string): ChatThreadBinding {
  return {
    larkAppId: appId,
    botKey: appId,
    tenantKey: 'tenant',
    chatId,
    threadId: `thread-${chatId}`,
    workspaceId: '/workspace',
    revision: 1,
    updatedAtMs: 1,
  };
}
