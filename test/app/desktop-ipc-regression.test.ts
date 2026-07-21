import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import { CardKitError } from '../../src/app/cards/cardkit-client';
import type { CardKitJson } from '../../src/app/cards/layouts';
import {
  DesktopIpcClient,
  DesktopIpcRequestError,
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
  type DesktopDeliveryOutcome,
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

test('orchestrator exposes an unavailable Desktop owner in health callbacks and the failure card', async () => {
  const desktop = new RejectingDesktopTurnClient();
  const cards = new RecordingCards();
  const deliveryOutcomes: DesktopDeliveryOutcome[] = [];
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    onDesktopDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome),
  });

  assert.equal(await orchestrator.handleInbound(inbound('owner-missing', 'start'), binding), 'started');
  await waitFor(() => cards.replacements.length > 0);

  assert.deepEqual(deliveryOutcomes.map((outcome) => ({
    operation: outcome.operation,
    status: outcome.status,
    threadId: outcome.threadId,
    chatId: outcome.chatId,
    messageId: outcome.messageId,
    code: outcome.status === 'failed' && outcome.error instanceof DesktopIpcRequestError
      ? outcome.error.code
      : null,
    remoteError: outcome.status === 'failed' && outcome.error instanceof DesktopIpcRequestError
      ? outcome.error.remoteError
      : null,
  })), [{
    operation: 'start',
    status: 'failed',
    threadId: 'thread-bound',
    chatId: 'chat',
    messageId: 'message-owner-missing',
    code: 'DESKTOP_IPC_REMOTE_REJECTED',
    remoteError: 'no-client-found',
  }]);
  assert.match(
    JSON.stringify(cards.replacements.at(-1)),
    /任务启动未发送到 ChatGPT Desktop（no-client-found）/,
  );
  orchestrator.abandonAll();
});

test('Desktop delivery observers cannot change start, steer, or interrupt semantics', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const orchestrator = new InMemoryOrchestrator(config, desktop, new RecordingCards(), {
    onDesktopDeliveryOutcome: () => {
      throw new Error('diagnostic observer failed');
    },
  });

  assert.equal(await orchestrator.handleInbound(inbound('observer-1', 'start'), binding), 'started');
  assert.equal(
    await orchestrator.handleInbound(
      inbound('observer-2', 'follow up', 'root-observer-1'),
      binding,
    ),
    'steered',
  );
  assert.equal(await orchestrator.cancelCurrent('chat', 'thread-bound'), true);
  assert.equal(desktop.starts.length, 1);
  assert.equal(desktop.steers.length, 1);
  assert.deepEqual(desktop.interrupts, [{ threadId: 'thread-bound', turnId: 'turn-1' }]);
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
  const deliveredBeforeResume = cards.replacements.length;
  orchestrator.resumeCardDelivery();
  await waitFor(() => cards.replacements.length > deliveredBeforeResume);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /result after reconnect/);
  orchestrator.abandonAll();
});

