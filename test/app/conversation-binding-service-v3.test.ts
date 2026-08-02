import assert from 'node:assert/strict';
import test from 'node:test';

import type { BindingStore, ChatThreadBinding } from '../../src/app/binding-store';
import type { CardKitJson } from '../../src/app/cards/layouts';
import {
  ConversationBindingServiceV3,
  type BindingCardsV3,
  type BindingCatalogV3,
} from '../../src/app/conversation-binding-service-v3';
import type { BridgeConfig } from '../../src/app/domain';

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
  threadId: 'thread-active',
  threadTitle: 'Active task',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

test('binding pushes latest history when Desktop projection is unknown', async () => {
  const catalogRequests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string, params: unknown): Promise<TResult> => {
      catalogRequests.push({ method, params });
      if (method !== 'thread/resume') {
        throw new Error(`unexpected method: ${method}`);
      }
      return completedThreadResumeResponse() as TResult;
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (_card: CardKitJson) => 'card',
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      throw new Error('Desktop snapshot is not available yet');
    },
  );

  await (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  assert.deepEqual(catalogRequests.map((request) => request.method), ['thread/resume']);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.chatId, binding.chatId);
  assert.match(sentCards[0]?.idempotencyKey ?? '', /history:picker-message:thread-active:turn-completed/);
});

test('binding pushes only the newest terminal history turn by timestamp', async () => {
  const createdCards: CardKitJson[] = [];
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string): Promise<TResult> => {
      if (method !== 'thread/resume') {
        throw new Error(`unexpected method: ${method}`);
      }
      return threadResumeResponseWithTurns([
        completedTurn('turn-newest', 'new prompt', 'newest answer', 3_000, 4_000),
        completedTurn('turn-middle', 'middle prompt', 'middle answer', 2_000, 3_000),
        completedTurn('turn-oldest', 'old prompt', 'old answer', 1_000, 2_000),
      ]) as TResult;
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (card: CardKitJson) => {
      createdCards.push(card);
      return `card-${createdCards.length}`;
    },
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => false,
  );

  await (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0]?.idempotencyKey ?? '', /turn-newest/);
  const cardJson = JSON.stringify(createdCards[0]);
  assert.match(cardJson, /newest answer/);
  assert.doesNotMatch(cardJson, /old answer/);
  assert.doesNotMatch(cardJson, /middle answer/);
});

test('binding does not push stale history after the chat is rebound again', async () => {
  let currentBinding: ChatThreadBinding | undefined = binding;
  let projectionStarted = false;
  let resolveProjection: ((value: boolean) => void) | undefined;
  const catalogRequests: string[] = [];
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string): Promise<TResult> => {
      catalogRequests.push(method);
      return completedThreadResumeResponse() as TResult;
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (_card: CardKitJson) => 'card',
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => currentBinding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      projectionStarted = true;
      return new Promise<boolean>((resolve) => {
        resolveProjection = resolve;
      });
    },
  );
  const sideEffect = (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  await waitFor(() => projectionStarted);
  currentBinding = {
    ...binding,
    threadId: 'thread-new-binding',
    revision: binding.revision + 1,
  };
  resolveProjection?.(false);
  await sideEffect;

  assert.deepEqual(catalogRequests, []);
  assert.equal(sentCards.length, 0);
});

test('binding sends at most one history card for concurrent same-revision side effects', async () => {
  let resumeCalls = 0;
  let releaseResume: (() => void) | undefined;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string): Promise<TResult> => {
      if (method !== 'thread/resume') {
        throw new Error(`unexpected method: ${method}`);
      }
      resumeCalls += 1;
      await resumeGate;
      return completedThreadResumeResponse() as TResult;
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (_card: CardKitJson) => 'card',
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => false,
  );
  const completeBindingSideEffects = (selectedBinding: ChatThreadBinding, messageId: string) => (
    service as unknown as {
      completeBindingSideEffects(
        binding: ChatThreadBinding,
        messageId: string,
      ): Promise<void>;
    }
  ).completeBindingSideEffects(selectedBinding, messageId);

  const first = completeBindingSideEffects(binding, 'picker-message');
  const second = completeBindingSideEffects(binding, 'picker-message');
  await waitFor(() => resumeCalls === 1);
  releaseResume?.();
  await Promise.all([first, second]);

  assert.equal(resumeCalls, 1);
  assert.equal(sentCards.length, 1);
});

