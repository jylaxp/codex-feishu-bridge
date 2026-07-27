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

test('binding does not classify Desktop state from App Server history when projection is unknown', async () => {
  let catalogRequests = 0;
  const catalog: BindingCatalogV3 = {
    request: async () => {
      catalogRequests += 1;
      throw new Error('App Server history must not be queried');
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

  assert.equal(catalogRequests, 0);
});

for (const command of ['/l', '/ll']) {
  test(`${command} scans thread/list pages before filtering by local workspace`, async () => {
    await assertCommandScansThreadListPages(command);
  });
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
