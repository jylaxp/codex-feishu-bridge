import type {
  AppServerProtocolSmokeResult,
  AppServerProtocolSmokeTarget,
} from './codex/app-server-protocol-smoke';
import type { CardKitJson } from './cards/layouts';
import type { LogFields } from './logger';

export interface RuntimeCompatibilityCardClient {
  createCard(card: CardKitJson): Promise<string>;
  sendCard(chatId: string, cardId: string, idempotencyKey: string): Promise<string>;
  patchMessage(messageId: string, card: CardKitJson): Promise<void>;
}

export interface RuntimeCompatibilityLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
}

export interface RuntimeCompatibilityNotifierOptions {
  readonly cards: RuntimeCompatibilityCardClient;
  readonly chatIds: readonly string[];
  readonly logger: RuntimeCompatibilityLogger;
}

/**
 * Posts best-effort Feishu visibility for startup protocol smoke checks.
 *
 * Notification delivery must never decide runtime compatibility. The protocol
 * smoke result remains the only gate; card failures are diagnostic side effects.
 */
export class RuntimeCompatibilityNotifier {
  private readonly chatIds: readonly string[];
  private readonly messages = new Map<string, string>();

  public constructor(private readonly options: RuntimeCompatibilityNotifierOptions) {
    this.chatIds = Object.freeze([...new Set(options.chatIds.filter((chatId) => chatId.trim()))]);
  }

  public async started(target: AppServerProtocolSmokeTarget): Promise<void> {
    this.messages.clear();
    if (this.chatIds.length === 0) {
      this.options.logger.info('runtime_compatibility_notification_skipped', {
        reason: 'no_chat_target',
      });
      return;
    }

    let cardId: string;
    try {
      cardId = await this.options.cards.createCard(createCompatibilityCard({
        template: 'blue',
        title: 'App Server 兼容检查中',
        content: [
          'Bridge 检测到当前 Codex App Server exact pair 尚未登记。',
          '正在运行隔离协议检查，验证 Bridge 实际使用的非模型控制面。',
          '',
          compatibilityTargetMarkdown(target),
        ].join('\n'),
      }));
    } catch (error) {
      this.options.logger.error('runtime_compatibility_start_card_create_failed', error);
      return;
    }

    await Promise.all(this.chatIds.map(async (chatId, index) => {
      try {
        const messageId = await this.options.cards.sendCard(
          chatId,
          cardId,
          idempotencyKey(target, 'start', index),
        );
        this.messages.set(chatId, messageId);
      } catch (error) {
        this.options.logger.error('runtime_compatibility_start_card_send_failed', error, {
          chatId,
        });
      }
    }));
  }

  public async succeeded(
    target: AppServerProtocolSmokeTarget,
    result: AppServerProtocolSmokeResult,
  ): Promise<void> {
    await this.deliverResult(target, 'success', createCompatibilityCard({
      template: 'green',
      title: 'App Server 兼容检查通过',
      content: [
        '结果：兼容，Bridge 已自动支持当前 exact pair。',
        `协议：\`${result.adapterProfileId}\``,
        `验证方法：${result.provenMethods.length} 个控制面方法`,
        `Rate limit：\`${result.rateLimitsCapability}\``,
        '',
        compatibilityTargetMarkdown(target),
      ].join('\n'),
    }));
  }

  public async failed(target: AppServerProtocolSmokeTarget, error: unknown): Promise<void> {
    await this.deliverResult(target, 'failed', createCompatibilityCard({
      template: 'red',
      title: 'App Server 兼容检查失败',
      content: [
        '结果：不兼容，Bridge 已拒绝继续启动。',
        `失败原因：${errorSummary(error)}`,
        '',
        compatibilityTargetMarkdown(target),
      ].join('\n'),
    }));
  }

  private async deliverResult(
    target: AppServerProtocolSmokeTarget,
    phase: 'success' | 'failed',
    card: CardKitJson,
  ): Promise<void> {
    if (this.chatIds.length === 0) {
      return;
    }

    let fallbackCardId: Promise<string> | null = null;
    await Promise.all(this.chatIds.map(async (chatId, index) => {
      const existingMessageId = this.messages.get(chatId);
      if (existingMessageId) {
        try {
          await this.options.cards.patchMessage(existingMessageId, card);
          return;
        } catch (error) {
          this.options.logger.error('runtime_compatibility_result_card_patch_failed', error, {
            chatId,
            phase,
          });
        }
      }

      try {
        if (fallbackCardId === null) {
          fallbackCardId = this.options.cards.createCard(card);
        }
        const cardId = await fallbackCardId;
        await this.options.cards.sendCard(
          chatId,
          cardId,
          idempotencyKey(target, phase, index),
        );
      } catch (error) {
        this.options.logger.error('runtime_compatibility_result_card_send_failed', error, {
          chatId,
          phase,
        });
      }
    }));
  }
}

export function runtimeCompatibilityNotificationChatIds(
  allowedChats: readonly string[],
  bindingChats: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set(
    [...allowedChats, ...bindingChats]
      .map((chatId) => chatId.trim())
      .filter(Boolean),
  )]);
}

function createCompatibilityCard(input: {
  readonly template: 'blue' | 'green' | 'red';
  readonly title: string;
  readonly content: string;
}): CardKitJson {
  return Object.freeze({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    body: {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: input.content },
      }],
    },
  });
}

function compatibilityTargetMarkdown(target: AppServerProtocolSmokeTarget): string {
  return [
    `Codex：\`${target.codexVersionOutput}\``,
    `Schema：\`${target.schemaDigest}\``,
  ].join('\n');
}

function idempotencyKey(
  target: AppServerProtocolSmokeTarget,
  phase: 'start' | 'success' | 'failed',
  index: number,
): string {
  return `runtime-compat:${phase}:${target.codexVersion}:${target.schemaDigest}:${index}`;
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) {
    return '`UnknownError`';
  }
  const message = error.message.replace(/\s+/g, ' ').slice(0, 240);
  return message ? `\`${error.name}: ${message}\`` : `\`${error.name}\``;
}
