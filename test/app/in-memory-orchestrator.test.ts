import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import { CardKitError } from '../../src/app/cards/cardkit-client';
import type { CardKitJson } from '../../src/app/cards/layouts';
import { DesktopIpcRequestError, type DesktopIpcClient } from '../../src/app/codex/desktop-ipc-client';
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
  threadId: 'thread-1',
  workspaceId: '/workspace-one',
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
  public readonly startFailures: Error[] = [];

  public async startTurnTracked(params: TurnStartParams): Promise<{ id: string; items: []; itemsView: 'notLoaded'; status: 'inProgress'; error: null; startedAt: null; completedAt: null; durationMs: null }> {
    this.starts.push(params);
    const failure = this.startFailures.shift();
    if (failure) {
      throw failure;
    }
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
  public readonly sent: Array<{ readonly chatId: string; readonly cardId: string; readonly key: string }> = [];
  public closed = 0;
  public readonly operations: string[] = [];

  public async createCard(card: CardKitJson): Promise<string> {
    this.created.push(card);
    return 'card-1';
  }
  public async replyCard(): Promise<string> { return 'card-message-1'; }
  public async sendCard(chatId: string, cardId: string, key: string): Promise<string> {
    this.sent.push({ chatId, cardId, key });
    return 'card-message-desktop-1';
  }
  public async replaceCard(_id: string, card: CardKitJson, sequence: number): Promise<number> {
    this.operations.push('replace');
    this.replacements.push(card);
    return sequence + 1;
  }
  public async closeStreaming(_id: string, sequence: number): Promise<number> {
    this.operations.push('close');
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
  assert.equal(desktop.starts[0]?.cwd, '/workspace-one');
  assert.equal(desktop.starts[0]?.runtimeWorkspaceRoots, undefined);
  assert.deepEqual(desktop.starts[0]?.sandboxPolicy, { type: 'dangerFullAccess' });
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
  assert.deepEqual(cards.operations.slice(-2), ['close', 'replace']);
});

test('sends a locked skill as the original structured skill plus text input', async () => {
  const desktop = new FakeDesktop();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    new FakeCards(),
  );
  const skillBinding: ChatThreadBinding = {
    ...binding,
    activeSkill: 'ce-debug',
    activeSkillPath: '/workspace/.agents/skills/ce-debug/SKILL.md',
  };

  await orchestrator.handleInbound(message('skill', '排查这个问题'), skillBinding);

  assert.deepEqual(desktop.starts[0]?.input, [
    { type: 'skill', name: 'ce-debug', path: '/workspace/.agents/skills/ce-debug/SKILL.md' },
    { type: 'text', text: '排查这个问题', text_elements: [] },
  ]);
});

test('resolves the original inline @skill mention and sends structured skill input', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const orchestrator = new InMemoryOrchestrator(config, desktop as unknown as DesktopIpcClient, cards, {
    readSkills: async () => ({
      data: [{
        skills: [{ name: 'ce-debug', path: '/workspace/.agents/skills/ce-debug/SKILL.md' }],
      }],
    }),
  });

  await orchestrator.handleInbound(message('inline-skill', '@ce-debug 排查这个问题'), binding);

  assert.deepEqual(desktop.starts[0]?.input, [
    { type: 'skill', name: 'ce-debug', path: '/workspace/.agents/skills/ce-debug/SKILL.md' },
    { type: 'text', text: '排查这个问题', text_elements: [] },
  ]);
  const cardText = JSON.stringify(cards.created[0]);
  assert.match(cardText, /排查这个问题/);
  assert.match(cardText, /调用的技能/);
  assert.doesNotMatch(cardText, /@ce-debug/);
});

test('mirrors a direct Desktop prompt into its uniquely bound Feishu chat and streams the same card', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
    { resolveBindingByThreadId: (threadId) => threadId === binding.threadId ? binding : undefined },
  );
  const directTurn = {
    id: 'desktop-turn-1', status: 'inProgress' as const, itemsView: 'full' as const,
    startedAt: null, completedAt: null, durationMs: null, error: null,
    input: [{ type: 'text' as const, text: 'Desktop 直接发送的提示词', text_elements: [] }],
    items: [],
  };

  orchestrator.handleNotification({
    method: 'turn/started',
    params: { threadId: binding.threadId, turn: directTurn },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(desktop.starts.length, 0);
  assert.deepEqual(cards.sent, [{
    chatId: binding.chatId,
    cardId: 'card-1',
    key: cards.sent[0]!.key,
  }]);
  assert.match(JSON.stringify(cards.created[0]), /Desktop 直接发送的提示词/);

  orchestrator.handleNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: binding.threadId, turnId: directTurn.id, itemId: 'reasoning', delta: '正在推理' },
  });
  orchestrator.handleNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: binding.threadId, turnId: directTurn.id, itemId: 'answer', delta: '流式回答' },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(JSON.stringify(cards.replacements.at(-1)), /正在推理/);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /流式回答/);

  orchestrator.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: binding.threadId,
      turn: {
        ...directTurn,
        status: 'completed',
        items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Desktop 最终回答' }],
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cards.closed, 1);
  assert.match(JSON.stringify(cards.replacements.at(-1)), /Desktop 最终回答/);
});

