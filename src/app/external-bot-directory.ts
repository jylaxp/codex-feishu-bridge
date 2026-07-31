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

const DIRECTORY_SCHEMA_VERSION = 2;
const DIRECTORY_FILE_NAME = 'external-bots.json';
const MAX_DIRECTORY_FILE_BYTES = 1024 * 1024;
const MAX_ENTRY_COUNT = 20_000;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 200;

export interface ExternalBotDirectoryEntry {
  readonly sourceAppId?: string;
  /** Deprecated runtime alias. New persisted entries write sourceAppId only. */
  readonly sourceBotKey: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly botOpenId: string;
  readonly displayName: string;
  readonly discoveredAtMs: number;
  readonly updatedAtMs: number;
}

export interface ExternalBotDirectoryBotInput {
  readonly botOpenId: string;
  readonly displayName: string;
}

export interface ExternalBotDirectoryGroupInput {
  readonly sourceBotKey: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly bots: readonly ExternalBotDirectoryBotInput[];
}

interface ExternalBotDirectoryDocument {
  readonly schemaVersion: number;
  readonly entries: readonly SerializedExternalBotDirectoryEntry[];
}

type SerializedExternalBotDirectoryEntry = Omit<ExternalBotDirectoryEntry, 'sourceBotKey'>;

export type ExternalBotDirectoryResolution =
  | { readonly status: 'found'; readonly entry: ExternalBotDirectoryEntry }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly matches: readonly ExternalBotDirectoryEntry[] };

export class ExternalBotDirectoryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExternalBotDirectoryError';
  }
}

export interface ExternalBotDirectoryStoreOptions {
  readonly now?: () => number;
  readonly fileName?: string;
}

/** Persistent per-source-bot directory of external Feishu bots visible in a group. */
export class ExternalBotDirectoryStore {
  private readonly now: () => number;
  private readonly directoryPath: string;
  private readonly entries = new Map<string, ExternalBotDirectoryEntry>();

  public constructor(configHome: string, options: ExternalBotDirectoryStoreOptions = {}) {
    if (!configHome.trim()) {
      throw new ExternalBotDirectoryError('External bot directory config home must not be blank');
    }
    this.now = options.now ?? Date.now;
    this.directoryPath = join(configHome, options.fileName ?? DIRECTORY_FILE_NAME);
  }

  public get filePath(): string {
    return this.directoryPath;
  }

  public load(): void {
    this.entries.clear();
    if (!existsSync(this.directoryPath)) {
      return;
    }
    let content: string;
    try {
      content = readFileSync(this.directoryPath, { encoding: 'utf8' });
    } catch (error) {
      throw new ExternalBotDirectoryError('external-bots.json could not be read', { cause: error });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DIRECTORY_FILE_BYTES) {
      throw new ExternalBotDirectoryError('external-bots.json exceeds the maximum allowed size');
    }
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch (error) {
      throw new ExternalBotDirectoryError('external-bots.json is not valid JSON', { cause: error });
    }
    const parsed = parseDocument(document);
    for (const entry of parsed.entries) {
      const key = entryKey(entry.sourceBotKey, entry.tenantKey, entry.chatId, entry.botOpenId);
      if (this.entries.has(key)) {
        throw new ExternalBotDirectoryError('external-bots.json contains a duplicate bot entry');
      }
      this.entries.set(key, entry);
    }
  }

  public list(): readonly ExternalBotDirectoryEntry[] {
    return Object.freeze([...this.entries.values()]);
  }

  public listForGroup(
    sourceBotKey: string,
    tenantKey: string,
    chatId: string,
  ): readonly ExternalBotDirectoryEntry[] {
    const normalizedSourceBotKey = requiredBotIdentifier(sourceBotKey, 'sourceAppId');
    const normalizedTenantKey = requiredText(tenantKey, 'tenantKey');
    const normalizedChatId = requiredText(chatId, 'chatId');
    return Object.freeze([...this.entries.values()].filter((entry) => (
      entry.sourceBotKey === normalizedSourceBotKey
        && entry.tenantKey === normalizedTenantKey
        && entry.chatId === normalizedChatId
    )));
  }

  public resolveForGroup(
    sourceBotKey: string,
    tenantKey: string,
    chatId: string,
    selector: string,
  ): ExternalBotDirectoryResolution {
    const normalizedSelector = selector.trim().toLowerCase();
    if (!normalizedSelector) {
      return { status: 'not_found' };
    }
    const matches = this.listForGroup(sourceBotKey, tenantKey, chatId).filter((entry) => (
      entry.displayName.toLowerCase() === normalizedSelector
        || entry.botOpenId.toLowerCase() === normalizedSelector
        || entry.botOpenId.toLowerCase().endsWith(normalizedSelector)
    ));
    if (matches.length === 0) {
      return { status: 'not_found' };
    }
    if (matches.length === 1) {
      const [entry] = matches;
      if (entry) {
        return { status: 'found', entry };
      }
    }
    return { status: 'ambiguous', matches: Object.freeze(matches) };
  }

