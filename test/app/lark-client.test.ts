import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeConfig } from '../../src/app/domain';
import {
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
