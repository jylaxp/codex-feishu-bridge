import assert from 'node:assert/strict';
import test from 'node:test';

import { BridgeConfig } from '../../src/app/domain';
import {
  LarkEventServer,
  LarkWebSocketClient,
  normalizeCardAction,
} from '../../src/app/lark/event-server';
import { RawMessageEvent } from '../../src/app/lark/intake';

const config: BridgeConfig = {
  larkAppId: 'app-test',
  larkAppSecret: 'secret-test',
  larkTenantKey: 'tenant-test',
  allowedChats: ['chat-test'],
  authorizedUsers: ['user-test'],
  allowedApprovers: ['approver-test'],
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/usr/local/bin/codex',
  codexCwd: '/workspace/project',
  allowedWorkspaceRoots: ['/workspace'],
  dataDir: '/var/lib/bridge',
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1_500,
  maxQueuedTasks: 100,
};

test('normalizes a scoped card action without exposing arbitrary callback fields', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-test' },
    operator: { open_id: 'approver-test' },
    action: {
      value: {
        action: 'approval',
        token: 'opaque_token-123',
        threadId: 'must-not-be-copied',
      },
    },
  }, config);

  assert.deepEqual(action, {
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    messageId: 'message-test',
    operatorOpenId: 'approver-test',
    action: 'approval',
    token: 'opaque_token-123',
  });
});

test('normalizes a signed conversation-binding card action', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
    operator: { open_id: 'user-test' },
    action: { value: { action: 'binding', token: 'b1.exp.revision.thread.signature' } },
  }, config);

  assert.deepEqual(action, {
    tenantKey: 'tenant-test',
    chatId: 'chat-test',
    messageId: 'message-card',
    operatorOpenId: 'user-test',
    action: 'binding',
    token: 'b1.exp.revision.thread.signature',
  });
});

test('normalizes a signed bound-thread open action', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
    operator: { open_id: 'user-test' },
    action: { value: { action: 'open', token: 'b1.exp.revision.thread.signature' } },
  }, config);

  assert.equal(action?.action, 'open');
  assert.equal(action?.token, 'b1.exp.revision.thread.signature');
});

test('accepts a bounded signed binding token larger than an opaque action token', () => {
  const token = `${'a'.repeat(260)}.${'b'.repeat(43)}`;
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
    operator: { open_id: 'user-test' },
    action: { value: { action: 'binding', token } },
  }, config);

  assert.equal(action?.token, token);
});

test('reads the signed binding token from a select_static option', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
    operator: { open_id: 'user-test' },
    action: {
      value: { action: 'binding' },
      option: { value: 'selected-binding-token' },
    },
  }, config);

  assert.equal(action?.action, 'binding');
  assert.equal(action?.token, 'selected-binding-token');
});

test('reads the current Feishu select_static string option callback', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
    operator: { open_id: 'user-test' },
    action: {
      value: { action: 'binding' },
      option: 'selected-binding-token',
    },
  }, config);

  assert.equal(action?.action, 'binding');
  assert.equal(action?.token, 'selected-binding-token');
});

test('rejects card actions from another chat or with malformed tokens', () => {
  const baseEvent = {
    tenant_key: 'tenant-test',
    context: { open_chat_id: 'chat-test', open_message_id: 'message-test' },
    operator: { open_id: 'approver-test' },
    action: { value: { action: 'cancel', token: 'opaque-token' } },
  } as const;

  assert.equal(normalizeCardAction({
    ...baseEvent,
    context: { ...baseEvent.context, open_chat_id: 'other-chat' },
  }, config), null);
  assert.equal(normalizeCardAction({
    ...baseEvent,
    action: { value: { action: 'cancel', token: 'contains spaces' } },
  }, config), null);
  const { tenant_key: _tenantKey, ...missingTenant } = baseEvent;
  assert.equal(normalizeCardAction(missingTenant, config), null);
});

test('propagates message handler failures so the WebSocket delivery is retryable', async () => {
  class FakeWebSocket implements LarkWebSocketClient {
    public dispatcher: { readonly handles: Map<string, Function> } | undefined;

    public async start(params: Parameters<LarkWebSocketClient['start']>[0]): Promise<void> {
      this.dispatcher = params.eventDispatcher;
    }

    public close(): void {}
  }

  const websocket = new FakeWebSocket();
  let reportedErrors = 0;
  const server = new LarkEventServer(websocket, config, {
    onMessage: async () => {
      throw new Error('durable inbox failed');
    },
    onCardAction: async () => ({}),
    onHandlerError: () => {
      reportedErrors += 1;
    },
  });
  await server.start();
  const handler = websocket.dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(handler);

  const event: RawMessageEvent = {
    app_id: 'app-test',
    event_id: 'event-test',
    tenant_key: 'tenant-test',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-test',
      sender_id: { open_id: 'user-test' },
    },
    message: {
      message_id: 'message-test',
      chat_id: 'chat-test',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: 'run checks' }),
    },
  };
  await assert.rejects(handler(event), /durable inbox failed/);
  assert.equal(reportedErrors, 1);
});
