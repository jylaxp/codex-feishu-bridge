import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_BOT_KEY } from './bot-config-store';
import { FEISHU_CHANNEL_ID, type ChannelId } from './channel-paths';

export const BINDINGS_SCHEMA_VERSION = 6;
const MAX_BINDINGS_FILE_BYTES = 1024 * 1024;
const MAX_BINDING_COUNT = 10_000;
const MAX_IDENTIFIER_LENGTH = 512;

export interface BindingSettings {
  readonly model?: string;
  readonly personality?: string;
  readonly style?: string;
  readonly plan?: string;
  /** One-shot skill selected from /skills and consumed by the next user turn. */
  readonly activeSkill?: string;
  readonly activeSkillPath?: string;
}

export interface ChatThreadBinding extends BindingSettings {
  readonly channel?: ChannelId;
  readonly larkAppId?: string;
  /** Deprecated runtime alias. New persisted bindings write larkAppId only. */
  readonly botKey?: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly chatType?: 'p2p' | 'group' | 'unknown';
  readonly threadId: string;
  readonly threadTitle?: string;
  readonly workspaceId: string;
  readonly allowExternalGroupUserMentions?: boolean;
  readonly revision: number;
  readonly updatedAtMs: number;
}

export type ChatThreadBindingInput =
  Omit<ChatThreadBinding, 'channel' | 'larkAppId' | 'botKey' | 'revision' | 'updatedAtMs'>
  & { readonly channel?: ChannelId; readonly larkAppId?: string; readonly botKey?: string };

interface BindingDocument {
  readonly schemaVersion: number;
  readonly bindings: readonly ChatThreadBinding[];
}

export class BindingStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BindingStoreError';
  }
}

export interface BindingStoreOptions {
  readonly now?: () => number;
  readonly bindingsFileName?: string;
}

export interface BindingLoadOptions {
  readonly legacyDefaultBotIdentifier?: string;
}

/**
 * Minimal persistent Bridge state. This file never stores task execution or
 * CardKit state, so a process restart cannot replay an in-flight request.
 */
export class BindingStore {
  private readonly now: () => number;
  private readonly bindingsPath: string;
  private readonly bindings = new Map<string, ChatThreadBinding>();

  public constructor(configHome: string, options: BindingStoreOptions = {}) {
    if (!configHome.trim()) {
      throw new BindingStoreError('Binding config home must not be blank');
    }
    this.now = options.now ?? Date.now;
    this.bindingsPath = join(configHome, options.bindingsFileName ?? 'bindings.json');
  }

  public get filePath(): string {
    return this.bindingsPath;
  }

  /** Loads and validates the whole document once at Bridge startup. */
  public load(options: BindingLoadOptions = {}): void {
    this.bindings.clear();
    if (!existsSync(this.bindingsPath)) {
      return;
    }
    let content: string;
    try {
      content = readFileSync(this.bindingsPath, { encoding: 'utf8' });
    } catch (error) {
      throw new BindingStoreError('bindings.json could not be read', { cause: error });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BINDINGS_FILE_BYTES) {
      throw new BindingStoreError('bindings.json exceeds the maximum allowed size');
    }
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch (error) {
      throw new BindingStoreError('bindings.json is not valid JSON', { cause: error });
    }
    const parsed = parseDocument(document, options);
    for (const binding of parsed.bindings) {
      const key = bindingKey(
        binding.channel,
        binding.larkAppId ?? DEFAULT_BOT_KEY,
        binding.tenantKey,
        binding.chatId,
      );
      if (this.bindings.has(key)) {
        throw new BindingStoreError('bindings.json contains a duplicate channel/app/tenant/chat binding');
      }
      this.bindings.set(key, binding);
    }
  }

  public get(
    tenantKey: string,
    chatId: string,
    botKey: string = DEFAULT_BOT_KEY,
    channel: ChannelId = FEISHU_CHANNEL_ID,
  ): ChatThreadBinding | undefined {
    return this.bindings.get(bindingKey(channel, botKey, tenantKey, chatId));
  }

  public list(): readonly ChatThreadBinding[] {
    return Object.freeze([...this.bindings.values()]);
  }

  /** Lists every channel endpoint subscribed to one ChatGPT thread. */
  public listByThreadId(threadId: string): readonly ChatThreadBinding[] {
    return Object.freeze([...this.bindings.values()].filter((binding) => binding.threadId === threadId));
  }

