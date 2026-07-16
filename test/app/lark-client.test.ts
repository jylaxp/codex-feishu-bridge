import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLarkRuntimeClients,
  createRedactedLarkSdkLogger,
  LarkSdkLogLevel,
} from '../../src/app/lark/client';
import { BridgeConfig } from '../../src/app/domain';

const SECRET = 'lark-app-secret-must-not-leak';
const TOKEN = 'tenant-access-token-must-not-leak';

function bridgeConfig(): BridgeConfig {
  return Object.freeze({
    larkAppId: 'cli_test',
    larkAppSecret: SECRET,
    larkTenantKey: 'tenant-test',
    allowedChats: Object.freeze(['oc_chat']),
    authorizedUsers: Object.freeze(['ou_user']),
    allowedApprovers: Object.freeze(['ou_approver']),
    appServerMode: 'owned_stdio',
    appServerSocketPath: null,
    codexBin: '/usr/bin/codex',
    codexCwd: '/workspace',
    maxTextLength: 10_000,
    cardUpdateIntervalMs: 1_500,
  maxQueuedTasks: 100,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
});
}

test('redacted SDK logger emits severity only and never forwards raw arguments', () => {
  const events: LarkSdkLogLevel[] = [];
  const logger = createRedactedLarkSdkLogger((level) => events.push(level));
  const sensitiveError = {
    config: {
      data: { app_secret: SECRET },
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  };

  logger.error(sensitiveError, SECRET, TOKEN);
  logger.warn(sensitiveError, SECRET, TOKEN);
  logger.info(sensitiveError, SECRET, TOKEN);
  logger.debug(sensitiveError, SECRET, TOKEN);
  logger.trace(sensitiveError, SECRET, TOKEN);

  assert.deepEqual(events, ['error', 'warn']);
  const serializedEvents = JSON.stringify(events);
  assert.doesNotMatch(serializedEvents, new RegExp(SECRET));
  assert.doesNotMatch(serializedEvents, new RegExp(TOKEN));
});

test('runtime clients use redacted logging and wait for WebSocket readiness', async () => {
  const events: LarkSdkLogLevel[] = [];
  let apiLogger: { error(...messages: unknown[]): void } | undefined;
  let websocketLogger: { error(...messages: unknown[]): void } | undefined;
  const fakeApi = Object.freeze({});
  let signalReady = (): void => undefined;
  const fakeWebsocket = Object.freeze({
    start: async (): Promise<void> => {
      queueMicrotask(signalReady);
    },
    close: (): void => undefined,
  });
  const clients = createLarkRuntimeClients(
    bridgeConfig(),
    {
      logSink: (level) => events.push(level),
      factories: {
        createClient: (options) => {
          apiLogger = options.logger;
          return fakeApi as never;
        },
        createWebsocketClient: (options) => {
          websocketLogger = options.logger;
          signalReady = () => options.onReady?.();
          return fakeWebsocket as never;
        },
      },
    },
  );
  const sensitiveError = {
    config: {
      data: { app_secret: SECRET },
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  };

  assert.strictEqual(clients.api, fakeApi);
  assert.notStrictEqual(clients.websocket, fakeWebsocket);
  assert.ok(apiLogger);
  assert.ok(websocketLogger);
  apiLogger.error(sensitiveError);
  websocketLogger.error(sensitiveError);
  await clients.websocket.start({ eventDispatcher: {} as never });

  assert.deepEqual(events, ['error', 'error']);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(TOKEN));
});

test('WebSocket startup errors are generic and force-close the raw SDK client', async () => {
  let signalFailure = (): void => undefined;
  let forceClosed = false;
  const clients = createLarkRuntimeClients(
    bridgeConfig(),
    {
      factories: {
        createClient: () => Object.freeze({}) as never,
        createWebsocketClient: (options) => {
          signalFailure = () => options.onError?.(new Error(`${SECRET} ${TOKEN}`));
          return {
            start: async () => { queueMicrotask(signalFailure); },
            close: (params?: { readonly force?: boolean }) => {
              forceClosed = params?.force === true;
            },
          } as never;
        },
      },
      websocketReadyTimeoutMs: 100,
    },
  );

  await assert.rejects(
    clients.websocket.start({ eventDispatcher: {} as never }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );
  assert.equal(forceClosed, true);
});

test('reports a generic terminal WebSocket error after initial readiness exactly once', async () => {
  let signalReady = (): void => undefined;
  let signalFailure = (): void => undefined;
  const terminalErrors: Error[] = [];
  const clients = createLarkRuntimeClients(bridgeConfig(), {
    factories: {
      createClient: () => Object.freeze({}) as never,
      createWebsocketClient: (options) => {
        signalReady = () => options.onReady?.();
        signalFailure = () => options.onError?.(new Error(`${SECRET} ${TOKEN}`));
        return {
          start: async () => { queueMicrotask(signalReady); },
          close: (): void => undefined,
        } as never;
      },
    },
    websocketReadyTimeoutMs: 100,
    onTerminalWebsocketError: (error) => terminalErrors.push(error),
  });

  await clients.websocket.start({ eventDispatcher: {} as never });
  signalFailure();
  signalFailure();

  assert.equal(terminalErrors.length, 1);
  assert.equal(terminalErrors[0]?.name, 'LarkWebsocketTerminalError');
  assert.doesNotMatch(terminalErrors[0]?.message ?? '', new RegExp(SECRET));
  assert.doesNotMatch(terminalErrors[0]?.message ?? '', new RegExp(TOKEN));
});
