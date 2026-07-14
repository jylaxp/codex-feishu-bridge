import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DesktopIpcClient,
  DesktopIpcRequestError,
  desktopIpcSocketPath,
  type DesktopThreadStreamBroadcast,
} from '../../src/app/codex/desktop-ipc-client';
import type { Turn, TurnStartParams } from '../../src/app/codex/protocol';

type WireMessage = Readonly<Record<string, unknown>>;

const MAX_FRAME_BYTES = 256 * 1024 * 1024;

function encodeFrame(message: WireMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

class FrameReader {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer): WireMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: WireMessage[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      assert.ok(length > 0 && length <= MAX_FRAME_BYTES);
      if (this.buffer.length < 4 + length) {
        break;
      }
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

interface MockServer {
  readonly root: string;
  readonly socketPath: string;
  readonly server: Server;
  readonly messages: WireMessage[];
  close(): Promise<void>;
}

async function createMockServer(
  onMessage: (message: WireMessage, socket: Socket) => void,
): Promise<MockServer> {
  const root = mkdtempSync(join(tmpdir(), 'desktop-ipc-client-'));
  const socketPath = join(root, 'ipc-501.sock');
  const messages: WireMessage[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const reader = new FrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) {
        messages.push(message);
        onMessage(message, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    root,
    socketPath,
    server,
    messages,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function turnStartParams(): TurnStartParams {
  return {
    threadId: 'thread-bound',
    clientUserMessageId: 'inbox-stable-id',
    input: [{ type: 'text', text: '你好 Desktop', text_elements: [] }],
    cwd: '/workspace/project',
    runtimeWorkspaceRoots: ['/workspace/project'],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/workspace/project'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

test('uses the uid-scoped codex-ipc socket and never an Electron SingletonSocket', () => {
  assert.equal(
    desktopIpcSocketPath('/private/tmp/example', 501),
    '/private/tmp/example/codex-ipc/ipc-501.sock',
  );
  assert.equal(
    desktopIpcSocketPath('/private/tmp/example', 0),
    '/private/tmp/example/codex-ipc/ipc.sock',
  );
});

test('initializes, starts a follower turn, and preserves an interleaved stream broadcast', async () => {
  const broadcast: DesktopThreadStreamBroadcast = {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: 11,
    params: {
      conversationId: 'thread-bound',
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [{ id: 'turn-desktop', status: 'inProgress', items: [] }],
        },
      },
    },
  };
  const mock = await createMockServer((message, socket) => {
    if (message.method === 'initialize') {
      const response = encodeFrame({
        type: 'response',
        requestId: message.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'bridge-client' },
      });
      socket.write(response.subarray(0, 2));
      socket.write(response.subarray(2, 7));
      socket.write(response.subarray(7));
      return;
    }
    if (message.method === 'thread-follower-start-turn') {
      socket.write(Buffer.concat([
        encodeFrame(broadcast),
        encodeFrame({
          type: 'response',
          requestId: message.requestId,
          method: 'thread-follower-start-turn',
          resultType: 'success',
          handledByClientId: 'desktop-owner',
          result: {
            result: {
              turn: {
                id: 'turn-desktop',
                items: [],
                itemsView: 'notLoaded',
                status: 'inProgress',
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          },
        }),
      ]));
    }
  });
  const client = new DesktopIpcClient({ socketPath: mock.socketPath });
  const broadcasts: DesktopThreadStreamBroadcast[] = [];
  const unsubscribe = client.onThreadStreamStateChanged((message) => broadcasts.push(message));

  try {
    const handshake = await client.start();
    assert.equal(handshake.clientId, 'bridge-client');
    const response = await client.requestTracked<{ readonly turn: Turn }>(
      'turn/start',
      turnStartParams(),
      () => undefined,
    );

    assert.equal(response.turn.id, 'turn-desktop');
    assert.deepEqual(broadcasts, [broadcast]);
    assert.equal(mock.messages.length, 2);
    assert.deepEqual(mock.messages[0], {
      type: 'request',
      requestId: mock.messages[0]?.requestId,
      method: 'initialize',
      params: { clientType: 'vscode' },
    });
    assert.deepEqual(mock.messages[1], {
      type: 'request',
      requestId: mock.messages[1]?.requestId,
      sourceClientId: 'bridge-client',
      version: 1,
      method: 'thread-follower-start-turn',
      params: {
        conversationId: 'thread-bound',
        turnStartParams: turnStartParams(),
      },
      timeoutMs: 30_000,
    });
  } finally {
    unsubscribe();
    await client.stop();
    await mock.close();
  }
});

test('returns an approval decision to the same follower owner runtime', async () => {
  const mock = await createMockServer((message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encodeFrame({
        type: 'response', requestId: message.requestId, method: 'initialize', resultType: 'success',
        result: { clientId: 'bridge-client' },
      }));
      return;
    }
    socket.write(encodeFrame({
      type: 'response', requestId: message.requestId, method: message.method, resultType: 'success',
      result: {},
    }));
  });
  const client = new DesktopIpcClient({ socketPath: mock.socketPath });

  try {
    await client.start();
    await client.respondToApproval({
      threadId: 'thread-bound', requestId: 'approval-1', kind: 'command', decision: 'accept',
    }, () => undefined);
    assert.deepEqual(mock.messages[1], {
      type: 'request',
      requestId: mock.messages[1]?.requestId,
      sourceClientId: 'bridge-client',
      version: 1,
      method: 'thread-follower-command-approval-decision',
      params: { conversationId: 'thread-bound', requestId: 'approval-1', decision: 'accept' },
      timeoutMs: 30_000,
    });
  } finally {
    await client.stop();
    await mock.close();
  }
});

test('classifies a sent request timeout as outcome unknown without retrying', async () => {
  const mock = await createMockServer((message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encodeFrame({
        type: 'response',
        requestId: message.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'bridge-client' },
      }));
    }
  });
  const client = new DesktopIpcClient({
    socketPath: mock.socketPath,
    requestTimeoutMs: 20,
  });
  let sent = false;

  try {
    await client.start();
    await assert.rejects(
      client.startTurnTracked(turnStartParams(), () => {
        sent = true;
      }),
      (error: unknown) => {
        assert.ok(error instanceof DesktopIpcRequestError);
        assert.equal(error.code, 'DESKTOP_IPC_REQUEST_TIMEOUT');
        assert.equal(error.disposition, 'OUTCOME_UNKNOWN');
        return true;
      },
    );
    assert.equal(sent, true);
    assert.equal(
      mock.messages.filter((message) => message.method === 'thread-follower-start-turn').length,
      1,
    );
  } finally {
    await client.stop();
    await mock.close();
  }
});

test('classifies router no-client-found as provably unsent without requiring a method', async () => {
  const mock = await createMockServer((message, socket) => {
    if (message.method === 'initialize') {
      socket.write(encodeFrame({
        type: 'response',
        requestId: message.requestId,
        method: 'initialize',
        resultType: 'success',
        result: { clientId: 'bridge-client' },
      }));
      return;
    }
    if (message.method === 'thread-follower-start-turn') {
      socket.write(encodeFrame({
        type: 'response',
        requestId: message.requestId,
        resultType: 'error',
        error: 'no-client-found',
      }));
    }
  });
  const client = new DesktopIpcClient({ socketPath: mock.socketPath });

  try {
    await client.start();
    await assert.rejects(
      client.startTurnTracked(turnStartParams(), () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof DesktopIpcRequestError);
        assert.equal(error.code, 'DESKTOP_IPC_REMOTE_REJECTED');
        assert.equal(error.disposition, 'PROVABLY_UNSENT');
        return true;
      },
    );
  } finally {
    await client.stop();
    await mock.close();
  }
});
