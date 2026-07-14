import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import { CardKitError } from '../../src/app/cards/cardkit-client';
import type { CardKitJson } from '../../src/app/cards/layouts';
import type { DesktopIpcClient } from '../../src/app/codex/desktop-ipc-client';
import type { TurnStartParams, TurnSteerParams } from '../../src/app/codex/protocol';
import type { BridgeConfig } from '../../src/app/domain';
import { InMemoryOrchestrator, type InMemoryCardClient } from '../../src/app/in-memory-orchestrator';
import type { InboundTextMessage } from '../../src/app/lark/intake';

const config: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['user'],
  allowedApprovers: ['approver'],
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/codex',
  codexCwd: '/workspace',
  allowedWorkspaceRoots: ['/workspace'],
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1,
  maxQueuedTasks: 10,
};

const binding: ChatThreadBinding = {
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-1',
  workspaceId: 'workspace-one',
  personality: 'friendly',
  plan: 'plan',
  revision: 1,
  updatedAtMs: 1,
};

function message(id: string, text: string, rootId = id): InboundTextMessage {
  return {
    tenantKey: 'tenant',
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatId: 'chat',
    rootMessageId: `root-${rootId}`,
    senderOpenId: 'user',
    text,
    payloadDigest: id,
    createdAtMs: 1,
  };
}

class FakeDesktop {
  public starts: TurnStartParams[] = [];
  public steers: TurnSteerParams[] = [];
  public interrupts: unknown[] = [];

  public async startTurnTracked(params: TurnStartParams): Promise<{ id: string; items: []; itemsView: 'notLoaded'; status: 'inProgress'; error: null; startedAt: null; completedAt: null; durationMs: null }> {
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

  public async steerTurnTracked(params: TurnSteerParams): Promise<string> {
    this.steers.push(params);
    return params.expectedTurnId;
  }

  public async interruptTurnTracked(params: unknown): Promise<void> {
    this.interrupts.push(params);
  }
}

class FakeCards implements InMemoryCardClient {
  public readonly created: CardKitJson[] = [];
  public readonly replacements: CardKitJson[] = [];
  public closed = 0;

  public async createCard(card: CardKitJson): Promise<string> {
    this.created.push(card);
    return 'card-1';
  }
  public async replyCard(): Promise<string> { return 'card-message-1'; }
  public async replaceCard(_id: string, card: CardKitJson, sequence: number): Promise<number> {
    this.replacements.push(card);
    return sequence + 1;
  }
  public async closeStreaming(_id: string, sequence: number): Promise<number> {
    this.closed += 1;
    return sequence + 1;
  }
}

test('sends a bound prompt only once through Desktop IPC and projects its terminal reply', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
  );

  assert.equal(await orchestrator.handleInbound(message('1', 'hello'), binding), 'started');
  assert.equal(await orchestrator.handleInbound(message('1', 'hello'), binding), 'duplicate');
  assert.equal(desktop.starts.length, 1);
  assert.equal(desktop.starts[0]?.threadId, 'thread-1');
  assert.equal(desktop.starts[0]?.personality, 'friendly');
  assert.equal(desktop.starts[0]?.collaborationMode, 'plan');
  assert.doesNotMatch(JSON.stringify(cards.created[0]), /↑/);

  orchestrator.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'Hello' },
  });
  orchestrator.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'completed', itemsView: 'full', startedAt: null, completedAt: null,
        durationMs: null, error: null,
        items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Hello from Desktop' }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cards.closed, 1);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /Hello from Desktop/);
});

test('steers the active turn and abandons all local state after Desktop loss', async () => {
  const desktop = new FakeDesktop();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    new FakeCards(),
  );

  await orchestrator.handleInbound(message('1', 'first'), binding);
  assert.equal(await orchestrator.handleInbound(message('2', 'follow up', '1'), binding), 'steered');
  assert.equal(desktop.steers.length, 1);

  orchestrator.abandonAll();
  await orchestrator.handleInbound(message('3', 'new after reconnect'), binding);
  assert.equal(desktop.starts.length, 2);
});

test('queues a different Feishu root instead of steering it into the active turn', async () => {
  const desktop = new FakeDesktop();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    new FakeCards(),
  );

  await orchestrator.handleInbound(message('1', 'first'), binding);
  assert.equal(await orchestrator.handleInbound(message('2', 'other root'), binding), 'queued');
  assert.equal(desktop.steers.length, 0);
  assert.equal(desktop.starts.length, 1);
});

test('does not retain a duplicate key when initial CardKit delivery fails before a turn starts', async () => {
  const desktop = new FakeDesktop();
  let createAttempts = 0;
  const cards: InMemoryCardClient = {
    createCard: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('temporary CardKit error');
      return 'card-1';
    },
    replyCard: async () => 'card-message-1',
    replaceCard: async (_id, _card, sequence) => sequence + 1,
    closeStreaming: async (_id, sequence) => sequence + 1,
  };
  const orchestrator = new InMemoryOrchestrator(config, desktop as unknown as DesktopIpcClient, cards);

  await assert.rejects(orchestrator.handleInbound(message('1', 'retry me'), binding), /temporary CardKit error/);
  assert.equal(await orchestrator.handleInbound(message('1', 'retry me'), binding), 'started');
  assert.equal(desktop.starts.length, 1);
});

test('retries a transient CardKit update without replaying the Desktop turn', async () => {
  const desktop = new FakeDesktop();
  let updateAttempts = 0;
  const cards: InMemoryCardClient = {
    createCard: async () => 'card-1',
    replyCard: async () => 'card-message-1',
    replaceCard: async (_id, _card, sequence) => {
      updateAttempts += 1;
      if (updateAttempts === 1) {
        throw new CardKitError('NETWORK_RETRYABLE', 'temporary CardKit outage');
      }
      return sequence + 1;
    },
    closeStreaming: async (_id, sequence) => sequence + 1,
  };
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
    { cardRetryDelayMs: 1 },
  );

  assert.equal(await orchestrator.handleInbound(message('1', 'retry update'), binding), 'started');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updateAttempts, 2);
  assert.equal(desktop.starts.length, 1);
});

test('keeps a terminal card briefly so late usage and rate limits update its original footer', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
    {
      readRateLimits: async () => ({
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 12, resetsAt: 1_784_016_000 },
            secondary: { usedPercent: 34, resetsAt: 1_784_102_400 },
            credits: { hasCredits: true, balance: '7' },
          },
        },
      }),
    },
  );
  await orchestrator.handleInbound(message('1', 'hello'), binding);
  orchestrator.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'completed', itemsView: 'full', startedAt: null, completedAt: null,
        durationMs: null, error: null,
        items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'done' }],
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  orchestrator.handleNotification({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      model: 'gpt-5.6-sol',
      apiCalls: 3,
      tokenUsage: {
        last: { inputTokens: 1_200, outputTokens: 345 },
        total: { totalTokens: 12_345 },
        modelContextWindow: 128_000,
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const serialized = JSON.stringify(cards.replacements.at(-1));
  assert.ok(serialized.includes('gpt\\\\-5\\\\.6\\\\-sol'));
  assert.match(serialized, /API 3/);
  assert.ok(serialized.includes('上下文 12\\\\.3K\\\\/128\\\\.0K'));
  assert.ok(serialized.includes('5h\\\\: 12\\\\%'));
  assert.ok(serialized.includes('7d\\\\: 34\\\\%'));
  assert.ok(serialized.includes('点数\\\\: 7'));
  assert.equal(cards.closed, 1);
});