test('binding skips history when Desktop projection reports active turn', async () => {
  let catalogRequests = 0;
  const catalog: BindingCatalogV3 = {
    request: async () => {
      catalogRequests += 1;
      throw new Error('App Server history must not be queried for an active Desktop turn');
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (_card: CardKitJson) => 'card',
    replyCard: async () => 'message',
    sendCard: async () => 'message',
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => true,
  );

  await (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  assert.equal(catalogRequests, 0);
});

test('binding skips stale history when App Server reports the thread is active', async () => {
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string): Promise<TResult> => {
      if (method !== 'thread/resume') {
        throw new Error(`unexpected method: ${method}`);
      }
      const response = threadResumeResponseWithTurns([
        completedTurn('turn-old', 'old prompt', 'old answer', 1_000, 2_000),
      ]) as {
        readonly thread: { status: { type: string } };
      };
      response.thread.status = { type: 'active' };
      return response as TResult;
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (_card: CardKitJson) => 'card',
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => false,
  );

  await (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  assert.equal(sentCards.length, 0);
});

test('binding sends a failure card when latest history cannot be read', async () => {
  const sentCards: Array<{ readonly chatId: string; readonly cardId: string; readonly idempotencyKey?: string }> = [];
  const createdCards: CardKitJson[] = [];
  const logs: Array<{
    readonly level: string;
    readonly event: string;
    readonly error?: unknown;
    readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
  }> = [];
  const catalog: BindingCatalogV3 = {
    request: async () => {
      throw Object.assign(
        new Error('App Server control-plane request failed'),
        { code: 'REQUEST_FAILED', name: 'AppServerControlPlaneError' },
      );
    },
  };
  const cards: BindingCardsV3 = {
    createCard: async (card: CardKitJson) => {
      createdCards.push(card);
      return `card-${createdCards.length}`;
    },
    replyCard: async () => 'message',
    sendCard: async (chatId, cardId, idempotencyKey) => {
      sentCards.push({ chatId, cardId, idempotencyKey });
      return 'message';
    },
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => binding,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    undefined,
    undefined,
    {
      info: (event, fields) => logs.push({ level: 'info', event, fields }),
      warn: (event, fields) => logs.push({ level: 'warn', event, fields }),
      error: (event, error, fields) => logs.push({ level: 'error', event, error, fields }),
    },
    undefined,
    undefined,
    async () => false,
  );

  await (service as unknown as {
    completeBindingSideEffects(
      selectedBinding: ChatThreadBinding,
      messageId: string,
    ): Promise<void>;
  }).completeBindingSideEffects(binding, 'picker-message');

  assert.deepEqual(logs.filter((log) => log.level === 'error').map((log) => log.event), ['history_push_failed']);
  const failureLog = logs.find((log) => log.event === 'history_push_failed');
  assert.equal(failureLog?.fields?.source, 'card_action');
  assert.equal(failureLog?.fields?.threadId, binding.threadId);
  assert.equal(failureLog?.fields?.idempotencyPrefix, 'history:picker-message:thread-active');
  assert.equal((failureLog?.error as { readonly code?: unknown } | undefined)?.code, 'REQUEST_FAILED');
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.chatId, binding.chatId);
  assert.equal(sentCards[0]?.idempotencyKey, 'history:picker-message:thread-active:history-failed');
  assert.match(JSON.stringify(createdCards[0]), /绑定已完成/);
  assert.match(JSON.stringify(createdCards[0]), /历史推送失败/);
  assert.match(JSON.stringify(createdCards[0]), /REQUEST_FAILED/);
});

for (const command of ['/l', '/ll']) {
  test(`${command} scans thread/list pages before filtering by local workspace`, async () => {
    await assertCommandScansThreadListPages(command);
  });
}

function completedThreadResumeResponse(): unknown {
  return threadResumeResponseWithTurns([
    completedTurn('turn-completed', 'hello', 'done', 1_000, 2_000),
  ]);
}

function threadResumeResponseWithTurns(turns: readonly unknown[]): unknown {
  return {
    thread: {
      id: binding.threadId,
      sessionId: 'session',
      preview: 'hello',
      cwd: binding.workspaceId,
      modelProvider: 'openai',
      status: { type: 'idle' },
      name: binding.threadTitle,
      turns,
    },
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    cwd: binding.workspaceId,
    initialTurnsPage: null,
  };
}

function completedTurn(
  id: string,
  prompt: string,
  answer: string,
  startedAt: number,
  completedAt: number,
): unknown {
  return {
    id,
    input: [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }],
    items: [{
      id: `${id}-user`,
      type: 'userMessage',
      text: prompt,
    }, {
      id: `${id}-final`,
      type: 'agentMessage',
      phase: 'final_answer',
      text: answer,
    }],
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt,
    completedAt,
    durationMs: (completedAt - startedAt) * 1_000,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true);
}