  /** Deprecated: use listByThreadId for multi-channel fan-out. */
  public getUniqueByThreadId(threadId: string): ChatThreadBinding | undefined {
    let match: ChatThreadBinding | undefined;
    for (const binding of this.bindings.values()) {
      if (binding.threadId !== threadId) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = binding;
    }
    return match;
  }

  /** Persists one replacement binding using same-directory atomic replacement. */
  public bind(input: ChatThreadBindingInput): ChatThreadBinding {
    const normalized = normalizeBindingInput(input);
    const key = bindingKey(
      normalized.channel,
      normalized.larkAppId ?? DEFAULT_BOT_KEY,
      normalized.tenantKey,
      normalized.chatId,
    );
    const previous = this.bindings.get(key);
    const binding = Object.freeze({
      ...normalized,
      revision: (previous?.revision ?? 0) + 1,
      updatedAtMs: safeNow(this.now),
    });
    this.bindings.set(key, binding);
    try {
      this.persist();
      return binding;
    } catch (error) {
      if (previous) {
        this.bindings.set(key, previous);
      } else {
        this.bindings.delete(key);
      }
      throw error;
    }
  }

  /** Removes only the static chat binding and never touches any runtime task. */
  public unbind(
    tenantKey: string,
    chatId: string,
    botKey: string = DEFAULT_BOT_KEY,
    channel: ChannelId = FEISHU_CHANNEL_ID,
  ): boolean {
    const key = bindingKey(channel, botKey, tenantKey, chatId);
    const previous = this.bindings.get(key);
    if (!previous) {
      return false;
    }
    this.bindings.delete(key);
    try {
      this.persist();
      return true;
    } catch (error) {
      this.bindings.set(key, previous);
      throw error;
    }
  }

  public updateExternalGroupUserMentionPolicy(
    tenantKey: string,
    chatId: string,
    allowExternalGroupUserMentions: boolean,
    botKey: string = DEFAULT_BOT_KEY,
    channel: ChannelId = FEISHU_CHANNEL_ID,
  ): ChatThreadBinding | undefined {
    const key = bindingKey(channel, botKey, tenantKey, chatId);
    const previous = this.bindings.get(key);
    if (!previous) {
      return undefined;
    }
    const { allowExternalGroupUserMentions: _previousPolicy, ...previousWithoutPolicy } = previous;
    const next = Object.freeze({
      ...previousWithoutPolicy,
      ...(allowExternalGroupUserMentions ? {} : { allowExternalGroupUserMentions: false }),
      revision: previous.revision + 1,
      updatedAtMs: safeNow(this.now),
    });
    this.bindings.set(key, next);
    try {
      this.persist();
      return next;
    } catch (error) {
      this.bindings.set(key, previous);
      throw error;
    }
  }

  public recordObservedChatType(
    tenantKey: string,
    chatId: string,
    chatType: ChatThreadBinding['chatType'] | undefined,
    botKey: string = DEFAULT_BOT_KEY,
    channel: ChannelId = FEISHU_CHANNEL_ID,
  ): ChatThreadBinding | undefined {
    const observed = observedChatTypeValue(chatType);
    const key = bindingKey(channel, botKey, tenantKey, chatId);
    const previous = this.bindings.get(key);
    if (!previous || !observed || previous.chatType === observed) {
      return previous;
    }
    if (previous.chatType && previous.chatType !== 'unknown') {
      return previous;
    }
    const next = Object.freeze({
      ...previous,
      chatType: observed,
      revision: previous.revision + 1,
      updatedAtMs: safeNow(this.now),
    });
    this.bindings.set(key, next);
    try {
      this.persist();
      return next;
    } catch (error) {
      this.bindings.set(key, previous);
      throw error;
    }
  }

