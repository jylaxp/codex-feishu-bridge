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
    assert.equal(document.schemaVersion, 2);
    assert.deepEqual(document.bindings.map((binding) => binding.botKey).sort(), [
      'bot_aaaaaaaaaaaa',
      'bot_bbbbbbbbbbbb',
    ]);
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
