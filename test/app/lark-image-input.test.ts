import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createHelpCard } from '../../src/app/cards/command-cards';
import {
  createImagePendingCard,
  createImageSubmissionFailedCard,
} from '../../src/app/cards/layouts';
import type { BridgeConfig } from '../../src/app/domain';
import {
  InboundImageStore,
  type LarkMessageResourceApi,
} from '../../src/app/lark/inbound-image-store';
import { InboundMessageAggregator } from '../../src/app/lark/inbound-message-aggregator';
import { normalizeCardAction } from '../../src/app/lark/event-server';
import {
  normalizeInboundMessage,
  isTextOnlyInboundMessage,
  type InboundMessage,
  type RawMessageEvent,
} from '../../src/app/lark/intake';

const config = {
  larkAppId: 'app',
  larkAppSecret: 'secret',
  larkTenantKey: 'tenant',
  allowedChats: ['chat'],
  authorizedUsers: ['user'],
  allowedApprovers: ['user'],
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

test('image events are accepted without fabricating a task description', () => {
  const result = normalizeInboundMessage(
    imageEvent('{"image_key":"img_v3_valid-key"}'),
    config,
    () => 1_000_000_001_000,
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.equal(result.message.messageType, 'image');
  assert.equal(result.message.imageKey, 'img_v3_valid-key');
  assert.equal(result.message.hasExplicitText, false);
  assert.deepEqual(result.message.imageReferences, [{
    messageId: 'message',
    imageKey: 'img_v3_valid-key',
  }]);
  assert.equal(result.message.text, '');
});

test('post events preserve mixed text and multiple image references', () => {
  const result = normalizeInboundMessage(postEvent(JSON.stringify({
    title: '检查界面',
    content: [
      [{ tag: 'text', text: '请找出问题' }, { tag: 'img', image_key: 'img_v3_first' }],
      [{
        tag: 'md',
        text: '并给出修改建议 ![补充截图](img_v3_markdown)',
      }, { tag: 'img', image_key: 'img_v3_second' }],
    ],
  })), config, () => 1_000_000_001_000);

  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.equal(result.message.messageType, 'post');
  assert.equal(result.message.hasExplicitText, true);
  assert.equal(result.message.text, '检查界面\n请找出问题\n并给出修改建议');
  assert.deepEqual(result.message.imageReferences, [
    { messageId: 'message', imageKey: 'img_v3_first' },
    { messageId: 'message', imageKey: 'img_v3_markdown' },
    { messageId: 'message', imageKey: 'img_v3_second' },
  ]);
});

test('post events accept locale-wrapped image-only content for later aggregation', () => {
  const result = normalizeInboundMessage(postEvent(JSON.stringify({
    zh_cn: { content: [[{ tag: 'img', image_key: 'img_v3_only' }]] },
  })), config, () => 1_000_000_001_000);

  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.equal(result.message.hasExplicitText, false);
  assert.equal(result.message.text, '');
  assert.deepEqual(result.message.imageReferences, [
    { messageId: 'message', imageKey: 'img_v3_only' },
  ]);
});

test('image events with malformed content are rejected', () => {
  const result = normalizeInboundMessage(
    imageEvent('{"image_key":"../unsafe"}'),
    config,
    () => 1_000_000_001_000,
  );
  assert.deepEqual(result, { accepted: false, reason: 'TEXT_INVALID' });
});

test('inbound image store validates, bounds, and cleans downloaded images', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const api = resourceApi(png);
  const store = new InboundImageStore(api, temporaryDirectory, 16);
  try {
    const path = await store.download('message', 'img_v3_key');
    assert.equal(path.endsWith('.png'), true);
    assert.equal(existsSync(path), true);

    await store.release([path]);
    assert.equal(existsSync(path), false);
  } finally {
    await store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('inbound image store rejects oversized and unsupported resources', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-reject-test-'));
  try {
    const oversized = new InboundImageStore(resourceApi(Buffer.alloc(17, 1)), temporaryDirectory, 16);
    await assert.rejects(() => oversized.download('message', 'img_v3_key'), /exceeds/);
    await oversized.close();

    const unsupported = new InboundImageStore(resourceApi(Buffer.from('not-an-image')), temporaryDirectory, 16);
    await assert.rejects(() => unsupported.download('message', 'img_v3_key'), /unsupported/);
    await unsupported.close();
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('inbound image store limits concurrent downloads across callers', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-concurrency-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const controlled = controlledResourceApi(png);
  const store = new InboundImageStore(controlled.api, temporaryDirectory, 16);
  try {
    const downloads = ['img_v3_one', 'img_v3_two', 'img_v3_three']
      .map((imageKey) => store.download('message', imageKey));

    await waitFor(() => controlled.started.length === 2);
    assert.equal(controlled.maximumActive, 2);
    assert.deepEqual(controlled.started, ['img_v3_one', 'img_v3_two']);

    controlled.complete('img_v3_one');
    controlled.complete('img_v3_two');
    await waitFor(() => controlled.started.length === 3);
    assert.equal(controlled.maximumActive, 2);
    controlled.complete('img_v3_three');

    const paths = await Promise.all(downloads);
    assert.equal(paths.every((path) => existsSync(path)), true);
    await store.release(paths);
  } finally {
    await store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('inbound image store enforces a bridge-wide retained byte budget', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-budget-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const store = new InboundImageStore(resourceApi(png), temporaryDirectory, 16, 2, 20);
  try {
    const first = await store.download('message', 'img_v3_first');
    const second = await store.download('message', 'img_v3_second');
    await assert.rejects(() => store.download('message', 'img_v3_third'), /bridge limit/);

    await store.release([first]);
    const third = await store.download('message', 'img_v3_third');
    await store.release([second, third]);
  } finally {
    await store.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('inbound image store fences downloads that finish during close', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-close-test-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const controlled = controlledResourceApi(png);
  const store = new InboundImageStore(controlled.api, temporaryDirectory, 16);
  const download = store.download('message', 'img_v3_closing');
  await waitFor(() => controlled.started.length === 1);

  const close = store.close();
  controlled.complete('img_v3_closing');
  await assert.rejects(() => download, /closing/);
  await close;
  await assert.rejects(() => store.download('message', 'img_v3_after_close'), /closing/);
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('inbound image store bounds close while a resource request never settles', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bridge-image-close-timeout-test-'));
  let requested = false;
  const api: LarkMessageResourceApi = {
    im: {
      messageResource: {
        get: () => {
          requested = true;
          return new Promise(() => undefined);
        },
      },
    },
  };
  const store = new InboundImageStore(api, temporaryDirectory, 16, 2, 20, 5);
  void store.download('message', 'img_v3_never').catch(() => undefined);
  await waitFor(() => requested);
  await store.close();
  await assert.rejects(() => store.download('message', 'img_v3_after_close'), /closing/);
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('image aggregation merges immediate task text and all pending images', async () => {
  const dispatched: InboundMessage[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
  );
  try {
    await aggregator.accept(normalizedImage('first', 'img_v3_first'));
    await aggregator.accept(normalizedImage('second', 'img_v3_second'));
    assert.equal(dispatched.length, 0);

    await aggregator.accept(normalizedText('describe', '请比较两张图并修改页面'));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '请比较两张图并修改页面');
    assert.equal(dispatched[0]?.rootMessageId, 'message-describe');
    assert.deepEqual(dispatched[0]?.imageReferences, [
      { messageId: 'message-first', imageKey: 'img_v3_first' },
      { messageId: 'message-second', imageKey: 'img_v3_second' },
    ]);
  } finally {
    aggregator.close();
  }
});

test('image aggregation keeps image-only input pending until explicitly submitted', async () => {
  const dispatched: InboundMessage[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
  );
  try {
    await aggregator.accept(normalizedImage('pending', 'img_v3_pending'));
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(dispatched.length, 0);

    await aggregator.accept(normalizedText('run', '/image-run'));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '');
    assert.equal(dispatched[0]?.hasExplicitText, false);
  } finally {
    aggregator.close();
  }
});

test('image aggregation preserves pending images across unrelated slash commands', async () => {
  const dispatched: InboundMessage[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
  );
  try {
    await aggregator.accept(normalizedImage('command-image', 'img_v3_command'));
    await aggregator.accept(normalizedText('command', '/status'));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '/status');
    assert.deepEqual(dispatched[0]?.imageReferences, []);

    await aggregator.accept(normalizedText('description', '分析图片中的报错'));
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1]?.text, '分析图片中的报错');
    assert.deepEqual(dispatched[1]?.imageReferences, [
      { messageId: 'message-command-image', imageKey: 'img_v3_command' },
    ]);
  } finally {
    aggregator.close();
  }
});

test('image aggregation cancels a pending batch without dispatching it', async () => {
  const dispatched: InboundMessage[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
  );
  try {
    await aggregator.accept(normalizedImage('cancel-image', 'img_v3_cancel'));
    await aggregator.accept(normalizedText('cancel', '/image-cancel'));
    await aggregator.accept(normalizedText('after-cancel', '新的独立任务'));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '新的独立任务');
    assert.deepEqual(dispatched[0]?.imageReferences, []);
  } finally {
    aggregator.close();
  }
});

test('image aggregation rejects images beyond the batch limit without losing the pending batch', async () => {
  const dispatched: InboundMessage[] = [];
  const rejected: number[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
    { onTooManyImages: (_message, maximumImages) => { rejected.push(maximumImages); } },
  );
  try {
    const firstEight: InboundMessage = {
      ...normalizedImage('eight', 'img_v3_1'),
      imageReferences: Array.from({ length: 8 }, (_value, index) => ({
        messageId: 'message-eight',
        imageKey: `img_v3_${index + 1}`,
      })),
    };
    await aggregator.accept(firstEight);
    await aggregator.accept(normalizedImage('ninth', 'img_v3_9'));
    await aggregator.accept(normalizedText('run-eight', '/image-run'));

    assert.deepEqual(rejected, [8]);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.imageReferences?.length, 8);
  } finally {
    aggregator.close();
  }
});

test('image aggregation retains pending images when task dispatch fails', async () => {
  const dispatched: InboundMessage[] = [];
  let failNextDispatch = true;
  const aggregator = new InboundMessageAggregator(async (message) => {
    if (failNextDispatch) {
      failNextDispatch = false;
      throw new Error('Desktop unavailable');
    }
    dispatched.push(message);
  });
  try {
    await aggregator.accept(normalizedImage('retry-image', 'img_v3_retry'));
    await assert.rejects(
      () => aggregator.accept(normalizedText('failed-description', '第一次描述')),
      /Desktop unavailable/,
    );
    await aggregator.accept(normalizedText('retry-description', '重新提交描述'));

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '重新提交描述');
    assert.deepEqual(dispatched[0]?.imageReferences, [
      { messageId: 'message-retry-image', imageKey: 'img_v3_retry' },
    ]);
  } finally {
    aggregator.close();
  }
});

test('image aggregation invalidates queued accepts when closed', async () => {
  const dispatched: InboundMessage[] = [];
  let releaseFirst!: () => void;
  const firstDispatch = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const aggregator = new InboundMessageAggregator(async (message) => {
    dispatched.push(message);
    if (message.text === '/status') {
      await firstDispatch;
    }
  });

  const status = aggregator.accept(normalizedText('blocked-status', '/status'));
  await waitFor(() => dispatched.length === 1);
  const staleImage = aggregator.accept(normalizedImage('stale-image', 'img_v3_stale'));
  aggregator.close();
  releaseFirst();
  await Promise.all([status, staleImage]);
  await aggregator.accept(normalizedText('after-reset', '新的任务'));

  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1]?.text, '新的任务');
  assert.deepEqual(dispatched[1]?.imageReferences, []);
  aggregator.close();
});

test('image aggregation bounds a blocked conversation backlog', async () => {
  let releaseFirst!: () => void;
  const firstDispatch = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let overloads = 0;
  const aggregator = new InboundMessageAggregator(
    async (message) => {
      if (message.text === '/status') {
        await firstDispatch;
      }
    },
    { onOverloaded: () => { overloads += 1; } },
  );

  const accepts = [aggregator.accept(normalizedText('backlog-0', '/status'))];
  for (let index = 1; index < 40; index += 1) {
    accepts.push(aggregator.accept(normalizedImage(`backlog-${index}`, `img_v3_${index}`)));
  }
  await waitFor(() => overloads === 1);
  aggregator.close();
  releaseFirst();
  await Promise.all(accepts);
  assert.equal(overloads, 1);
});

test('image batch commands report an empty pending state', async () => {
  const emptyCommands: string[] = [];
  const aggregator = new InboundMessageAggregator(
    async () => undefined,
    { onEmptyBatch: (message) => { emptyCommands.push(message.text); } },
  );
  try {
    await aggregator.accept(normalizedText('empty-run', '/image-run'));
    await aggregator.accept(normalizedText('empty-cancel', '/image-cancel'));
    assert.deepEqual(emptyCommands, ['/image-run', '/image-cancel']);
  } finally {
    aggregator.close();
  }
});

test('pending image card exposes an optional description form and batch actions', () => {
  const card = JSON.stringify(createImagePendingCard(2, 'opaque_token'));

  assert.match(card, /"tag":"form"/);
  assert.match(card, /"tag":"input","name":"task_description"/);
  assert.match(card, /任务描述（可选）/);
  assert.match(card, /提交图片/);
  assert.match(card, /取消/);
  assert.match(card, /"action_type":"form_submit"/);
  assert.match(card, /"action":"image-run","token":"opaque_token"/);
  assert.match(card, /"action":"image-cancel","token":"opaque_token"/);
  assert.doesNotMatch(card, /image-run`/);
});

test('retry image card restores the previously submitted description', () => {
  const card = JSON.stringify(createImageSubmissionFailedCard(
    2,
    'retry_token',
    '比较图片并给出修改建议',
  ));

  assert.match(card, /已保留 2 张图片和任务描述/);
  assert.match(card, /"default_value":"比较图片并给出修改建议"/);
});

test('card actions submit or cancel only the matching pending image batch', async () => {
  const dispatched: InboundMessage[] = [];
  const actionTokens: string[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
    { onPending: (_message, _count, actionToken) => { actionTokens.push(actionToken); } },
  );
  try {
    await aggregator.accept(normalizedImage('button-submit', 'img_v3_submit'));
    const submitResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: actionTokens[0] ?? '',
      taskDescription: '比较图片并给出修改建议',
    });
    assert.equal(submitResult, 'submitted');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '比较图片并给出修改建议');
    assert.equal(dispatched[0]?.hasExplicitText, true);
    assert.equal(dispatched[0]?.imageReferences?.[0]?.imageKey, 'img_v3_submit');

    await aggregator.accept(normalizedImage('button-cancel', 'img_v3_cancel'));
    const otherSenderResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'other-user',
      action: 'image-cancel',
      token: actionTokens[1] ?? '',
    });
    assert.equal(otherSenderResult, 'invalid');

    const staleResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-cancel',
      token: actionTokens[0] ?? '',
    });
    assert.equal(staleResult, 'invalid');

    const cancelResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-cancel',
      token: actionTokens[1] ?? '',
    });
    assert.equal(cancelResult, 'cancelled');
    assert.equal(dispatched.length, 1);
  } finally {
    aggregator.close();
  }
});

test('submit button dispatches images without adding text when description is empty', async () => {
  const dispatched: InboundMessage[] = [];
  let actionToken = '';
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
    { onPending: (_message, _count, token) => { actionToken = token; } },
  );
  try {
    await aggregator.accept(normalizedImage('button-image-only', 'img_v3_image_only'));
    const result = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: actionToken,
    });

    assert.equal(result, 'submitted');
    await waitFor(() => dispatched.length === 1);
    assert.equal(dispatched[0]?.text, '');
    assert.equal(dispatched[0]?.hasExplicitText, false);
    assert.equal(dispatched[0]?.imageReferences?.[0]?.imageKey, 'img_v3_image_only');
  } finally {
    aggregator.close();
  }
});

test('submit button returns before background dispatch completes', async () => {
  let releaseDispatch!: () => void;
  const dispatchBlocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  let actionToken = '';
  const aggregator = new InboundMessageAggregator(
    async () => dispatchBlocked,
    { onPending: (_message, _count, token) => { actionToken = token; } },
  );
  try {
    await aggregator.accept(normalizedImage('fast-button', 'img_v3_fast'));
    const result = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: actionToken,
    });

    assert.equal(result, 'submitted');
    releaseDispatch();
  } finally {
    aggregator.close();
  }
});

test('submitted card transition runs only after background dispatch is accepted', async () => {
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const events: string[] = [];
  let actionToken = '';
  const aggregator = new InboundMessageAggregator(
    async () => {
      events.push('dispatch');
      await dispatchGate;
      return true;
    },
    {
      onPending: (_message, _count, token) => {
        actionToken = token;
        return 'pending-card';
      },
      onSubmitted: (_message, cardMessageId) => {
        events.push(`submitted:${cardMessageId ?? 'none'}`);
      },
    },
  );
  try {
    await aggregator.accept(normalizedImage('ordered-button', 'img_v3_ordered_button'));
    const result = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: actionToken,
    });

    assert.equal(result, 'submitted');
    assert.deepEqual(events, ['dispatch']);
    releaseDispatch();
    await waitFor(() => events.length === 2);
    assert.deepEqual(events, ['dispatch', 'submitted:pending-card']);
  } finally {
    aggregator.close();
  }
});

test('a stale dispatch failure does not publish a failure card after close', async () => {
  let releaseDispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  let actionToken = '';
  let failureCards = 0;
  const aggregator = new InboundMessageAggregator(
    async () => {
      await dispatchGate;
      return false;
    },
    {
      onPending: (_message, _count, token) => {
        actionToken = token;
        return 'pending-card';
      },
      onActionDispatchFailed: () => {
        failureCards += 1;
      },
    },
  );
  await aggregator.accept(normalizedImage('stale-button', 'img_v3_stale_button'));
  const result = await aggregator.handleImageBatchAction({
    tenantKey: 'tenant',
    chatId: 'chat',
    senderOpenId: 'user',
    action: 'image-run',
    token: actionToken,
  });

  assert.equal(result, 'submitted');
  aggregator.close();
  releaseDispatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failureCards, 0);
});

test('failed button dispatch restores the batch with a fresh retry token', async () => {
  let failNextDispatch = true;
  const dispatched: InboundMessage[] = [];
  const pendingTokens: string[] = [];
  let retryToken: string | null = null;
  let retainedDescription: string | undefined;
  let originalCardMessageId: string | undefined;
  const aggregator = new InboundMessageAggregator(
    async (message) => {
      if (failNextDispatch) {
        failNextDispatch = false;
        return false;
      }
      dispatched.push(message);
      return true;
    },
    {
      onPending: (_message, _count, token) => {
        pendingTokens.push(token);
        return 'pending-card';
      },
      onActionDispatchFailed: (
        _message,
        _count,
        token,
        _error,
        taskDescription,
        cardMessageId,
      ) => {
        retryToken = token;
        retainedDescription = taskDescription;
        originalCardMessageId = cardMessageId;
        return 'retry-card';
      },
    },
  );
  try {
    await aggregator.accept(normalizedImage('retry-button', 'img_v3_retry_button'));
    const firstResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: pendingTokens[0] ?? '',
      taskDescription: '分析重试图片',
    });
    assert.equal(firstResult, 'submitted');
    await waitFor(() => retryToken !== null);
    assert.notEqual(retryToken, pendingTokens[0]);
    assert.equal(retainedDescription, '分析重试图片');
    assert.equal(originalCardMessageId, 'pending-card');

    const retryResult = await aggregator.handleImageBatchAction({
      tenantKey: 'tenant',
      chatId: 'chat',
      senderOpenId: 'user',
      action: 'image-run',
      token: retryToken ?? '',
    });
    assert.equal(retryResult, 'submitted');
    await waitFor(() => dispatched.length === 1);
    assert.equal(dispatched[0]?.text, '分析重试图片');
    assert.equal(dispatched[0]?.imageReferences?.[0]?.imageKey, 'img_v3_retry_button');
  } finally {
    aggregator.close();
  }
});

test('additional images update the existing pending card count', async () => {
  const updates: Array<{ count: number; cardMessageId: string }> = [];
  const aggregator = new InboundMessageAggregator(
    async () => undefined,
    {
      onPending: () => 'pending-card',
      onPendingUpdated: (_message, count, _token, cardMessageId) => {
        updates.push({ count, cardMessageId });
      },
    },
  );
  try {
    await aggregator.accept(normalizedImage('count-one', 'img_v3_count_one'));
    await aggregator.accept(normalizedImage('count-two', 'img_v3_count_two'));

    assert.deepEqual(updates, [{ count: 2, cardMessageId: 'pending-card' }]);
  } finally {
    aggregator.close();
  }
});

test('the same image can be retried after the first pending-card reply fails', async () => {
  let pendingCalls = 0;
  const aggregator = new InboundMessageAggregator(
    async () => undefined,
    {
      onPending: () => {
        pendingCalls += 1;
        if (pendingCalls === 1) {
          throw new Error('temporary Feishu failure');
        }
        return 'recovered-card';
      },
    },
  );
  try {
    await assert.rejects(
      () => aggregator.accept(normalizedImage('reply-failure', 'img_v3_reply_failure')),
      /temporary Feishu failure/,
    );
    await aggregator.accept(normalizedImage('reply-failure', 'img_v3_reply_failure'));
    assert.equal(pendingCalls, 2);
  } finally {
    aggregator.close();
  }
});

test('pending image card action is normalized with its operator and scope', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant',
    context: { open_chat_id: 'chat', open_message_id: 'card-message' },
    operator: { open_id: 'user' },
    action: {
      value: { action: 'image-run', token: 'opaque_token' },
      form_value: { task_description: '  比较图片并给出修改建议  ', ignored: 'drop-me' },
    },
  }, config);

  assert.deepEqual(action, {
    tenantKey: 'tenant',
    chatId: 'chat',
    messageId: 'card-message',
    operatorOpenId: 'user',
    action: 'image-run',
    token: 'opaque_token',
    taskDescription: '比较图片并给出修改建议',
  });
});

test('pending image card action accepts an empty optional description', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant',
    context: { open_chat_id: 'chat', open_message_id: 'card-message' },
    operator: { open_id: 'user' },
    action: {
      value: { action: 'image-run', token: 'opaque_token' },
      form_value: { task_description: '   ' },
    },
  }, config);

  assert.deepEqual(action, {
    tenantKey: 'tenant',
    chatId: 'chat',
    messageId: 'card-message',
    operatorOpenId: 'user',
    action: 'image-run',
    token: 'opaque_token',
    taskDescription: '',
  });
});

test('pending image card action rejects an oversized description', () => {
  const action = normalizeCardAction({
    tenant_key: 'tenant',
    context: { open_chat_id: 'chat', open_message_id: 'card-message' },
    operator: { open_id: 'user' },
    action: {
      value: { action: 'image-run', token: 'opaque_token' },
      form_value: { task_description: 'x'.repeat(config.maxTextLength + 1) },
    },
  }, config);

  assert.equal(action, null);
});

test('slash text inside a mixed post remains a normal image task', async () => {
  const dispatched: InboundMessage[] = [];
  const aggregator = new InboundMessageAggregator(
    async (message) => { dispatched.push(message); },
  );
  try {
    await aggregator.accept({
      ...normalizedText('mixed-slash', '/image-run'),
      messageType: 'post',
      imageReferences: [{ messageId: 'message-mixed-slash', imageKey: 'img_v3_mixed' }],
    });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]?.text, '/image-run');
    assert.equal(dispatched[0]?.imageReferences?.length, 1);
    assert.equal(isTextOnlyInboundMessage(dispatched[0] as InboundMessage), false);
  } finally {
    aggregator.close();
  }
});

test('help card documents the image task workflow', () => {
  const card = JSON.stringify(createHelpCard([]));
  assert.match(card, /图片任务/);
  assert.match(card, /提交图片/);
  assert.match(card, /兼容指令/);
  assert.match(card, /image-run/);
  assert.match(card, /image-cancel/);
});

function imageEvent(content: string): RawMessageEvent {
  return messageEvent('image', content);
}

function postEvent(content: string): RawMessageEvent {
  return messageEvent('post', content);
}

function messageEvent(messageType: string, content: string): RawMessageEvent {
  return {
    app_id: 'app',
    event_id: 'event',
    tenant_key: 'tenant',
    sender: {
      sender_type: 'user',
      tenant_key: 'tenant',
      sender_id: { open_id: 'user' },
    },
    message: {
      message_id: 'message',
      chat_id: 'chat',
      message_type: messageType,
      create_time: '1000000000',
      content,
    },
  };
}

function normalizedImage(id: string, imageKey: string): InboundMessage {
  return {
    ...normalizedText(id, ''),
    messageType: 'image',
    hasExplicitText: false,
    imageKey,
    imageReferences: [{ messageId: `message-${id}`, imageKey }],
  };
}

function normalizedText(id: string, text: string): InboundMessage {
  return {
    tenantKey: 'tenant',
    eventId: `event-${id}`,
    messageId: `message-${id}`,
    chatId: 'chat',
    rootMessageId: `message-${id}`,
    senderOpenId: 'user',
    messageType: 'text',
    hasExplicitText: true,
    text,
    imageReferences: [],
    payloadDigest: id,
    createdAtMs: 1_000,
  };
}

function resourceApi(bytes: Buffer): LarkMessageResourceApi {
  return {
    im: {
      messageResource: {
        get: async () => ({ getReadableStream: () => Readable.from([bytes]) }),
      },
    },
  };
}

function controlledResourceApi(bytes: Buffer): {
  readonly api: LarkMessageResourceApi;
  readonly started: string[];
  readonly maximumActive: number;
  readonly complete: (imageKey: string) => void;
} {
  const started: string[] = [];
  const completions = new Map<string, () => void>();
  let active = 0;
  let maximumActive = 0;
  return {
    api: {
      im: {
        messageResource: {
          get: ({ path }) => new Promise((resolve) => {
            started.push(path.file_key);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            completions.set(path.file_key, () => {
              active -= 1;
              resolve({ getReadableStream: () => Readable.from([bytes]) });
            });
          }),
        },
      },
    },
    started,
    get maximumActive(): number {
      return maximumActive;
    },
    complete: (imageKey) => {
      const completion = completions.get(imageKey);
      if (!completion) {
        throw new Error(`No active image download for ${imageKey}`);
      }
      completions.delete(imageKey);
      completion();
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadlineMs = Date.now() + 1_000;
  while (Date.now() < deadlineMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Condition was not met before timeout');
}
