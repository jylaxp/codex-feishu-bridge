import { createHash } from 'node:crypto';
import { BridgeConfig } from '../domain';

export const MAX_INBOUND_IMAGES = 8;

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

export interface InboundMessage {
  readonly tenantKey: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly senderOpenId: string;
  readonly messageType?: 'text' | 'image' | 'post';
  readonly hasExplicitText?: boolean;
  readonly text: string;
  readonly imageKey?: string;
  readonly imageReferences?: readonly InboundImageReference[];
  readonly localImagePaths?: readonly string[];
  readonly payloadDigest: string;
  readonly createdAtMs: number;
}

export interface InboundImageReference {
  readonly messageId: string;
  readonly imageKey: string;
}

/** Compatibility alias for command handlers that remain text-only. */
export type InboundTextMessage = InboundMessage;

/** Keeps Bridge slash commands from consuming mixed image tasks. */
export function isTextOnlyInboundMessage(message: InboundMessage): boolean {
  return !message.imageKey
    && (message.imageReferences?.length ?? 0) === 0
    && (message.localImagePaths?.length ?? 0) === 0;
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
  | { readonly accepted: true; readonly message: InboundMessage }
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

    return normalizeText(parsed.text, mentionKeys);
  } catch {
    return null;
  }
}

interface PostContent {
  readonly text: string | null;
  readonly imageKeys: readonly string[];
}

function extractPost(content: string, mentionKeys: readonly string[]): PostContent | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    const document = postDocument(parsed);
    if (!document) {
      return null;
    }
    const lines: string[] = [];
    if (typeof document.title === 'string' && document.title.trim()) {
      lines.push(document.title);
    }
    const imageKeys: string[] = [];
    for (const row of document.content) {
      if (!Array.isArray(row)) {
        continue;
      }
      let line = '';
      for (const rawElement of row) {
        if (!isRecord(rawElement)) {
          continue;
        }
        const tag = rawElement.tag;
        if (tag === 'img' && validImageKey(rawElement.image_key)) {
          imageKeys.push(rawElement.image_key);
          continue;
        }
        if (
          (tag === 'text' || tag === 'md' || tag === 'a')
          && typeof rawElement.text === 'string'
        ) {
          if (tag === 'md') {
            const markdown = extractMarkdownImages(rawElement.text);
            line += markdown.text;
            imageKeys.push(...markdown.imageKeys);
          } else {
            line += rawElement.text;
          }
        }
      }
      if (line.trim()) {
        lines.push(line);
      }
    }
    const text = normalizeText(lines.join('\n'), mentionKeys);
    return text || imageKeys.length > 0
      ? { text, imageKeys: Object.freeze([...new Set(imageKeys)]) }
      : null;
  } catch {
    return null;
  }
}

function extractMarkdownImages(text: string): { readonly text: string; readonly imageKeys: readonly string[] } {
  const imageKeys: string[] = [];
  const normalized = text.replace(
    /!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g,
    (_match, imageKey: string) => {
      imageKeys.push(imageKey);
      return ' ';
    },
  );
  return { text: normalized, imageKeys };
}

function postDocument(value: unknown): { readonly title?: unknown; readonly content: readonly unknown[] } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (Array.isArray(value.content)) {
    return { title: value.title, content: value.content };
  }
  const localized = [value.zh_cn, value.en_us, ...Object.values(value)]
    .find((candidate) => isRecord(candidate) && Array.isArray(candidate.content));
  return isRecord(localized) && Array.isArray(localized.content)
    ? { title: localized.title, content: localized.content }
    : null;
}

function normalizeText(text: string, mentionKeys: readonly string[]): string | null {
  let normalized = text;
  for (const mentionKey of mentionKeys) {
    if (mentionKey) {
      normalized = normalized.replaceAll(mentionKey, ' ');
    }
  }
  return normalized
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validImageKey(value: unknown): value is string {
  return typeof value === 'string' && /^img_[A-Za-z0-9_-]+$/.test(value);
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

  const rawMessage = event.message;
  const chatId = nonBlank(rawMessage?.chat_id);
  if (!rawMessage || !chatId || !config.allowedChats.includes(chatId)) {
    return { accepted: false, reason: 'CHAT_NOT_ALLOWED' };
  }
  if (!config.authorizedUsers.includes(senderOpenId)) {
    return { accepted: false, reason: 'USER_NOT_ALLOWED' };
  }
  const messageType = rawMessage?.message_type;
  if (messageType !== 'text' && messageType !== 'image' && messageType !== 'post') {
    return { accepted: false, reason: 'MESSAGE_NOT_TEXT' };
  }

  const eventId = nonBlank(event.event_id);
  if (!eventId) {
    return { accepted: false, reason: 'EVENT_ID_MISSING' };
  }
  const messageId = nonBlank(rawMessage.message_id);
  if (!messageId) {
    return { accepted: false, reason: 'MESSAGE_ID_MISSING' };
  }
  const createdAtMs = parseCreatedAt(rawMessage.create_time);
  if (createdAtMs === null) {
    return { accepted: false, reason: 'MESSAGE_TIME_INVALID' };
  }
  if (now() - createdAtMs > 30_000) {
    return { accepted: false, reason: 'MESSAGE_TOO_OLD' };
  }

  const content = rawMessage.content;
  const mentionKeys = (rawMessage.mentions ?? [])
    .map((mention) => mention.key?.trim() ?? '')
    .filter(Boolean);
  const parsedContent = content ? extractMessageContent(messageType, content, mentionKeys) : null;
  if (!parsedContent) {
    return { accepted: false, reason: 'TEXT_INVALID' };
  }
  const { text, hasExplicitText, imageKeys } = parsedContent;
  if (text.length > config.maxTextLength) {
    return { accepted: false, reason: 'TEXT_TOO_LONG' };
  }

  const rootMessageId = nonBlank(rawMessage.root_id) ?? messageId;
  return {
    accepted: true,
    message: Object.freeze({
      tenantKey,
      eventId,
      messageId,
      chatId,
      rootMessageId,
      senderOpenId,
      messageType,
      hasExplicitText,
      text,
      ...(imageKeys[0] ? { imageKey: imageKeys[0] } : {}),
      imageReferences: Object.freeze(imageKeys.map((imageKey) => ({ messageId, imageKey }))),
      payloadDigest: digestMessage(eventId, messageId, `${text}\0${imageKeys.join('\0')}`),
      createdAtMs,
    }),
  };
}

function extractMessageContent(
  messageType: 'text' | 'image' | 'post',
  content: string,
  mentionKeys: readonly string[],
): { readonly text: string; readonly hasExplicitText: boolean; readonly imageKeys: readonly string[] } | null {
  if (messageType === 'text') {
    const text = extractText(content, mentionKeys);
    return text ? { text, hasExplicitText: true, imageKeys: [] } : null;
  }
  if (messageType === 'post') {
    const post = extractPost(content, mentionKeys);
    if (!post) {
      return null;
    }
    return {
      text: post.text ?? '',
      hasExplicitText: post.text !== null,
      imageKeys: post.imageKeys,
    };
  }
  try {
    const parsed = JSON.parse(content) as { readonly image_key?: unknown };
    return validImageKey(parsed.image_key)
      ? {
        text: '',
        hasExplicitText: false,
        imageKeys: [parsed.image_key],
      }
      : null;
  } catch {
    return null;
  }
}
