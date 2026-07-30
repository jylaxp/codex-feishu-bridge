import { createHash } from 'node:crypto';
import { DEFAULT_BOT_KEY } from '../bot-config-store';
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
    readonly mentions?: ReadonlyArray<{
      readonly key?: string;
      readonly id?: {
        readonly open_id?: string;
        readonly user_id?: string;
        readonly union_id?: string;
      };
    }>;
  };
}

export interface InboundMessage {
  readonly botKey?: string;
  readonly tenantKey: string;
  readonly eventTenantKey?: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType?: 'p2p' | 'group' | 'unknown';
  readonly rootMessageId: string;
  readonly senderOpenId: string;
  readonly senderType?: 'user' | 'bot';
  readonly senderTenantKey?: string;
  readonly externalGroupUser?: boolean;
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

export interface InboundReplyContext {
  readonly botKey?: string;
  readonly tenantKey: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType?: 'p2p' | 'group' | 'unknown';
  readonly rootMessageId: string;
  readonly senderOpenId?: string;
  readonly senderType?: 'user' | 'bot';
  readonly createdAtMs: number;
}

/** Compatibility alias for command handlers that remain text-only. */
export type InboundTextMessage = InboundMessage;

/** Keeps Bridge slash commands from consuming mixed image tasks. */
export function isTextOnlyInboundMessage(message: InboundMessage): boolean {
  return !message.imageKey
    && (message.imageReferences?.length ?? 0) === 0
    && (message.localImagePaths?.length ?? 0) === 0;
}

export function isGroupManagementCommandText(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command === '/bind'
    || command === '/l'
    || command === '/list'
    || command === '/ll'
    || command === '/external'
    || command === '/collab';
}

export type IntakeRejectionReason =
  | 'APP_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'SENDER_NOT_USER'
  | 'SENDER_NOT_ALLOWED'
  | 'SENDER_MISSING'
  | 'CHAT_NOT_ALLOWED'
  | 'USER_NOT_ALLOWED'
  | 'BOT_NOT_MENTIONED'
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

function mentionKey(value: { readonly key?: string } | undefined): string | null {
  return nonBlank(value?.key);
}

function mentionOpenId(
  value: { readonly id?: { readonly open_id?: string } } | undefined,
): string | null {
  return nonBlank(value?.id?.open_id);
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

function isExternalGroupUserSender(
  chatType: InboundMessage['chatType'],
  senderType: string | undefined,
  tenantKey: string | null,
  senderTenantKey: string | null,
  config: BridgeConfig,
): boolean {
  if (
    chatType !== 'group'
    || senderType !== 'user'
    || config.allowGroupUserMentions === false
    || config.allowExternalGroupUserMentions === false
    || !config.larkTenantKey
  ) {
    return false;
  }
  return (tenantKey !== null && tenantKey !== config.larkTenantKey)
    || (senderTenantKey !== null && senderTenantKey !== config.larkTenantKey);
}

function isRelaxedGroupBotSender(
  chatType: InboundMessage['chatType'],
  senderType: string | undefined,
  config: BridgeConfig,
): boolean {
  return chatType === 'group'
    && senderType === 'bot'
    && config.allowGroupBotMentions !== false;
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

/**
 * Extracts only the fields needed to reply with an availability reason.
 * It deliberately skips command/binding/user policy checks because no task is
 * accepted from this path.
 */
export function normalizeInboundReplyContext(
  event: RawMessageEvent,
  config: BridgeConfig,
  now: () => number = Date.now,
  botKey: string = config.botKey ?? DEFAULT_BOT_KEY,
): InboundReplyContext | null {
  if (event.app_id !== config.larkAppId) {
    return null;
  }

  const rawMessage = event.message;
  const chatType = normalizeChatType(rawMessage?.chat_type);
  const tenantKey = nonBlank(event.tenant_key);
  const senderTenantKey = nonBlank(event.sender?.tenant_key);
  const externalGroupUserSender = isExternalGroupUserSender(
    chatType,
    event.sender?.sender_type,
    tenantKey,
    senderTenantKey,
    config,
  );
  const relaxedGroupBotSender = isRelaxedGroupBotSender(
    chatType,
    event.sender?.sender_type,
    config,
  );
  const resolvedTenantKey = config.larkTenantKey || tenantKey;
  if (
    !resolvedTenantKey
    || (
      !externalGroupUserSender
      && !relaxedGroupBotSender
      && (!tenantKey || (config.larkTenantKey && tenantKey !== config.larkTenantKey))
    )
  ) {
    return null;
  }
  if (!externalGroupUserSender && !relaxedGroupBotSender && senderTenantKey !== null && senderTenantKey !== tenantKey) {
    return null;
  }

  const chatId = nonBlank(rawMessage?.chat_id);
  const messageId = nonBlank(rawMessage?.message_id);
  if (!rawMessage || !chatId || !messageId) {
    return null;
  }
  if (chatType === 'group' && currentBotMentionKeysFor(rawMessage.mentions ?? [], config).length === 0) {
    return null;
  }

  const eventId = nonBlank(event.event_id) ?? messageId;
  const createdAtMs = parseCreatedAt(rawMessage.create_time);
  if (createdAtMs === null || now() - createdAtMs > 30_000) {
    return null;
  }

  const rawSenderType = event.sender?.sender_type;
  const senderType = rawSenderType === 'bot' ? 'bot' : rawSenderType === 'user' ? 'user' : undefined;
  const senderOpenId = nonBlank(event.sender?.sender_id?.open_id);
  return Object.freeze({
    botKey,
    tenantKey: resolvedTenantKey,
    eventId,
    messageId,
    chatId,
    chatType,
    rootMessageId: nonBlank(rawMessage.root_id) ?? messageId,
    ...(senderOpenId ? { senderOpenId } : {}),
    ...(senderType ? { senderType } : {}),
    createdAtMs,
  });
}

/** Validates and normalizes an SDK-verified Feishu message event. */
export function normalizeInboundMessage(
  event: RawMessageEvent,
  config: BridgeConfig,
  now: () => number = Date.now,
  botKey: string = config.botKey ?? DEFAULT_BOT_KEY,
): IntakeResult {
  if (event.app_id !== config.larkAppId) {
    return { accepted: false, reason: 'APP_MISMATCH' };
  }

  const rawMessage = event.message;
  const chatType = normalizeChatType(rawMessage?.chat_type);
  const senderType = event.sender?.sender_type === 'bot' ? 'bot' : 'user';
  const tenantKey = nonBlank(event.tenant_key);
  const senderTenantKey = nonBlank(event.sender?.tenant_key);
  const externalGroupUserSender = isExternalGroupUserSender(
    chatType,
    event.sender?.sender_type,
    tenantKey,
    senderTenantKey,
    config,
  );
  const relaxedGroupBotSender = isRelaxedGroupBotSender(
    chatType,
    event.sender?.sender_type,
    config,
  );
  const resolvedTenantKey = config.larkTenantKey || tenantKey;
  if (
    !resolvedTenantKey
    || (
      !externalGroupUserSender
      && !relaxedGroupBotSender
      && (
        tenantKey !== config.larkTenantKey
        || (senderTenantKey !== null && senderTenantKey !== config.larkTenantKey)
      )
    )
  ) {
    return { accepted: false, reason: 'TENANT_MISMATCH' };
  }

  if (event.sender?.sender_type !== 'user' && event.sender?.sender_type !== 'bot') {
    return { accepted: false, reason: 'SENDER_NOT_ALLOWED' };
  }
  if (chatType !== 'group' && event.sender?.sender_type !== 'user') {
    return { accepted: false, reason: 'SENDER_NOT_USER' };
  }
  const senderOpenId = nonBlank(event.sender.sender_id?.open_id);
  if (!senderOpenId) {
    return { accepted: false, reason: 'SENDER_MISSING' };
  }

  const chatId = nonBlank(rawMessage?.chat_id);
  if (!rawMessage || !chatId) {
    return { accepted: false, reason: 'CHAT_NOT_ALLOWED' };
  }
  const mentions = rawMessage.mentions ?? [];
  const currentBotMentionKeys = currentBotMentionKeysFor(mentions, config);
  const chatAllowed = externalGroupUserSender
    || relaxedGroupBotSender
    || config.allowedChats.length === 0
    || config.allowedChats.includes(chatId);
  const groupManagementCommand = !chatAllowed
    && chatType === 'group'
    && senderType === 'user'
    && config.authorizedUsers.includes(senderOpenId)
    && currentBotMentionKeys.length > 0
    && rawMessage.message_type === 'text'
    && isGroupManagementCommandContent(rawMessage.content, currentBotMentionKeys);
  if (!chatAllowed && !groupManagementCommand) {
    return { accepted: false, reason: 'CHAT_NOT_ALLOWED' };
  }
  if (
    senderType === 'user'
    && !config.authorizedUsers.includes(senderOpenId)
    && !(chatType === 'group' && config.allowGroupUserMentions !== false)
  ) {
    return { accepted: false, reason: 'USER_NOT_ALLOWED' };
  }
  if (chatType === 'group' && currentBotMentionKeys.length === 0) {
    return { accepted: false, reason: 'BOT_NOT_MENTIONED' };
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
  const mentionKeys = chatType === 'group'
    ? currentBotMentionKeys
    : mentions.map((mention) => mentionKey(mention) ?? '').filter(Boolean);
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
      botKey,
      tenantKey: resolvedTenantKey,
      ...(tenantKey ? { eventTenantKey: tenantKey } : {}),
      eventId,
      messageId,
      chatId,
      chatType,
      rootMessageId,
      senderOpenId,
      senderType,
      ...(senderTenantKey ? { senderTenantKey } : {}),
      ...(externalGroupUserSender ? { externalGroupUser: true } : {}),
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

function normalizeChatType(value: string | undefined): InboundMessage['chatType'] {
  if (value === 'p2p' || value === 'group') {
    return value;
  }
  return 'unknown';
}

function currentBotMentionKeysFor(
  mentions: readonly {
    readonly key?: string;
    readonly id?: { readonly open_id?: string };
  }[],
  config: BridgeConfig,
): readonly string[] {
  const botOpenId = nonBlank(config.larkBotOpenId);
  const currentMentions = botOpenId
    ? mentions.filter((mention) => mentionOpenId(mention) === botOpenId)
    : mentions;
  return Object.freeze(currentMentions.map((mention) => mentionKey(mention) ?? '').filter(Boolean));
}

function isGroupManagementCommandContent(content: string | undefined, mentionKeys: readonly string[]): boolean {
  return typeof content === 'string'
    && isGroupManagementCommandText(extractText(content, mentionKeys) ?? '');
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
