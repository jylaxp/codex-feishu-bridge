import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatThreadBinding } from '../../src/app/binding-store';
import type { LarkBotConfig } from '../../src/app/bot-config-store';
import { HandoffCoordinator } from '../../src/app/collaboration/handoff-coordinator';
import { HandoffChainStore } from '../../src/app/collaboration/handoff-chain-store';
import type { ExternalBotDirectoryEntry } from '../../src/app/external-bot-directory';
import type { HandoffMessageEmitter, HandoffMessage } from '../../src/app/lark/handoff-message-emitter';

test('handoff coordinator validates and emits a target bot mention', async () => {
  const sent: HandoffMessage[] = [];
  const coordinator = coordinatorWith({ sent });

  const result = await coordinator.handleTerminalHandoff({
    sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
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
    sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
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
    sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
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

test('handoff coordinator emits a discovered external target bot mention', async () => {
  const sent: HandoffMessage[] = [];
  const coordinator = coordinatorWith({
    sent,
    externalTargets: [externalOrderBot],
  });

  const result = await coordinator.handleTerminalHandoff({
    sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
    tenantKey: 'tenant',
    chatId: 'chat',
    rootMessageId: 'root',
    messageId: 'message',
    threadId: 'thread-search',
    binding: sourceBinding,
    finalAnswer: [
      '搜索侧已确认价格有效。',
      '',
      '```cfb-handoff',
      'target: External Order Bot',
      'task: 排查外部订单创建失败',
      'context: requestId=req-2',
      '```',
    ].join('\n'),
  });

  assert.equal(result?.emitted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.targetBotOpenId, 'ou_external_order');
  assert.equal(sent[0]?.targetBotName, 'External Order Bot');
  assert.match(result?.finalAnswer ?? '', /已交接给 External Order Bot/);
});

function coordinatorWith(options: {
  readonly sent: HandoffMessage[];
	  readonly targetBinding?: ChatThreadBinding;
	  readonly targetBot?: LarkBotConfig;
	  readonly externalTargets?: readonly ExternalBotDirectoryEntry[];
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
	      botKey === 'cli_bbbbbbbbbbbbbbbb' ? options.targetBinding ?? targetBinding : undefined
	    ),
	    emitterForSourceBot: () => emitter,
	    externalBotDirectoryForGroup: (_sourceBotKey, _tenantKey, _chatId, selector) => {
	      const matches = (options.externalTargets ?? []).filter((entry) => (
	        entry.displayName.toLowerCase() === selector.toLowerCase()
	          || entry.botOpenId === selector
	      ));
	      if (matches.length === 0) {
	        return { status: 'not_found' };
	      }
	      if (matches.length === 1 && matches[0]) {
	        return { status: 'found', entry: matches[0] };
	      }
	      return { status: 'ambiguous', matches };
	    },
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

const searchBot = bot('cli_aaaaaaaaaaaaaaaa', 'ou_search', 'Search Bot');
const orderBot = bot('cli_bbbbbbbbbbbbbbbb', 'ou_order', 'Order Bot');

const externalOrderBot: ExternalBotDirectoryEntry = {
  sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
  tenantKey: 'tenant',
  chatId: 'chat',
  botOpenId: 'ou_external_order',
  displayName: 'External Order Bot',
  discoveredAtMs: 1,
  updatedAtMs: 1,
};

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
