import assert from 'node:assert/strict';
import test from 'node:test';

import type * as Lark from '@larksuiteoapi/node-sdk';

import type { BridgeConfig } from '../../src/app/domain';
import {
  LarkEventServer,
  toast,
  type RawCardActionEvent,
} from '../../src/app/lark/event-server';
import type { InboundReplyContext, RawMessageEvent } from '../../src/app/lark/intake';

const config = {
  botKey: 'bot_release_test',
  larkAppId: 'app',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  larkBotOpenId: 'bot-open-id',
  larkBotName: 'Release Bot',
  allowedChats: ['chat'],
  authorizedUsers: ['owner'],
  allowedApprovers: ['owner'],
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
} satisfies BridgeConfig;

test('disabled bot event server replies with unavailable reason without accepting a task', async () => {
  const websocket = new FakeWebSocket();
  let acceptedMessages = 0;
  const unavailable: Array<{
    readonly context: InboundReplyContext;
    readonly reason: string;
  }> = [];
  const server = new LarkEventServer(websocket, config, {
    onMessage: async () => {
      acceptedMessages += 1;
    },
    onCardAction: async () => {
      throw new Error('card actions should not be routed for disabled bots');
    },
    onUnavailableMessage: async (context, reason) => {
      unavailable.push({ context, reason });
    },
  }, undefined, { unavailableReason: 'BOT_DISABLED' });

  await server.start();
  await websocket.dispatchMessage(groupMentionEvent('@_bot 请处理'));

  assert.equal(acceptedMessages, 0);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]?.reason, 'BOT_DISABLED');
  assert.equal(unavailable[0]?.context.botKey, 'bot_release_test');
  assert.equal(unavailable[0]?.context.chatId, 'chat');
  assert.equal(unavailable[0]?.context.chatType, 'group');
});

test('disabled bot event server stays silent when a group mentions another bot', async () => {
  const websocket = new FakeWebSocket();
  let replies = 0;
  const rejectedReasons: string[] = [];
  const server = new LarkEventServer(websocket, config, {
    onMessage: async () => {
      throw new Error('messages should not be routed for disabled bots');
    },
    onCardAction: async () => {
      throw new Error('card actions should not be routed for disabled bots');
    },
    onUnavailableMessage: async () => {
      replies += 1;
    },
    onRejectedEvent: (reason) => {
      rejectedReasons.push(reason);
    },
  }, undefined, { unavailableReason: 'BOT_DISABLED' });

  await server.start();
  await websocket.dispatchMessage(groupMentionEvent('@_other 请处理', 'other-open-id'));

  assert.equal(replies, 0);
  assert.deepEqual(rejectedReasons, ['BOT_DISABLED']);
});

test('disabled bot card actions return a reason toast without routing the action', async () => {
  const websocket = new FakeWebSocket();
  let routedActions = 0;
  const server = new LarkEventServer(websocket, config, {
    onMessage: async () => undefined,
    onCardAction: async () => {
      routedActions += 1;
      return toast('should-not-route', 'error');
    },
  }, undefined, { unavailableReason: 'BOT_DISABLED' });

  await server.start();
  const response = await websocket.dispatchCardAction({
    tenant_key: 'tenant',
    context: { open_chat_id: 'chat', open_message_id: 'card-message' },
    operator: { open_id: 'owner' },
    action: { value: { action: 'cancel', token: 'task_token' } },
  });

  assert.equal(routedActions, 0);
  assert.deepEqual(response, toast('机器人已被 Bridge 管理员禁用，当前不会处理任务。', 'warning'));
});

type DispatcherHandler = (event: unknown) => Promise<unknown> | unknown;

class FakeWebSocket {
  private dispatcher?: Lark.EventDispatcher;

  public async start(params: { readonly eventDispatcher: Lark.EventDispatcher }): Promise<void> {
    this.dispatcher = params.eventDispatcher;
  }

  public close(): void {
    this.dispatcher = undefined;
  }

  public async dispatchMessage(event: RawMessageEvent): Promise<void> {
    await this.dispatch('im.message.receive_v1', event);
  }

  public dispatchCardAction(event: RawCardActionEvent): Promise<unknown> {
    return this.dispatch('card.action.trigger', event);
  }

  private async dispatch(eventName: string, event: unknown): Promise<unknown> {
    const handler = this.dispatcher?.handles.get(eventName) as DispatcherHandler | undefined;
    if (!handler) {
      throw new Error(`No handler registered for ${eventName}`);
    }
    return handler(event);
  }
}

function groupMentionEvent(text: string, botOpenId: string = 'bot-open-id'): RawMessageEvent {
  return {
    app_id: 'app',
    event_id: `event-${botOpenId}`,
    tenant_key: 'tenant',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant',
      sender_id: { open_id: 'group-user' },
    },
    message: {
      message_id: `message-${botOpenId}`,
      root_id: `root-${botOpenId}`,
      chat_id: 'chat',
      chat_type: 'group',
      message_type: 'text',
      create_time: String(Date.now()),
      content: JSON.stringify({ text }),
      mentions: [{ key: text.split(' ')[0] ?? '@_bot', id: { open_id: botOpenId } }],
    },
  };
}