test('projects tool calls as collapsed steps and never projects command stdout', async () => {
  const desktop = new FakeDesktop();
  const cards = new FakeCards();
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    cards,
  );

  await orchestrator.handleInbound(message('tool-call', 'inspect the project'), binding);
  orchestrator.handleNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'mcp-1', type: 'mcpToolCall', server: 'openai-docs', tool: 'search' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'mcp-1', type: 'mcpToolCall', server: 'openai-docs', tool: 'search', status: 'completed' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'agent-1', type: 'collabAgentToolCall', action: '创建智能体' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'agent-1', type: 'collabAgentToolCall', action: '创建智能体', status: 'completed' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'search-1', type: 'webSearch', query: 'Codex App Server' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'rg --files src' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/commandExecution/outputDelta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      delta: 'very-long-command-output-that-must-not-reach-the-card'.repeat(1_000),
    },
  });
  orchestrator.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'rg --files src', exitCode: 0 },
    },
  });
  orchestrator.handleNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'reasoning-1',
      delta: 'Next tool group.',
    },
  });
  orchestrator.handleNotification({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-2', type: 'commandExecution', command: 'git diff -- src' },
    },
  });
  orchestrator.handleNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-2', type: 'commandExecution', command: 'git diff -- src', exitCode: 0 },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const serialized = JSON.stringify(cards.replacements.at(-1));
  assert.match(serialized, /🛠️ 工具执行 · 4 步/);
  assert.match(serialized, /🛠️ 工具执行 · 1 步/);
  assert.match(serialized, /rg --files src/);
  assert.match(serialized, /git diff -- src/);
  assert.match(serialized, /openai-docs\.search/);
  assert.match(serialized, /创建智能体/);
  assert.match(serialized, /webSearch: Codex App Server/);
  assert.equal((serialized.match(/collapsible_panel/g) ?? []).length, 2);
  assert.doesNotMatch(serialized, /very-long-command-output-that-must-not-reach-the-card/);
  assert.match(serialized, /"expanded":false/);
});

test('opens the bound Desktop thread and retries only a provably unsent follower start', async () => {
  const desktop = new FakeDesktop();
  desktop.startFailures.push(new DesktopIpcRequestError(
    'DESKTOP_IPC_REMOTE_REJECTED',
    'PROVABLY_UNSENT',
    1,
    'thread-follower-start-turn',
    'request-1',
    undefined,
    'no-client-found',
  ));
  const openedThreadIds: string[] = [];
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    new FakeCards(),
    {
      navigation: {
        openThread: async (threadId: string) => {
          openedThreadIds.push(threadId);
        },
      },
      navigationRetryDelayMs: 1,
    },
  );

  assert.equal(await orchestrator.handleInbound(message('owner-missing', 'hello'), binding), 'started');
  assert.deepEqual(openedThreadIds, ['thread-1']);
  assert.equal(desktop.starts.length, 2);
});

test('does not retry a follower start when Desktop cannot prove the owner lookup missed', async () => {
  const desktop = new FakeDesktop();
  desktop.startFailures.push(new DesktopIpcRequestError(
    'DESKTOP_IPC_REMOTE_REJECTED',
    'DEFINITIVE_FAILURE',
    1,
    'thread-follower-start-turn',
    'request-1',
  ));
  const openedThreadIds: string[] = [];
  const orchestrator = new InMemoryOrchestrator(
    config,
    desktop as unknown as DesktopIpcClient,
    new FakeCards(),
    {
      navigation: {
        openThread: async (threadId: string) => {
          openedThreadIds.push(threadId);
        },
      },
      navigationRetryDelayMs: 1,
    },
  );

  assert.equal(await orchestrator.handleInbound(message('remote-rejected', 'hello'), binding), 'started');
  assert.deepEqual(openedThreadIds, []);
  assert.equal(desktop.starts.length, 1);
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
    sendCard: async () => 'card-message-1',
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
    sendCard: async () => 'card-message-1',
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
            // The Desktop currently returns the remaining weekly window in
            // `primary`; `secondary` is absent after the 5h window removal.
            primary: {
              usedPercent: 12,
              resetsAt: 1_784_016_000,
              windowDurationMins: 10_080,
            },
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
  assert.ok(serialized.includes('gpt-5.6-sol'));
  assert.match(serialized, /API 3/);
  assert.ok(serialized.includes('上下文 12.3K/128.0K'));
  assert.doesNotMatch(serialized, /5h/);
  assert.ok(serialized.includes('7d: 12%'));
  assert.ok(serialized.includes('点数: 7'));
  assert.equal(cards.closed, 1);
});
