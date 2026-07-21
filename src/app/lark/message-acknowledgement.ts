import type { InboundMessage } from './intake';

export interface LarkMessageAcknowledgementApi {
  readonly im: {
    readonly messageReaction: {
      create(request: {
        readonly path: { readonly message_id: string };
        readonly data: { readonly reaction_type: { readonly emoji_type: 'OK' } };
      }): Promise<unknown>;
    };
    readonly message: {
      create(request: {
        readonly params: { readonly receive_id_type: 'chat_id' };
        readonly data: {
          readonly receive_id: string;
          readonly msg_type: 'text';
          readonly content: string;
        };
      }): Promise<unknown>;
    };
  };
}

export interface LarkMessageAcknowledgementLogger {
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  error(event: string, error: unknown, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

/** Sends the legacy immediate OK receipt without blocking task processing. */
export class LarkMessageAcknowledgement {
  public constructor(
    private readonly api: LarkMessageAcknowledgementApi,
    private readonly logger: LarkMessageAcknowledgementLogger | undefined = undefined,
  ) {}

  public async ack(message: InboundMessage): Promise<void> {
    try {
      await this.api.im.messageReaction.create({
        path: { message_id: message.messageId },
        data: { reaction_type: { emoji_type: 'OK' } },
      });
      return;
    } catch {
      this.logger?.warn('lark_ok_reaction_failed', {
        chatId: message.chatId,
        messageId: message.messageId,
      });
    }

    try {
      await this.api.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: '👌' }),
        },
      });
    } catch (error) {
      this.logger?.error('lark_ok_fallback_failed', error, {
        chatId: message.chatId,
        messageId: message.messageId,
      });
    }
  }
}
