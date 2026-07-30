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

test('binding store scopes the same tenant chat by bot key', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-bots-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    store.bind({
      botKey: 'bot_aaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread-a',
      workspaceId: '/workspace-a',
    });
    store.bind({
      botKey: 'bot_bbbbbbbbbbbb',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread-b',
      workspaceId: '/workspace-b',
    });

    assert.equal(store.get('tenant', 'chat', 'bot_aaaaaaaaaaaa')?.threadId, 'thread-a');
    assert.equal(store.get('tenant', 'chat', 'bot_bbbbbbbbbbbb')?.threadId, 'thread-b');
    assert.equal(store.list().length, 2);

    const document = JSON.parse(readFileSync(join(configHome, 'bindings.json'), 'utf8')) as {
      readonly schemaVersion: number;
      readonly bindings: readonly { readonly botKey?: string }[];
    };
    assert.equal(document.schemaVersion, 4);
    assert.deepEqual(document.bindings.map((binding) => binding.botKey).sort(), [
      'bot_aaaaaaaaaaaa',
      'bot_bbbbbbbbbbbb',
    ]);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store persists chat type metadata', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-chat-type-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    const binding = store.bind({
      botKey: 'bot_aaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      chatType: 'group',
      threadId: 'thread',
      workspaceId: '/workspace',
    });

    assert.equal(binding.chatType, 'group');

    const loaded = new BindingStore(configHome);
    loaded.load();
    assert.equal(loaded.get('tenant', 'chat', 'bot_aaaaaaaaaaaa')?.chatType, 'group');
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
      botKey: 'bot_aaaaaaaaaaaa',
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
      'bot_aaaaaaaaaaaa',
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
      'bot_aaaaaaaaaaaa',
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

test('binding store loads old bindings with bot collaboration disabled', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-collab-default-'));
  try {
    writeFileSync(join(configHome, 'bindings.json'), JSON.stringify({
      schemaVersion: 2,
      bindings: [{
        botKey: 'bot_aaaaaaaaaaaa',
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

    const loaded = store.get('tenant', 'chat', 'bot_aaaaaaaaaaaa');
    assert.equal(loaded?.allowBotSenderMentions, undefined);
    assert.deepEqual(loaded?.allowedBotSenderKeys ?? [], []);
    assert.deepEqual(loaded?.allowedBotSenderOpenIds ?? [], []);
    assert.deepEqual(loaded?.allowedHandoffTargetBotKeys ?? [], []);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store persists bot collaboration policy per binding', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-collab-policy-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    const binding = store.bind({
      botKey: 'bot_aaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      threadId: 'thread',
      workspaceId: '/workspace',
      allowBotSenderMentions: true,
      allowedBotSenderKeys: ['bot_bbbbbbbbbbbb', 'bot_bbbbbbbbbbbb'],
      allowedBotSenderOpenIds: ['ou_source', 'ou_source'],
      allowedHandoffTargetBotKeys: ['bot_cccccccccccc'],
    });

    assert.equal(binding.allowBotSenderMentions, true);
    assert.deepEqual(binding.allowedBotSenderKeys, ['bot_bbbbbbbbbbbb']);
    assert.deepEqual(binding.allowedBotSenderOpenIds, ['ou_source']);
    assert.deepEqual(binding.allowedHandoffTargetBotKeys, ['bot_cccccccccccc']);

    const document = JSON.parse(readFileSync(join(configHome, 'bindings.json'), 'utf8')) as {
      readonly schemaVersion: number;
      readonly bindings: readonly {
        readonly allowBotSenderMentions?: boolean;
        readonly allowedBotSenderKeys?: readonly string[];
        readonly allowedBotSenderOpenIds?: readonly string[];
        readonly allowedHandoffTargetBotKeys?: readonly string[];
      }[];
    };
    assert.equal(document.schemaVersion, 4);
    assert.equal(document.bindings[0]?.allowBotSenderMentions, true);
    assert.deepEqual(document.bindings[0]?.allowedBotSenderKeys, ['bot_bbbbbbbbbbbb']);
    assert.deepEqual(document.bindings[0]?.allowedBotSenderOpenIds, ['ou_source']);
    assert.deepEqual(document.bindings[0]?.allowedHandoffTargetBotKeys, ['bot_cccccccccccc']);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('binding store refuses to choose one Desktop projection when multiple bots share a thread', () => {
  const configHome = mkdtempSync(join(tmpdir(), 'bridge-binding-shared-thread-'));
  try {
    const store = new BindingStore(configHome, { now: () => 1_000 });
    store.bind({
      botKey: 'bot_aaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat-a',
      threadId: 'thread-shared',
      workspaceId: '/workspace-a',
    });
    store.bind({
      botKey: 'bot_bbbbbbbbbbbb',
      tenantKey: 'tenant',
      chatId: 'chat-b',
      threadId: 'thread-shared',
      workspaceId: '/workspace-b',
    });

    assert.equal(store.getUniqueByThreadId('thread-shared'), undefined);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
