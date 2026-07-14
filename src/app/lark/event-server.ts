import * as Lark from '@larksuiteoapi/node-sdk';

import { BridgeConfig } from '../domain';
import {
  InboundTextMessage,
  normalizeInboundMessage,
  RawMessageEvent,
} from './intake';

const MAX_OPAQUE_ACTION_TOKEN_LENGTH = 256;
const MAX_SIGNED_BINDING_TOKEN_LENGTH = 1024;

export type CardActionKind = 'approval' | 'binding' | 'cancel';

type CardActionOption = string | { readonly value?: unknown };

export interface InboundCardAction {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly action: CardActionKind;
  readonly token: string;
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
  };
}

export interface LarkEventHandlers {
  readonly onMessage: (message: InboundTextMessage) => Promise<void>;
  readonly onCardAction: (action: InboundCardAction) => Promise<unknown>;
  readonly onRejectedEvent?: (reason: string) => void;
  readonly onHandlerError?: (kind: 'message' | 'card_action', error: Error) => void;
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
  const token = action === 'binding'
    ? selectedOption ?? nonBlank(value.token)
    : nonBlank(value.token);
  const tokenPattern = action === 'binding'
    ? /^[A-Za-z0-9_.-]+$/
    : /^[A-Za-z0-9_-]+$/;
  const maxTokenLength = action === 'binding'
    ? MAX_SIGNED_BINDING_TOKEN_LENGTH
    : MAX_OPAQUE_ACTION_TOKEN_LENGTH;
  if (
    (action !== 'approval' && action !== 'binding' && action !== 'cancel')
    || !token
    || token.length > maxTokenLength
    || !tokenPattern.test(token)
  ) {
    return null;
  }

  return Object.freeze({
    tenantKey,
    chatId,
    messageId,
    operatorOpenId,
    action,
    token,
  });
}

/** Wires SDK-verified WebSocket events to the clean-slate application handlers. */
export class LarkEventServer {
  private dispatcher: Lark.EventDispatcher | undefined;

  public constructor(
    private readonly websocket: LarkWebSocketClient,
    private readonly config: BridgeConfig,
    private readonly handlers: LarkEventHandlers,
  ) {}

  public async start(): Promise<void> {
    if (this.dispatcher) {
      throw new Error('Lark event server is already started');
    }

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (event: RawMessageEvent) => {
        const result = normalizeInboundMessage(event, this.config);
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
        const action = normalizeCardAction(event, this.config);
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