  public replaceGroup(input: ExternalBotDirectoryGroupInput): readonly ExternalBotDirectoryEntry[] {
    const sourceBotKey = requiredBotIdentifier(input.sourceBotKey, 'sourceAppId');
    const tenantKey = requiredText(input.tenantKey, 'tenantKey');
    const chatId = requiredText(input.chatId, 'chatId');
    const now = safeNow(this.now);
    const previousGroupEntries = new Map<string, ExternalBotDirectoryEntry>();
    for (const [key, entry] of this.entries) {
      if (entry.sourceBotKey === sourceBotKey && entry.tenantKey === tenantKey && entry.chatId === chatId) {
        previousGroupEntries.set(entry.botOpenId, entry);
        this.entries.delete(key);
      }
    }

    const nextEntries = uniqueBots(input.bots).map((bot) => {
      const previous = previousGroupEntries.get(bot.botOpenId);
      return Object.freeze({
        sourceBotKey,
        sourceAppId: sourceBotKey,
        tenantKey,
        chatId,
        botOpenId: bot.botOpenId,
        displayName: bot.displayName,
        discoveredAtMs: previous?.discoveredAtMs ?? now,
        updatedAtMs: now,
      });
    });
    for (const entry of nextEntries) {
      this.entries.set(entryKey(sourceBotKey, tenantKey, chatId, entry.botOpenId), entry);
    }

    try {
      this.persist();
      return Object.freeze(nextEntries);
    } catch (error) {
      for (const key of [...this.entries.keys()]) {
        const entry = this.entries.get(key);
        if (entry?.sourceBotKey === sourceBotKey && entry.tenantKey === tenantKey && entry.chatId === chatId) {
          this.entries.delete(key);
        }
      }
      for (const entry of previousGroupEntries.values()) {
        this.entries.set(entryKey(sourceBotKey, tenantKey, chatId, entry.botOpenId), entry);
      }
      throw error;
    }
  }

  public removeGroup(sourceBotKey: string, tenantKey: string, chatId: string): number {
    const normalizedSourceBotKey = requiredBotIdentifier(sourceBotKey, 'sourceAppId');
    const normalizedTenantKey = requiredText(tenantKey, 'tenantKey');
    const normalizedChatId = requiredText(chatId, 'chatId');
    const removed: ExternalBotDirectoryEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (
        entry.sourceBotKey === normalizedSourceBotKey
        && entry.tenantKey === normalizedTenantKey
        && entry.chatId === normalizedChatId
      ) {
        removed.push(entry);
        this.entries.delete(key);
      }
    }
    if (removed.length === 0) {
      return 0;
    }
    try {
      this.persist();
      return removed.length;
    } catch (error) {
      for (const entry of removed) {
        this.entries.set(
          entryKey(normalizedSourceBotKey, normalizedTenantKey, normalizedChatId, entry.botOpenId),
          entry,
        );
      }
      throw error;
    }
  }

  private persist(): void {
    if (this.entries.size > MAX_ENTRY_COUNT) {
      throw new ExternalBotDirectoryError('external-bots.json would contain too many entries');
    }
    const directory = dirname(this.directoryPath);
    mkdirSync(directory, { recursive: true });
    const document: ExternalBotDirectoryDocument = Object.freeze({
      schemaVersion: DIRECTORY_SCHEMA_VERSION,
      entries: Object.freeze([...this.entries.values()].map(serializeEntry)),
    });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DIRECTORY_FILE_BYTES) {
      throw new ExternalBotDirectoryError('external-bots.json would exceed the maximum allowed size');
    }
    const temporaryPath = `${this.directoryPath}.tmp`;
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
      renameSync(temporaryPath, this.directoryPath);
      syncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      safelyUnlink(temporaryPath);
      throw new ExternalBotDirectoryError('external-bots.json could not be atomically updated', { cause: error });
    }
  }
}

