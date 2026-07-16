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
  maxTextLength: 10_000,
  cardUpdateIntervalMs: 1_500,
  maxQueuedTasks: 100,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
};

function emptyScopeConfig(): BridgeConfig {
  return {
    ...config,
    larkTenantKey: '',
    allowedChats: [],
  };
}

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

test('normalizes model and skill dropdown selections', () => {
  for (const kind of ['model', 'skill'] as const) {
    const action = normalizeCardAction({
      tenant_key: 'tenant-test',
      context: { open_chat_id: 'chat-test', open_message_id: 'message-card' },
      operator: { open_id: 'user-test' },
      action: {
        value: { action: kind },
        option: 'opaqueSelection123',
      },
    }, config);
    assert.equal(action?.action, kind);
    assert.equal(action?.token, 'opaqueSelection123');
  }
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

test('auto-binds an empty scope from the first authorized private chat and accepts that message', async () => {
  class FakeWebSocket implements LarkWebSocketClient {
    public dispatcher: { readonly handles: Map<string, Function> } | undefined;

    public async start(params: Parameters<LarkWebSocketClient['start']>[0]): Promise<void> {
      this.dispatcher = params.eventDispatcher;
    }

    public close(): void {}
  }

  const websocket = new FakeWebSocket();
  const savedScopes: Array<{ readonly tenantKey: string; readonly allowedChats: string }> = [];
  const acceptedMessages: string[] = [];
  const server = new LarkEventServer(websocket, emptyScopeConfig(), {
    onMessage: async (message) => {
      acceptedMessages.push(`${message.tenantKey}/${message.chatId}/${message.text}`);
    },
    onCardAction: async () => ({}),
  }, {
    save: (scope) => {
      savedScopes.push(scope);
    },
  });
  await server.start();
  const handler = websocket.dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(handler);

  await handler({
    app_id: 'app-test',
    event_id: 'event-bootstrap',
    tenant_key: 'tenant-test',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-test',
      sender_id: { open_id: 'user-test' },
    },
    message: {
      message_id: 'message-bootstrap',
      chat_id: 'chat-test',
      chat_type: 'p2p',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  } satisfies RawMessageEvent);

  assert.deepEqual(savedScopes, [{
    tenantKey: 'tenant-test',
    allowedChats: 'chat-test',
    authorizedUsers: 'user-test',
    allowedApprovers: 'approver-test',
  }]);
  assert.deepEqual(acceptedMessages, ['tenant-test/chat-test/hello']);
});

test('auto-binds the first private-chat user as owner when no owner is configured', async () => {
  class FakeWebSocket implements LarkWebSocketClient {
    public dispatcher: { readonly handles: Map<string, Function> } | undefined;

    public async start(params: Parameters<LarkWebSocketClient['start']>[0]): Promise<void> {
      this.dispatcher = params.eventDispatcher;
    }

    public close(): void {}
  }

  const websocket = new FakeWebSocket();
  const savedScopes: Array<{
    readonly tenantKey: string;
    readonly allowedChats: string;
    readonly authorizedUsers?: string;
    readonly allowedApprovers?: string;
  }> = [];
  const acceptedUsers: string[] = [];
  const server = new LarkEventServer(websocket, {
    ...config,
    larkTenantKey: '',
    allowedChats: [],
    authorizedUsers: [],
    allowedApprovers: [],
  }, {
    onMessage: async (message) => {
      acceptedUsers.push(message.senderOpenId);
    },
    onCardAction: async () => ({}),
  }, {
    save: (scope) => {
      savedScopes.push(scope);
    },
  });
  await server.start();
  const handler = websocket.dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(handler);

  await handler({
    app_id: 'app-test',
    event_id: 'event-owner',
    tenant_key: 'tenant-test',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-test',
      sender_id: { open_id: 'first-user' },
    },
    message: {
      message_id: 'message-owner',
      chat_id: 'chat-test',
      chat_type: 'p2p',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  } satisfies RawMessageEvent);

  assert.deepEqual(savedScopes, [{
    tenantKey: 'tenant-test',
    allowedChats: 'chat-test',
    authorizedUsers: 'first-user',
    allowedApprovers: 'first-user',
  }]);
  assert.deepEqual(acceptedUsers, ['first-user']);
});

test('fills missing owner fields from the first private message even when tenant and chat are configured', async () => {
  class FakeWebSocket implements LarkWebSocketClient {
    public dispatcher: { readonly handles: Map<string, Function> } | undefined;

    public async start(params: Parameters<LarkWebSocketClient['start']>[0]): Promise<void> {
      this.dispatcher = params.eventDispatcher;
    }

    public close(): void {}
  }

  const websocket = new FakeWebSocket();
  const savedUsers: string[] = [];
  const server = new LarkEventServer(websocket, {
    ...config,
    authorizedUsers: [],
    allowedApprovers: [],
  }, {
    onMessage: async (message) => {
      savedUsers.push(message.senderOpenId);
    },
    onCardAction: async () => ({}),
  }, {
    save: (scope) => {
      savedUsers.push(`${scope.authorizedUsers}/${scope.allowedApprovers}`);
    },
  });
  await server.start();
  const handler = websocket.dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(handler);
  await handler({
    app_id: 'app-test',
    event_id: 'event-owner-partial',
    tenant_key: 'tenant-test',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-test',
      sender_id: { open_id: 'first-user' },
    },
    message: {
      message_id: 'message-owner-partial',
      chat_id: 'chat-test',
      chat_type: 'p2p',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  } satisfies RawMessageEvent);

  assert.deepEqual(savedUsers, ['first-user/first-user', 'first-user']);
});

test('does not auto-bind an empty scope from a group chat', async () => {
  class FakeWebSocket implements LarkWebSocketClient {
    public dispatcher: { readonly handles: Map<string, Function> } | undefined;

    public async start(params: Parameters<LarkWebSocketClient['start']>[0]): Promise<void> {
      this.dispatcher = params.eventDispatcher;
    }

    public close(): void {}
  }

  const websocket = new FakeWebSocket();
  const savedScopes: Array<{ readonly tenantKey: string; readonly allowedChats: string }> = [];
  const rejectedReasons: string[] = [];
  const server = new LarkEventServer(websocket, emptyScopeConfig(), {
    onMessage: async () => undefined,
    onCardAction: async () => ({}),
    onRejectedEvent: (reason) => {
      rejectedReasons.push(reason);
    },
  }, {
    save: (scope) => {
      savedScopes.push(scope);
    },
  });
  await server.start();
  const handler = websocket.dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(handler);

  await handler({
    app_id: 'app-test',
    event_id: 'event-group',
    tenant_key: 'tenant-test',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-test',
      sender_id: { open_id: 'user-test' },
    },
    message: {
      message_id: 'message-group',
      chat_id: 'chat-group',
      chat_type: 'group',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello group' }),
    },
  } satisfies RawMessageEvent);

  assert.deepEqual(savedScopes, []);
  assert.deepEqual(rejectedReasons, ['TENANT_MISMATCH']);
});
