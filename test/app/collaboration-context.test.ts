import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import type { LarkBotConfig } from '../../src/app/bot-config-store';
import { buildCollaborationContext } from '../../src/app/collaboration/collaboration-context';

test('collaboration context is omitted when no other responding bot is bound', () => {
  assert.equal(buildCollaborationContext({
    binding: sourceBinding,
    currentBot: searchBot,
    bots: [searchBot, orderBot],
    targetBindings: [],
  }), null);
});

test('collaboration context includes enabled responding bots bound to the same group', () => {
  const context = buildCollaborationContext({
    binding: sourceBinding,
    currentBot: searchBot,
    bots: [searchBot, orderBot, { ...pricingBot, enabled: false }],
    targetBindings: [targetBinding, pricingBinding],
  });

  assert.match(context ?? '', /Order Bot/);
  assert.match(context ?? '', /订单组/);
  assert.match(context ?? '', /```cfb-handoff/);
  assert.doesNotMatch(context ?? '', /Pricing Bot/);
});

test('collaboration context includes discovered external bots in the same group', () => {
  const context = buildCollaborationContext({
    binding: sourceBinding,
    currentBot: searchBot,
    bots: [searchBot],
    targetBindings: [],
    externalTargets: [{
      sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
      tenantKey: 'tenant',
      chatId: 'chat',
      botOpenId: 'ou_external_order',
      displayName: 'External Order Bot',
      discoveredAtMs: 1,
      updatedAtMs: 1,
    }],
  });

  assert.match(context ?? '', /External Order Bot/);
  assert.match(context ?? '', /externalBotOpenId=ou_external_order/);
  assert.match(context ?? '', /external=true/);
});

const sourceBinding: ChatThreadBinding = {
  botKey: 'cli_aaaaaaaaaaaaaaaa',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-search',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const targetBinding: ChatThreadBinding = {
  botKey: 'cli_bbbbbbbbbbbbbbbb',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-order',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const pricingBinding: ChatThreadBinding = {
  botKey: 'cli_cccccccccccccccc',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-pricing',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const searchBot = bot('cli_aaaaaaaaaaaaaaaa', 'Search Bot', '搜索组', '擅长搜索排查');
const orderBot = bot('cli_bbbbbbbbbbbbbbbb', 'Order Bot', '订单组', '擅长下单排查');
const pricingBot = bot('cli_cccccccccccccccc', 'Pricing Bot', '价格组', '擅长价格排查');

function bot(
  botKey: string,
  displayName: string,
  ownerLabel: string,
  domainDescription: string,
): LarkBotConfig {
  return {
    botKey,
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    enabled: true,
    tenantKey: 'tenant',
    allowedChats: ['chat'],
    authorizedUsers: ['owner'],
    allowedApprovers: ['owner'],
    allowGroupUserMentions: true,
    allowExternalGroupUserMentions: true,
    allowGroupBotMentions: true,
    botOpenId: `ou_${botKey}`,
    displayName,
    roleProfile: {
      roleName: displayName,
      ownerLabel,
      domainDescription,
    },
    source: 'import',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
