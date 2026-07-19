import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectChatGptAppVersion } from '../../src/app/codex/chatgpt-app-version';

test('ChatGPT app inspector reports the containing macOS bundle version and build', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-chatgpt-app-'));
  try {
    const appPath = join(root, 'ChatGPT.app');
    const resources = join(appPath, 'Contents', 'Resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(appPath, 'Contents', 'Info.plist'), 'fixture');
    const codexBinary = join(resources, 'codex');

    const result = inspectChatGptAppVersion(codexBinary, {
      platform: 'darwin',
      executeFile: ((_command: string, args: readonly string[]) => (
        args[1]?.includes('CFBundleShortVersionString') ? '26.715.31925\n' : '5551\n'
      )) as typeof import('node:child_process').execFileSync,
    });

    assert.deepEqual(result, { appPath, version: '26.715.31925', build: '5551' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT app inspector returns null for an external Codex binary', () => {
  assert.equal(inspectChatGptAppVersion('/usr/local/bin/codex', { platform: 'darwin' }), null);
});
