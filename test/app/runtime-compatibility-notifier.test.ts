import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AppServerProtocolSmokeResult,
  AppServerProtocolSmokeTarget,
} from '../../src/app/codex/app-server-protocol-smoke';
import type { CardKitJson } from '../../src/app/cards/layouts';
import {
  RuntimeCompatibilityNotifier,
  runtimeCompatibilityNotificationChatIds,
  type RuntimeCompatibilityCardClient,
  type RuntimeCompatibilityLogger,
} from '../../src/app/runtime-compatibility-notifier';

const target: AppServerProtocolSmokeTarget = Object.freeze({
  codexBin: '/Applications/ChatGPT.app/Contents/Resources/codex',
  codexVersionOutput: 'codex-cli 0.146.0-alpha.9.2',
  codexVersion: '0.146.0-alpha.9.2',
  schemaDigest: '9db7ac39730e01ec6942886fba92f02c992ac0c18d9d39d748e2f0065c980961',
});

const smokeResult: AppServerProtocolSmokeResult = Object.freeze({
  adapterProfileId: 'app-server-0.145.0-alpha.18',
  provenMethods: Object.freeze([
    'thread/list',
    'thread/start',
    'thread/name/set',
    'thread/read',
    'thread/resume',
    'thread/fork',
    'thread/goal/set',
    'thread/goal/get',
    'thread/goal/clear',
    'skills/list',
    'mcpServerStatus/list',
    'thread/archive',
  ] as const),
  rateLimitsCapability: 'unavailable:REQUEST_FAILED',
  compactCapability: 'not-attempted:model-operation-prohibited',
});

test('runtime compatibility notifier sends start card and patches successful result', async () => {
  const cards = new RecordingCards();
  const logger = new RecordingLogger();
  const notifier = new RuntimeCompatibilityNotifier({
    cards,
    chatIds: ['chat-a', 'chat-b', 'chat-a', '  '],
    logger,
  });

  await notifier.started(target);
  await notifier.succeeded(target, smokeResult);

  assert.deepEqual(cards.sends.map((send) => send.chatId), ['chat-a', 'chat-b']);
  assert.equal(cards.createdCards.length, 1);
  assert.match(JSON.stringify(cards.createdCards[0]), /兼容检查中/);
  assert.deepEqual(cards.patches.map((patch) => patch.messageId), [
    'message-chat-a-card-1',
    'message-chat-b-card-1',
  ]);
  assert.match(JSON.stringify(cards.patches[0]?.card), /兼容检查通过/);
  assert.equal(logger.errors.length, 0);
});

test('runtime compatibility notifier sends failed result even when no start card exists', async () => {
  const cards = new RecordingCards();
  const logger = new RecordingLogger();
  const notifier = new RuntimeCompatibilityNotifier({
    cards,
    chatIds: ['chat-a'],
    logger,
  });

  await notifier.failed(target, new Error('protocol smoke failed'));

  assert.equal(cards.createdCards.length, 1);
  assert.deepEqual(cards.sends.map((send) => send.chatId), ['chat-a']);
  assert.match(JSON.stringify(cards.createdCards[0]), /兼容检查失败/);
  assert.match(JSON.stringify(cards.createdCards[0]), /protocol smoke failed/);
  assert.equal(logger.errors.length, 0);
});

test('runtime compatibility notifier logs delivery failures without throwing', async () => {
  const cards = new RecordingCards({ failSendFor: 'chat-b' });
  const logger = new RecordingLogger();
  const notifier = new RuntimeCompatibilityNotifier({
    cards,
    chatIds: ['chat-a', 'chat-b'],
    logger,
  });

  await notifier.started(target);
  await notifier.succeeded(target, smokeResult);

  assert.deepEqual(cards.sends.map((send) => send.chatId), ['chat-a', 'chat-b', 'chat-b']);
  assert.equal(cards.patches.length, 1);
  assert.deepEqual(logger.errors.map((error) => error.event), [
    'runtime_compatibility_start_card_send_failed',
    'runtime_compatibility_result_card_send_failed',
  ]);
});

test('runtime compatibility notification targets are allowed chats plus binding chats', () => {
  assert.deepEqual(
    runtimeCompatibilityNotificationChatIds(
      ['chat-a', ' ', 'chat-b'],
      ['chat-b', 'chat-c'],
    ),
    ['chat-a', 'chat-b', 'chat-c'],
  );
});

class RecordingCards implements RuntimeCompatibilityCardClient {
  public readonly createdCards: CardKitJson[] = [];
  public readonly sends: Array<{
    readonly chatId: string;
    readonly cardId: string;
    readonly idempotencyKey: string;
  }> = [];
  public readonly patches: Array<{
    readonly messageId: string;
    readonly card: CardKitJson;
  }> = [];

  public constructor(private readonly options: { readonly failSendFor?: string } = {}) {}

  public async createCard(card: CardKitJson): Promise<string> {
    this.createdCards.push(card);
    return `card-${this.createdCards.length}`;
  }

  public async sendCard(
    chatId: string,
    cardId: string,
    idempotencyKey: string,
  ): Promise<string> {
    this.sends.push({ chatId, cardId, idempotencyKey });
    if (chatId === this.options.failSendFor) {
      throw new Error('send failed');
    }
    return `message-${chatId}-${cardId}`;
  }

  public async patchMessage(messageId: string, card: CardKitJson): Promise<void> {
    this.patches.push({ messageId, card });
  }
}

class RecordingLogger implements RuntimeCompatibilityLogger {
  public readonly infos: Array<{ readonly event: string; readonly fields: unknown }> = [];
  public readonly warnings: Array<{ readonly event: string; readonly fields: unknown }> = [];
  public readonly errors: Array<{ readonly event: string; readonly error: unknown }> = [];

  public info(event: string, fields?: unknown): void {
    this.infos.push({ event, fields });
  }

  public warn(event: string, fields?: unknown): void {
    this.warnings.push({ event, fields });
  }

  public error(event: string, error: unknown): void {
    this.errors.push({ event, error });
  }
}
