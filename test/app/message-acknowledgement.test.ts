import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LarkMessageAcknowledgement,
  type LarkMessageAcknowledgementApi,
} from '../../src/app/lark/message-acknowledgement';
import type { InboundTextMessage } from '../../src/app/lark/intake';

function message(): InboundTextMessage {
  return {
    tenantKey: 'tenant',
    eventId: 'event',
    messageId: 'message-1',
    chatId: 'chat',
    rootMessageId: 'message-1',
    senderOpenId: 'user',
    text: 'hello',
    payloadDigest: 'digest',
    createdAtMs: 1,
  };
}

test('acknowledges a Feishu message with the legacy OK reaction first', async () => {
  const reactions: unknown[] = [];
  const textMessages: unknown[] = [];
  const api: LarkMessageAcknowledgementApi = {
    im: {
      messageReaction: {
        create: async (request) => {
          reactions.push(request);
        },
      },
      message: {
        create: async (request) => {
          textMessages.push(request);
        },
      },
    },
  };

  await new LarkMessageAcknowledgement(api).ack(message());

  assert.deepEqual(reactions, [{
    path: { message_id: 'message-1' },
    data: { reaction_type: { emoji_type: 'OK' } },
  }]);
  assert.deepEqual(textMessages, []);
});

test('falls back to a text receipt when the OK reaction fails', async () => {
  const textMessages: unknown[] = [];
  const warnings: string[] = [];
  const api: LarkMessageAcknowledgementApi = {
    im: {
      messageReaction: {
        create: async () => {
          throw new Error('reaction failed');
        },
      },
      message: {
        create: async (request) => {
          textMessages.push(request);
        },
      },
    },
  };

  await new LarkMessageAcknowledgement(api, {
    warn: (event) => warnings.push(event),
    error: () => undefined,
  }).ack(message());

  assert.deepEqual(warnings, ['lark_ok_reaction_failed']);
  assert.deepEqual(textMessages, [{
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'chat',
      msg_type: 'text',
      content: JSON.stringify({ text: '👌' }),
    },
  }]);
});

test('logs and swallows fallback failures so user processing can continue asynchronously', async () => {
  const errors: string[] = [];
  const api: LarkMessageAcknowledgementApi = {
    im: {
      messageReaction: {
        create: async () => {
          throw new Error('reaction failed');
        },
      },
      message: {
        create: async () => {
          throw new Error('fallback failed');
        },
      },
    },
  };

  await new LarkMessageAcknowledgement(api, {
    warn: () => undefined,
    error: (event) => errors.push(event),
  }).ack(message());

  assert.deepEqual(errors, ['lark_ok_fallback_failed']);
});
