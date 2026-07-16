import { createHash } from 'node:crypto';
import { BridgeConfig } from '../domain';

export interface RawMessageEvent {
  readonly app_id?: string;
  readonly event_id?: string;
  readonly tenant_key?: string;
  readonly sender?: {
    readonly sender_id?: { readonly open_id?: string };
    readonly sender_type?: string;
    readonly tenant_key?: string;
  };
  readonly message?: {
    readonly message_id?: string;
    readonly root_id?: string;
    readonly create_time?: string;
    readonly chat_id?: string;
    readonly chat_type?: string;
    readonly message_type?: string;
    readonly content?: string;
    readonly mentions?: ReadonlyArray<{ readonly key?: string }>;
  };
}

export interface InboundTextMessage {
  readonly tenantKey: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly senderOpenId: string;
  readonly text: string;
  readonly payloadDigest: string;
  readonly createdAtMs: number;
}

export type IntakeRejectionReason =
  | 'APP_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'SENDER_NOT_USER'
  | 'SENDER_MISSING'
  | 'CHAT_NOT_ALLOWED'
  | 'USER_NOT_ALLOWED'
  | 'MESSAGE_NOT_TEXT'
  | 'EVENT_ID_MISSING'
  | 'MESSAGE_ID_MISSING'
  | 'MESSAGE_TIME_INVALID'
  | 'MESSAGE_TOO_OLD'
  | 'TEXT_INVALID'
  | 'TEXT_TOO_LONG';

export type IntakeResult =
  | { readonly accepted: true; readonly message: InboundTextMessage }
  | { readonly accepted: false; readonly reason: IntakeRejectionReason };

function nonBlank(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function extractText(content: string, mentionKeys: readonly string[]): string | null {
  try {
    const parsed = JSON.parse(content) as { readonly text?: unknown };
    if (typeof parsed.text !== 'string') {
      return null;
    }

    let text = parsed.text;
    for (const mentionKey of mentionKeys) {
      if (mentionKey) {
        text = text.replaceAll(mentionKey, ' ');
      }
    }
    return text
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/ *\r?\n */g, '\n')
      .trim() || null;
  } catch {
    return null;
  }
}

function parseCreatedAt(value: string | undefined): number | null {
  if (!value || !/^\d{10,16}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return value.length <= 10 ? parsed * 1_000 : parsed;
}

function digestMessage(eventId: string, messageId: string, text: string): string {
  return createHash('sha256')
    .update(eventId)
    .update('\0')
    .update(messageId)
    .update('\0')
    .update(text)
    .digest('hex');
}

/** Validates and normalizes an SDK-verified Feishu message event. */
export function normalizeInboundMessage(
  event: RawMessageEvent,
  config: BridgeConfig,
  now: () => number = Date.now,
): IntakeResult {
  if (event.app_id !== config.larkAppId) {
    return { accepted: false, reason: 'APP_MISMATCH' };
  }

  const tenantKey = nonBlank(event.tenant_key);
  const senderTenantKey = nonBlank(event.sender?.tenant_key);
  if (
    tenantKey !== config.larkTenantKey
    || (senderTenantKey !== null && senderTenantKey !== config.larkTenantKey)
  ) {
    return { accepted: false, reason: 'TENANT_MISMATCH' };
  }

  if (event.sender?.sender_type !== 'user') {
    return { accepted: false, reason: 'SENDER_NOT_USER' };
  }

  const senderOpenId = nonBlank(event.sender.sender_id?.open_id);
  if (!senderOpenId) {
    return { accepted: false, reason: 'SENDER_MISSING' };
  }

  const chatId = nonBlank(event.message?.chat_id);
  if (!chatId || !config.allowedChats.includes(chatId)) {
    return { accepted: false, reason: 'CHAT_NOT_ALLOWED' };
  }
  if (!config.authorizedUsers.includes(senderOpenId)) {
    return { accepted: false, reason: 'USER_NOT_ALLOWED' };
  }
  if (event.message?.message_type !== 'text') {
    return { accepted: false, reason: 'MESSAGE_NOT_TEXT' };
  }

  const eventId = nonBlank(event.event_id);
  if (!eventId) {
    return { accepted: false, reason: 'EVENT_ID_MISSING' };
  }
  const messageId = nonBlank(event.message.message_id);
  if (!messageId) {
    return { accepted: false, reason: 'MESSAGE_ID_MISSING' };
  }
  const createdAtMs = parseCreatedAt(event.message.create_time);
  if (createdAtMs === null) {
    return { accepted: false, reason: 'MESSAGE_TIME_INVALID' };
  }
  if (now() - createdAtMs > 30_000) {
    return { accepted: false, reason: 'MESSAGE_TOO_OLD' };
  }

  const mentionKeys = (event.message.mentions ?? [])
    .map((mention) => mention.key?.trim() ?? '')
    .filter(Boolean);
  const content = event.message.content;
  const text = content ? extractText(content, mentionKeys) : null;
  if (!text) {
    return { accepted: false, reason: 'TEXT_INVALID' };
  }
  if (text.length > config.maxTextLength) {
    return { accepted: false, reason: 'TEXT_TOO_LONG' };
  }

  const rootMessageId = nonBlank(event.message.root_id) ?? messageId;
  return {
    accepted: true,
    message: Object.freeze({
      tenantKey,
      eventId,
      messageId,
      chatId,
      rootMessageId,
      senderOpenId,
      text,
      payloadDigest: digestMessage(eventId, messageId, text),
      createdAtMs,
    }),
  };
}
