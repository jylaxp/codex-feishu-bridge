import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import type { LarkBotConfig } from '../../src/app/bot-config-store';
import {
  evaluateGroupBotSenderMention,
  shouldSuppressExternalGroupUserMention,
} from '../../src/app/group-access-policy';
import type { InboundMessage } from '../../src/app/lark/intake';

const binding: ChatThreadBinding = {
  botKey: 'default',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const message: InboundMessage = {
  botKey: 'default',
  tenantKey: 'tenant',
  eventTenantKey: 'tenant',
  eventId: 'event',
  messageId: 'message',
  chatId: 'chat',
  chatType: 'group',
  rootMessageId: 'message',
  senderOpenId: 'external-user',
  senderType: 'user',
  senderTenantKey: 'external-tenant',
  externalGroupUser: true,
  messageType: 'text',
  hasExplicitText: true,
  text: 'hi',
  imageReferences: [],
  payloadDigest: 'digest',
  createdAtMs: 1,
};

test('external group user mentions are suppressed only when the binding policy is disabled', () => {
  assert.equal(
    shouldSuppressExternalGroupUserMention(message, {
      ...binding,
      allowExternalGroupUserMentions: false,
    }),
    true,
  );
  assert.equal(shouldSuppressExternalGroupUserMention(message, binding), false);
  assert.equal(shouldSuppressExternalGroupUserMention({
    ...message,
    externalGroupUser: false,
  }, {
    ...binding,
    allowExternalGroupUserMentions: false,
  }), false);
  assert.equal(shouldSuppressExternalGroupUserMention({
    ...message,
    chatType: 'p2p',
  }, {
    ...binding,
    allowExternalGroupUserMentions: false,
  }), false);
});

test('group bot sender mentions are accepted by default for MVP collaboration', () => {
  assert.deepEqual(evaluateGroupBotSenderMention({
    ...message,
    senderType: 'bot',
    senderOpenId: 'ou_source',
  }, binding, undefined), { accepted: true });
});

test('group bot sender mentions can be disabled by receiver response switch', () => {
  assert.deepEqual(evaluateGroupBotSenderMention({
    ...message,
    senderType: 'bot',
    senderOpenId: 'ou_source',
  }, binding, undefined, false), { accepted: false, reason: 'receiver_disabled' });
});

test('group bot sender slash commands are never accepted as tasks', () => {
  assert.deepEqual(evaluateGroupBotSenderMention({
    ...message,
    senderType: 'bot',
    senderOpenId: 'ou_source',
    text: '/collab accept bot_aaaaaaaaaaaa',
  }, binding, undefined), { accepted: false, reason: 'bot_sender_command' });
});

test('disabled local source bot cannot invoke a receiver binding', () => {
  assert.deepEqual(evaluateGroupBotSenderMention({
    ...message,
    senderType: 'bot',
    senderOpenId: 'ou_source',
  }, binding, sourceBot(false)), { accepted: false, reason: 'sender_disabled' });
});

function sourceBot(enabled: boolean): LarkBotConfig {
  return {
    botKey: 'bot_aaaaaaaaaaaa',
    appId: 'cli_0123456789abcdef',
    appSecret: 'secret',
    enabled,
    tenantKey: 'tenant',
    allowedChats: ['chat'],
    authorizedUsers: ['owner'],
    allowedApprovers: ['owner'],
    allowGroupUserMentions: true,
    allowExternalGroupUserMentions: true,
    allowGroupBotMentions: true,
    botOpenId: 'ou_source',
    source: 'import',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
