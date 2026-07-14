import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppNavigationError,
  CodexAppNavigationAdapter,
} from '../../src/app/codex/app-navigation-adapter';

test('opens only the exact bound Codex thread with the canonical deep link', async () => {
  const opened: string[] = [];
  const navigation = new CodexAppNavigationAdapter({
    platform: 'darwin',
    launcher: { open: async (uri) => { opened.push(uri); } },
  });

  await navigation.openThread('thread id/with?characters');

  assert.deepEqual(opened, ['codex://threads/thread%20id%2Fwith%3Fcharacters']);
});

test('rejects control characters before constructing a deep link', async () => {
  const navigation = new CodexAppNavigationAdapter({
    launcher: { open: async () => undefined },
  });
  await assert.rejects(navigation.openThread('thread\nother'), AppNavigationError);
});
