import assert from 'node:assert/strict';
import test from 'node:test';

import { DesktopIpcEndpointError } from '../../../src/app/platform/platform-adapter';
import {
  WindowsPlatformAdapter,
  type WindowsDesktopProbe,
} from '../../../src/app/platform/windows-platform-adapter';

test('fails closed when no Windows native endpoint probe is available', async () => {
  const adapter = new WindowsPlatformAdapter();
  await assert.rejects(
    adapter.discoverDesktopIpcEndpoint(),
    (error: unknown) => {
      assert.ok(error instanceof DesktopIpcEndpointError);
      assert.equal(error.code, 'DESKTOP_IPC_UNAVAILABLE');
      return true;
    },
  );
});

test('accepts only the endpoint attested by the Windows probe seam', async () => {
  const endpoint = Object.freeze({
    transport: 'named_pipe' as const,
    address: '\\\\.\\pipe\\codex-desktop-attested',
  });
  const probe: WindowsDesktopProbe = {
    discoverAttestedEndpoint: async () => endpoint,
    attestEndpoint: async (candidate) => candidate.address === endpoint.address,
  };
  const adapter = new WindowsPlatformAdapter(probe);

  assert.deepEqual(await adapter.discoverDesktopIpcEndpoint(), endpoint);
  await adapter.attestDesktopIpcEndpoint(endpoint);
  await assert.rejects(
    adapter.attestDesktopIpcEndpoint({
      transport: 'named_pipe',
      address: '\\\\.\\pipe\\untrusted',
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopIpcEndpointError);
      assert.equal(error.code, 'DESKTOP_IPC_INVALID_ENDPOINT');
      return true;
    },
  );
});
