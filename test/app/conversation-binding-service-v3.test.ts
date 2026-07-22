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
