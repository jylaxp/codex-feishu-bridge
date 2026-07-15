import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BindingStore } from '../../src/app/binding-store';
import type { CardKitJson } from '../../src/app/cards/layouts';
import { ConversationBindingServiceV3 } from '../../src/app/conversation-binding-service-v3';
import type { BridgeConfig } from '../../src/app/domain';
import type { InboundTextMessage } from '../../src/app/lark/intake';

const config: BridgeConfig = {
  larkAppId: 'cli_0123456789abcdef',
  larkAppSecret: 'binding-secret',
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
  cardUpdateIntervalMs: 1_000,
  maxQueuedTasks: 10,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

function inbound(text: string): InboundTextMessage {
  return {
    tenantKey: 'tenant',
    eventId: 'event-1',
    messageId: 'message-1',
    chatId: 'chat',
    rootMessageId: 'root-1',
    senderOpenId: 'user',
    text,
    payloadDigest: 'digest',
    createdAtMs: 1,
  };
}

class FakeCards {
  public readonly cards: CardKitJson[] = [];
  public readonly sent: Array<{
    readonly chatId: string;
    readonly cardId: string;
    readonly idempotencyKey: string;
  }> = [];

  public async createCard(card: CardKitJson): Promise<string> {
    this.cards.push(card);
    return `card-${this.cards.length}`;
  }

  public async replyCard(): Promise<string> {
    return 'card-message';
  }

  public async sendCard(chatId: string, cardId: string, idempotencyKey: string): Promise<string> {
    this.sent.push({ chatId, cardId, idempotencyKey });
    return 'card-message';
  }
}

function firstBindingToken(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const picker = body.elements.find((element) => element.tag === 'select_static');
  const options = picker?.options as Array<{ value?: unknown }> | undefined;
  const token = options?.[0]?.value;
  assert.equal(typeof token, 'string');
  return token as string;
}

function pickerOptionLabels(card: CardKitJson): string[] {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const picker = body.elements.find((element) => element.tag === 'select_static');
  const options = picker?.options as Array<{ text?: { content?: unknown } }> | undefined;
  return (options ?? []).map((option) => {
    const content = option.text?.content;
    assert.equal(typeof content, 'string');
    return content as string;
  });
}

function openToken(card: CardKitJson): string {
  const body = card.body as { elements: Array<Record<string, unknown>> };
  const button = body.elements.find((element) => element.tag === 'button');
  const value = button?.value as { token?: unknown } | undefined;
  assert.equal(typeof value?.token, 'string');
  return value?.token as string;
}

test('binds only an explicit signed picker choice to the current Feishu chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root, { now: () => 100 });
    store.load();
    const cards = new FakeCards();
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(method: string, params: unknown): Promise<TResult> => {
          calls.push({ method, params });
          if (method === 'thread/list') {
            return { data: [{ id: 'thread-selected', name: 'Feishu test', updatedAt: 1 }] } as TResult;
          }
          if (method === 'thread/resume') {
            return { thread: { id: 'thread-selected', turns: [] } } as TResult;
          }
          assert.equal(method, 'thread/read');
          return { thread: { id: 'thread-selected' } } as TResult;
        },
      },
      cards,
      () => 1_000,
    );

    assert.equal(await service.handleCommand(inbound('/bind')), true);
    const token = firstBindingToken(cards.cards[0]!);
    const result = await service.handleCardAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      messageId: 'card-message',
      operatorOpenId: 'user',
      token,
    });

    assert.deepEqual(result, {
      toast: {
        type: 'warning',
        content: '绑定成功；未能自动打开 ChatGPT 会话，可发送 /open 重试',
        i18n: {
          zh_cn: '绑定成功；未能自动打开 ChatGPT 会话，可发送 /open 重试',
          en_us: '绑定成功；未能自动打开 ChatGPT 会话，可发送 /open 重试',
        },
      },
    });
    assert.equal(store.get('tenant', 'chat')?.threadId, 'thread-selected');
    assert.deepEqual(calls.map((call) => call.method), ['thread/list', 'thread/read', 'thread/resume']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pushes the latest terminal ChatGPT history card immediately after binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root, { now: () => 100 });
    store.load();
    const cards = new FakeCards();
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(method: string): Promise<TResult> => {
          if (method === 'thread/list') {
            return { data: [{ id: 'thread-selected', name: 'Feishu test', updatedAt: 1 }] } as TResult;
          }
          if (method === 'thread/resume') {
            return {
              thread: {
                id: 'thread-selected',
                turns: [{
                  id: 'turn-old',
                  status: 'completed',
                  input: [{ type: 'text', text: 'old prompt', text_elements: [] }],
                  items: [{ id: 'old-answer', type: 'agentMessage', phase: 'final_answer', text: 'old answer' }],
                  itemsView: 'full',
                  error: null,
                  startedAt: 100,
                  completedAt: 200,
                  durationMs: 100,
                }, {
                  id: 'turn-latest',
                  status: 'completed',
                  input: [{ type: 'text', text: 'latest prompt', text_elements: [] }],
                  items: [
                    { id: 'latest-reasoning', type: 'agentMessage', phase: 'commentary', text: 'thinking' },
                    { id: 'latest-tool', type: 'commandExecution', command: 'npm test', exitCode: 0 },
                    { id: 'latest-answer', type: 'agentMessage', phase: 'final_answer', text: 'latest answer' },
                  ],
                  itemsView: 'full',
                  error: null,
                  startedAt: 300,
                  completedAt: 450,
                  durationMs: 150,
                }, {
                  id: 'turn-running',
                  status: 'inProgress',
                  input: [{ type: 'text', text: 'running prompt', text_elements: [] }],
                  items: [],
                  itemsView: 'full',
                  error: null,
                  startedAt: 500,
                  completedAt: null,
                  durationMs: null,
                }],
              },
              model: 'gpt-5.6-sol',
            } as TResult;
          }
          return { thread: { id: 'thread-selected' } } as TResult;
        },
      },
      cards,
      () => 1_000,
    );

    await service.handleCommand(inbound('/bind'));
    await service.handleCardAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      messageId: 'card-message',
      operatorOpenId: 'user',
      token: firstBindingToken(cards.cards[0]!),
    });

    assert.deepEqual(cards.sent, [{
      chatId: 'chat',
      cardId: 'card-2',
      idempotencyKey: 'history:card-message:thread-selected:turn-latest',
    }]);
    const historyCard = JSON.stringify(cards.cards[1]!);
    assert.match(historyCard, /\[历史\]/);
    assert.match(historyCard, /latest prompt/);
    assert.match(historyCard, /thinking/);
    assert.match(historyCard, /npm test/);
    assert.match(historyCard, /latest answer/);
    assert.doesNotMatch(historyCard, /old prompt|running prompt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pushes bound thread history when opening the picker for an already bound chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root, { now: () => 100 });
    store.load();
    store.bind({ tenantKey: 'tenant', chatId: 'chat', threadId: 'thread-bound', workspaceId: '/workspace' });
    const cards = new FakeCards();
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(method: string): Promise<TResult> => {
          if (method === 'thread/list') {
            return { data: [{ id: 'thread-bound', name: 'Feishu test', updatedAt: 1 }] } as TResult;
          }
          assert.equal(method, 'thread/resume');
          return {
            thread: {
              id: 'thread-bound',
              turns: [{
                id: 'turn-latest',
                status: 'completed',
                input: [{ type: 'text', text: 'bound prompt', text_elements: [] }],
                items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'bound answer' }],
                itemsView: 'full',
                error: null,
                startedAt: 300,
                completedAt: 450,
                durationMs: 150,
              }],
            },
            model: 'gpt-5.6-sol',
          } as TResult;
        },
      },
      cards,
      () => 1_000,
    );

    assert.equal(await service.handleCommand(inbound('/l')), true);

    assert.deepEqual(cards.sent, [{
      chatId: 'chat',
      cardId: 'card-2',
      idempotencyKey: 'history:message-1:thread-bound:turn-latest',
    }]);
    assert.match(JSON.stringify(cards.cards[1]!), /bound prompt/);
    assert.match(JSON.stringify(cards.cards[1]!), /bound answer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renders picker option labels as plain text without markdown escaping', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root);
    store.load();
    const cards = new FakeCards();
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(): Promise<TResult> => (
          {
            data: [
              { id: 'thread-1', name: 'codex-feishu-bridge', cwd: '/workspace/app-server', updatedAt: 1 },
              { id: 'thread-2', name: 'search-core', cwd: '/workspace/search-ai', updatedAt: 1 },
              { id: 'thread-3', name: 'price/compare', cwd: '/workspace/project', updatedAt: 1 },
            ],
          } as TResult
        ),
      },
      cards,
      () => 1_000,
    );

    assert.equal(await service.handleCommand(inbound('/l')), true);

    const labels = pickerOptionLabels(cards.cards[0]!);
    assert.deepEqual(labels, [
      '💬 codex-feishu-bridge (📁 app-server)',
      '💬 search-core (📁 search-ai)',
      '💬 price/compare (📁 project)',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('opens the exact bound thread after binding and through /open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root);
    store.load();
    const cards = new FakeCards();
    const opened: string[] = [];
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(method: string): Promise<TResult> => (
          method === 'thread/list'
            ? { data: [{ id: 'thread-selected', name: 'Feishu test', updatedAt: 1 }] } as TResult
            : { thread: { id: 'thread-selected' } } as TResult
        ),
      },
      cards,
      () => 1_000,
      { openThread: async (threadId) => { opened.push(threadId); } },
    );

    await service.handleCommand(inbound('/bind'));
    const result = await service.handleCardAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      messageId: 'card-message',
      operatorOpenId: 'user',
      token: firstBindingToken(cards.cards[0]!),
    });
    assert.deepEqual(result, {
      toast: {
        type: 'success',
        content: '绑定成功，已打开对应 ChatGPT 会话',
        i18n: {
          zh_cn: '绑定成功，已打开对应 ChatGPT 会话',
          en_us: '绑定成功，已打开对应 ChatGPT 会话',
        },
      },
    });

    assert.equal(await service.handleCommand(inbound('/open')), true);
    assert.deepEqual(opened, ['thread-selected', 'thread-selected']);
    assert.equal(cards.cards.at(-1)?.header && (cards.cards.at(-1)?.header as { template: string }).template, 'green');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a picker token when another Feishu chat attempts to use it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root);
    store.load();
    const cards = new FakeCards();
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(): Promise<TResult> => (
          { data: [{ id: 'thread-selected', name: 'Feishu test', updatedAt: 1 }] } as TResult
        ),
      },
      cards,
      () => 1_000,
    );

    await service.handleCommand(inbound('/bind'));
    const result = await service.handleCardAction({
      tenantKey: 'tenant',
      chatId: 'other-chat',
      messageId: 'card-message',
      operatorOpenId: 'user',
      token: firstBindingToken(cards.cards[0]!),
    });

    assert.deepEqual(result, {
      toast: {
        type: 'warning',
        content: '会话选择已过期、作用域不匹配或无效，请重新 /bind',
        i18n: {
          zh_cn: '会话选择已过期、作用域不匹配或无效，请重新 /bind',
          en_us: '会话选择已过期、作用域不匹配或无效，请重新 /bind',
        },
      },
    });
    assert.equal(store.list().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps /l and /list aliases with trailing arguments on the legacy binding-picker command surface', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root);
    store.load();
    const cards = new FakeCards();
    const service = new ConversationBindingServiceV3(
      config,
      store,
      {
        request: async <TResult>(): Promise<TResult> => (
          {
            data: [{
              id: 'thread-selected', name: 'Feishu test', cwd: '/workspace/bridge',
              updatedAt: 1_752_444_800,
            }],
          } as TResult
        ),
      },
      cards,
      () => 1_000,
    );

    assert.equal(await service.handleCommand(inbound('/l filter')), true);
    assert.equal(await service.handleCommand(inbound('/list filter')), true);
    assert.equal(await service.handleCommand(inbound('/ll table')), true);
    const card = cards.cards.at(-1)!;
    const header = card.header as { title: { content: string } };
    const body = card.body as { elements: Array<Record<string, unknown>> };
    assert.equal(header.title.content, '📂 Codex 绑定会话 (Table 视图)');
    assert.equal(body.elements[0]?.tag, 'div');
    assert.equal(body.elements[1]?.tag, 'table');
    assert.equal(body.elements[2]?.tag, 'select_static');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumes a bound-thread open card action once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-v3-'));
  try {
    const store = new BindingStore(root);
    store.load();
    store.bind({ tenantKey: 'tenant', chatId: 'chat', threadId: 'thread-bound', workspaceId: '/workspace' });
    const cards = new FakeCards();
    const opened: string[] = [];
    const service = new ConversationBindingServiceV3(
      config,
      store,
      { request: async <TResult>(): Promise<TResult> => ({}) as TResult },
      cards,
      () => 1_000,
      { openThread: async (threadId) => { opened.push(threadId); } },
    );
    await service.handleCommand(inbound('/binding'));
    const action = {
      tenantKey: 'tenant', chatId: 'chat', messageId: 'card-message', operatorOpenId: 'user',
      token: openToken(cards.cards.at(-1)!),
    };
    assert.equal((await service.handleOpenAction(action) as { type: string }).type, 'success');
    assert.match(JSON.stringify(await service.handleOpenAction(action)), /已使用/);
    assert.deepEqual(opened, ['thread-bound']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
