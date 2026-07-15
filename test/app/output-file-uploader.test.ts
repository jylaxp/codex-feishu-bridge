import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BridgeConfig } from '../../src/app/domain';
import { OutputFileUploader, type FileUploadApi } from '../../src/app/lark/output-file-uploader';

test('uploads only opted-in non-image output files below the authorized workspace root', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-output-file-'));
  try {
    const output = join(workspace, 'result.txt');
    writeFileSync(output, 'result');
    const calls: string[] = [];
    const api: FileUploadApi = {
      im: { v1: {
        // The installed Lark SDK returns the root-level file_key without a code field.
        file: { create: async () => { calls.push('upload'); return { file_key: 'file-key' }; } },
        message: { reply: async (payload) => {
          calls.push(JSON.stringify(payload));
          return { code: 0 };
        } },
      } },
    };
    const config: BridgeConfig = {
      larkAppId: 'cli_0123456789abcdef', larkAppSecret: 'secret', larkTenantKey: 'tenant',
      allowedChats: ['chat'], authorizedUsers: ['user'], allowedApprovers: ['approver'],
      appServerMode: 'owned_stdio', appServerSocketPath: null, codexBin: '/codex', codexCwd: workspace,
      allowedWorkspaceRoots: [workspace], maxTextLength: 10_000, cardUpdateIntervalMs: 1_000,
      maxQueuedTasks: 10, rateLimitQueryIntervalMs: 300_000, logToFile: false, logFilePath: null,
      enableAutoFileUpload: true,
    };
    await new OutputFileUploader(config, api).uploadMarkdownFiles(
      `[result](${output})\n![ignored](${output}.png)\n[outside](/etc/hosts)`,
      'root-message',
      'task-id',
    );
    assert.equal(calls[0], 'upload');
    assert.match(calls[1] ?? '', /root-message/);
    assert.match(calls[1] ?? '', /file-key/);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('de-duplicates output files and continues after a rejected file reply', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'bridge-output-file-retry-'));
  try {
    const first = join(workspace, 'first.txt');
    const second = join(workspace, 'second.txt');
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    const uploads: string[] = [];
    let replies = 0;
    const api: FileUploadApi = {
      im: { v1: {
        file: { create: async (payload) => {
          uploads.push(payload.data.file_name);
          return { code: 0, file_key: `key-${uploads.length}` };
        } },
        message: { reply: async () => {
          replies += 1;
          return { code: replies === 1 ? 999 : 0 };
        } },
      } },
    };
    const config: BridgeConfig = {
      larkAppId: 'cli_0123456789abcdef', larkAppSecret: 'secret', larkTenantKey: 'tenant',
      allowedChats: ['chat'], authorizedUsers: ['user'], allowedApprovers: ['approver'],
      appServerMode: 'owned_stdio', appServerSocketPath: null, codexBin: '/codex', codexCwd: workspace,
      allowedWorkspaceRoots: [workspace], maxTextLength: 10_000, cardUpdateIntervalMs: 1_000,
      maxQueuedTasks: 10, rateLimitQueryIntervalMs: 300_000, logToFile: false, logFilePath: null,
      enableAutoFileUpload: true,
    };

    await new OutputFileUploader(config, api).uploadMarkdownFiles(
      `[first](${first})\n[again](${first})\n[second](${second})`,
      'root-message',
      'task-id',
    );

    assert.deepEqual(uploads, ['first', 'second']);
    assert.equal(replies, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
