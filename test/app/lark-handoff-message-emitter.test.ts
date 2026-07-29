import assert from 'node:assert/strict';
import test from 'node:test';

import type { HandoffEnvelope } from '../../src/app/collaboration/handoff-directive';
import {
  HandoffMessageEmitter,
  type LarkHandoffMessageApi,
} from '../../src/app/lark/handoff-message-emitter';

test('handoff emitter sends a post message with a real at element and envelope', async () => {
  const creates: unknown[] = [];
  const emitter = new HandoffMessageEmitter(fakeApi(creates));

  const messageId = await emitter.send({
    chatId: 'chat',
    targetBotKey: 'bot_bbbbbbbbbbbb',
    targetBotOpenId: 'ou_target',
    targetBotName: 'Order Bot',
    envelope,
    directive: {
      target: 'Order Bot',
      task: '排查订单创建失败',
      reason: '需要订单域判断',
      contextSummary: 'requestId=req-1',
      evidence: 'traceId=trace-1',
      expectedOutput: '给出订单域结论',
    },
  });

  assert.equal(messageId, 'message-handoff');
  const request = creates[0] as {
    readonly params: { readonly receive_id_type: string };
    readonly data: { readonly receive_id: string; readonly msg_type: string; readonly content: string };
  };
  assert.equal(request.params.receive_id_type, 'chat_id');
  assert.equal(request.data.receive_id, 'chat');
  assert.equal(request.data.msg_type, 'post');
  const content = JSON.parse(request.data.content) as {
    readonly zh_cn: { readonly content: readonly unknown[][] };
  };
  assert.deepEqual(content.zh_cn.content[0]?.[0], {
    tag: 'at',
    user_id: 'ou_target',
    user_name: 'Order Bot',
  });
  assert.match(JSON.stringify(content), /cfb-handoff v1/);
  assert.match(JSON.stringify(content), /排查订单创建失败/);
});

test('handoff emitter falls back to text when post is rejected', async () => {
  const creates: unknown[] = [];
  const emitter = new HandoffMessageEmitter({
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          if (payload.data.msg_type === 'post') {
            return { code: 999, msg: 'post rejected' };
          }
          return { code: 0, data: { message_id: 'message-text-handoff' } };
        },
      },
    },
  });

  const messageId = await emitter.send({
    chatId: 'chat',
    targetBotKey: 'bot_bbbbbbbbbbbb',
    targetBotOpenId: 'ou_target',
    targetBotName: 'Order Bot',
    envelope,
    directive: {
      target: 'Order Bot',
      task: '排查订单创建失败',
    },
  });

  assert.equal(messageId, 'message-text-handoff');
  assert.equal(creates.length, 2);
  const fallback = creates[1] as {
    readonly data: { readonly msg_type: string; readonly content: string };
  };
  assert.equal(fallback.data.msg_type, 'text');
  assert.match(fallback.data.content, /<at user_id=\\"ou_target\\">Order Bot<\/at>/);
  assert.match(fallback.data.content, /cfb-handoff v1/);
});

test('handoff emitter can send a plain group member mention without a handoff envelope', async () => {
  const creates: unknown[] = [];
  const emitter = new HandoffMessageEmitter(fakeApi(creates));

  const messageId = await emitter.sendUserMention({
    chatId: 'chat',
    targetUserOpenId: 'ou_member',
    targetUserName: '张亮',
    text: '请确认订单域的字段口径。',
    dedupeKey: 'mention-1',
  });

  assert.equal(messageId, 'message-handoff');
  const request = creates[0] as {
    readonly data: {
      readonly receive_id: string;
      readonly msg_type: string;
      readonly content: string;
      readonly uuid: string;
    };
  };
  assert.equal(request.data.receive_id, 'chat');
  assert.equal(request.data.msg_type, 'post');
  assert.equal(request.data.uuid.length, 50);
  const content = JSON.parse(request.data.content) as {
    readonly zh_cn: { readonly content: readonly unknown[][] };
  };
  assert.deepEqual(content.zh_cn.content[0]?.[0], {
    tag: 'at',
    user_id: 'ou_member',
    user_name: '张亮',
  });
  assert.match(JSON.stringify(content), /请确认订单域的字段口径/);
  assert.doesNotMatch(JSON.stringify(content), /cfb-handoff v1/);
});

const envelope: HandoffEnvelope = {
  chainId: 'ch_aaaaaaaaaaaaaaaaaaaaaaaa',
  handoffId: 'hf_aaaaaaaaaaaaaaaaaaaaaaaa',
  sourceBotKey: 'bot_aaaaaaaaaaaa',
  hop: 1,
  expiresAtMs: 10_000,
  visitedBotKeys: ['bot_aaaaaaaaaaaa'],
};

function fakeApi(creates: unknown[]): LarkHandoffMessageApi {
  return {
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          return { code: 0, data: { message_id: 'message-handoff' } };
        },
      },
    },
  };
}