test('orchestrator continues an oversized timeline and final answer across new cards', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new ExpandingRenderCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards);

  assert.equal(await orchestrator.handleInbound(inbound('pages', 'long running task'), binding), 'started');
  const reasoning = Array.from({ length: 45 }, (_, index) => (
    `第 ${index} 段推理 ${'过程内容'.repeat(index === 0 ? 2_000 : 80)}`
  ));
  for (let index = 0; index < reasoning.length; index += 1) {
    orchestrator.handleNotification(reasoningNotification(
      'turn-1',
      `reasoning-${index}`,
      reasoning[index] as string,
    ));
  }

  await waitFor(() => cards.sentCardIds.length >= 2);
  const firstPage = cards.card('card-1');
  const activeTimelinePage = cards.card(cards.sentCardIds.at(-1) as string);
  assert.doesNotMatch(JSON.stringify(firstPage), /停止任务/);
  assert.match(JSON.stringify(activeTimelinePage), /停止任务/);
  assert.equal(await orchestrator.cancel({
    chatId: 'chat',
    messageId: 'card-message-1',
    operatorOpenId: 'user',
    token: taskCancelToken(activeTimelinePage),
  }), false);
  assert.doesNotMatch(JSON.stringify([...cards.cardsById.values()]), /未在飞书展示/);
  assert.match(JSON.stringify([...cards.cardsById.values()]), /第 0 段推理/);
  assert.match(JSON.stringify([...cards.cardsById.values()]), /第 44 段推理/);

  const answer = `${Array.from({ length: 90 }, (_, index) => (
    `[答案分段-${index}]${'完整结果'.repeat(100)}`
  )).join('\n')}\n[ASCII长段]${'x'.repeat(20_000)}`;
  orchestrator.handleNotification(completedNotification('turn-1', answer));

  await waitFor(() => (
    cards.sentCardIds.map((cardId) => cardAnswer(cards.card(cardId))).join('') === answer
  ));
  const delivered = cards.sentCardIds.map((cardId) => JSON.stringify(cards.card(cardId))).join('\n');
  for (let index = 0; index < 90; index += 1) {
    assert.match(delivered, new RegExp(`答案分段-${index}`));
  }
  assert.equal(
    cards.sentCardIds.map((cardId) => cardAnswer(cards.card(cardId))).join(''),
    answer,
  );
  assert.equal(
    cards.sentCardIds.map((cardId) => cardReasoning(cards.card(cardId))).join(''),
    reasoning.join(''),
  );
  assert.equal(
    cards.sentCardIds.filter((cardId) => JSON.stringify(cards.card(cardId)).includes('long running task')).length,
    1,
  );
  for (const cardId of cards.sentCardIds) {
    assert.ok(Buffer.byteLength(JSON.stringify(cards.card(cardId)), 'utf8') <= 28 * 1024);
  }
  const finalPage = cards.card(cards.sentCardIds.at(-1) as string);
  assert.doesNotMatch(JSON.stringify(finalPage), /停止任务/);
  assert.match(cardAnswer(finalPage), /x+$/);
  orchestrator.abandonAll();
});

test('orchestrator keeps a short answer on the current card and preserves answer deltas beyond 128 KiB', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const shortCards = new RecordingCards();
  const shortTask = new InMemoryOrchestrator(config, desktop, shortCards);

  assert.equal(await shortTask.handleInbound(inbound('short-answer', 'small task'), binding), 'started');
  shortTask.handleNotification(reasoningNotification('turn-1', 'short-reasoning', '简短推理'));
  shortTask.handleNotification(completedNotification('turn-1', '简短答案'));
  await waitFor(() => cardAnswer(shortCards.card('card-1')) === '简短答案');
  assert.deepEqual(shortCards.sentCardIds, ['card-1']);
  shortTask.abandonAll();

  const longCards = new RecordingCards();
  const longTask = new InMemoryOrchestrator(config, desktop, longCards);
  assert.equal(await longTask.handleInbound(inbound('large-delta', 'large answer'), binding), 'started');
  const longAnswer = `[开始]${'x'.repeat(150 * 1024)}[结束]`;
  longTask.handleNotification(deltaNotification('turn-2', longAnswer));
  await waitFor(() => longCards.sentCardIds.length >= 2);
  await waitFor(() => (
    longCards.sentCardIds.map((cardId) => cardAnswer(longCards.card(cardId))).join('').length
    === longAnswer.length
  ));
  assert.equal(
    longCards.sentCardIds.map((cardId) => cardAnswer(longCards.card(cardId))).join(''),
    longAnswer,
  );
  const activeCardId = longCards.sentCardIds.at(-1) as string;
  assert.equal(await longTask.cancel({
    chatId: 'chat',
    messageId: `card-message-${longCards.sentCardIds.length}`,
    operatorOpenId: 'user',
    token: taskCancelToken(longCards.card(activeCardId)),
  }), true);
  assert.deepEqual(desktop.interrupts.at(-1), { threadId: 'thread-bound', turnId: 'turn-2' });
  longTask.abandonAll();
});

test('orchestrator reuses a pending continuation card after Lark reconnects', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RolloverReconnectingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    cardRetryDelayMs: 1,
  });

  assert.equal(await orchestrator.handleInbound(inbound('page-reconnect', 'long task'), binding), 'started');
  cards.connected = false;
  for (let index = 0; index < 45; index += 1) {
    orchestrator.handleNotification(reasoningNotification(
      'turn-1',
      `offline-reasoning-${index}`,
      `离线分段 ${index} ${'过程内容'.repeat(80)}`,
    ));
  }

  await waitFor(() => cards.failedContinuationSends >= 4);
  assert.equal(cards.cardsById.size, 2);
  assert.deepEqual(cards.sentCardIds, ['card-1']);
  assert.deepEqual(cards.closedCardIds, []);
  assert.match(JSON.stringify(cards.card('card-1')), /停止任务/);

  cards.connected = true;
  orchestrator.resumeCardDelivery();
  await waitFor(() => cards.sentCardIds.length >= 2);
  assert.equal(cards.sentCardIds[1], 'card-2');
  await waitFor(() => /离线分段 44/.test(JSON.stringify([...cards.cardsById.values()])));
  orchestrator.abandonAll();
});