  public removeBotBindings(botKey: string): number {
    const normalizedBotKey = requiredBotIdentifier(botKey, 'bot identifier');
    const removed: [string, ChatThreadBinding][] = [];
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.larkAppId === normalizedBotKey || binding.botKey === normalizedBotKey) {
        removed.push([key, binding]);
      }
    }
    if (removed.length === 0) {
      return 0;
    }
    for (const [key] of removed) {
      this.bindings.delete(key);
    }
    try {
      this.persist();
      return removed.length;
    } catch (error) {
      for (const [key, binding] of removed) {
        this.bindings.set(key, binding);
      }
      throw error;
    }
  }

  /** Rewrites the loaded bindings using the current schema and serializer. */
  public materialize(): void {
    this.persist();
  }

  private persist(): void {
    const directory = dirname(this.bindingsPath);
    mkdirSync(directory, { recursive: true });
    const document: BindingDocument = Object.freeze({
      schemaVersion: BINDINGS_SCHEMA_VERSION,
      bindings: Object.freeze([...this.bindings.values()].map(serializeBinding)),
    });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BINDINGS_FILE_BYTES) {
      throw new BindingStoreError('bindings.json would exceed the maximum allowed size');
    }
    const temporaryPath = `${this.bindingsPath}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, serialized, { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.bindingsPath);
      syncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      safelyUnlink(temporaryPath);
      throw new BindingStoreError('bindings.json could not be atomically updated', { cause: error });
    }
  }
}

function parseDocument(value: unknown, options: BindingLoadOptions): BindingDocument {
  if (!isRecord(value) || hasUnknownKeys(value, ['schemaVersion', 'bindings'])) {
    throw new BindingStoreError('bindings.json has an invalid document shape');
  }
  if (!isSupportedSchemaVersion(value.schemaVersion) || !Array.isArray(value.bindings)) {
    throw new BindingStoreError('bindings.json schema version is unsupported');
  }
  if (value.bindings.length > MAX_BINDING_COUNT) {
    throw new BindingStoreError('bindings.json contains too many bindings');
  }
  return Object.freeze({
    schemaVersion: BINDINGS_SCHEMA_VERSION,
    bindings: Object.freeze(value.bindings.map((binding) => parseBinding(binding, value.schemaVersion, options))),
  });
}

function parseBinding(value: unknown, schemaVersion: unknown, options: BindingLoadOptions): ChatThreadBinding {
  if (!isRecord(value) || hasUnknownKeys(value, [
    'channel',
    'larkAppId',
    'tenantKey',
    'chatId',
    'chatType',
    'threadId',
    'threadTitle',
    'workspaceId',
    'allowExternalGroupUserMentions',
    'model',
    'personality',
    'style',
    'plan',
    'activeSkill',
    'activeSkillPath',
    'revision',
    'updatedAtMs',
  ])) {
    throw new BindingStoreError('bindings.json contains an invalid binding');
  }
  if (
    value.allowExternalGroupUserMentions !== undefined
    && typeof value.allowExternalGroupUserMentions !== 'boolean'
  ) {
    throw new BindingStoreError('binding allowExternalGroupUserMentions must be a boolean when present');
  }
  const normalized = normalizeBindingInput({
    channel: channelValue(value.channel),
    larkAppId: resolveBindingBotIdentifier(value, schemaVersion, options),
    tenantKey: requiredText(value.tenantKey, 'tenantKey'),
    chatId: requiredText(value.chatId, 'chatId'),
    ...(chatTypeValue(value.chatType) ? { chatType: chatTypeValue(value.chatType) } : {}),
    threadId: requiredText(value.threadId, 'threadId'),
    ...(optionalText(value.threadTitle, 'threadTitle')
      ? { threadTitle: optionalText(value.threadTitle, 'threadTitle') }
      : {}),
    workspaceId: requiredText(value.workspaceId, 'workspaceId'),
    ...(value.allowExternalGroupUserMentions === false ? { allowExternalGroupUserMentions: false } : {}),
    ...(optionalText(value.model, 'model') ? { model: optionalText(value.model, 'model') } : {}),
    ...(optionalText(value.personality, 'personality')
      ? { personality: optionalText(value.personality, 'personality') }
      : {}),
    ...(optionalText(value.style, 'style') ? { style: optionalText(value.style, 'style') } : {}),
    ...(optionalText(value.plan, 'plan') ? { plan: optionalText(value.plan, 'plan') } : {}),
    ...(optionalText(value.activeSkill, 'activeSkill')
      ? { activeSkill: optionalText(value.activeSkill, 'activeSkill') }
      : {}),
    ...(optionalText(value.activeSkillPath, 'activeSkillPath')
      ? { activeSkillPath: optionalText(value.activeSkillPath, 'activeSkillPath') }
      : {}),
  });
  const revision = value.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new BindingStoreError('binding revision must be a positive safe integer');
  }
  const updatedAtMs = value.updatedAtMs;
  if (
    typeof updatedAtMs !== 'number'
    || !Number.isSafeInteger(updatedAtMs)
    || updatedAtMs < 0
  ) {
    throw new BindingStoreError('binding updatedAtMs must be a non-negative safe integer');
  }
  return Object.freeze({ ...normalized, revision, updatedAtMs });
}

function normalizeBindingInput(
  input: ChatThreadBindingInput,
): Omit<ChatThreadBinding, 'revision' | 'updatedAtMs'> {
  const larkAppId = requiredBotIdentifier(input.larkAppId ?? input.botKey, 'larkAppId');
  return Object.freeze({
    channel: channelValue(input.channel),
    larkAppId,
    botKey: larkAppId,
    tenantKey: requiredText(input.tenantKey, 'tenantKey'),
    chatId: requiredText(input.chatId, 'chatId'),
    ...(chatTypeValue(input.chatType) ? { chatType: chatTypeValue(input.chatType) } : {}),
    threadId: requiredText(input.threadId, 'threadId'),
    ...(optionalText(input.threadTitle, 'threadTitle')
      ? { threadTitle: optionalText(input.threadTitle, 'threadTitle') }
      : {}),
    workspaceId: requiredText(input.workspaceId, 'workspaceId'),
    ...(input.allowExternalGroupUserMentions === false ? { allowExternalGroupUserMentions: false } : {}),
    ...(optionalText(input.model, 'model') ? { model: optionalText(input.model, 'model') } : {}),
    ...(optionalText(input.personality, 'personality')
      ? { personality: optionalText(input.personality, 'personality') }
      : {}),
    ...(optionalText(input.style, 'style') ? { style: optionalText(input.style, 'style') } : {}),
    ...(optionalText(input.plan, 'plan') ? { plan: optionalText(input.plan, 'plan') } : {}),
    ...(optionalText(input.activeSkill, 'activeSkill')
      ? { activeSkill: optionalText(input.activeSkill, 'activeSkill') }
      : {}),
    ...(optionalText(input.activeSkillPath, 'activeSkillPath')
      ? { activeSkillPath: optionalText(input.activeSkillPath, 'activeSkillPath') }
      : {}),
  });
}

function resolveBindingBotIdentifier(
  value: Record<string, unknown>,
  schemaVersion: unknown,
  options: BindingLoadOptions,
): string {
  if (schemaVersion === 1) {
    return requiredBotIdentifier(options.legacyDefaultBotIdentifier ?? DEFAULT_BOT_KEY, 'bot identifier');
  }
  return requiredBotIdentifier(value.larkAppId, 'larkAppId');
}

function requiredBotIdentifier(value: unknown, label: string): string {
  const key = requiredText(value, label);
  if (!isBotIdentifier(key)) {
    throw new BindingStoreError(`${label} is invalid`);
  }
  return key;
}

function isBotIdentifier(value: string): boolean {
  return /^cli_[0-9a-fA-F]{16}$/.test(value)
    || value === DEFAULT_BOT_KEY;
}

function isSupportedSchemaVersion(value: unknown): boolean {
  return value === 1
    || value === BINDINGS_SCHEMA_VERSION;
}

function channelValue(value: unknown): ChannelId {
  if (value === undefined || value === FEISHU_CHANNEL_ID) {
    return FEISHU_CHANNEL_ID;
  }
  throw new BindingStoreError('binding channel is invalid');
}

function chatTypeValue(value: unknown): ChatThreadBinding['chatType'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'p2p' || value === 'group' || value === 'unknown') {
    return value;
  }
  throw new BindingStoreError('binding chatType is invalid');
}

function observedChatTypeValue(value: ChatThreadBinding['chatType'] | undefined): 'p2p' | 'group' | undefined {
  return value === 'p2p' || value === 'group' ? value : undefined;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label);
  if (!text) {
    throw new BindingStoreError(`${label} must be a non-blank string`);
  }
  return text;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BindingStoreError(`${label} must be a string when present`);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > MAX_IDENTIFIER_LENGTH || text.includes('\0')) {
    throw new BindingStoreError(`${label} is invalid`);
  }
  return text;
}

function bindingKey(channel: ChannelId | undefined, botKey: string, tenantKey: string, chatId: string): string {
  return JSON.stringify([
    channelValue(channel),
    requiredBotIdentifier(botKey, 'bot identifier'),
    requiredText(tenantKey, 'tenantKey'),
    requiredText(chatId, 'chatId'),
  ]);
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BindingStoreError('Binding clock must return a non-negative safe integer');
  }
  return value;
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function safelyUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // The original write/replace failure is more useful to callers.
  }
}

function serializeBinding(binding: ChatThreadBinding): ChatThreadBinding {
  const {
    botKey: _botKey,
    larkAppId,
    ...serialized
  } = binding;
  return Object.freeze({
    ...serialized,
    larkAppId: larkAppId ?? DEFAULT_BOT_KEY,
  });
}
