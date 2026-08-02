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

export interface RuntimeCompatibilityChatInfoClient {
  getChatMode(chatId: string): Promise<string | null>;
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
      title: '开始检查兼容性',
      content: [
        'Bridge 开始检查当前 ChatGPT/Codex App Server 兼容性。',
        '正在采集版本与协议信息，确认当前版本是否可以继续使用。',
        '',
        compatibilityRuntimeMarkdown(target),
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

  public async runtimeDetected(target: RuntimeCompatibilityCheckTarget): Promise<void> {
    await this.deliverStatus(target, 'detected', createCompatibilityCard({
      template: 'blue',
      title: '兼容性检查中',
      content: [
        'Bridge 已完成版本与协议信息采集。',
        '正在判定当前版本是否兼容、是否可以继续使用。',
        '',
        compatibilityRuntimeMarkdown(target),
      ].join('\n'),
    }));
  }

  public async protocolSmokeStarted(target: AppServerProtocolSmokeTarget): Promise<void> {
    await this.deliverStatus(target, 'smoke', createCompatibilityCard({
      template: 'blue',
      title: '协议兼容性检查中',
      content: [
        '当前版本尚未登记为已支持版本。',
        '正在运行协议功能检测，确认 Bridge 是否还能继续使用。',
        '',
        compatibilityRuntimeMarkdown(target),
      ].join('\n'),
    }));
  }

  public async succeeded(
    target: RuntimeCompatibilityCheckTarget,
    result: RuntimeCompatibilitySuccessResult,
  ): Promise<void> {
    await this.deliverStatus(target, 'success', createCompatibilityCard({
      template: 'green',
      title: '兼容性检查通过',
      content: successMarkdown(target, result),
    }));
  }

  public async failed(
    target: RuntimeCompatibilityCheckTarget | null,
    error: unknown,
  ): Promise<void> {
    await this.deliverStatus(target, 'failed', createCompatibilityCard({
      template: 'red',
      title: '兼容性检查不通过',
      content: [
        '结果：兼容性不通过，当前版本不能使用。',
        'Bridge 已拒绝继续启动，请回退到已支持版本或先完成协议适配。',
        `失败原因：${errorSummary(error)}`,
        '',
        target ? compatibilityRuntimeMarkdown(target) : 'Codex：`未完成版本探测`',
      ].join('\n'),
    }));
  }

  private async deliverStatus(
    target: RuntimeCompatibilityCheckTarget | null,
    phase: 'detected' | 'smoke' | 'success' | 'failed',
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
    phase: 'start' | 'detected' | 'smoke' | 'success' | 'failed',
    index: number,
  ): string {
    const version = target?.codexVersion ?? 'unknown';
    return `runtime-compat:${phase}:${version}:${this.checkId}:${index}`;
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
): readonly string[] {
  return Object.freeze([...new Set(
    allowedChats
      .map((chatId) => chatId.trim())
      .filter(Boolean),
  )]);
}

export async function runtimeCompatibilityDirectNotificationChatIds(
  allowedChats: readonly string[],
  chatInfo: RuntimeCompatibilityChatInfoClient,
  logger: RuntimeCompatibilityLogger,
): Promise<readonly string[]> {
  const chatIds = runtimeCompatibilityNotificationChatIds(allowedChats);
  const checked = await Promise.all(chatIds.map(async (chatId) => {
    try {
      const chatMode = await chatInfo.getChatMode(chatId);
      if (chatMode === 'p2p' || chatMode === 'direct') {
        return { chatId, accepted: true };
      }
      logger.info('runtime_compatibility_notification_chat_skipped', {
        chatId,
        reason: 'not_direct_chat',
        chatMode: chatMode ?? 'unknown',
      });
    } catch (error) {
      logger.warn('runtime_compatibility_notification_chat_skipped', {
        chatId,
        reason: 'chat_mode_unavailable',
        error: errorSummary(error),
      });
    }
    return { chatId, accepted: false };
  }));
  return Object.freeze(checked
    .filter((result) => result.accepted)
    .map((result) => result.chatId));
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

function compatibilityRuntimeMarkdown(target: RuntimeCompatibilityCheckTarget): string {
  const codex = target.codexVersionOutput ?? (
    target.codexVersion ? `codex-cli ${target.codexVersion}` : 'detecting'
  );
  return `Codex：\`${codex}\``;
}

function successMarkdown(
  target: RuntimeCompatibilityCheckTarget,
  result: RuntimeCompatibilitySuccessResult,
): string {
  const lines = [
    isProtocolSmokeResult(result)
      ? '结果：兼容性通过，可以继续使用。Bridge 已自动支持当前版本。'
      : '结果：兼容性通过，可以继续使用。Bridge 已确认当前版本已支持。',
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
  return [...lines, '', compatibilityRuntimeMarkdown(target)].join('\n');
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