function parseDocument(value: unknown): { readonly schemaVersion: number; readonly entries: readonly ExternalBotDirectoryEntry[] } {
  if (!isRecord(value) || hasUnknownKeys(value, ['schemaVersion', 'entries'])) {
    throw new ExternalBotDirectoryError('external-bots.json has an invalid document shape');
  }
  if ((value.schemaVersion !== 1 && value.schemaVersion !== DIRECTORY_SCHEMA_VERSION) || !Array.isArray(value.entries)) {
    throw new ExternalBotDirectoryError('external-bots.json schema version is unsupported');
  }
  if (value.entries.length > MAX_ENTRY_COUNT) {
    throw new ExternalBotDirectoryError('external-bots.json contains too many entries');
  }
  return Object.freeze({
    schemaVersion: DIRECTORY_SCHEMA_VERSION,
    entries: Object.freeze(value.entries.map(parseEntry)),
  });
}

function parseEntry(value: unknown): ExternalBotDirectoryEntry {
  if (!isRecord(value) || hasUnknownKeys(value, [
    'sourceBotKey',
    'sourceAppId',
    'tenantKey',
    'chatId',
    'botOpenId',
    'displayName',
    'discoveredAtMs',
    'updatedAtMs',
  ])) {
    throw new ExternalBotDirectoryError('external-bots.json contains an invalid entry');
  }
  const discoveredAtMs = safeTimestamp(value.discoveredAtMs, 'discoveredAtMs');
  const updatedAtMs = safeTimestamp(value.updatedAtMs, 'updatedAtMs');
  return Object.freeze({
    sourceBotKey: requiredBotIdentifier(value.sourceAppId ?? value.sourceBotKey ?? DEFAULT_BOT_KEY, 'sourceAppId'),
    sourceAppId: requiredBotIdentifier(value.sourceAppId ?? value.sourceBotKey ?? DEFAULT_BOT_KEY, 'sourceAppId'),
    tenantKey: requiredText(value.tenantKey, 'tenantKey'),
    chatId: requiredText(value.chatId, 'chatId'),
    botOpenId: requiredOpenId(value.botOpenId),
    displayName: requiredDisplayName(value.displayName),
    discoveredAtMs,
    updatedAtMs,
  });
}

function uniqueBots(bots: readonly ExternalBotDirectoryBotInput[]): readonly ExternalBotDirectoryBotInput[] {
  const seen = new Set<string>();
  const result: ExternalBotDirectoryBotInput[] = [];
  for (const bot of bots) {
    const botOpenId = requiredOpenId(bot.botOpenId);
    const displayName = requiredDisplayName(bot.displayName);
    if (seen.has(botOpenId)) {
      continue;
    }
    seen.add(botOpenId);
    result.push(Object.freeze({ botOpenId, displayName }));
  }
  return Object.freeze(result);
}

function requiredBotIdentifier(value: unknown, label: string): string {
  const key = value === undefined ? DEFAULT_BOT_KEY : requiredText(value, label);
  if (!/^cli_[0-9a-fA-F]{16}$/.test(key) && !/^(?:default|bot_[a-z2-7][a-z2-7]{11,59})$/.test(key)) {
    throw new ExternalBotDirectoryError(`${label} is invalid`);
  }
  return key;
}

function requiredOpenId(value: unknown): string {
  const text = requiredText(value, 'botOpenId');
  if (!/^ou_[A-Za-z0-9_-]{4,}$/.test(text)) {
    throw new ExternalBotDirectoryError('botOpenId is invalid');
  }
  return text;
}

function requiredDisplayName(value: unknown): string {
  const text = requiredText(value, 'displayName');
  if (text.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ExternalBotDirectoryError('displayName is invalid');
  }
  return text;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ExternalBotDirectoryError(`${label} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new ExternalBotDirectoryError(`${label} must not be blank`);
  }
  if (text.length > MAX_IDENTIFIER_LENGTH || text.includes('\0')) {
    throw new ExternalBotDirectoryError(`${label} is invalid`);
  }
  return text;
}

function safeTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ExternalBotDirectoryError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExternalBotDirectoryError('Current time must be a non-negative safe integer');
  }
  return value;
}

function entryKey(sourceBotKey: string, tenantKey: string, chatId: string, botOpenId: string): string {
  return `${sourceBotKey}\0${tenantKey}\0${chatId}\0${botOpenId}`;
}

function serializeEntry(entry: ExternalBotDirectoryEntry): SerializedExternalBotDirectoryEntry {
  const {
    sourceBotKey: _sourceBotKey,
    sourceAppId,
    ...serialized
  } = entry;
  return Object.freeze({
    ...serialized,
    sourceAppId: sourceAppId ?? entry.sourceBotKey,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).some((key) => !allowed.has(key));
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is best-effort on platforms that support it.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function safelyUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Temporary files are best-effort cleanup after failed atomic replacement.
  }
}
