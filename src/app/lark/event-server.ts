import * as Lark from '@larksuiteoapi/node-sdk';

import { BridgeConfig } from '../domain';
import { createRedactedLarkSdkLogger, type LarkSdkLogSink } from './client';
import {
  InboundMessage,
  normalizeInboundMessage,
  RawMessageEvent,
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

export interface LarkEventHandlers {
  readonly onMessage: (message: InboundMessage) => Promise<void>;
  readonly onCardAction: (action: InboundCardAction) => Promise<unknown>;
  readonly onRejectedEvent?: (reason: string) => void;
  readonly onHandlerError?: (kind: 'message' | 'card_action', error: Error) => void;
  readonly onScopeBound?: (config: BridgeConfig) => void;
  readonly onSdkLog?: LarkSdkLogSink;
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
): InboundCardAction | null {
  const tenantKey = nonBlank(event.tenant_key);
  const chatId = nonBlank(event.context?.open_chat_id);
  const messageId = nonBlank(event.context?.open_message_id);
  const operatorOpenId = nonBlank(event.operator?.open_id);
  const value = event.action?.value;
  if (
    tenantKey !== config.larkTenantKey
    || !chatId
    || !config.allowedChats.includes(chatId)
    || !messageId
    || !operatorOpenId
    || !isRecord(value)
  ) {
    return null;
  }

  const action = nonBlank(value.action);
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
  ) {
    this.activeConfig = config;
  }

  private activeConfig: BridgeConfig;

  public async start(): Promise<void> {
    if (this.dispatcher) {
      throw new Error('Lark event server is already started');
    }

    const dispatcher = new Lark.EventDispatcher({
      logger: createRedactedLarkSdkLogger(this.handlers.onSdkLog),
    }).register({
      'im.message.receive_v1': async (event: RawMessageEvent) => {
        let scopedConfig: BridgeConfig;
        try {
          scopedConfig = this.resolveMessageScope(event);
        } catch (error) {
          const handlerError = toError(error);
          this.handlers.onHandlerError?.('message', handlerError);
          throw handlerError;
        }
        const result = normalizeInboundMessage(event, scopedConfig);
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
        const action = normalizeCardAction(event, this.activeConfig);
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
