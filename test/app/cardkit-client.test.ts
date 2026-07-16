import assert from 'node:assert/strict';
import test from 'node:test';

import { CardKitClient, CardKitError, LarkReplyApi } from '../../src/app/cards/cardkit-client';
import { sanitizeCardText } from '../../src/app/cards/sanitizer';
import { createTaskCard } from '../../src/app/cards/layouts';
import { TenantTokenProvider } from '../../src/app/lark/client';

const tokenProvider: TenantTokenProvider = {
  getToken: async () => 'tenant-token',
};

function larkApi(
  replyCalls: unknown[],
  sentCalls: unknown[] = [],
  patchCalls: unknown[] = [],
): LarkReplyApi {
  return {
    im: {
      message: {
        reply: async (payload) => {
          replyCalls.push(payload);
          return { code: 0, data: { message_id: 'om-card-message' } };
        },
        create: async (payload) => {
          sentCalls.push(payload);
          return { code: 0, data: { message_id: 'om-sent-card-message' } };
        },
        patch: async (payload) => {
          patchCalls.push(payload);
          return { code: 0 };
        },
      },
    },
  };
}

function card() {
  return createTaskCard({
    status: 'RUNNING',
    payload: {
      title: sanitizeCardText('Task'),
      prompt: sanitizeCardText('Prompt'),
      commentary: sanitizeCardText('Working'),
      toolSummary: sanitizeCardText('None'),
      finalAnswer: sanitizeCardText(''),
      footer: sanitizeCardText('Ref'),
      terminal: false,
    },
  });
}

test('creates and replies inline with a root-scoped idempotent CardKit reference', async () => {
  const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  const replies: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ code: 0, data: { card_id: 'card-1' } }));
  };
  const client = new CardKitClient(tokenProvider, larkApi(replies), fetchImpl);

  const cardId = await client.createCard(card());
  const messageId = await client.replyCard('om-root', cardId, 'stable-task-uuid');

  assert.equal(cardId, 'card-1');
  assert.equal(messageId, 'om-card-message');
  assert.equal(requests.length, 1);
  assert.match(String(requests[0]?.init?.headers && JSON.stringify(requests[0].init.headers)), /Bearer/);
  assert.equal(replies.length, 1);
  assert.match(JSON.stringify(replies[0]), /stable-task-uuid/);
  const replyPayload = replies[0] as {
    readonly data?: { readonly reply_in_thread?: boolean };
  };
  assert.equal(replyPayload.data?.reply_in_thread, false);
});

test('sends an independent CardKit reference to one bound chat', async () => {
  const sent: unknown[] = [];
  const client = new CardKitClient(tokenProvider, larkApi([], sent));

  const messageId = await client.sendCard('oc-bound-chat', 'card-1', 'desktop-card-uuid');

  assert.equal(messageId, 'om-sent-card-message');
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0]), /oc-bound-chat/);
  assert.match(JSON.stringify(sent[0]), /desktop-card-uuid/);
  assert.match(JSON.stringify(sent[0]), /receive_id_type/);
});

test('patches a picker message with the complete selected-state card', async () => {
  const patches: unknown[] = [];
  const client = new CardKitClient(tokenProvider, larkApi([], [], patches));

  await client.patchMessage('om-picker-message', card());

  assert.equal(patches.length, 1);
  const payload = patches[0] as {
    readonly path: { readonly message_id: string };
    readonly data: { readonly content: string };
  };
  assert.equal(payload.path.message_id, 'om-picker-message');
  assert.equal(JSON.parse(payload.data.content).schema, '2.0');
});

test('retries a newly-created card reference while Feishu is still propagating the card id', async () => {
  let replyAttempts = 0;
  const replies: unknown[] = [];
  const api = larkApi(replies);
  api.im.message.reply = async (payload) => {
    replies.push(payload);
    replyAttempts += 1;
    return replyAttempts === 1
      ? { code: 230099, msg: 'cardid is invalid' }
      : { code: 0, data: { message_id: 'om-card-after-propagation' } };
  };
  const client = new CardKitClient(tokenProvider, api);

  assert.equal(
    await client.replyCard('om-root', 'card-new', 'stable-card-reference'),
    'om-card-after-propagation',
  );
  assert.equal(replyAttempts, 2);
  assert.equal(replies.length, 2);
});