test('old-card freeze failures do not block the continuation and keep cancellation valid', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new FreezeFailingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    cardRetryDelayMs: 1,
  });

  assert.equal(await orchestrator.handleInbound(inbound('freeze-failure', 'freeze failure'), binding), 'started');
  for (let index = 0; index < 45; index += 1) {
    orchestrator.handleNotification(reasoningNotification(
      'turn-1',
      `freeze-reasoning-${index}`,
      `冻结失败分段 ${index} ${'过程内容'.repeat(80)}`,
    ));
  }
  await waitFor(() => cards.sentCardIds.length >= 2 && cards.failedFreezes >= 1);

  orchestrator.handleNotification(reasoningNotification('turn-1', 'after-freeze-failure', '冻结失败后仍继续更新'));
  await waitFor(() => JSON.stringify(cards.card(cards.sentCardIds.at(-1) as string)).includes('冻结失败后仍继续更新'));
  assert.equal(await orchestrator.cancel({
    chatId: 'chat',
    messageId: 'card-message-1',
    operatorOpenId: 'user',
    token: taskCancelToken(cards.card('card-1')),
  }), true);
  assert.deepEqual(desktop.interrupts.at(-1), { threadId: 'thread-bound', turnId: 'turn-1' });
  orchestrator.abandonAll();
});

test('late timeline replacement cannot shift already delivered page boundaries', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RecordingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards);

  assert.equal(await orchestrator.handleInbound(inbound('stable-timeline', 'stable timeline'), binding), 'started');
  const first = `稳定首段 ${'过程内容'.repeat(2_000)}`;
  orchestrator.handleNotification(reasoningNotification('turn-1', 'stable-first', first));
  for (let index = 0; index < 40; index += 1) {
    orchestrator.handleNotification(reasoningNotification(
      'turn-1',
      `stable-${index}`,
      `稳定后续 ${index} ${'内容'.repeat(100)}`,
    ));
  }
  await waitFor(() => cards.sentCardIds.length >= 2);

  orchestrator.handleNotification(commentaryCompletedNotification('turn-1', 'stable-first', ''));
  orchestrator.handleNotification(reasoningNotification('turn-1', 'stable-last', '边界后新消息'));
  await waitFor(() => JSON.stringify([...cards.cardsById.values()]).includes('边界后新消息'));
  const delivered = cards.sentCardIds.map((cardId) => cardReasoning(cards.card(cardId))).join('');
  assert.equal(delivered.split('稳定首段').length - 1, 1);
  assert.match(delivered, /稳定后续 39/);
  assert.match(delivered, /边界后新消息/);
  orchestrator.abandonAll();
});

test('a divergent terminal answer is sent as an explicit authoritative revision', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RecordingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards);

  assert.equal(await orchestrator.handleInbound(inbound('answer-revision', 'answer revision'), binding), 'started');
  orchestrator.handleNotification(deltaNotification('turn-1', `流式草稿${'x'.repeat(80 * 1024)}`));
  await waitFor(() => cards.sentCardIds.length >= 2);
  const authoritative = `权威最终答案${'y'.repeat(60 * 1024)}`;
  orchestrator.handleNotification(completedNotification('turn-1', authoritative));
  await waitFor(() => cards.sentCardIds.some((cardId) => JSON.stringify(cards.card(cardId)).includes('最终结果修订版')));
  const revisionStart = cards.sentCardIds.findIndex((cardId) => (
    JSON.stringify(cards.card(cardId)).includes('最终结果修订版')
  ));
  await waitFor(() => (
    cards.sentCardIds.slice(revisionStart).map((cardId) => cardAnswer(cards.card(cardId))).join('')
    === authoritative
  ));
  orchestrator.abandonAll();
});

