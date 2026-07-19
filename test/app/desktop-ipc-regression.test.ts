import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import { CardKitError } from '../../src/app/cards/cardkit-client';
import type { CardKitJson } from '../../src/app/cards/layouts';
import {
  DesktopIpcClient,
  type DesktopThreadStreamBroadcast,
} from '../../src/app/codex/desktop-ipc-client';
import type {
  ServerNotification,
  Turn,
  TurnInterruptParams,
  TurnStartParams,
  TurnSteerParams,
} from '../../src/app/codex/protocol';
import { DesktopIpcSupervisor } from '../../src/app/codex/desktop-ipc-supervisor';
import {
  DESKTOP_THREAD_STREAM_PROTOCOL_VERSION,
  DesktopThreadStreamNormalizer,
} from '../../src/app/codex/desktop-thread-stream-normalizer';
import type { DesktopIpcEndpoint, PlatformAdapter } from '../../src/app/platform/platform-adapter';
import {
  DesktopApprovalService,
  type DesktopApprovalClient,
} from '../../src/app/desktop-approval-service';
import type { BridgeConfig } from '../../src/app/domain';
import {
  InMemoryOrchestrator,
  type DesktopTurnClient,
  type InMemoryCardClient,
} from '../../src/app/in-memory-orchestrator';
import type { InboundTextMessage } from '../../src/app/lark/intake';

type WireMessage = Readonly<Record<string, unknown>>;

const config: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['user'],
  allowedApprovers: ['approver'],
  approvalCardMode: 'individual',
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/codex',
  codexCwd: '/workspace',
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1,
  maxQueuedTasks: 10,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

