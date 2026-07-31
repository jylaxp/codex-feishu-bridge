import assert from 'node:assert/strict';
import test from 'node:test';

import type { HandoffEnvelope } from '../../src/app/collaboration/handoff-directive';
import {
  HandoffMessageEmitter,
  type LarkHandoffMessageApi,
} from '../../src/app/lark/handoff-message-emitter';

test('handoff emitter sends a direct text mention with only the task', async () => {
  const creates: unknown[] = [];
  const emitter = new HandoffMessageEmitter(fakeApi(creates));

  const messageId = await emitter.send({
    chatId: 'chat',
    targetBotKey: 'cli_bbbbbbbbbbbbbbbb',
    targetBotOpenId: 'ou_target',
    targetBotName: 'Order Bot',
    envelope,
    directive: {
      target: 'Order Bot',
      task: '排查订单创建失败',
      reason: '需要订单域判断',
      contextSummary: 'requestId=req-1',
      evidence: 'externalBotOpenId=ou_external',
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
  assert.equal(request.data.msg_type, 'text');
  const content = JSON.parse(request.data.content) as { readonly text: string };
  assert.equal(content.text, '<at user_id="ou_target">Order Bot</at> 排查订单创建失败');
  assert.doesNotMatch(content.text, /需要订单域判断/);
  assert.doesNotMatch(content.text, /requestId=req-1/);
  assert.doesNotMatch(content.text, /externalBotOpenId/);
  assert.doesNotMatch(content.text, /cfb-handoff/);
});

test('handoff emitter falls back to post when text is rejected', async () => {
  const creates: unknown[] = [];
  const emitter = new HandoffMessageEmitter({
    im: {
      message: {
        create: async (payload) => {
          creates.push(payload);
          if (payload.data.msg_type === 'text') {
            return { code: 999, msg: 'text rejected' };
          }
          return { code: 0, data: { message_id: 'message-post-handoff' } };
        },
      },
    },
  });

  const messageId = await emitter.send({
    chatId: 'chat',
    targetBotKey: 'cli_bbbbbbbbbbbbbbbb',
    targetBotOpenId: 'ou_target',
    targetBotName: 'Order Bot',
    envelope,
    directive: {
      target: 'Order Bot',
      task: '排查订单创建失败',
    },
  });

  assert.equal(messageId, 'message-post-handoff');
  assert.equal(creates.length, 2);
  const fallback = creates[1] as {
    readonly data: { readonly msg_type: string; readonly content: string };
  };
  assert.equal(fallback.data.msg_type, 'post');
  const content = JSON.parse(fallback.data.content) as {
    readonly zh_cn: { readonly content: readonly unknown[][] };
  };
  assert.deepEqual(content.zh_cn.content[0]?.[0], {
    tag: 'at',
    user_id: 'ou_target',
    user_name: 'Order Bot',
  });
  assert.match(JSON.stringify(content), /排查订单创建失败/);
  assert.doesNotMatch(JSON.stringify(content), /cfb-handoff/);
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
  sourceBotKey: 'cli_aaaaaaaaaaaaaaaa',
  hop: 1,
  expiresAtMs: 10_000,
  visitedBotKeys: ['cli_aaaaaaaaaaaaaaaa'],
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
