import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BridgeConfig } from '../../src/app/domain';
import { BridgeLogger } from '../../src/app/logger';
import {
  createRedactedLarkSdkLogger,
  createLarkRuntimeClients,
  type LarkRuntimeClientFactories,
  type LarkWebsocketConnectionSnapshot,
} from '../../src/app/lark/client';

const config = {
  larkAppId: 'cli_test',
  larkAppSecret: 'secret',
} as BridgeConfig;

test('Lark WebSocket exposes reconnecting and recovered connection states', async () => {
  let websocketOptions: Parameters<LarkRuntimeClientFactories['createWebsocketClient']>[0]
    | undefined;
  const snapshots: LarkWebsocketConnectionSnapshot[] = [];
  const factories: LarkRuntimeClientFactories = {
    createClient: () => ({}) as never,
    createWebsocketClient: (options) => {
      websocketOptions = options;
      return {
        start: async () => {
          options.onReady?.();
        },
        close: () => undefined,
      } as never;
    },
  };
  const clients = createLarkRuntimeClients(config, {
    factories,
    onWebsocketStateChanged: (snapshot) => snapshots.push(snapshot),
  });

  await clients.websocket.start({} as never);
  assert.equal(clients.websocket.connectionSnapshot().state, 'ready');

  websocketOptions?.onReconnecting?.();
  assert.deepEqual(clients.websocket.connectionSnapshot(), {
    state: 'reconnecting',
    reconnectCount: 1,
    connectedAtMs: null,
  });

  websocketOptions?.onReconnected?.();
  assert.equal(clients.websocket.connectionSnapshot().state, 'ready');
  assert.equal(clients.websocket.connectionSnapshot().reconnectCount, 1);
  assert.ok(clients.websocket.connectionSnapshot().connectedAtMs !== null);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.state), [
    'connecting',
    'ready',
    'reconnecting',
    'ready',
  ]);
});

test('Lark WebSocket reports only an exhausted SDK connection as terminal', async () => {
  let websocketOptions: Parameters<LarkRuntimeClientFactories['createWebsocketClient']>[0]
    | undefined;
  const terminalErrors: Error[] = [];
  const factories: LarkRuntimeClientFactories = {
    createClient: () => ({}) as never,
    createWebsocketClient: (options) => {
      websocketOptions = options;
      return {
        start: async () => options.onReady?.(),
        close: () => undefined,
      } as never;
    },
  };
  const clients = createLarkRuntimeClients(config, {
    factories,
    onTerminalWebsocketError: (error) => terminalErrors.push(error),
  });

  await clients.websocket.start({} as never);
  websocketOptions?.onReconnecting?.();
  assert.equal(terminalErrors.length, 0);

  websocketOptions?.onError?.(new Error('reconnect exhausted'));
  assert.equal(clients.websocket.connectionSnapshot().state, 'terminal');
  assert.equal(terminalErrors.length, 1);
});

test('Lark SDK logs obey the Bridge switch and discard all third-party payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-lark-sdk-log-'));
  const output: string[] = [];
  try {
    const logger = new BridgeLogger({ write: (value) => output.push(String(value)) });
    const sdkLogger = createRedactedLarkSdkLogger((level) => {
      logger.warn(`lark_sdk_${level}`, { source: 'lark_sdk' });
    });

    logger.configure({ configHome: root, logToFile: false, logFilePath: 'bridge.log' });
    sdkLogger.warn('Authorization: Bearer disabled-secret');
    assert.deepEqual(output, []);

    logger.configure({ configHome: root, logToFile: true, logFilePath: 'bridge.log' });
    sdkLogger.error({ token: 'enabled-secret' }, 'request payload');

    const contents = readFileSync(join(root, 'logs', 'bridge.log'), 'utf8');
    assert.match(contents, /"event":"lark_sdk_error"/);
    assert.doesNotMatch(contents, /disabled-secret|enabled-secret|Authorization|request payload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
