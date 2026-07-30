import * as Lark from '@larksuiteoapi/node-sdk';

import { DEFAULT_BOT_KEY } from '../bot-config-store';
import type { BridgeConfig } from '../domain';
import { createRedactedLarkSdkLogger, type LarkSdkLogSink } from './client';
import {
  normalizeInboundMessage,
  normalizeInboundReplyContext,
  type InboundMessage,
  type InboundReplyContext,
  type RawMessageEvent,
} from './intake';
import type { LarkScope } from './scope-config-store';

const MAX_OPAQUE_ACTION_TOKEN_LENGTH = 256;
const MAX_SIGNED_BINDING_TOKEN_LENGTH = 1024;

export type CardActionKind =
  | 'approval'
  | 'binding'
  | 'cancel'
  | 'open'
  | 'model'
  | 'skill'
  | 'image-run'
  | 'image-cancel';

type CardActionOption = string | { readonly value?: unknown };

export interface InboundCardAction {
  readonly botKey: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly action: CardActionKind;
  readonly token: string;
  readonly taskDescription?: string;
}

export interface RawCardActionEvent {
  readonly tenant_key?: string;
  readonly context?: {
    readonly open_message_id?: string;
    readonly open_chat_id?: string;
  };
  readonly operator?: { readonly open_id?: string };
  readonly action?: {
    readonly value?: unknown;
    /**
     * `select_static` callbacks use a string in the current Feishu SDK.
     * Keep the object variant for older callback envelopes.
     */
    readonly option?: CardActionOption;
    readonly form_value?: Readonly<Record<string, unknown>>;
  };
}

export interface RawBotMembershipEvent {
  readonly event_id?: string;
  readonly tenant_key?: string;
  readonly app_id?: string;
  readonly chat_id?: string;
  readonly operator_id?: {
    readonly open_id?: string;
    readonly user_id?: string;
    readonly union_id?: string;
  };
  readonly external?: boolean;
  readonly operator_tenant_key?: string;
  readonly name?: string;
  readonly i18n_names?: {
    readonly zh_cn?: string;
    readonly en_us?: string;
    readonly ja_jp?: string;
  };
}

export interface InboundBotMembershipEvent {
  readonly botKey: string;
  readonly tenantKey: string;
  readonly eventId: string;
  readonly chatId: string;
  readonly operatorOpenId?: string;
  readonly operatorTenantKey?: string;
  readonly external?: boolean;
  readonly botName?: string;
}

export interface LarkEventHandlers {
  readonly onMessage: (message: InboundMessage) => Promise<void>;
  readonly onCardAction: (action: InboundCardAction) => Promise<unknown>;
  readonly onBotAdded?: (event: InboundBotMembershipEvent) => Promise<void>;
  readonly onBotDeleted?: (event: InboundBotMembershipEvent) => Promise<void>;
  readonly onUnavailableMessage?: (
    context: InboundReplyContext,
    reason: LarkUnavailableReason,
  ) => Promise<void>;
  readonly onRejectedEvent?: (reason: string) => void;
  readonly onHandlerError?: (kind: 'message' | 'card_action' | 'bot_membership', error: Error) => void;
  readonly onScopeBound?: (config: BridgeConfig) => void;
  readonly onSdkLog?: LarkSdkLogSink;
}

export type LarkUnavailableReason = 'BOT_DISABLED';

export interface LarkEventServerOptions {
  readonly unavailableReason?: LarkUnavailableReason;
}

export interface LarkScopeAutoBindStore {
  save(scope: LarkScope): void;
}

