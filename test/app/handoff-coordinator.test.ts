import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import type { LarkBotConfig } from '../../src/app/bot-config-store';
import { HandoffCoordinator } from '../../src/app/collaboration/handoff-coordinator';
import { HandoffChainStore } from '../../src/app/collaboration/handoff-chain-store';
import type { HandoffMessageEmitter, HandoffMessage } from '../../src/app/lark/handoff-message-emitter';

test('handoff coordinator validates and emits a target bot mention', async () => {
  const sent: HandoffMessage[] = [];
  const coordinator = coordinatorWith({ sent });

  const result = await coordinator.handleTerminalHandoff({
    sourceBotKey: 'bot_aaaaaaaaaaaa',
    tenantKey: 'tenant',
    chatId: 'chat',
    rootMessageId: 'root',
    messageId: 'message',
    threadId: 'thread-search',
    binding: sourceBinding,
    finalAnswer: finalAnswerWithDirective(),
  });

  assert.equal(result?.emitted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.targetBotOpenId, 'ou_order');
  assert.match(result?.finalAnswer ?? '', /已交接给 Order Bot/);
  assert.doesNotMatch(result?.finalAnswer ?? '', /```cfb-handoff/);
});

test('handoff coordinator blocks when target bot does not respond to group bot mentions', async () => {
  const sent: HandoffMessage[] = [];
  const coordinator = coordinatorWith({
    sent,
    targetBot: { ...orderBot, allowGroupBotMentions: false },
  });

  const result = await coordinator.handleTerminalHandoff({
    sourceBotKey: 'bot_aaaaaaaaaaaa',
    tenantKey: 'tenant',
    chatId: 'chat',
    rootMessageId: 'root',
    messageId: 'message',
    threadId: 'thread-search',
    binding: sourceBinding,
    finalAnswer: finalAnswerWithDirective(),
  });

  assert.equal(result?.emitted, false);
  assert.equal(sent.length, 0);
  assert.match(result?.finalAnswer ?? '', /已关闭群机器人 @ 响应/);
});

test('handoff coordinator blocks when target runner is unavailable', async () => {
  const sent: HandoffMessage[] = [];
  const coordinator = coordinatorWith({
    sent,
    runnerReady: false,
  });

  const result = await coordinator.handleTerminalHandoff({
    sourceBotKey: 'bot_aaaaaaaaaaaa',
    tenantKey: 'tenant',
    chatId: 'chat',
    rootMessageId: 'root',
    messageId: 'message',
    threadId: 'thread-search',
    binding: sourceBinding,
    finalAnswer: finalAnswerWithDirective(),
  });

  assert.equal(result?.emitted, false);
  assert.equal(sent.length, 0);
  assert.match(result?.finalAnswer ?? '', /执行路由未就绪/);
});

function coordinatorWith(options: {
  readonly sent: HandoffMessage[];
  readonly targetBinding?: ChatThreadBinding;
  readonly targetBot?: LarkBotConfig;
  readonly runnerReady?: boolean;
}): HandoffCoordinator {
  const emitter = {
    send: async (message: HandoffMessage) => {
      options.sent.push(message);
      return 'message-handoff';
    },
  } as HandoffMessageEmitter;
  return new HandoffCoordinator({
    now: () => 1_000,
    bots: () => [searchBot, options.targetBot ?? orderBot],
    bindingFor: (_tenantKey, _chatId, botKey) => (
      botKey === 'bot_bbbbbbbbbbbb' ? options.targetBinding ?? targetBinding : undefined
    ),
    emitterForSourceBot: () => emitter,
    runnerReadinessForBinding: () => (
      options.runnerReady === false
        ? { ready: false, reason: 'desktop_ipc_not_ready' }
        : { ready: true }
    ),
    chainStore: new HandoffChainStore({ now: () => 1_000, cooldownMs: 1 }),
  });
}

function finalAnswerWithDirective(): string {
  return [
    '搜索侧已确认价格有效。',
    '',
    '```cfb-handoff',
    'target: Order Bot',
    'task: 排查订单创建失败',
    'context: requestId=req-1',
    '```',
  ].join('\n');
}

const sourceBinding: ChatThreadBinding = {
  botKey: 'bot_aaaaaaaaaaaa',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-search',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const targetBinding: ChatThreadBinding = {
  botKey: 'bot_bbbbbbbbbbbb',
  tenantKey: 'tenant',
  chatId: 'chat',
  threadId: 'thread-order',
  workspaceId: '/workspace',
  revision: 1,
  updatedAtMs: 1,
};

const searchBot = bot('bot_aaaaaaaaaaaa', 'ou_search', 'Search Bot');
const orderBot = bot('bot_bbbbbbbbbbbb', 'ou_order', 'Order Bot');

function bot(botKey: string, botOpenId: string, displayName: string): LarkBotConfig {
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
    botOpenId,
    displayName,
    source: 'import',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}