test('an oversized rendered timeline entry is split before any continuation card is sent', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new ProportionalRenderCards();
  const errors: Error[] = [];
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards, {
    onCardError: (error) => errors.push(error),
  });

  assert.equal(await orchestrator.handleInbound(inbound('render-overflow', 'render overflow'), binding), 'started');
  const reasoning = `自适应超限${'z'.repeat(6 * 1024)}`;
  orchestrator.handleNotification(reasoningNotification('turn-1', 'render-overflow-item', reasoning));
  await waitFor(() => cards.sentCardIds.length >= 2 || errors.length > 0);
  assert.deepEqual(errors.map((error) => error.message), []);
  await waitFor(() => cards.sentCardIds.map((cardId) => cardReasoning(cards.card(cardId))).join('') === reasoning);
  for (const cardId of cards.sentCardIds) {
    assert.ok(Buffer.byteLength(JSON.stringify(cards.card(cardId)), 'utf8') <= 28 * 1024);
  }
  orchestrator.abandonAll();
});

test('late output from a frozen tool page is delivered as one explicit tool update', async () => {
  const desktop = new RecordingDesktopTurnClient();
  const cards = new RecordingCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop, cards);

  assert.equal(await orchestrator.handleInbound(inbound('late-tool', 'late tool'), binding), 'started');
  orchestrator.handleNotification(toolStartedNotification('turn-1', 'late-tool-item', 'printf late'));
  for (let index = 0; index < 45; index += 1) {
    orchestrator.handleNotification(reasoningNotification(
      'turn-1',
      `late-tool-reasoning-${index}`,
      `工具后推理 ${index} ${'内容'.repeat(100)}`,
    ));
  }
  await waitFor(() => cards.sentCardIds.length >= 2);

  orchestrator.handleNotification(toolOutputNotification('turn-1', 'late-tool-item', 'late-output-visible'));
  orchestrator.handleNotification(toolCompletedNotification('turn-1', 'late-tool-item', 'printf late'));
  await waitFor(() => JSON.stringify([...cards.cardsById.values()]).includes('late-output-visible'));
  const delivered = JSON.stringify([...cards.cardsById.values()]);
  assert.match(delivered, /工具执行更新/);
  assert.equal(delivered.split('late-output-visible').length - 1, 1);
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

class RejectingDesktopTurnClient extends RecordingDesktopTurnClient {
  override async startTurnTracked(params: TurnStartParams): Promise<Turn> {
    this.starts.push(params);
    throw new DesktopIpcRequestError(
      'DESKTOP_IPC_REMOTE_REJECTED',
      'PROVABLY_UNSENT',
      7,
      'thread-follower-start-turn',
      'request-owner-missing',
      undefined,
      'no-client-found',
    );
  }
}

class RecordingCards implements InMemoryCardClient {
  readonly replacements: CardKitJson[] = [];
  readonly cardsById = new Map<string, CardKitJson>();
  readonly sentCardIds: string[] = [];
  readonly closedCardIds: string[] = [];

  async renderCard(card: CardKitJson): Promise<CardKitJson> {
    return card;
  }

  async createCard(card: CardKitJson): Promise<string> {
    return this.createRenderedCard(await this.renderCard(card));
  }

  async createRenderedCard(card: CardKitJson): Promise<string> {
    const cardId = `card-${this.cardsById.size + 1}`;
    this.cardsById.set(cardId, card);
    return cardId;
  }

  async replyCard(): Promise<string> {
    return 'card-message';
  }

  async sendCard(_chatId: string, cardId: string): Promise<string> {
    this.sentCardIds.push(cardId);
    return `card-message-${this.sentCardIds.length}`;
  }

  async replaceCard(id: string, card: CardKitJson, sequence: number): Promise<number> {
    return this.replaceRenderedCard(id, await this.renderCard(card), sequence);
  }

  async replaceRenderedCard(id: string, card: CardKitJson, sequence: number): Promise<number> {
    this.replacements.push(card);
    this.cardsById.set(id, card);
    return sequence + 1;
  }

  async streamElement(_id: string, _element: string, _content: string, sequence: number): Promise<number> {
    return sequence + 1;
  }

  async closeStreaming(id: string, sequence: number): Promise<number> {
    this.closedCardIds.push(id);
    return sequence + 1;
  }

  card(cardId: string): CardKitJson {
    const card = this.cardsById.get(cardId);
    assert.ok(card, `missing recorded card ${cardId}`);
    return card;
  }
}

class ReconnectingCards extends RecordingCards {
  connected = true;
  failedWrites = 0;

  override async replaceRenderedCard(
    id: string,
    card: CardKitJson,
    sequence: number,
  ): Promise<number> {
    if (!this.connected) {
      this.failedWrites += 1;
      throw new CardKitError('NETWORK_RETRYABLE', 'offline');
    }
    return super.replaceRenderedCard(id, card, sequence);
  }
}

class ExpandingRenderCards extends RecordingCards {
  override async renderCard(card: CardKitJson): Promise<CardKitJson> {
    const rendered = structuredClone(card) as Record<string, unknown>;
    const body = rendered.body as { elements: Array<Record<string, unknown>> };
    body.elements.push({ tag: 'markdown', content: `rendered:${'r'.repeat(2_000)}` });
    return rendered;
  }

}

class ProportionalRenderCards extends RecordingCards {
  override async renderCard(card: CardKitJson): Promise<CardKitJson> {
    const rendered = structuredClone(card) as Record<string, unknown>;
    const body = rendered.body as { elements: Array<Record<string, unknown>> };
    const timelineText = body.elements
      .filter((element) => String(element.content ?? '').includes('自适应超限'))
      .map((element) => String(element.content ?? ''))
      .join('');
    if (timelineText) {
      body.elements.push({ tag: 'markdown', content: `rendered:${timelineText.repeat(8)}` });
    }
    return rendered;
  }
}

class RolloverReconnectingCards extends RecordingCards {
  connected = true;
  failedContinuationSends = 0;

  override async sendCard(chatId: string, cardId: string): Promise<string> {
    if (!this.connected && cardId !== 'card-1') {
      this.failedContinuationSends += 1;
      throw new CardKitError('NETWORK_RETRYABLE', 'offline');
    }
    return super.sendCard(chatId, cardId);
  }
}

class FreezeFailingCards extends RecordingCards {
  failedFreezes = 0;

  override async closeStreaming(id: string, sequence: number): Promise<number> {
    if (id === 'card-1') {
      this.failedFreezes += 1;
      throw new CardKitError('NETWORK_RETRYABLE', 'old card freeze failed');
    }
    return super.closeStreaming(id, sequence);
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

function reasoningNotification(turnId: string, itemId: string, delta: string): ServerNotification {
  return {
    method: 'item/reasoning/textDelta',
    params: { threadId: 'thread-bound', turnId, itemId, delta },
  };
}

function commentaryCompletedNotification(
  turnId: string,
  itemId: string,
  text: string,
): ServerNotification {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread-bound',
      turnId,
      item: { id: itemId, type: 'agentMessage', phase: 'commentary', text },
    },
  };
}

function toolStartedNotification(turnId: string, itemId: string, command: string): ServerNotification {
  return {
    method: 'item/started',
    params: {
      threadId: 'thread-bound',
      turnId,
      item: { id: itemId, type: 'commandExecution', command },
    },
  };
}

function toolOutputNotification(turnId: string, itemId: string, delta: string): ServerNotification {
  return {
    method: 'item/commandExecution/outputDelta',
    params: { threadId: 'thread-bound', turnId, itemId, delta },
  };
}

function toolCompletedNotification(turnId: string, itemId: string, command: string): ServerNotification {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread-bound',
      turnId,
      item: { id: itemId, type: 'commandExecution', command, status: 'completed', exitCode: 0 },
    },
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

function cardAnswer(card: CardKitJson): string {
  const prefix = '✨ **最终结果输出**\n';
  const body = card.body as { elements: Array<Record<string, unknown>> };
  for (const element of body.elements) {
    if (element.tag !== 'markdown' || typeof element.content !== 'string') {
      continue;
    }
    if (element.content.startsWith(prefix)) {
      return element.content.slice(prefix.length).replace(/ ▍$/, '');
    }
  }
  return '';
}

function cardReasoning(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  return body.elements.flatMap((element) => {
    if (element.tag !== 'markdown' || typeof element.content !== 'string') {
      return [];
    }
    if (!element.content.startsWith('📎 **[')) {
      return [];
    }
    const contentStart = element.content.indexOf('\n');
    return contentStart < 0 ? [] : [element.content.slice(contentStart + 1)];
  }).join('');
}

function taskCancelToken(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const cancel = body.elements.find((element) => element.element_id === 'codex_cancel');
  const value = cancel?.value as { token?: unknown } | undefined;
  const token = value?.token;
  assert.equal(typeof token, 'string');
  return token as string;
}
