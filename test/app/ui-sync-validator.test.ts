import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AppServerClientOptions } from '../../src/app/codex/app-server-client';
import {
  APP_SERVER_PROTOCOL_PROFILE_0_144_3,
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
} from '../../src/app/codex/app-server-protocol-registry';
import type { ServerNotification, Thread } from '../../src/app/codex/protocol';
import {
  createUiSyncThreadCandidate,
  runUiSyncValidator,
  type UiSyncAppServerClient,
} from '../../src/app/ui-sync-validator';

test('UI validator detects once and binds the selected profile to client and control plane', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-ui-sync-profile-'));
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const codex = join(root, 'codex');
  mkdirSync(workspace);
  mkdirSync(configHome);
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let detectionCount = 0;
  let clientOptions: AppServerClientOptions | undefined;
  const client = new FakeUiSyncClient();
  try {
    const result = await runUiSyncValidator({
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      CODEX_BIN: codex,
      CODEX_CWD: workspace,
      BRIDGE_CONFIG_HOME: configHome,
      APP_SERVER_MODE: 'managed_proxy',
    }, undefined, 1_000, {
      verifyRuntimeContract: async () => {
        detectionCount += 1;
        return {
          codexVersion: 'codex-cli 0.145.0-alpha.18',
          schemaDigest: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18.schemaDigest,
          protocolProfile: APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
        };
      },
      createClient: (options) => {
        clientOptions = options;
        return client;
      },
    });

    assert.equal(detectionCount, 1);
    assert.equal(clientOptions?.protocolProfile, APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18);
    assert.equal(clientOptions?.transport.mode, 'managed_proxy');
    assert.deepEqual(client.calls.map((call) => call.method), ['thread/list']);
    assert.equal(client.started, true);
    assert.equal(client.stopped, true);
    assert.deepEqual(result, {
      mode: 'thread_list',
      threads: [{ threadId: 'thread-1', status: 'idle', updatedAt: 1_752_444_800 }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('144 UI validator maps turn/start while preserving the resumed thread path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-ui-sync-144-'));
  const workspace = join(root, 'workspace');
  const configHome = join(root, 'config');
  const codex = join(root, 'codex');
  mkdirSync(workspace);
  mkdirSync(configHome);
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const client = new ValidationUiSyncClient();
  try {
    const result = await runUiSyncValidator({
      LARK_APP_ID: 'cli_0123456789abcdef',
      LARK_APP_SECRET: 'secret',
      CODEX_BIN: codex,
      CODEX_CWD: workspace,
      BRIDGE_CONFIG_HOME: configHome,
      APP_SERVER_MODE: 'managed_proxy',
    }, 'thread-144', 1_000, {
      verifyRuntimeContract: async () => ({
        codexVersion: 'codex-cli 0.144.3',
        schemaDigest: APP_SERVER_PROTOCOL_PROFILE_0_144_3.schemaDigest,
        protocolProfile: APP_SERVER_PROTOCOL_PROFILE_0_144_3,
      }),
      createClient: () => client,
    });

    assert.equal(result.mode, 'validation');
    assert.deepEqual(client.calls.map((call) => call.method), ['thread/resume', 'turn/start']);
    const resumeParams = client.calls[0]?.params as Record<string, unknown>;
    const turnParams = client.calls[1]?.params as Record<string, unknown>;
    assert.equal(resumeParams.threadId, 'thread-144');
    assert.deepEqual(resumeParams.runtimeWorkspaceRoots, [realpathSync(workspace)]);
    assert.equal(turnParams.threadId, 'thread-144');
    assert.equal(Object.hasOwn(turnParams, 'runtimeWorkspaceRoots'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('thread list output fails closed when updatedAt is absent', () => {
  const thread = { id: 'thread-1', status: { type: 'idle' } } as Thread;

  assert.throws(
    () => createUiSyncThreadCandidate(thread),
    /invalid updatedAt value/,
  );
});

class FakeUiSyncClient implements UiSyncAppServerClient {
  readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  started = false;
  stopped = false;

  async start(): Promise<unknown> {
    this.started = true;
    return {};
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    if (method !== 'thread/list') {
      throw new Error('Unexpected method');
    }
    return {
      data: [{
        id: 'thread-1',
        preview: 'secret preview',
        cwd: '/private/workspace',
        updatedAt: 1_752_444_800,
        status: { type: 'idle' },
        name: 'secret name',
      }],
    } as TResult;
  }

  onNotification(
    _listener: (notification: ServerNotification, epoch: number) => void,
  ): () => void {
    return () => undefined;
  }
}

class ValidationUiSyncClient implements UiSyncAppServerClient {
  readonly calls: Array<{ readonly method: string; readonly params: unknown }> = [];
  private readonly listeners = new Set<(
    notification: ServerNotification,
    epoch: number,
  ) => void>();

  async start(): Promise<unknown> {
    return {};
  }

  async stop(): Promise<void> {}

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.calls.push({ method, params });
    if (method === 'thread/resume') {
      return {
        thread: { id: 'thread-144', turns: [] },
        model: 'gpt-test',
      } as TResult;
    }
    if (method === 'turn/start') {
      const turn = { id: 'turn-144', items: [], status: 'inProgress' };
      for (const listener of this.listeners) {
        listener({ method: 'turn/started', params: { threadId: 'thread-144', turn } }, 1);
        listener({
          method: 'turn/completed',
          params: {
            threadId: 'thread-144',
            turn: { ...turn, status: 'completed' },
          },
        }, 1);
      }
      return { turn } as TResult;
    }
    throw new Error('Unexpected method');
  }

  onNotification(
    listener: (notification: ServerNotification, epoch: number) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
