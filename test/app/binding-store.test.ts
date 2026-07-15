import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BindingStore, BindingStoreError } from '../../src/app/binding-store';

function withStore(
  callback: (store: BindingStore, root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'binding-store-'));
  try {
    callback(new BindingStore(root, { now: () => 1_700_000_000_000 }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('persists only static chat-to-thread bindings atomically', () => {
  withStore((store, root) => {
    store.load();
    const binding = store.bind({
      tenantKey: 'tenant-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      model: 'gpt-5.4',
    });

    assert.equal(binding.revision, 1);
    const document = readFileSync(join(root, 'bindings.json'), 'utf8');
    assert.match(document, /thread-1/);
    assert.doesNotMatch(document, /prompt|approval|card|outbox|item/i);

    const reloaded = new BindingStore(root);
    reloaded.load();
    assert.deepEqual(reloaded.get('tenant-1', 'chat-1'), binding);
  });
});

test('increments binding revision and removes only the requested binding', () => {
  withStore((store) => {
    store.load();
    store.bind({ tenantKey: 'tenant-1', chatId: 'chat-1', threadId: 'thread-1', workspaceId: 'one' });
    const replacement = store.bind({
      tenantKey: 'tenant-1',
      chatId: 'chat-1',
      threadId: 'thread-2',
      workspaceId: 'two',
    });

    assert.equal(replacement.revision, 2);
    assert.equal(store.unbind('tenant-1', 'chat-1'), true);
    assert.equal(store.get('tenant-1', 'chat-1'), undefined);
    assert.equal(store.unbind('tenant-1', 'chat-1'), false);
  });
});

test('resolves a Desktop thread only when exactly one Feishu chat binds it', () => {
  withStore((store) => {
    store.load();
    const first = store.bind({
      tenantKey: 'tenant-1', chatId: 'chat-1', threadId: 'thread-1', workspaceId: 'one',
    });
    assert.deepEqual(store.getUniqueByThreadId('thread-1'), first);
    store.bind({
      tenantKey: 'tenant-1', chatId: 'chat-2', threadId: 'thread-1', workspaceId: 'two',
    });
    assert.equal(store.getUniqueByThreadId('thread-1'), undefined);
    assert.equal(store.getUniqueByThreadId('missing-thread'), undefined);
  });
});

test('fails closed on an unknown field or malformed binding document', () => {
  withStore((store, root) => {
    writeFileSync(join(root, 'bindings.json'), JSON.stringify({
      schemaVersion: 1,
      bindings: [{
        tenantKey: 'tenant-1',
        chatId: 'chat-1',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        revision: 1,
        updatedAtMs: 1,
        prompt: 'must never be stored',
      }],
    }));

    assert.throws(() => store.load(), BindingStoreError);
    assert.match(readFileSync(join(root, 'bindings.json'), 'utf8'), /must never be stored/);
  });
});
