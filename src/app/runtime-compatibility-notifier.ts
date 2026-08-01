import type {
  AppServerProtocolSmokeResult,
  AppServerProtocolSmokeTarget,
} from './codex/app-server-protocol-smoke';
import type { AppServerProtocolProfileId } from './codex/app-server-protocol-registry';
import type { CardKitJson } from './cards/layouts';
import type { LogFields } from './logger';

export interface RuntimeCompatibilityCheckTarget {
  readonly codexBin: string;
  readonly codexVersionOutput?: string;
  readonly codexVersion?: string;
  readonly schemaDigest?: string;
}

export interface RegisteredRuntimeCompatibilityResult {
  readonly adapterProfileId: AppServerProtocolProfileId;
  readonly source: 'registered';
}

type RuntimeCompatibilitySuccessResult =
  | AppServerProtocolSmokeResult
  | RegisteredRuntimeCompatibilityResult;

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
  private readonly checkId = `runtime-compat-${process.pid}-${Date.now().toString(36)}`;
  private readonly messages = new Map<string, string>();

  public constructor(private readonly options: RuntimeCompatibilityNotifierOptions) {
    this.chatIds = Object.freeze([...new Set(options.chatIds.filter((chatId) => chatId.trim()))]);
  }

  public async started(target: RuntimeCompatibilityCheckTarget): Promise<void> {
    this.messages.clear();
    if (this.chatIds.length === 0) {
      this.options.logger.info('runtime_compatibility_notification_skipped', {
        reason: 'no_chat_target',
      });
      return;
    }

    const startCard = createCompatibilityCard({
      template: 'blue',
      title: 'App Server 兼容检查中',
      content: [
        'Bridge 正在检查当前 Codex App Server runtime。',
        '正在采集版本、完整 schema digest，并按协议目录执行功能兼容判定。',
        '',
        compatibilityTargetMarkdown(target),
      ].join('\n'),
    });
    let cardId: string;
    try {
      cardId = await this.options.cards.createCard(startCard);
    } catch (error) {
      this.options.logger.error('runtime_compatibility_start_card_create_failed', error);
      return;
    }

    await Promise.all(this.chatIds.map(async (chatId, index) => {
      const operationKey = this.idempotencyKey(target, 'start', index);
      try {
        const messageId = await this.options.cards.sendCard(chatId, cardId, operationKey);
        this.messages.set(chatId, messageId);
        this.options.logger.info('runtime_compatibility_start_card_sent', { chatId });
      } catch (error) {
        await this.retryStartCard(chatId, operationKey, startCard, error);
      }
    }));
  }

  public async protocolSmokeStarted(target: AppServerProtocolSmokeTarget): Promise<void> {
    await this.deliverResult(target, 'smoke', createCompatibilityCard({
      template: 'blue',
      title: 'App Server 协议检查中',
      content: [
        '当前 exact pair 尚未登记。',
        '正在运行隔离协议检查，验证 Bridge 实际使用的非模型控制面。',
        '',
        compatibilityTargetMarkdown(target),
      ].join('\n'),
    }));
  }

  public async succeeded(
    target: RuntimeCompatibilityCheckTarget,
    result: RuntimeCompatibilitySuccessResult,
  ): Promise<void> {
    await this.deliverResult(target, 'success', createCompatibilityCard({
      template: 'green',
      title: 'App Server 兼容检查通过',
      content: successMarkdown(target, result),
    }));
  }

  public async failed(
    target: RuntimeCompatibilityCheckTarget | null,
    error: unknown,
  ): Promise<void> {
    await this.deliverResult(target, 'failed', createCompatibilityCard({
      template: 'red',
      title: 'App Server 兼容检查失败',
      content: [
        '结果：不兼容，Bridge 已拒绝继续启动。',
        `失败原因：${errorSummary(error)}`,
        '',
        target ? compatibilityTargetMarkdown(target) : 'Codex：`未完成 runtime 探测`',
      ].join('\n'),
    }));
  }

  private async deliverResult(
    target: RuntimeCompatibilityCheckTarget | null,
    phase: 'smoke' | 'success' | 'failed',
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
          this.options.logger.info('runtime_compatibility_result_card_patched', {
            chatId,
            phase,
          });
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
          this.idempotencyKey(target, phase, index),
        );
        this.options.logger.info('runtime_compatibility_result_card_sent', {
          chatId,
          phase,
        });
      } catch (error) {
        this.options.logger.error('runtime_compatibility_result_card_send_failed', error, {
          chatId,
          phase,
        });
      }
    }));
  }

  private idempotencyKey(
    target: RuntimeCompatibilityCheckTarget | null,
    phase: 'start' | 'smoke' | 'success' | 'failed',
    index: number,
  ): string {
    const version = target?.codexVersion ?? 'unknown';
    const digest = target?.schemaDigest ?? this.checkId;
    return `runtime-compat:${phase}:${version}:${digest}:${index}`;
  }

  private async retryStartCard(
    chatId: string,
    operationKey: string,
    card: CardKitJson,
    firstError: unknown,
  ): Promise<void> {
    try {
      const retryCardId = await this.options.cards.createCard(card);
      const messageId = await this.options.cards.sendCard(chatId, retryCardId, operationKey);
      this.messages.set(chatId, messageId);
      this.options.logger.info('runtime_compatibility_start_card_sent', {
        chatId,
        retry: true,
      });
    } catch (error) {
      this.options.logger.error('runtime_compatibility_start_card_send_failed', error, {
        chatId,
        firstError: errorSummary(firstError),
      });
    }
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

function compatibilityTargetMarkdown(target: RuntimeCompatibilityCheckTarget): string {
  const codex = target.codexVersionOutput ?? (
    target.codexVersion ? `codex-cli ${target.codexVersion}` : 'detecting'
  );
  return [
    `Codex：\`${codex}\``,
    `Schema：\`${target.schemaDigest ?? 'detecting'}\``,
  ].join('\n');
}

function successMarkdown(
  target: RuntimeCompatibilityCheckTarget,
  result: RuntimeCompatibilitySuccessResult,
): string {
  const lines = [
    isProtocolSmokeResult(result)
      ? '结果：兼容，Bridge 已自动支持当前 exact pair。'
      : '结果：兼容，Bridge 已确认当前 exact pair 已支持。',
    `协议：\`${result.adapterProfileId}\``,
  ];
  if (isProtocolSmokeResult(result)) {
    lines.push(
      `验证方法：${result.provenMethods.length} 个控制面方法`,
      `Rate limit：\`${result.rateLimitsCapability}\``,
    );
  } else {
    lines.push('来源：`已登记版本`');
  }
  return [...lines, '', compatibilityTargetMarkdown(target)].join('\n');
}

function isProtocolSmokeResult(
  result: RuntimeCompatibilitySuccessResult,
): result is AppServerProtocolSmokeResult {
  return 'provenMethods' in result;
}

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) {
    return '`UnknownError`';
  }
  const message = error.message.replace(/\s+/g, ' ').slice(0, 240);
  return message ? `\`${error.name}: ${message}\`` : `\`${error.name}\``;
}
