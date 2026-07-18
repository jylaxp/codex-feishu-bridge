import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MacosPlatformAdapter,
  macosCodexHomeIpcSocketPath,
  macosDesktopIpcSocketPath,
} from '../../src/app/platform/macos-platform-adapter';

test('macOS Desktop IPC prefers the current Codex home socket when present', () => {
  const adapter = new MacosPlatformAdapter({
    codexHome: '/Users/test/.codex',
    temporaryDirectory: '/private/tmp/test',
    uid: 501,
    endpointExists: (path) => path === '/Users/test/.codex/ipc/ipc.sock',
  });

  assert.deepEqual(adapter.desktopIpcEndpoint(), {
    transport: 'unix_socket',
    address: '/Users/test/.codex/ipc/ipc.sock',
  });
});

test('macOS Desktop IPC falls back to the legacy UID-scoped socket', () => {
  const adapter = new MacosPlatformAdapter({
    codexHome: '/Users/test/.codex',
    temporaryDirectory: '/private/tmp/test',
    uid: 501,
    endpointExists: () => false,
  });

  assert.deepEqual(adapter.desktopIpcEndpoint(), {
    transport: 'unix_socket',
    address: '/private/tmp/test/codex-ipc/ipc-501.sock',
  });
});

test('macOS Desktop IPC explicit override wins over discovered sockets', () => {
  const adapter = new MacosPlatformAdapter({
    endpointExists: () => true,
  });

  assert.equal(adapter.desktopIpcEndpoint('/tmp/explicit/ipc.sock').address, '/tmp/explicit/ipc.sock');
});

test('macOS Desktop IPC path helpers preserve current and legacy layouts', () => {
  assert.equal(macosCodexHomeIpcSocketPath('/Users/test/.codex'), '/Users/test/.codex/ipc/ipc.sock');
  assert.equal(
    macosDesktopIpcSocketPath('/private/tmp/test', 501),
    '/private/tmp/test/codex-ipc/ipc-501.sock',
  );
});
