import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MacosPlatformAdapter,
  macosDesktopIpcSocketPath,
} from '../../../src/app/platform/macos-platform-adapter';
import { DesktopIpcEndpointError } from '../../../src/app/platform/platform-adapter';

test('builds the established UID-scoped macOS follower socket path', () => {
  assert.equal(
    macosDesktopIpcSocketPath('/private/tmp/example', 501),
    '/private/tmp/example/codex-ipc/ipc-501.sock',
  );
  assert.equal(
    macosDesktopIpcSocketPath('/private/tmp/example', 0),
    '/private/tmp/example/codex-ipc/ipc.sock',
  );
});

test('attests an owned Unix socket and rejects arbitrary names', async () => {
  const adapter = new MacosPlatformAdapter({
    uid: 501,
    lstatEndpoint: async () => ({
      isSocket: () => true,
      isSymbolicLink: () => false,
      uid: 501,
    }) as never,
  });
  await adapter.attestDesktopIpcEndpoint(
    adapter.desktopIpcEndpoint('/private/tmp/codex-ipc/ipc-501.sock'),
  );
  await assert.rejects(
    adapter.attestDesktopIpcEndpoint(
      adapter.desktopIpcEndpoint('/private/tmp/codex-ipc/SingletonSocket'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof DesktopIpcEndpointError);
      assert.equal(error.code, 'DESKTOP_IPC_INVALID_ENDPOINT');
      return true;
    },
  );
});