export interface LarkWebSocketClient {
  start(params: { readonly eventDispatcher: Lark.EventDispatcher }): Promise<void>;
  close(params?: { readonly force?: boolean }): void;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectedOptionValue(option: CardActionOption | undefined): string | null {
  if (typeof option === 'string') {
    return nonBlank(option);
  }
  return isRecord(option) ? nonBlank(option.value) : null;
}

/** Normalizes the minimal callback fields without retaining the raw payload. */
export function normalizeCardAction(
  event: RawCardActionEvent,
  config: BridgeConfig,
  botKey: string = config.botKey ?? DEFAULT_BOT_KEY,
): InboundCardAction | null {
  const tenantKey = nonBlank(event.tenant_key);
  const chatId = nonBlank(event.context?.open_chat_id);
  const messageId = nonBlank(event.context?.open_message_id);
  const operatorOpenId = nonBlank(event.operator?.open_id);
  const value = event.action?.value;
  const action = isRecord(value) ? nonBlank(value.action) : null;
  const chatAllowed = !!chatId
    && (config.allowedChats.length === 0 || config.allowedChats.includes(chatId));
  const bindingBootstrap = action === 'binding'
    && !!operatorOpenId
    && config.authorizedUsers.includes(operatorOpenId);
  if (
    tenantKey !== config.larkTenantKey
    || !chatId
    || (!chatAllowed && !bindingBootstrap)
    || !messageId
    || !operatorOpenId
    || !isRecord(value)
  ) {
    return null;
  }

  const selectedOption = selectedOptionValue(event.action?.option);
  const token = action === 'binding' || action === 'model' || action === 'skill'
    ? selectedOption ?? nonBlank(value.token)
    : nonBlank(value.token);
  const tokenPattern = action === 'binding' || action === 'open'
    ? /^[A-Za-z0-9_.-]+$/
    : /^[A-Za-z0-9_-]+$/;
  const maxTokenLength = action === 'binding' || action === 'open'
    ? MAX_SIGNED_BINDING_TOKEN_LENGTH
    : MAX_OPAQUE_ACTION_TOKEN_LENGTH;
  if (
    (
      action !== 'approval'
      && action !== 'binding'
      && action !== 'cancel'
      && action !== 'open'
      && action !== 'model'
      && action !== 'skill'
      && action !== 'image-run'
      && action !== 'image-cancel'
    )
    || !token
    || token.length > maxTokenLength
    || !tokenPattern.test(token)
  ) {
    return null;
  }

  const rawTaskDescription = event.action?.form_value?.task_description;
  if (
    action === 'image-run'
    && rawTaskDescription !== undefined
    && typeof rawTaskDescription !== 'string'
  ) {
    return null;
  }
  const taskDescription = action === 'image-run' && typeof rawTaskDescription === 'string'
    ? rawTaskDescription.trim()
    : undefined;
  if (taskDescription !== undefined && taskDescription.length > config.maxTextLength) {
    return null;
  }

  return Object.freeze({
    botKey,
    tenantKey,
    chatId,
    messageId,
    operatorOpenId,
    action,
    token,
    ...(taskDescription !== undefined ? { taskDescription } : {}),
  });
}

/** Wires SDK-verified WebSocket events to the clean-slate application handlers. */
export class LarkEventServer {
  private dispatcher: Lark.EventDispatcher | undefined;

  public constructor(
    private readonly websocket: LarkWebSocketClient,
    config: BridgeConfig,
    private readonly handlers: LarkEventHandlers,
    private readonly scopeAutoBindStore?: LarkScopeAutoBindStore,
    private readonly options: LarkEventServerOptions = {},
  ) {
    this.activeConfig = config;
    this.botKey = config.botKey ?? DEFAULT_BOT_KEY;
  }

  private activeConfig: BridgeConfig;
  private readonly botKey: string;

  public async start(): Promise<void> {
    if (this.dispatcher) {
      throw new Error('Lark event server is already started');
    }

    const dispatcher = new Lark.EventDispatcher({
      logger: createRedactedLarkSdkLogger(this.handlers.onSdkLog),
    }).register({
      'im.message.receive_v1': async (event: RawMessageEvent) => {
        if (this.options.unavailableReason) {
          const context = normalizeInboundReplyContext(
            event,
            this.activeConfig,
            Date.now,
            this.botKey,
          );
          if (!context) {
            this.handlers.onRejectedEvent?.(this.options.unavailableReason);
            return;
          }
          try {
            await this.handlers.onUnavailableMessage?.(context, this.options.unavailableReason);
          } catch (error) {
            const handlerError = toError(error);
            this.handlers.onHandlerError?.('message', handlerError);
            throw handlerError;
          }
          return;
        }
        let scopedConfig: BridgeConfig;
        try {
          scopedConfig = this.resolveMessageScope(event);
        } catch (error) {
          const handlerError = toError(error);
          this.handlers.onHandlerError?.('message', handlerError);
          throw handlerError;
        }
        const result = normalizeInboundMessage(event, scopedConfig, Date.now, this.botKey);
        if (!result.accepted) {
          this.handlers.onRejectedEvent?.(result.reason);
          return;
        }
        try {
          await this.handlers.onMessage(result.message);
        } catch (error) {
          const handlerError = toError(error);
          this.handlers.onHandlerError?.('message', handlerError);
          throw handlerError;
        }
      },
      'card.action.trigger': async (event: RawCardActionEvent) => {
        if (this.options.unavailableReason) {
          return toast(unavailableToast(this.options.unavailableReason), 'warning');
        }
        const action = normalizeCardAction(event, this.activeConfig, this.botKey);
        if (!action) {
          this.handlers.onRejectedEvent?.('CARD_ACTION_INVALID');
          return toast('操作无效或已失效', 'warning');
        }
        try {
          return await this.handlers.onCardAction(action);
        } catch (error) {
          this.handlers.onHandlerError?.('card_action', toError(error));
          return toast('操作提交失败，请稍后重试', 'error');
        }
      },
      'im.chat.member.bot.added_v1': async (event: RawBotMembershipEvent) => {
        await this.handleBotMembershipEvent(event, this.handlers.onBotAdded);
      },
      'im.chat.member.bot.deleted_v1': async (event: RawBotMembershipEvent) => {
        await this.handleBotMembershipEvent(event, this.handlers.onBotDeleted);
      },
    });

    this.dispatcher = dispatcher;
    try {
      await this.websocket.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.dispatcher = undefined;
      throw error;
    }
  }

  public stop(): void {
    this.dispatcher = undefined;
    this.websocket.close({ force: false });
  }

