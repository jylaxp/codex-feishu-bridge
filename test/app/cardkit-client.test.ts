import assert from 'node:assert/strict';
import test from 'node:test';

import { CardKitClient, CardKitError, LarkReplyApi } from '../../src/app/cards/cardkit-client';
import { sanitizeCardText } from '../../src/app/cards/sanitizer';
import { createTaskCard } from '../../src/app/cards/layouts';
import { TenantTokenProvider } from '../../src/app/lark/client';

const tokenProvider: TenantTokenProvider = {
  getToken: async () => 'tenant-token',
};

function larkApi(replyCalls: unknown[]): LarkReplyApi {
  return {
    im: {
      message: {
        reply: async (payload) => {
          replyCalls.push(payload);
          return { code: 0, data: { message_id: 'om-card-message' } };
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
      target: sanitizeCardText('workspace · abc123'),
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
