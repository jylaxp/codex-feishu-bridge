import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeConfig } from '../../src/app/domain';
import { normalizeInboundMessage, RawMessageEvent } from '../../src/app/lark/intake';

const config: BridgeConfig = Object.freeze({
  larkAppId: 'cli_app',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant-1',
  allowedChats: Object.freeze(['oc_allowed']),
  authorizedUsers: Object.freeze(['ou_allowed']),
  allowedApprovers: Object.freeze(['ou_approver']),
  appServerMode: 'owned_stdio',
  appServerSocketPath: null,
  codexBin: '/opt/codex',
  codexCwd: '/workspace',
  maxTextLength: 1_000,
  cardUpdateIntervalMs: 1_500,
  maxQueuedTasks: 100,
  rateLimitQueryIntervalMs: 300_000,
  logToFile: false,
  logFilePath: null,
  enableAutoFileUpload: false,
});

function validEvent(): RawMessageEvent {
  return {
    app_id: 'cli_app',
    event_id: 'evt-1',
    tenant_key: 'tenant-1',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant-1',
      sender_id: { open_id: 'ou_allowed' },
    },
    message: {
      message_id: 'om-root',
      chat_id: 'oc_allowed',
      create_time: '1783960000000',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1  请检查项目  ' }),
      mentions: [{ key: '@_user_1' }],
    },
  };
}

function normalize(event: RawMessageEvent) {
  return normalizeInboundMessage(event, config, () => 1_783_960_010_000);
}

test('accepts an authorized text event and derives the root binding', () => {
  const result = normalize(validEvent());
  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.equal(result.message.text, '请检查项目');
  assert.equal(result.message.rootMessageId, 'om-root');
  assert.equal(result.message.payloadDigest.length, 64);
});

test('uses explicit root_id for replies', () => {
  const baseEvent = validEvent();
  const event: RawMessageEvent = {
    ...baseEvent,
    message: { ...baseEvent.message, message_id: 'om-reply', root_id: 'om-root' },
  };
  const result = normalize(event);
  assert.equal(result.accepted && result.message.rootMessageId, 'om-root');
});

test('preserves multiline prompt structure after removing the bot mention', () => {
  const baseEvent = validEvent();
  const event: RawMessageEvent = {
    ...baseEvent,
    message: {
      ...baseEvent.message,
      content: JSON.stringify({
        text: '@_user_1 请修改：\n```ts\nconst value = 1;\n```',
      }),
    },
  };
  const result = normalize(event);

  assert.equal(
    result.accepted && result.message.text,
    '请修改：\n```ts\nconst value = 1;\n```',
  );
});

test('fails closed for identity, tenant, chat, user and message type', () => {
  const cases: ReadonlyArray<readonly [RawMessageEvent, string]> = [
    [{ ...validEvent(), app_id: undefined }, 'APP_MISMATCH'],
    [{ ...validEvent(), app_id: 'another-app' }, 'APP_MISMATCH'],
    [{ ...validEvent(), tenant_key: 'tenant-2' }, 'TENANT_MISMATCH'],
    [{ ...validEvent(), sender: { sender_type: 'app' } }, 'SENDER_NOT_USER'],
    [{ ...validEvent(), sender: { sender_type: 'user', sender_id: {} } }, 'SENDER_MISSING'],
    [
      { ...validEvent(), message: { ...validEvent().message, chat_id: 'oc_unknown' } },
      'CHAT_NOT_ALLOWED',
    ],
    [
      {
        ...validEvent(),
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_unknown' } },
      },
      'USER_NOT_ALLOWED',
    ],
    [
      { ...validEvent(), message: { ...validEvent().message, message_type: 'file' } },
      'MESSAGE_NOT_TEXT',
    ],
  ];

  for (const [event, expectedReason] of cases) {
    const result = normalize(event);
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.reason, expectedReason);
    }
  }
});

test('rejects malformed and oversized text without parsing arbitrary payloads', () => {
  const malformedBase = validEvent();
  const malformed: RawMessageEvent = {
    ...malformedBase,
    message: { ...malformedBase.message, content: '{invalid' },
  };
  assert.deepEqual(normalize(malformed), {
    accepted: false,
    reason: 'TEXT_INVALID',
  });

  const oversizedBase = validEvent();
  const oversized: RawMessageEvent = {
    ...oversizedBase,
    message: {
      ...oversizedBase.message,
      content: JSON.stringify({ text: 'x'.repeat(1_001) }),
    },
  };
  assert.deepEqual(normalize(oversized), {
    accepted: false,
    reason: 'TEXT_TOO_LONG',
  });
});

test('rejects Feishu backlog messages older than thirty seconds', () => {
  assert.deepEqual(
    normalizeInboundMessage(validEvent(), config, () => 1_783_960_031_000),
    { accepted: false, reason: 'MESSAGE_TOO_OLD' },
  );
});