  private resolveMessageScope(event: RawMessageEvent): BridgeConfig {
    if (!scopeNeedsBootstrap(this.activeConfig)) {
      return this.activeConfig;
    }

    const tenantKey = nonBlank(event.tenant_key);
    const senderTenantKey = nonBlank(event.sender?.tenant_key);
    const chatId = nonBlank(event.message?.chat_id);
    const senderOpenId = nonBlank(event.sender?.sender_id?.open_id);
    if (
      event.app_id !== this.activeConfig.larkAppId
      || event.sender?.sender_type !== 'user'
      || !tenantKey
      || !chatId
      || event.message?.chat_type !== 'p2p'
      || !senderOpenId
      || (
        this.activeConfig.authorizedUsers.length > 0
        && !this.activeConfig.authorizedUsers.includes(senderOpenId)
      )
      || (senderTenantKey !== null && senderTenantKey !== tenantKey)
      || (this.activeConfig.larkTenantKey && tenantKey !== this.activeConfig.larkTenantKey)
      || (
        this.activeConfig.allowedChats.length > 0
        && !this.activeConfig.allowedChats.includes(chatId)
      )
    ) {
      return this.activeConfig;
    }

    const nextConfig: BridgeConfig = Object.freeze({
      ...this.activeConfig,
      larkTenantKey: this.activeConfig.larkTenantKey || tenantKey,
      allowedChats: this.activeConfig.allowedChats.length > 0
        ? this.activeConfig.allowedChats
        : Object.freeze([chatId]),
      authorizedUsers: this.activeConfig.authorizedUsers.length > 0
        ? this.activeConfig.authorizedUsers
        : Object.freeze([senderOpenId]),
      allowedApprovers: this.activeConfig.allowedApprovers.length > 0
        ? this.activeConfig.allowedApprovers
        : Object.freeze([senderOpenId]),
    });
    this.scopeAutoBindStore?.save({
      tenantKey: nextConfig.larkTenantKey,
      allowedChats: nextConfig.allowedChats.join(','),
      authorizedUsers: nextConfig.authorizedUsers.join(','),
      allowedApprovers: nextConfig.allowedApprovers.join(','),
    });
    this.activeConfig = nextConfig;
    this.handlers.onScopeBound?.(nextConfig);
    return this.activeConfig;
  }

  private async handleBotMembershipEvent(
    event: RawBotMembershipEvent,
    handler: ((event: InboundBotMembershipEvent) => Promise<void>) | undefined,
  ): Promise<void> {
    const normalized = this.normalizeBotMembershipEvent(event);
    if (!normalized) {
      this.handlers.onRejectedEvent?.('BOT_MEMBERSHIP_INVALID');
      return;
    }
    try {
      await handler?.(normalized);
    } catch (error) {
      const handlerError = toError(error);
      this.handlers.onHandlerError?.('bot_membership', handlerError);
      throw handlerError;
    }
  }

  private normalizeBotMembershipEvent(event: RawBotMembershipEvent): InboundBotMembershipEvent | null {
    const tenantKey = nonBlank(event.tenant_key) ?? this.activeConfig.larkTenantKey;
    const chatId = nonBlank(event.chat_id);
    const eventId = nonBlank(event.event_id) ?? `${this.botKey}:${chatId ?? 'unknown'}:${Date.now()}`;
    if (
      event.app_id !== this.activeConfig.larkAppId
      || !tenantKey
      || !chatId
      || (this.activeConfig.larkTenantKey && tenantKey !== this.activeConfig.larkTenantKey)
    ) {
      return null;
    }
    const operatorOpenId = nonBlank(event.operator_id?.open_id);
    const operatorTenantKey = nonBlank(event.operator_tenant_key);
    const botName = botMembershipName(event);
    return Object.freeze({
      botKey: this.botKey,
      tenantKey,
      eventId,
      chatId,
      ...(operatorOpenId ? { operatorOpenId } : {}),
      ...(operatorTenantKey ? { operatorTenantKey } : {}),
      ...(event.external !== undefined ? { external: event.external } : {}),
      ...(botName ? { botName } : {}),
    });
  }
}

function unavailableToast(reason: LarkUnavailableReason): string {
  if (reason === 'BOT_DISABLED') {
    return '机器人已被 Bridge 管理员禁用，当前不会处理任务。';
  }
  return '机器人当前不可用。';
}

function botMembershipName(event: RawBotMembershipEvent): string | null {
  return nonBlank(event.name)
    ?? nonBlank(event.i18n_names?.zh_cn)
    ?? nonBlank(event.i18n_names?.en_us)
    ?? nonBlank(event.i18n_names?.ja_jp);
}

function scopeNeedsBootstrap(config: BridgeConfig): boolean {
  return !config.larkTenantKey
    || config.allowedChats.length === 0
    || config.authorizedUsers.length === 0
    || config.allowedApprovers.length === 0;
}

/** Card-action callback response understood by Feishu clients. */
export function toast(content: string, type: 'success' | 'warning' | 'error'): object {
  return {
    toast: {
      type,
      content,
      i18n: { zh_cn: content, en_us: content },
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown Lark event handler error');
}