const binding: ChatThreadBinding = {
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-bound',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

test('Desktop IPC owns start, steer, interrupt, approval, and live protocol v11 events', async () => {
  const followedThreads = new Set<string>();
  const broadcast: DesktopThreadStreamBroadcast = {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: DESKTOP_THREAD_STREAM_PROTOCOL_VERSION,
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
  const mock = createMockTransport((message, socket) => {
    if (message.method === 'initialize') {
      respond(socket, message, { clientId: 'bridge-client' });
      return;
    }
    if (message.method === 'thread-stream-following-changed') {
      const threadId = nestedString(message, 'params', 'conversationId');
      const following = nestedBoolean(message, 'params', 'following');
      if (threadId && following === true) {
        followedThreads.add(threadId);
      } else if (threadId && following === false) {
        followedThreads.delete(threadId);
      }
      return;
    }
    if (message.method === 'thread-follower-start-turn') {
      if (followedThreads.has('thread-bound')) {
        socket.sendToClient(broadcast);
      }
      respond(socket, message, {
        result: { turn: { id: 'turn-desktop', items: [], status: 'inProgress' } },
      }, 'desktop-owner');
      return;
    }
    respond(socket, message, {}, 'desktop-owner');
  });
  const endpoint: DesktopIpcEndpoint = { transport: 'unix_socket', address: 'mock-desktop' };
  const client = new DesktopIpcClient({
    endpoint,
    platformAdapter: trustedTestPlatform(endpoint),
    connectSocket: mock.connect,
  });
  const broadcasts: DesktopThreadStreamBroadcast[] = [];
  const unsubscribe = client.onThreadStreamStateChanged((message) => broadcasts.push(message));

  try {
    await client.start();
    const start = turnStartParams();
    const turn = await client.startTurnTracked(start, () => undefined);
    await client.steerTurnTracked({
      threadId: start.threadId,
      expectedTurnId: turn.id,
      clientUserMessageId: 'message-2',
      input: [{ type: 'text', text: 'follow up', text_elements: [] }],
    }, () => undefined);
    await client.interruptTurnTracked({ threadId: start.threadId, turnId: turn.id }, () => undefined);
    await client.respondToApproval({
      threadId: start.threadId,
      requestId: 'approval-1',
      kind: 'command',
      decision: 'accept',
    }, () => undefined);

    assert.equal(DESKTOP_THREAD_STREAM_PROTOCOL_VERSION, 11);
    assert.deepEqual(broadcasts, [broadcast]);
    assert.deepEqual(mock.messages.map((message) => message.method), [
      'initialize',
      'thread-stream-following-changed',
      'thread-follower-start-turn',
      'thread-follower-steer-turn',
      'thread-follower-interrupt-turn',
      'thread-follower-command-approval-decision',
    ]);
    assert.equal(nestedString(mock.messages[1], 'params', 'conversationId'), 'thread-bound');
    assert.equal(nestedBoolean(mock.messages[1], 'params', 'following'), true);
    assert.equal(nestedString(mock.messages[1], 'params', 'hostId'), 'local');
    assert.equal(nestedString(mock.messages[2], 'params', 'conversationId'), 'thread-bound');
    assert.equal(nestedString(mock.messages[3], 'params', 'expectedTurnId'), 'turn-desktop');
    assert.equal(nestedString(mock.messages[4], 'params', 'turnId'), 'turn-desktop');
    assert.equal(nestedString(mock.messages[5], 'params', 'requestId'), 'approval-1');
  } finally {
    unsubscribe();
    await client.stop();
    await mock.close();
  }
});

test('Desktop IPC initializes the epoch before handling an immediate restored snapshot', async () => {
  const restoredSnapshot = threadSnapshotBroadcast(
    'thread-bound',
    'turn-restored',
    'Restored Desktop state',
  );
  const mock = createMockTransport((message, socket) => {
    if (message.method === 'initialize') {
      respond(socket, message, { clientId: 'bridge-client' });
      return;
    }
    if (
      message.method === 'thread-stream-following-changed'
      && nestedBoolean(message, 'params', 'following') === true
    ) {
      socket.sendToClient(restoredSnapshot);
    }
  });
  const endpoint: DesktopIpcEndpoint = { transport: 'unix_socket', address: 'mock-desktop' };
  const client = new DesktopIpcClient({
    endpoint,
    platformAdapter: trustedTestPlatform(endpoint),
    connectSocket: mock.connect,
  });
  const normalizer = new DesktopThreadStreamNormalizer(() => 100);
  const notifications: ServerNotification[] = [];
  let supervisorReady = false;
  let snapshotArrivedBeforeReady = false;
  const unsubscribe = client.onThreadStreamStateChanged((message, epoch) => {
    snapshotArrivedBeforeReady ||= !supervisorReady;
    normalizer.beginEpoch(epoch);
    notifications.push(...normalizer.handle(message));
  });
  const supervisor = new DesktopIpcSupervisor(client, {
    reconnectInitialDelayMs: 1,
    reconnectMaximumDelayMs: 1,
    onDisconnected: () => undefined,
    onReady: (handshake) => {
      normalizer.beginEpoch(handshake.epoch);
      supervisorReady = true;
    },
  });

  try {
    await client.syncFollowedThreads(['thread-bound']);
    const handshake = await supervisor.start();

    assert.equal(snapshotArrivedBeforeReady, true);
    assert.equal(normalizer.connectionEpoch, handshake.epoch);
    assert.equal(normalizer.activeTurnSnapshot('thread-bound').length > 0, true);
    assert.equal(
      notifications.some((notification) => notification.method === 'turn/started'),
      true,
    );
  } finally {
    unsubscribe();
    await supervisor.stop();
    await mock.close();
  }
});

test('Desktop supervisor restores followers after an actual socket loss', async () => {
  const mock = createMockTransport((message, socket) => {
    if (message.method === 'initialize') {
      respond(socket, message, { clientId: 'bridge-client' });
    }
  });
  const endpoint: DesktopIpcEndpoint = { transport: 'unix_socket', address: 'mock-desktop' };
  const client = new DesktopIpcClient({
    endpoint,
    platformAdapter: trustedTestPlatform(endpoint),
    connectSocket: mock.connect,
  });
  const lifecycleEvents: string[] = [];
  const supervisor = new DesktopIpcSupervisor(client, {
    reconnectInitialDelayMs: 1,
    reconnectMaximumDelayMs: 1,
    onDisconnected: (epoch) => {
      lifecycleEvents.push(`disconnected:${epoch}`);
    },
    onReady: (handshake) => {
      lifecycleEvents.push(`ready:${handshake.epoch}`);
    },
  });

  try {
    await client.syncFollowedThreads(['thread-a', 'thread-b']);
    await supervisor.start();
    await client.syncFollowedThreads(['thread-b', 'thread-c']);
    mock.disconnect();
    await waitFor(() => lifecycleEvents.includes('ready:2'));

    assert.deepEqual(lifecycleEvents, ['ready:1', 'disconnected:1', 'ready:2']);
    assert.deepEqual(
      mock.messages
        .filter((message) => message.method === 'thread-stream-following-changed')
        .map((message) => ({
          threadId: nestedString(message, 'params', 'conversationId'),
          following: nestedBoolean(message, 'params', 'following'),
        })),
      [
        { threadId: 'thread-a', following: true },
        { threadId: 'thread-b', following: true },
        { threadId: 'thread-a', following: false },
        { threadId: 'thread-c', following: true },
        { threadId: 'thread-b', following: true },
        { threadId: 'thread-c', following: true },
      ],
    );
  } finally {
    await supervisor.stop();
    await mock.close();
  }
});

test('orchestrator uses App Server callbacks only for metadata and never replays after abandon', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RecordingCards();
  const metadataReads: string[] = [];
  const activeThreadSnapshots: string[][] = [];
  let orchestrator: InMemoryOrchestrator;
  orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    readThreadTitle: async (threadId) => {
      metadataReads.push(threadId);
      return 'Metadata title';
    },
    onActiveThreadsChanged: () => {
      activeThreadSnapshots.push([...orchestrator.activeThreadIds()]);
    },
  });

  assert.equal(await orchestrator.handleInbound(inbound('1', 'start'), binding), 'started');
  assert.deepEqual(activeThreadSnapshots.at(-1), ['thread-bound']);
  assert.equal(
    await orchestrator.handleInbound(inbound('2', 'follow up', 'root-1'), binding),
    'steered',
  );
  assert.deepEqual(metadataReads, ['thread-bound']);
  assert.equal(desktop.starts.length, 1);
  assert.equal(desktop.steers.length, 1);

  orchestrator.handleNotification(deltaNotification('turn-1', 'Desktop live answer'));
  assert.equal(await orchestrator.cancelCurrent('chat', 'thread-bound'), true);
  assert.deepEqual(desktop.interrupts, [{ threadId: 'thread-bound', turnId: 'turn-1' }]);

  orchestrator.abandonAll();
  assert.equal(await orchestrator.handleInbound(inbound('3', 'after restart'), binding), 'started');
  assert.equal(desktop.starts.length, 2);
  orchestrator.handleNotification(completedNotification('turn-2', 'Desktop final answer'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(JSON.stringify(cards.replacements.at(-1)), /Desktop final answer/);
  assert.deepEqual(activeThreadSnapshots.at(-1), []);
  orchestrator.abandonAll();
});

test('orchestrator keeps a thread active while handing off to its next queued task', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const activeThreadSnapshots: string[][] = [];
  let orchestrator: InMemoryOrchestrator;
  orchestrator = new InMemoryOrchestrator(config, desktop, new RecordingCards(), {
    onActiveThreadsChanged: () => {
      activeThreadSnapshots.push([...orchestrator.activeThreadIds()]);
    },
  });

  assert.equal(await orchestrator.handleInbound(inbound('queue-1', 'first'), binding), 'started');
  assert.equal(await orchestrator.handleInbound(inbound('queue-2', 'second'), binding), 'queued');
  orchestrator.handleNotification(completedNotification('turn-1', 'first result'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(desktop.starts.length, 2);
  assert.deepEqual(activeThreadSnapshots, [['thread-bound'], ['thread-bound']]);

  orchestrator.handleNotification(completedNotification('turn-2', 'second result'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(activeThreadSnapshots.at(-1), []);
  orchestrator.abandonAll();
});

test('orchestrator rejects a message when the per-thread queue is full', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const orchestrator = new InMemoryOrchestrator(
    { ...config, maxQueuedTasks: 1 },
    desktop,
    new RecordingCards(),
  );

  assert.equal(await orchestrator.handleInbound(inbound('full-1', 'first'), binding), 'started');
  assert.equal(await orchestrator.handleInbound(inbound('full-2', 'second'), binding), 'queued');
  assert.equal(
    await orchestrator.handleInbound(inbound('full-3', 'must not disappear'), binding),
    'rejected_queue_full',
  );

  orchestrator.handleNotification(completedNotification('turn-1', 'first result'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desktop.starts.length, 2);

  orchestrator.handleNotification(completedNotification('turn-2', 'second result'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(desktop.starts.length, 2);
  orchestrator.abandonAll();
});

test('orchestrator resumes the latest terminal card after Lark reconnects', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new ReconnectingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    cardRetryDelayMs: 1,
  });

  assert.equal(await orchestrator.handleInbound(inbound('recover-1', 'finish offline'), binding), 'started');
  const deliveredBeforeDisconnect = cards.replacements.length;
  cards.connected = false;
  orchestrator.handleNotification(completedNotification('turn-1', 'result after reconnect'));
  await waitFor(() => cards.failedWrites >= 4);
  assert.equal(cards.replacements.length, deliveredBeforeDisconnect);

  cards.connected = true;
  orchestrator.resumeCardDelivery();
  await waitFor(() => cards.replacements.length > 0);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /result after reconnect/);
  orchestrator.abandonAll();
});

test('unrelated Desktop thread broadcasts do not update the bound task card', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RecordingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards);
  const normalizer = new DesktopThreadStreamNormalizer(() => 100);
  normalizer.beginEpoch(1);

  assert.equal(await orchestrator.handleInbound(inbound('isolated', 'bound task'), binding), 'started');
  await waitFor(() => cards.replacements.length > 0);
  const replacementsBeforeUnrelatedBroadcast = cards.replacements.length;

  for (const notification of normalizer.handle(threadSnapshotBroadcast(
    'thread-unrelated',
    'turn-unrelated',
    'Unrelated Desktop output',
  ))) {
    orchestrator.handleNotification(notification);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(cards.replacements.length, replacementsBeforeUnrelatedBroadcast);
  assert.doesNotMatch(JSON.stringify(cards.replacements), /Unrelated Desktop output/);

  for (const notification of normalizer.handle(threadSnapshotBroadcast(
    'thread-bound',
    'turn-1',
    'Bound Desktop output',
  ))) {
    orchestrator.handleNotification(notification);
  }
  await waitFor(() => /Bound Desktop output/.test(JSON.stringify(cards.replacements)));
  orchestrator.abandonAll();
});

test('approval service returns a decision only through the Desktop owner epoch', async () => {
  const desktop = new RecordingDesktopApprovalClient();
  const cards = new ApprovalCards();
  const tasks = new ApprovalTasks();
  const approvals = new DesktopApprovalService(config, desktop, cards, tasks, () => 100);
  await approvals.present({
    requestId: 'request-1',
    threadId: 'thread-bound',
    turnId: 'turn-1',
    itemId: 'item-1',
    kind: 'command',
    reason: 'permission required',
    operationSummary: 'git status',
    availableDecisions: ['accept'],
  }, desktop.connectionEpoch);

  const result = await approvals.handleAction({
    chatId: 'chat',
    messageId: 'approval-message',
    operatorOpenId: 'approver',
    token: approvalToken(cards.created),
  });

  assert.deepEqual(desktop.responses, [{
    threadId: 'thread-bound',
    requestId: 'request-1',
    kind: 'command',
    decision: 'accept',
  }]);
  assert.equal(tasks.waiting, false);
  assert.match(JSON.stringify(result), /审批结果已提交/);
  approvals.abandonAll();
});

class RecordingDesktopTurnClient implements DesktopTurnClient {
  readonly starts: TurnStartParams[] = [];
  readonly steers: TurnSteerParams[] = [];
  readonly interrupts: TurnInterruptParams[] = [];

  async startTurnTracked(params: TurnStartParams): Promise<Turn> {
    this.starts.push(params);
    return {
      id: `turn-${this.starts.length}`,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
  }

  async steerTurnTracked(params: TurnSteerParams): Promise<string> {
    this.steers.push(params);
    return params.expectedTurnId;
  }

  async interruptTurnTracked(params: TurnInterruptParams): Promise<void> {
    this.interrupts.push(params);
  }
}

class RecordingCards implements InMemoryCardClient {
  readonly replacements: CardKitJson[] = [];

  async createCard(): Promise<string> {
    return 'card-1';
  }

  async replyCard(): Promise<string> {
    return 'card-message';
  }

  async sendCard(): Promise<string> {
    return 'card-message';
  }

  async replaceCard(_id: string, card: CardKitJson, sequence: number): Promise<number> {
    this.replacements.push(card);
    return sequence + 1;
  }

  async streamElement(_id: string, _element: string, _content: string, sequence: number): Promise<number> {
    return sequence + 1;
  }

  async closeStreaming(_id: string, sequence: number): Promise<number> {
    return sequence + 1;
  }
}

class ReconnectingCards extends RecordingCards {
  connected = true;
  failedWrites = 0;

  override async replaceCard(
    id: string,
    card: CardKitJson,
    sequence: number,
  ): Promise<number> {
    if (!this.connected) {
      this.failedWrites += 1;
      throw new CardKitError('NETWORK_RETRYABLE', 'offline');
    }
    return super.replaceCard(id, card, sequence);
  }
}

class RecordingDesktopApprovalClient implements DesktopApprovalClient {
  connectionEpoch = 7;
  readonly responses: unknown[] = [];

  async respondToApproval(response: unknown): Promise<void> {
    this.responses.push(response);
  }
}

class ApprovalCards {
  created: CardKitJson | undefined;

  async createCard(card: CardKitJson): Promise<string> {
    this.created = card;
    return 'approval-card';
  }

  async replyCard(): Promise<string> {
    return 'approval-message';
  }

  async replaceCard(_id: string, _card: CardKitJson, sequence: number): Promise<number> {
    return sequence + 1;
  }
}

class ApprovalTasks {
  waiting: boolean | undefined;

  approvalContext(): { taskId: string; chatId: string; rootMessageId: string; workspaceId: string } {
    return {
      taskId: 'task-1',
      chatId: 'chat',
      rootMessageId: 'root-1',
      workspaceId: '/workspace',
    };
  }

  setAwaitingApproval(_threadId: string, _turnId: string | null, waiting: boolean): boolean {
    this.waiting = waiting;
    return true;
  }

  failForApprovalDelivery(): void {
    throw new Error('approval delivery unexpectedly failed');
  }
}

interface MockServer {
  readonly messages: WireMessage[];
  connect(): Socket;
  disconnect(): void;
  close(): Promise<void>;
}

function createMockTransport(
  onMessage: (message: WireMessage, socket: MockDesktopSocket) => void,
): MockServer {
  const messages: WireMessage[] = [];
  const sockets = new Set<MockDesktopSocket>();
  return {
    messages,
    connect: () => {
      const socket = new MockDesktopSocket((message) => {
        messages.push(message);
        onMessage(message, socket);
      });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return socket as unknown as Socket;
    },
    disconnect: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}

class MockDesktopSocket extends Duplex {
  private readonly reader = new FrameReader();

  constructor(private readonly onMessage: (message: WireMessage) => void) {
    super();
    queueMicrotask(() => this.emit('connect'));
  }

  override _read(): void {
    // Responses are pushed by sendToClient when the mock owner handles a request.
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const message of this.reader.push(chunk)) this.onMessage(message);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.push(null);
    callback();
    this.destroy();
  }

  sendToClient(message: WireMessage): void {
    this.push(encodeFrame(message));
  }
}

function trustedTestPlatform(endpoint: DesktopIpcEndpoint): PlatformAdapter {
  return {
    platform: 'macos',
    desktopIpcEndpoint: () => endpoint,
    attestDesktopIpcEndpoint: async () => undefined,
  };
}

class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): WireMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: WireMessage[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')) as WireMessage);
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

function encodeFrame(message: WireMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function respond(
  socket: MockDesktopSocket,
  request: WireMessage,
  result: unknown,
  handledByClientId?: string,
): void {
  socket.sendToClient({
    type: 'response',
    requestId: request.requestId,
    method: request.method,
    resultType: 'success',
    ...(handledByClientId ? { handledByClientId } : {}),
    result,
  });
}

function turnStartParams(): TurnStartParams {
  return {
    threadId: 'thread-bound',
    clientUserMessageId: 'message-1',
    input: [{ type: 'text', text: 'hello Desktop', text_elements: [] }],
    cwd: '/workspace',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function inbound(id: string, text: string, rootMessageId = `root-${id}`): InboundTextMessage {
  return {
    tenantKey: 'tenant',
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatId: 'chat',
    rootMessageId,
    senderOpenId: 'user',
    text,
    payloadDigest: id,
    createdAtMs: 1,
  };
}

function deltaNotification(turnId: string, delta: string): ServerNotification {
  return {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-bound', turnId, itemId: 'answer', delta },
  };
}

function completedNotification(turnId: string, answer: string): ServerNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId: 'thread-bound',
      turn: {
        id: turnId,
        status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }],
      },
    },
  };
}

function threadSnapshotBroadcast(
  threadId: string,
  turnId: string,
  answer: string,
): DesktopThreadStreamBroadcast {
  return {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: DESKTOP_THREAD_STREAM_PROTOCOL_VERSION,
    params: {
      conversationId: threadId,
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [{
            id: turnId,
            status: 'inProgress',
            items: [{
              id: 'answer',
              type: 'agentMessage',
              phase: 'final_answer',
              text: answer,
            }],
          }],
        },
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function nestedString(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

function nestedBoolean(value: unknown, ...path: string[]): boolean | null {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'boolean' ? current : null;
}

function approvalToken(card: CardKitJson | undefined): string {
  assert.ok(card);
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const columns = body.elements.at(-1) as {
    columns: Array<{ elements: Array<Record<string, unknown>> }>;
  };
  const value = columns.columns[0]?.elements[0]?.value as { token?: unknown } | undefined;
  const token = value?.token;
  assert.equal(typeof token, 'string');
  return token as string;
}