test('retries an independent card send while Feishu is still propagating the card id', async () => {
  let sendAttempts = 0;
  const sent: unknown[] = [];
  const api = larkApi([], sent);
  api.im.message.create = async (payload) => {
    sent.push(payload);
    sendAttempts += 1;
    return sendAttempts === 1
      ? { code: 230099, msg: 'cardid is invalid' }
      : { code: 0, data: { message_id: 'om-sent-after-propagation' } };
  };
  const client = new CardKitClient(tokenProvider, api);

  assert.equal(
    await client.sendCard('oc-bound-chat', 'card-new', 'stable-card-reference'),
    'om-sent-after-propagation',
  );
  assert.equal(sendAttempts, 2);
  assert.equal(sent.length, 2);
});

test('normalizes overlong message idempotency keys to the Feishu 50-character limit', async () => {
  const replies: unknown[] = [];
  const sent: unknown[] = [];
  const client = new CardKitClient(tokenProvider, larkApi(replies, sent));
  const operationId = `binding:${'event-id-segment-'.repeat(4)}:picker-table`;

  await client.replyCard('om-root', 'card-1', operationId);
  await client.sendCard('oc-bound-chat', 'card-2', operationId);

  const replyUuid = (replies[0] as { data: { uuid: string } }).data.uuid;
  const sendUuid = (sent[0] as { data: { uuid: string } }).data.uuid;
  assert.ok(operationId.length > 50);
  assert.equal(replyUuid.length, 43);
  assert.equal(sendUuid, replyUuid);
});

test('advances sequence only after a successful replace', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ code: 0 }));
  };
  const client = new CardKitClient(tokenProvider, larkApi([]), fetchImpl);
  assert.equal(await client.replaceCard('card-1', card(), 0, 'update-operation'), 1);
  assert.equal(requestBodies[0]?.sequence, 1);
  assert.equal(requestBodies[0]?.uuid, 'update-operation');
});

test('closes streaming with the official nested settings and next sequence', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ code: 0 }));
  };
  const client = new CardKitClient(tokenProvider, larkApi([]), fetchImpl);

  assert.equal(await client.closeStreaming('card-1', 0, 'close-operation'), 1);
  assert.equal(requestBody?.sequence, 1);
  assert.equal(requestBody?.uuid, 'close-operation');
  assert.deepEqual(JSON.parse(String(requestBody?.settings)), {
    config: { streaming_mode: false },
  });
});

test('does not guess after a CardKit sequence conflict', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    code: 300317,
    msg: 'invalid sequence',
  }), { status: 400 });
  const client = new CardKitClient(tokenProvider, larkApi([]), fetchImpl);

  await assert.rejects(
    client.replaceCard('card-1', card(), 3),
    (error: unknown) => error instanceof CardKitError && error.kind === 'SEQUENCE_UNKNOWN',
  );
});

test('classifies 429 and server errors as bounded-retry candidates', async () => {
  const fetchImpl: typeof fetch = async () => new Response('limited', { status: 429 });
  const client = new CardKitClient(tokenProvider, larkApi([]), fetchImpl);
  await assert.rejects(
    client.createCard(card()),
    (error: unknown) => error instanceof CardKitError && error.retryable,
  );
});

test('classifies response body read failures as retryable network errors', async () => {
  const fetchImpl: typeof fetch = async () => {
    const response = new Response(JSON.stringify({ code: 0 }));
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw new Error('socket reset');
      },
    });
    return response;
  };
  const client = new CardKitClient(tokenProvider, larkApi([]), fetchImpl);

  await assert.rejects(
    client.replaceCard('card-1', card(), 0, 'stable-operation'),
    (error: unknown) => error instanceof CardKitError
      && error.kind === 'NETWORK_RETRYABLE'
      && error.retryable,
  );
});

test('invalidates a rejected tenant token and retries authentication once', async () => {
  const authorizationHeaders: string[] = [];
  let tokenIndex = 0;
  let invalidationCount = 0;
  const rotatingProvider: TenantTokenProvider = {
    getToken: async () => ['expired-token', 'fresh-token'][tokenIndex++] ?? 'fresh-token',
    invalidateToken: (token) => {
      assert.equal(token, 'expired-token');
      invalidationCount += 1;
    },
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    const authorization = headers.Authorization;
    assert.ok(authorization);
    authorizationHeaders.push(authorization);
    return authorizationHeaders.length === 1
      ? new Response('unauthorized', { status: 401 })
      : new Response(JSON.stringify({ code: 0, data: { card_id: 'card-fresh' } }));
  };
  const client = new CardKitClient(rotatingProvider, larkApi([]), fetchImpl);

  assert.equal(await client.createCard(card()), 'card-fresh');
  assert.deepEqual(authorizationHeaders, [
    'Bearer expired-token',
    'Bearer fresh-token',
  ]);
  assert.equal(invalidationCount, 1);
});