async function assertCommandScansThreadListPages(command: string): Promise<void> {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const catalog: BindingCatalogV3 = {
    request: async <TResult>(method: string, params: unknown): Promise<TResult> => {
      requests.push({ method, params });
      const cursor = params && typeof params === 'object' && 'cursor' in params
        ? (params as { readonly cursor?: unknown }).cursor
        : null;
      if (method !== 'thread/list') {
        throw new Error(`unexpected method: ${method}`);
      }
      if (cursor === null) {
        return {
          data: Array.from({ length: 99 }, (_unused, index) => ({
            id: `other-${index}`,
            name: `Other ${index}`,
            cwd: `/Users/jiang/work/ai/other/${index}`,
            updatedAt: 2_000 - index,
          })),
          nextCursor: 'page-2',
          backwardsCursor: null,
        } as TResult;
      }
      assert.equal(cursor, 'page-2');
      return {
        data: [{
          id: 'thread-bridge',
          name: 'codex-feishu-bridage',
          cwd: '/Users/jiang/work/ai/codex/bridge',
          updatedAt: 1_000,
        }],
        nextCursor: null,
        backwardsCursor: null,
      } as TResult;
    },
  };
  const createdCards: CardKitJson[] = [];
  const cards: BindingCardsV3 = {
    createCard: async (card: CardKitJson) => {
      createdCards.push(card);
      return 'card';
    },
    replyCard: async () => 'message',
    sendCard: async () => 'message',
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
  };
  const store = {
    get: () => undefined,
  } as unknown as BindingStore;
  const service = new ConversationBindingServiceV3(
    config,
    store,
    catalog,
    cards,
    () => 1_000,
    undefined,
    undefined,
    async () => ({
      savedWorkspaces: ['/Users/jiang/work/ai/codex/bridge'],
      workspaceLabels: { '/Users/jiang/work/ai/codex/bridge': 'bridge' },
      projectlessThreadIds: [],
      localProjects: {},
      threadProjectAssignments: {},
    }),
  );

  const handled = await service.handleCommand({
    tenantKey: 'tenant',
    eventId: 'event',
    messageId: 'message',
    chatId: 'chat',
    rootMessageId: 'message',
    senderOpenId: 'user',
    text: command,
    payloadDigest: 'digest',
    createdAtMs: 1_000,
  });

  assert.equal(handled, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.method), ['thread/list', 'thread/list']);
  assert.equal((requests[1]?.params as { readonly cursor?: unknown }).cursor, 'page-2');
  assert.match(JSON.stringify(createdCards[0]), /codex-feishu-bridage/);
}

for (const command of ['/l', '/ll']) {
  test(`${command} includes threads assigned to the local project when cwd is stale`, async () => {
    const catalog: BindingCatalogV3 = {
      request: async <TResult>(method: string): Promise<TResult> => {
        if (method !== 'thread/list') {
          throw new Error(`unexpected method: ${method}`);
        }
        return {
          data: [{
            id: 'thread-bridge',
            name: 'codex-feishu-bridage',
            cwd: '/Users/jiang/Documents/Codex/2026-07-13/app-server-app-server-ui-codex',
            updatedAt: 1_000,
          }],
          nextCursor: null,
          backwardsCursor: null,
        } as TResult;
      },
    };
    const createdCards: CardKitJson[] = [];
    const cards: BindingCardsV3 = {
      createCard: async (card: CardKitJson) => {
        createdCards.push(card);
        return 'card';
      },
      replyCard: async () => 'message',
      sendCard: async () => 'message',
      replaceCard: async (_cardId, _card, sequence) => sequence + 1,
    };
    const store = {
      get: () => undefined,
    } as unknown as BindingStore;
    const service = new ConversationBindingServiceV3(
      config,
      store,
      catalog,
      cards,
      () => 1_000,
      undefined,
      undefined,
      async () => ({
        savedWorkspaces: ['/Users/jiang/work/ai/codex/bridge'],
        workspaceLabels: {},
        projectlessThreadIds: [],
        localProjects: {
          'local-bridge': {
            id: 'local-bridge',
            name: 'bridge',
            rootPaths: ['/Users/jiang/work/ai/codex/bridge'],
          },
        },
        threadProjectAssignments: {
          'thread-bridge': {
            projectKind: 'local',
            projectId: 'local-bridge',
            path: '/Users/jiang/work/ai/codex/bridge',
            cwd: '/Users/jiang/work/ai/codex/bridge',
          },
        },
      }),
    );

    const handled = await service.handleCommand({
      tenantKey: 'tenant',
      eventId: `event-${command}`,
      messageId: 'message',
      chatId: 'chat',
      rootMessageId: 'message',
      senderOpenId: 'user',
      text: command,
      payloadDigest: 'digest',
      createdAtMs: 1_000,
    });

    const cardJson = JSON.stringify(createdCards[0]);
    assert.equal(handled, true);
    assert.match(cardJson, /codex-feishu-bridage/);
    assert.match(cardJson, /bridge/);
  });
}
