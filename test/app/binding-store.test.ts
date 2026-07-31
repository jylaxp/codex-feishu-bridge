import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BindingStore } from '../../src/app/binding-store';

test('binding store loads schema v1 bindings as the default bot', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-v1-'));
  try {
    writeFileSync(join(configHome, 'bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: [{
        tenantKey: 'tenant',
        chatId: 'chat',
        threadId: 'thread',
        workspaceId: '/workspace',
        revision: 1,
        updatedAtMs: 1,
      }],
    }));
    const store = new BindingStore(configHome);
    store.load();

    assert.equal(store.get('tenant', 'chat')?.botKey, 'default');
    assert.equal(store.get('tenant', 'chat')?.threadId, 'thread');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store maps legacy default bindings to the migrated app id', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-v1-appid-'));
  try {
    writeFileSync(join(configHome, 'bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: [{
        tenantKey: 'tenant',
        chatId: 'chat',
        threadId: 'thread',
        workspaceId: '/workspace',
        revision: 1,
        updatedAtMs: 1,
      }],
    }));
    const store = new BindingStore(configHome);
    store.load({ legacyDefaultBotIdentifier: 'cli_0123456789abcdef' });

    assert.equal(store.get('tenant', 'chat', 'cli_0123456789abcdef')?.larkAppId, 'cli_0123456789abcdef');
    assert.equal(store.get('tenant', 'chat', 'cli_0123456789abcdef')?.threadId, 'thread');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store scopes the same tenant chat by bot key', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-bots-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread-a',
      workspaceId: '/workspace-a',
    });
    store.bind({
      botKey: 'cli_bbbbbbbbbbbbbbbb',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread-b',
      workspaceId: '/workspace-b',
    });

    assert.equal(store.get('tenant', 'chat', 'cli_aaaaaaaaaaaaaaaa')?.threadId, 'thread-a');
    assert.equal(store.get('tenant', 'chat', 'cli_bbbbbbbbbbbbbbbb')?.threadId, 'thread-b');
    assert.equal(store.list().length, 2);

    const document = JSON.parse(readFileSync(join(configHome, 'bindings.json'), 'utf8')) as {
      readonly schemaVersion: number;
      readonly bindings: readonly {
        readonly channel?: string;
        readonly larkAppId?: string;
        readonly botKey?: string;
      }[];
    };
    assert.equal(document.schemaVersion, 6);
    assert.deepEqual(document.bindings.map((binding) => binding.channel), ['feishu', 'feishu']);
    assert.deepEqual(document.bindings.map((binding) => binding.larkAppId).sort(), [
      'cli_aaaaaaaaaaaaaaaa',
      'cli_bbbbbbbbbbbbbbbb',
    ]);
    assert.deepEqual(document.bindings.map((binding) => binding.botKey), [undefined, undefined]);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store persists chat type metadata', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-chat-type-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    const binding = store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      chatType: 'group',
      threadId: 'thread',
      workspaceId: '/workspace',
    });

    assert.equal(binding.chatType, 'group');

    const loaded = new BindingStore(configHome);
    loaded.load();
    assert.equal(loaded.get('tenant', 'chat', 'cli_aaaaaaaaaaaaaaaa')?.chatType, 'group');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store records observed chat type for legacy bindings without overwriting known types', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-observed-chat-type-'));
  try {
    let now = 1_000;
    const store = new BindingStore(configHome, { now: () => now });
    store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'legacy-chat',
      threadId: 'thread-legacy',
      workspaceId: '/workspace',
    });
    store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'known-chat',
      chatType: 'group',
      threadId: 'thread-known',
      workspaceId: '/workspace',
    });
    store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'unknown-chat',
      chatType: 'unknown',
      threadId: 'thread-unknown',
      workspaceId: '/workspace',
    });

    now = 2_000;
    const legacy = store.recordObservedChatType('tenant', 'legacy-chat', 'group', 'cli_aaaaaaaaaaaaaaaa');
    const known = store.recordObservedChatType('tenant', 'known-chat', 'p2p', 'cli_aaaaaaaaaaaaaaaa');
    const unknown = store.recordObservedChatType('tenant', 'unknown-chat', 'p2p', 'cli_aaaaaaaaaaaaaaaa');

    assert.equal(legacy?.chatType, 'group');
    assert.equal(legacy?.revision, 2);
    assert.equal(known?.chatType, 'group');
    assert.equal(known?.revision, 1);
    assert.equal(unknown?.chatType, 'p2p');
    assert.equal(unknown?.revision, 2);

    const loaded = new BindingStore(configHome);
    loaded.load();
    assert.equal(loaded.get('tenant', 'legacy-chat', 'cli_aaaaaaaaaaaaaaaa')?.chatType, 'group');
    assert.equal(loaded.get('tenant', 'known-chat', 'cli_aaaaaaaaaaaaaaaa')?.chatType, 'group');
    assert.equal(loaded.get('tenant', 'unknown-chat', 'cli_aaaaaaaaaaaaaaaa')?.chatType, 'p2p');
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store persists external group member access policy per binding', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-external-policy-'));
  try {
    let tick = 1_000;
    const store = new BindingStore(configHome, { now: () => tick });
    const initial = store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread',
      workspaceId: '/workspace',
    });
    assert.equal(initial.allowExternalGroupUserMentions, undefined);

    tick = 2_000;
    const disabled = store.updateExternalGroupUserMentionPolicy(
      'tenant',
      'chat',
      false,
      'cli_aaaaaaaaaaaaaaaa',
    );
    assert.equal(disabled?.allowExternalGroupUserMentions, false);
    assert.equal(disabled?.revision, 2);

    let document = JSON.parse(readFileSync(join(configHome, 'bindings.json'), 'utf8')) as {
      readonly bindings: readonly { readonly allowExternalGroupUserMentions?: boolean }[];
    };
    assert.equal(document.bindings[0]?.allowExternalGroupUserMentions, false);

    tick = 3_000;
    const enabled = store.updateExternalGroupUserMentionPolicy(
      'tenant',
      'chat',
      true,
      'cli_aaaaaaaaaaaaaaaa',
    );
    assert.equal(enabled?.allowExternalGroupUserMentions, undefined);
    assert.equal(enabled?.revision, 3);

    document = JSON.parse(readFileSync(join(configHome, 'bindings.json'), 'utf8')) as {
      readonly bindings: readonly { readonly allowExternalGroupUserMentions?: boolean }[];
    };
    assert.equal('allowExternalGroupUserMentions' in (document.bindings[0] ?? {}), false);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store lists every channel endpoint bound to the same thread', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-shared-thread-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    store.bind({
      botKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat-a',
      threadId: 'thread-shared',
      workspaceId: '/workspace-a',
    });
    store.bind({
      botKey: 'cli_bbbbbbbbbbbbbbbb',
      tenantKey: 'tenant',
      chatId: 'chat-b',
      threadId: 'thread-shared',
      workspaceId: '/workspace-b',
    });

    assert.equal(store.getUniqueByThreadId('thread-shared'), undefined);
    assert.deepEqual(
      store.listByThreadId('thread-shared').map((candidate) => candidate.chatId).sort(),
      ['chat-a', 'chat-b'],
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
