import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  AppServerClient,
  AppServerRpcError,
  appServerIdentityAssurance,
  type AppServerChildProcess,
  type AppServerClientEvent,
  type AppServerSpawn,
} from '../../src/app/codex/app-server-client';
import {
  APP_SERVER_PROTOCOL_PROFILE_0_144_3,
  APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
  type AppServerProtocolProfile,
} from '../../src/app/codex/app-server-protocol-registry';

type WireMessage = Record<string, unknown>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: WireMessage[] = [];
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  readonly stdin: Writable;
  private exited = false;

  constructor(
    private readonly onMessage?: (message: WireMessage, child: FakeChild) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
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

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => this.exit(null, typeof signal === 'string' ? signal : null));
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

test('exact 145 prerelease Desktop identity is required before READY', async () => {
  const child = autoInitializeChild(
    'Codex Desktop/0.145.0-alpha.18 (Mac OS 15.6.1; arm64) '
      + 'dumb (lark_codex_gateway; 3.0.0)',
  );
  const client = createClient(child);

  const result = await client.start();

  assert.equal(result.userAgent.startsWith('Codex Desktop/0.145.0-alpha.18 '), true);
  assert.equal(client.state, 'READY');
  assert.deepEqual(child.messages.at(-1), { method: 'initialized' });
  await client.stop();
});

test('exact 144 identity is accepted only with the 144 profile', async () => {
  const child = autoInitializeChild(
    'lark_codex_gateway/0.144.3 (Mac OS 15.6.1; arm64) '
      + 'unknown (lark_codex_gateway; 3.0.0)',
  );
  const client = createClient(child, APP_SERVER_PROTOCOL_PROFILE_0_144_3);

  const result = await client.start();

  assert.equal(result.userAgent.includes('/0.144.3 '), true);
  assert.equal(client.state, 'READY');
  await client.stop();
});

test('daemon version mismatch is rejected and terminated before READY', async () => {
  const child = autoInitializeChild('Codex Desktop/0.144.3 (Mac OS 15.6.1; arm64)');
  const client = createClient(child);

  await assert.rejects(client.start(), /runtime version is unsupported/);

  assert.equal(client.state, 'FAILED');
  assert.equal(child.messages.some((message) => message.method === 'initialized'), false);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('RPC errors discard untrusted message and data', async () => {
  const secret = 'token=secret-value /Users/private/work\n\u001b[31mcontrol';
  const child = new FakeChild((message, activeChild) => {
    if (message.method === 'initialize') {
      sendInitialize(activeChild, message.id);
      return;
    }
    if (message.method === 'thread/list') {
      activeChild.send({
        id: message.id,
        error: { code: -32001, message: secret, data: { token: secret } },
      });
    }
  });
  const client = createClient(child);
  await client.start();

  await assert.rejects(
    client.request('thread/list', {}),
    (error: unknown) => {
      assert.equal(error instanceof AppServerRpcError, true);
      assert.equal((error as AppServerRpcError).code, -32001);
      assert.equal((error as AppServerRpcError).message, 'App Server RPC request failed');
      assert.equal(Object.hasOwn(error as object, 'data'), false);
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );
  await client.stop();
});

test('stderr events expose only a bounded content-free diagnostic', async () => {
  const child = autoInitializeChild();
  const client = createClient(child);
  const events: AppServerClientEvent[] = [];
  client.subscribe((event) => events.push(event));
  await client.start();

  const secret = `Bearer abc.def.ghi /Users/private/work\n\u001b[31m${'x'.repeat(32_000)}`;
  child.stderr.write(secret);
  const stderrEvent = events.find((event) => event.type === 'stderr');

  assert.ok(stderrEvent && stderrEvent.type === 'stderr');
  assert.equal(stderrEvent.text.includes('abc.def.ghi'), false);
  assert.equal(stderrEvent.text.includes('/Users/private'), false);
  assert.equal(stderrEvent.text.includes('\u001b'), false);
  assert.ok(Buffer.byteLength(stderrEvent.text, 'utf8') < 128);
  await client.stop();
});

test('managed proxy identity is explicit operator-trusted corroboration', () => {
  assert.equal(appServerIdentityAssurance('owned_stdio'), 'owned_binary_exact_profile');
  assert.equal(appServerIdentityAssurance('managed_proxy'), 'operator_trusted_managed_proxy');
});

function createClient(
  child: FakeChild,
  protocolProfile: AppServerProtocolProfile = APP_SERVER_PROTOCOL_PROFILE_0_145_0_ALPHA_18,
): AppServerClient {
  const spawnProcess: AppServerSpawn = () => child as unknown as AppServerChildProcess;
  return new AppServerClient({
    transport: { mode: 'owned_stdio', codexBin: '/opt/codex/bin/codex' },
    protocolProfile,
    requestTimeoutMs: 100,
    terminationGraceMs: 100,
    spawnProcess,
  });
}

function autoInitializeChild(
  userAgent = 'Codex Desktop/0.145.0-alpha.18 (Mac OS 15.6.1; arm64)',
): FakeChild {
  return new FakeChild((message, child) => {
    if (message.method === 'initialize') {
      sendInitialize(child, message.id, userAgent);
    }
  });
}

function sendInitialize(
  child: FakeChild,
  id: unknown,
  userAgent = 'Codex Desktop/0.145.0-alpha.18 (Mac OS 15.6.1; arm64)',
): void {
  child.send({
    id,
    result: {
      userAgent,
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });
}
