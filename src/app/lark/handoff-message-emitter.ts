import { createHash, randomUUID } from 'node:crypto';

import {
  sanitizeHandoffField,
  type HandoffDirective,
  type HandoffEnvelope,
} from '../collaboration/handoff-directive';

export interface LarkHandoffMessageApi {
  readonly im: {
    readonly message: {
      create(payload: {
        readonly params: { readonly receive_id_type: 'chat_id' };
        readonly data: {
          readonly receive_id: string;
          readonly content: string;
          readonly msg_type: 'post' | 'text';
          readonly uuid: string;
        };
      }): Promise<{
        readonly code?: number;
        readonly msg?: string;
        readonly data?: { readonly message_id?: string };
      }>;
    };
  };
}

export interface HandoffMessage {
  readonly chatId: string;
  readonly targetBotKey: string;
  readonly targetBotOpenId: string;
  readonly targetBotName: string;
  readonly envelope: HandoffEnvelope;
  readonly directive: HandoffDirective;
}

export interface UserMentionMessage {
  readonly chatId: string;
  readonly targetUserOpenId: string;
  readonly targetUserName: string;
  readonly text: string;
  readonly dedupeKey?: string;
}

type CreateMessageResult =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'rejected'; readonly rejection: string };

export class HandoffMessageEmitter {
  public constructor(private readonly api: LarkHandoffMessageApi) {}

  public async send(message: HandoffMessage): Promise<string> {
    const uuid = handoffUuid(message);
    const textResult = await this.tryCreateMessage(
      message.chatId,
      'text',
      uuid,
      JSON.stringify(textContent(message)),
    );
    if (textResult.status === 'sent') {
      return textResult.messageId;
    }
    const postResult = await this.tryCreateMessage(
      message.chatId,
      'post',
      uuid,
      JSON.stringify(postContent(message)),
    );
    if (postResult.status === 'sent') {
      return postResult.messageId;
    }
    throw new HandoffMessageEmitterError(
      `Lark handoff message rejected: ${textResult.rejection}; post fallback rejected: ${postResult.rejection}`,
    );
  }

  public async sendUserMention(message: UserMentionMessage): Promise<string> {
    const uuid = userMentionUuid(message);
    const postResult = await this.tryCreateMessage(
      message.chatId,
      'post',
      uuid,
      JSON.stringify(userMentionPostContent(message)),
    );
    if (postResult.status === 'sent') {
      return postResult.messageId;
    }
    const textResult = await this.tryCreateMessage(
      message.chatId,
      'text',
      uuid,
      JSON.stringify(userMentionTextContent(message)),
    );
    if (textResult.status === 'sent') {
      return textResult.messageId;
    }
    throw new HandoffMessageEmitterError(
      `Lark user mention message rejected: ${postResult.rejection}; text fallback rejected: ${textResult.rejection}`,
    );
  }

  private async tryCreateMessage(
    chatId: string,
    msgType: 'post' | 'text',
    uuid: string,
    content: string,
  ): Promise<CreateMessageResult> {
    const response = await this.api.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        uuid,
        content,
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      return { status: 'rejected', rejection: response.msg ?? 'unknown error' };
    }
    const messageId = response.data?.message_id;
    if (!messageId) {
      throw new HandoffMessageEmitterError('Lark handoff message response has no message id');
    }
    return { status: 'sent', messageId };
  }
}

export class HandoffMessageEmitterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HandoffMessageEmitterError';
  }
}

function postContent(message: HandoffMessage): object {
  return {
    zh_cn: {
      content: [
        [
          {
            tag: 'at',
            user_id: message.targetBotOpenId,
            user_name: message.targetBotName,
          },
          { tag: 'text', text: ` ${handoffTaskText(message)}` },
        ],
      ],
    },
  };
}

function userMentionPostContent(message: UserMentionMessage): object {
  return {
    zh_cn: {
      title: 'Codex Bridge Mention',
      content: [
        [
          {
            tag: 'at',
            user_id: message.targetUserOpenId,
            user_name: message.targetUserName,
          },
          { tag: 'text', text: ` ${mentionText(message.text)}` },
        ],
      ],
    },
  };
}

function textContent(message: HandoffMessage): { readonly text: string } {
  return { text: `${atText(message.targetBotOpenId, message.targetBotName)} ${handoffTaskText(message)}` };
}

function userMentionTextContent(message: UserMentionMessage): { readonly text: string } {
  return {
    text: `${atText(message.targetUserOpenId, message.targetUserName)} ${mentionText(message.text)}`,
  };
}

function mentionText(value: string): string {
  return sanitizeHandoffField(value) ?? '请关注这条消息。';
}

function handoffTaskText(message: HandoffMessage): string {
  return sanitizeHandoffField(message.directive.task) ?? '继续处理一下。';
}

function atText(openId: string, name: string): string {
  return `<at user_id="${escapeXmlAttribute(openId)}">${escapeXmlText(name)}</at>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function handoffUuid(message: HandoffMessage): string {
  return createHash('sha256')
    .update(message.envelope.chainId)
    .update('\0')
    .update(message.envelope.handoffId)
    .update('\0')
    .update(message.envelope.sourceBotKey)
    .update('\0')
    .update(message.targetBotKey)
    .digest('hex')
    .slice(0, 50);
}

function userMentionUuid(message: UserMentionMessage): string {
  if (!message.dedupeKey) {
    return randomUUID();
  }
  return createHash('sha256')
    .update(message.chatId)
    .update('\0')
    .update(message.targetUserOpenId)
    .update('\0')
    .update(message.dedupeKey)
    .digest('hex')
    .slice(0, 50);
}
