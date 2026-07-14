import assert from 'node:assert/strict';
import test from 'node:test';

import { Thread } from '../../src/app/codex/protocol';
import { createUiSyncThreadCandidate } from '../../src/app/ui-sync-validator';

test('thread list output excludes conversation content and local paths', () => {
  const thread: Thread = {
    id: 'thread-1',
    sessionId: 'session-1',
    preview: 'sensitive conversation preview',
    cwd: '/private/workspace',
    modelProvider: 'openai',
    status: { type: 'idle' },
    name: 'sensitive task name',
    turns: [],
    updatedAt: 1_752_444_800,
  };

  assert.deepEqual(createUiSyncThreadCandidate(thread), {
    threadId: 'thread-1',
    status: 'idle',
    updatedAt: 1_752_444_800,
  });
});

test('thread list output fails closed when updatedAt is absent', () => {
  const thread = {
    id: 'thread-1',
    status: { type: 'idle' },
  } as Thread;

  assert.throws(
    () => createUiSyncThreadCandidate(thread),
    /invalid updatedAt value/,
  );
});
