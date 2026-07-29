import assert from 'node:assert/strict';
import test from 'node:test';

import { WindowsPlatformAdapter } from '../../src/app/platform/windows-platform-adapter';

test('windows Desktop IPC adapter fails closed without a native probe', async () => {
  const adapter = new WindowsPlatformAdapter();

  assert.throws(
    () => adapter.desktopIpcEndpoint(),
    /Windows Desktop IPC requires an attested native probe/,
  );
  await assert.rejects(
    () => adapter.discoverDesktopIpcEndpoint(),
    /Windows Desktop IPC requires an attested native probe/,
  );
});
