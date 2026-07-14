import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';

import {
  AppServerClient,
  AppServerNotReadyError,
  type AppServerChildProcess,
  type AppServerClientEvent,
  type AppServerSpawn,
} from '../../src/app/codex/app-server-client';

type WireMessage = Record<string, unknown>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: WireMessage[] = [];
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  readonly stdin: Writable;
  killed = false;
  killResult = true;
  exitOnSignals = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);
  private exited = false;
  private closed = false;
  private readonly onMessage?: (message: WireMessage, child: FakeChild) => void;
  private nextWriteError?: Error;

  constructor(onMessage?: (message: WireMessage, child: FakeChild) => void) {
    super();
    this.onMessage = onMessage;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const writeError = this.nextWriteError;
        if (writeError) {
          this.nextWriteError = undefined;
          callback(writeError);
          return;
        }
        const lines = chunk
          .toString()
          .split('\n')
          .filter((line: string) => line.length > 0);
        for (const line of lines) {
          const message = JSON.parse(line) as WireMessage;
          this.messages.push(message);
          this.onMessage?.(message, this);
        }
        callback();
      },
    });
  }

  send(message: WireMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  failNextWrite(error: Error): void {
    this.nextWriteError = error;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.emit('exit', code, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close', code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (typeof signal === 'string' && this.exitOnSignals.has(signal)) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return this.killResult;
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Parameters<AppServerSpawn>[2];
}

function createSpawn(children: FakeChild[], calls: SpawnCall[]): AppServerSpawn {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = children.shift();
    assert.ok(child, 'test did not provide a fake child for spawn');
    return child as unknown as AppServerChildProcess;
  };
}

function createAutoInitializeChild(): FakeChild {
  return new FakeChild((message, child) => {
    if (message.method !== 'initialize') {
      return;
    }
    child.send({
      id: message.id,
      result: {
        userAgent: 'codex-cli/0.142.4',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
  });
}

function createClient(
  children: FakeChild[],
  calls: SpawnCall[] = [],
  requestTimeoutMs = 100,
  maxLineBytes?: number,
  terminationGraceMs?: number,
): AppServerClient {
  return new AppServerClient({
    transport: {
      mode: 'owned_stdio',
      codexBin: '/opt/codex/bin/codex',
    },
    requestTimeoutMs,
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
    ...(terminationGraceMs === undefined ? {} : { terminationGraceMs }),
    spawnProcess: createSpawn(children, calls),
  });
}

test('performs initialize -> initialized before READY and rejects early business RPC', async () => {
  const child = new FakeChild();
  const spawnCalls: SpawnCall[] = [];
  const client = createClient([child], spawnCalls);

  const startPromise = client.start();
  assert.equal(client.state, 'INITIALIZING');
  await assert.rejects(
    client.request('thread/list', {}),
    (error: unknown) => error instanceof AppServerNotReadyError,
  );

  assert.equal(child.messages.length, 1);
  assert.deepEqual(child.messages[0], {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'lark_codex_gateway',
        title: 'Lark Codex Gateway',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  });

  child.send({
    id: 1,
    result: {
      userAgent: 'codex-cli/0.142.4',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });
  const initializeResult = await startPromise;

  assert.equal(initializeResult.userAgent, 'codex-cli/0.142.4');
  assert.equal(client.state, 'READY');
  assert.deepEqual(child.messages[1], { method: 'initialized' });
  const spawnCall = spawnCalls[0];
  assert.ok(spawnCall);
  assert.deepEqual(spawnCall.args, ['app-server', '--stdio']);
  assert.equal(spawnCall.command, '/opt/codex/bin/codex');
  assert.equal(spawnCall.options.shell, false);
  await client.stop();
});

test('builds managed proxy command without a shell', async () => {
  const child = createAutoInitializeChild();
  const spawnCalls: SpawnCall[] = [];
  const client = new AppServerClient({
    transport: {
      mode: 'managed_proxy',
      codexBin: '/opt/codex/bin/codex',
      socketPath: '/tmp/codex-app-server.sock',
      proxyArgs: ['--enable', 'example-feature'],
    },
    spawnProcess: createSpawn([child], spawnCalls),
  });

  await client.start();

  const spawnCall = spawnCalls[0];
  assert.ok(spawnCall);
  assert.deepEqual(spawnCall.args, [
    'app-server',
    'proxy',
    '--sock',
    '/tmp/codex-app-server.sock',
    '--enable',
    'example-feature',
  ]);
  assert.equal(spawnCall.options.shell, false);
  await client.stop();
});

test('rejects an App Server runtime outside the pinned protocol version', async () => {
  const child = new FakeChild((message, activeChild) => {
    if (message.method === 'initialize') {
      activeChild.send({
        id: message.id,
        result: {
          userAgent: 'Codex Desktop/0.143.0',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    }
  });
  const client = new AppServerClient({
    transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
    expectedServerVersion: '0.142.4',
    spawnProcess: createSpawn([child], []),
  });

  await assert.rejects(client.start(), /runtime version is unsupported/);
  assert.equal(client.state, 'FAILED');
  assert.equal(child.killed, true);
});

test('accepts an exact stable App Server runtime version', async () => {
  const child = createAutoInitializeChild();
  const client = new AppServerClient({
    transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
    expectedServerVersion: '0.142.4',
    spawnProcess: createSpawn([child], []),
  });

  const result = await client.start();

  assert.equal(result.userAgent, 'codex-cli/0.142.4');
  assert.equal(client.state, 'READY');
  await client.stop();
});

test('accepts the exact structured Codex Desktop runtime user agent', async () => {
  const child = new FakeChild((message, activeChild) => {
    if (message.method === 'initialize') {
      activeChild.send({
        id: message.id,
        result: {
          userAgent: 'Codex Desktop/0.142.4 (Mac OS 15.6.1; arm64) dumb (bridge; 2.0.0)',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    }
  });
  const client = new AppServerClient({
    transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
    expectedServerVersion: '0.142.4',
    spawnProcess: createSpawn([child], []),
  });

  await client.start();
  assert.equal(client.state, 'READY');
  await client.stop();
});

test('accepts the structured runtime user agent emitted for this client name', async () => {
  const child = new FakeChild((message, activeChild) => {
    if (message.method === 'initialize') {
      activeChild.send({
        id: message.id,
        result: {
          userAgent: 'lark_codex_gateway/0.142.4 (Mac OS 15.6.1; arm64) '
            + 'dumb (lark_codex_gateway; 0.1.0)',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    }
  });
  const client = new AppServerClient({
    transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
    expectedServerVersion: '0.142.4',
    spawnProcess: createSpawn([child], []),
  });

  await client.start();
  assert.equal(client.state, 'READY');
  await client.stop();
});

test('removes Bridge secrets from the App Server child environment', async () => {
  const child = createAutoInitializeChild();
  const spawnCalls: SpawnCall[] = [];
  const client = new AppServerClient({
    transport: {
      mode: 'owned_stdio',
      codexBin: '/opt/codex/bin/codex',
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/tester',
        LARK_APP_SECRET: 'must-not-cross-boundary',
        AWS_SECRET_ACCESS_KEY: 'must-not-cross-boundary',
      },
    },
    spawnProcess: createSpawn([child], spawnCalls),
  });

  await client.start();
  assert.deepEqual(spawnCalls[0]?.options.env, {
    PATH: '/usr/bin',
    HOME: '/Users/tester',
  });
  await client.stop();
});

for (const userAgent of [
  'codex-cli/0.142.40',
  'codex-cli/0.142.4-beta',
  'prefix codex-cli/0.142.4',
  'prefix codex-cli/0.142.4 suffix',
]) {
  test(`rejects non-exact App Server user agent ${userAgent}`, async () => {
    const child = new FakeChild((message, activeChild) => {
      if (message.method !== 'initialize') {
        return;
      }
      activeChild.send({
        id: message.id,
        result: {
          userAgent,
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
    });
    const client = new AppServerClient({
      transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
      expectedServerVersion: '0.142.4',
      spawnProcess: createSpawn([child], []),
    });

    await assert.rejects(client.start(), /runtime version is unsupported/);
    assert.equal(client.state, 'FAILED');
    assert.equal(child.killed, true);
  });
}

test('strictly routes response, server request, and notification', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  const notifications: WireMessage[] = [];
  const serverRequests: Array<{ message: WireMessage; epoch: number }> = [];
  client.onNotification((notification) => notifications.push(notification as WireMessage));
  client.onServerRequest((request, epoch) => {
    serverRequests.push({ message: request as WireMessage, epoch });
  });
  await client.start();

  const rpcPromise = client.request<{ data: string[] }>('thread/list', { limit: 10 });
  const rpcMessage = child.messages.at(-1);
  assert.ok(rpcMessage);
  const approvalRequest = {
    id: 'approval-request-1',
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      startedAtMs: 1,
      reason: 'write file',
    },
  };
  child.send(approvalRequest);
  child.send({
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-2',
      delta: 'hello',
    },
  });

  assert.equal(serverRequests.length, 1);
  const serverRequest = serverRequests[0];
  assert.ok(serverRequest);
  assert.deepEqual(serverRequest.message, approvalRequest);
  assert.equal(notifications.length, 1);

  let rpcSettled = false;
  rpcPromise.finally(() => {
    rpcSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rpcSettled, false, 'server request must not settle a client RPC');

  child.send({ id: rpcMessage.id, result: { data: ['thread-1'] } });
  assert.deepEqual(await rpcPromise, { data: ['thread-1'] });

  await client.respond(
    'approval-request-1',
    { decision: 'accept' },
    serverRequest.epoch,
  );
  assert.deepEqual(child.messages.at(-1), {
    id: 'approval-request-1',
    result: { decision: 'accept' },
  });
  await client.stop();
});

test('preserves UTF-8 notifications split across stdout chunks', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  const notifications: WireMessage[] = [];
  client.onNotification((notification) => notifications.push(notification as WireMessage));
  await client.start();

  const notification = {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      delta: '中文结果',
    },
  };
  const encoded = Buffer.from(`${JSON.stringify(notification)}\n`, 'utf8');
  const characterOffset = encoded.indexOf(Buffer.from('中', 'utf8'));
  assert.ok(characterOffset >= 0);
  child.stdout.write(encoded.subarray(0, characterOffset + 1));
  child.stdout.write(encoded.subarray(characterOffset + 1, characterOffset + 2));
  child.stdout.write(encoded.subarray(characterOffset + 2));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(notifications, [notification]);
  await client.stop();
});

test('tracks the real request id and epoch synchronously before transport write', async () => {
  const order: string[] = [];
  const child = new FakeChild((message, activeChild) => {
    if (message.method === 'initialize') {
      activeChild.send({
        id: message.id,
        result: {
          userAgent: 'codex-cli/0.142.4',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      });
      return;
    }
    if (message.method === 'turn/start') {
      order.push('transport');
      activeChild.send({ id: message.id, result: { accepted: true } });
    }
  });
  const client = createClient([child]);
  await client.start();

  let trackedIdentity: { id: string | number; epoch: number } | undefined;
  const requestPromise = client.requestTracked<{ accepted: boolean }>(
    'turn/start',
    { threadId: 'thread-1' },
    (identity) => {
      trackedIdentity = identity;
      order.push('beforeSend');
    },
  );

  assert.deepEqual(order, ['beforeSend', 'transport']);
  assert.ok(trackedIdentity);
  const wireRequest = child.messages.at(-1);
  assert.ok(wireRequest);
  assert.equal(trackedIdentity.id, wireRequest.id);
  assert.equal(trackedIdentity.epoch, client.connectionEpoch);
  assert.deepEqual(await requestPromise, { accepted: true });
  await client.stop();
});

test('does not write a tracked request when beforeSend throws', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  await client.start();
  const messageCountBeforeRequest = child.messages.length;
  const persistenceError = new Error('durable intent write failed');

  const requestPromise = client.requestTracked(
    'turn/start',
    { threadId: 'thread-1' },
    () => {
      throw persistenceError;
    },
  );

  assert.equal(child.messages.length, messageCountBeforeRequest);
  await assert.rejects(requestPromise, (error: unknown) => error === persistenceError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(child.messages.length, messageCountBeforeRequest);
  await client.stop();
});

test('times out a pending request and treats a late response as unknown', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child], [], 15);
  const events: AppServerClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  await client.start();

  const requestPromise = client.request('thread/list', {});
  const requestId = child.messages.at(-1)?.id;
  await assert.rejects(requestPromise, /App Server RPC timeout: thread\/list/);

  child.send({ id: requestId, result: { data: [] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(
    events.some(
      (event) =>
        event.type === 'protocolError' &&
        event.diagnostic.reason === 'unknown_response',
    ),
  );
  assert.equal(client.state, 'READY');
  assert.equal(child.killed, false);
  await client.stop();
});

interface FatalProtocolCase {
  readonly reason: 'invalid_json' | 'invalid_envelope' | 'invalid_response' | 'line_too_large';
  readonly maxLineBytes?: number;
  trigger(child: FakeChild, requestId: unknown): void;
}

const fatalProtocolCases: readonly FatalProtocolCase[] = [
  {
    reason: 'invalid_json',
    trigger: (child) => child.stdout.write('{not-json}\n'),
  },
  {
    reason: 'invalid_envelope',
    trigger: (child) => child.stdout.write('{}\n'),
  },
  {
    reason: 'invalid_response',
    trigger: (child, requestId) => child.send({
      id: requestId,
      result: { data: [] },
      error: { code: -32603, message: 'invalid response' },
    }),
  },
  {
    reason: 'line_too_large',
    maxLineBytes: 512,
    trigger: (child) => child.stdout.write(`${'x'.repeat(513)}\n`),
  },
];

for (const protocolCase of fatalProtocolCases) {
  test(`fails the connection after ${protocolCase.reason}`, async () => {
    const child = createAutoInitializeChild();
    const client = createClient(
      [child],
      [],
      100,
      protocolCase.maxLineBytes,
    );
    const events: AppServerClientEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.start();

    const requestPromise = client.request('thread/list', {});
    const requestId = child.messages.at(-1)?.id;
    protocolCase.trigger(child, requestId);

    await assert.rejects(
      requestPromise,
      new RegExp(`App Server protocol error: ${protocolCase.reason}`),
    );
    assert.equal(client.state, 'FAILED');
    assert.equal(child.killed, true);
    const diagnosticIndex = events.findIndex(
      (event) => event.type === 'protocolError'
        && event.diagnostic.reason === protocolCase.reason,
    );
    const failedIndex = events.findIndex(
      (event) => event.type === 'state' && event.state === 'FAILED',
    );
    assert.ok(diagnosticIndex >= 0, 'fatal error must publish a protocol diagnostic');
    assert.ok(failedIndex > diagnosticIndex, 'diagnostic must be published before FAILED');
  });
}

test('rejects pending requests when the child exits', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  await client.start();

  const requestPromise = client.request('thread/read', { threadId: 'thread-1' });
  child.exit(17);

  await assert.rejects(requestPromise, /App Server exited \(code=17, signal=null\)/);
  assert.equal(client.state, 'FAILED');
});

test('fails one epoch and rejects every pending request after a stdin write error', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  const events: AppServerClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  await client.start();

  const firstRequest = client.request('thread/read', { threadId: 'thread-1' });
  child.failNextWrite(new Error('write EPIPE'));
  const secondRequest = client.request('thread/list', {});
  const results = await Promise.allSettled([firstRequest, secondRequest]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.match(String(result.reason), /Failed to write to App Server: write EPIPE/);
    }
  }
  assert.equal(client.state, 'FAILED');
  assert.equal(child.killed, true);
  assert.equal(
    events.filter((event) => event.type === 'state' && event.state === 'FAILED').length,
    1,
  );
});

test('handles emitted stdin errors and rejects every pending request without duplicate failure', async () => {
  const child = createAutoInitializeChild();
  const client = createClient([child]);
  const events: AppServerClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  await client.start();

  const firstRequest = client.request('thread/read', { threadId: 'thread-1' });
  const secondRequest = client.request('thread/list', {});
  const stdinError = new Error('stdin exploded');
  assert.doesNotThrow(() => child.stdin.emit('error', stdinError));
  assert.doesNotThrow(() => child.stdin.emit('error', stdinError));
  const results = await Promise.allSettled([firstRequest, secondRequest]);

  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.match(String(result.reason), /App Server stdin failed: stdin exploded/);
    }
  }
  assert.equal(client.state, 'FAILED');
  assert.equal(child.killed, true);
  assert.equal(
    events.filter((event) => event.type === 'state' && event.state === 'FAILED').length,
    1,
  );
});

test('waits for child exit and escalates stop to SIGKILL after the grace period', async () => {
  const child = createAutoInitializeChild();
  child.exitOnSignals = new Set<NodeJS.Signals>(['SIGKILL']);
  const client = createClient([child], [], 100, undefined, 10);
  await client.start();

  let stopped = false;
  const stopPromise = client.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopped, false);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  await stopPromise;
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
});

test('does not spawn a replacement until the failed child has exited', async () => {
  const firstChild = createAutoInitializeChild();
  firstChild.exitOnSignals = new Set<NodeJS.Signals>(['SIGKILL']);
  const secondChild = createAutoInitializeChild();
  const spawnCalls: SpawnCall[] = [];
  const client = createClient(
    [firstChild, secondChild],
    spawnCalls,
    100,
    undefined,
    10,
  );
  await client.start();

  firstChild.stdin.emit('error', new Error('connection failed'));
  const restartPromise = client.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(firstChild.killSignals, ['SIGTERM']);
  await restartPromise;
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(firstChild.killSignals, ['SIGTERM', 'SIGKILL']);
  await client.stop();
});

test('cancels a replacement waiting on child termination when stop begins', async () => {
  const firstChild = createAutoInitializeChild();
  firstChild.exitOnSignals = new Set<NodeJS.Signals>(['SIGKILL']);
  const secondChild = createAutoInitializeChild();
  const spawnCalls: SpawnCall[] = [];
  const client = createClient(
    [firstChild, secondChild],
    spawnCalls,
    100,
    undefined,
    10,
  );
  await client.start();

  firstChild.stdin.emit('error', new Error('connection failed'));
  const restartPromise = client.start();
  const stopPromise = client.stop();

  await assert.rejects(restartPromise, /start was cancelled/);
  await stopPromise;
  assert.equal(spawnCalls.length, 1);
  assert.equal(client.state, 'CLOSED');
});

test('accepts close as the termination boundary after an asynchronous child error', async () => {
  const child = createAutoInitializeChild();
  child.exitOnSignals.clear();
  const client = createClient([child], [], 100, undefined, 50);
  await client.start();

  child.emit('error', new Error('child transport failed'));
  const stopPromise = client.stop();
  child.close(null, 'SIGTERM');

  await stopPromise;
  assert.equal(client.state, 'CLOSED');
});

test('fails within a bounded interval when SIGKILL produces no termination event', {
  timeout: 500,
}, async () => {
  const child = createAutoInitializeChild();
  const replacement = createAutoInitializeChild();
  const spawnCalls: SpawnCall[] = [];
  child.exitOnSignals.clear();
  const client = createClient([child, replacement], spawnCalls, 100, undefined, 10);
  await client.start();

  await assert.rejects(client.stop(), /did not terminate after SIGKILL/);
  await assert.rejects(client.start(), /did not terminate after SIGKILL/);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(spawnCalls.length, 1);
});

test('fails within a bounded interval when child kill reports false', {
  timeout: 500,
}, async () => {
  const child = createAutoInitializeChild();
  child.exitOnSignals.clear();
  child.killResult = false;
  const client = createClient([child], [], 100, undefined, 10);
  await client.start();

  await assert.rejects(client.stop(), /did not terminate after SIGKILL/);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
});

test('consumes bounded termination rejection from an asynchronous failure callback', {
  timeout: 500,
}, async () => {
  const child = createAutoInitializeChild();
  child.exitOnSignals.clear();
  const client = createClient([child], [], 100, undefined, 10);
  const unhandledReasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledReasons.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    await client.start();
    child.emit('error', new Error('child transport failed'));
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(client.state, 'FAILED');
    assert.deepEqual(unhandledReasons, []);
    await assert.rejects(client.stop(), /did not terminate after SIGKILL/);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('ignores stdout and exit events from an earlier connection epoch', async () => {
  const firstChild = createAutoInitializeChild();
  const secondChild = createAutoInitializeChild();
  const client = createClient([firstChild, secondChild]);
  const notifications: WireMessage[] = [];
  client.onNotification((notification) => notifications.push(notification as WireMessage));

  await client.start();
  const firstEpoch = client.connectionEpoch;
  await client.stop();
  await client.start();
  assert.ok(client.connectionEpoch > firstEpoch);

  firstChild.send({ method: 'turn/started', params: { threadId: 'stale' } });
  firstChild.exit(9);
  secondChild.send({ method: 'turn/started', params: { threadId: 'current' } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(client.state, 'READY');
  assert.deepEqual(notifications, [
    { method: 'turn/started', params: { threadId: 'current' } },
  ]);
  await client.stop();
});
