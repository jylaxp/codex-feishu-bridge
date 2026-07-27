import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CachedTenantTokenProvider, type FetchLike } from './lark/client';
import type { BridgeConfig } from './domain';

export const DEFAULT_BOT_KEY = 'default';
const BOTS_SCHEMA_VERSION = 1;
const BOTS_FILE_NAME = 'lark-bots.json';
const MAX_BOTS_FILE_BYTES = 1024 * 1024;
const MAX_BOT_COUNT = 100;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_BOT_KEY_LENGTH = 64;
const BOT_INFO_URL = 'https://open.feishu.cn/open-apis/bot/v3/info';
const MAX_BOT_INFO_BYTES = 64 * 1024;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export type LarkBotConfigSource = 'legacy-env' | 'lark-bots-json' | 'qr' | 'import';

export interface LarkBotConfig {
  readonly botKey: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly enabled: boolean;
  readonly tenantKey: string;
  readonly allowedChats: readonly string[];
  readonly authorizedUsers: readonly string[];
  readonly allowedApprovers: readonly string[];
  readonly allowGroupUserMentions: boolean;
  readonly allowGroupBotMentions: boolean;
  readonly botOpenId?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly activateStatus?: number;
  readonly source: LarkBotConfigSource;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface BotIdentity {
  readonly botOpenId?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly activateStatus?: number;
}

interface BotDocument {
  readonly schemaVersion: number;
  readonly bots: readonly LarkBotConfig[];
}

export class BotConfigStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BotConfigStoreError';
  }
}

export interface BotConfigStoreOptions {
  readonly now?: () => number;
  readonly botsFileName?: string;
}

/** Persistent local robot registry. Secrets are scoped to one app bot record. */
export class BotConfigStore {
  private readonly now: () => number;
  private readonly botsPath: string;
  private readonly bots = new Map<string, LarkBotConfig>();
  private materialized = false;

  public constructor(configHome: string, options: BotConfigStoreOptions = {}) {
    if (!configHome.trim()) {
      throw new BotConfigStoreError('Bot config home must not be blank');
    }
    this.now = options.now ?? Date.now;
    this.botsPath = join(configHome, options.botsFileName ?? BOTS_FILE_NAME);
  }

  public get filePath(): string {
    return this.botsPath;
  }

  public load(baseConfig: BridgeConfig): void {
    this.bots.clear();
    this.materialized = existsSync(this.botsPath);
    if (!this.materialized) {
      this.addLoadedBot(synthesizeDefaultBot(baseConfig, this.now()));
      return;
    }
    const stat = lstatSync(this.botsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BotConfigStoreError('lark-bots.json must be a regular file, not a symlink');
    }
    let content: string;
    try {
      content = readFileSync(this.botsPath, { encoding: 'utf8' });
    } catch (error) {
      throw new BotConfigStoreError('lark-bots.json could not be read', { cause: error });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BOTS_FILE_BYTES) {
      throw new BotConfigStoreError('lark-bots.json exceeds the maximum allowed size');
    }
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch (error) {
      throw new BotConfigStoreError('lark-bots.json is not valid JSON', { cause: error });
    }
    for (const bot of parseDocument(document).bots) {
      this.addLoadedBot(bot);
    }
  }

  public list(): readonly LarkBotConfig[] {
    return Object.freeze([...this.bots.values()]);
  }

  public get(botKey: string): LarkBotConfig | undefined {
    return this.bots.get(requiredBotKey(botKey));
  }

  public activeBots(): readonly LarkBotConfig[] {
    return Object.freeze(this.list().filter((bot) => bot.enabled));
  }

  public hasMaterializedFile(): boolean {
    return this.materialized;
  }

  public save(bot: Omit<LarkBotConfig, 'createdAtMs' | 'updatedAtMs'>): LarkBotConfig {
    const normalized = normalizeBotInput(bot);
    const previous = this.bots.get(normalized.botKey);
    const now = safeNow(this.now);
    const next = Object.freeze({
      ...normalized,
      createdAtMs: previous?.createdAtMs ?? now,
      updatedAtMs: now,
    });
    this.bots.set(next.botKey, next);
    try {
      this.persist();
      return next;
    } catch (error) {
      if (previous) {
        this.bots.set(previous.botKey, previous);
      } else {
        this.bots.delete(next.botKey);
      }
      throw error;
    }
  }

  public update(botKey: string, patch: Partial<Omit<LarkBotConfig, 'botKey' | 'createdAtMs' | 'updatedAtMs'>>): LarkBotConfig {
    const existing = this.get(botKey);
    if (!existing) {
      throw new BotConfigStoreError('bot record does not exist');
    }
    return this.save({
      botKey: existing.botKey,
      appId: patch.appId ?? existing.appId,
      appSecret: patch.appSecret ?? existing.appSecret,
      enabled: patch.enabled ?? existing.enabled,
      tenantKey: patch.tenantKey ?? existing.tenantKey,
      allowedChats: patch.allowedChats ?? existing.allowedChats,
      authorizedUsers: patch.authorizedUsers ?? existing.authorizedUsers,
      allowedApprovers: patch.allowedApprovers ?? existing.allowedApprovers,
      allowGroupUserMentions: patch.allowGroupUserMentions ?? existing.allowGroupUserMentions,
      allowGroupBotMentions: patch.allowGroupBotMentions ?? existing.allowGroupBotMentions,
      botOpenId: patch.botOpenId ?? existing.botOpenId,
      displayName: patch.displayName ?? existing.displayName,
      avatarUrl: patch.avatarUrl ?? existing.avatarUrl,
      activateStatus: patch.activateStatus ?? existing.activateStatus,
      source: patch.source ?? existing.source,
    });
  }

  public remove(botKey: string): boolean {
    const key = requiredBotKey(botKey);
    if (key === DEFAULT_BOT_KEY) {
      throw new BotConfigStoreError('default bot cannot be removed; disable it instead');
    }
    const previous = this.bots.get(key);
    if (!previous) {
      return false;
    }
    this.bots.delete(key);
    try {
      this.persist();
      return true;
    } catch (error) {
      this.bots.set(key, previous);
      throw error;
    }
  }

  public findByAppId(appId: string): LarkBotConfig | undefined {
    const normalized = requiredAppId(appId);
    return this.list().find((bot) => bot.appId.toLowerCase() === normalized.toLowerCase());
  }

  public nextBotKey(appId: string): string {
    return generateBotKey(appId, new Set(this.bots.keys()), (key) => this.bots.get(key)?.appId);
  }

  private addLoadedBot(bot: LarkBotConfig): void {
    if (this.bots.has(bot.botKey)) {
      throw new BotConfigStoreError('lark-bots.json contains duplicate botKey values');
    }
    if ([...this.bots.values()].some((existing) => existing.appId.toLowerCase() === bot.appId.toLowerCase())) {
      throw new BotConfigStoreError('lark-bots.json contains duplicate appId values');
    }
    this.bots.set(bot.botKey, bot);
  }

  private persist(): void {
    const directory = dirname(this.botsPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const document: BotDocument = Object.freeze({
      schemaVersion: BOTS_SCHEMA_VERSION,
      bots: Object.freeze([...this.bots.values()]),
    });
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BOTS_FILE_BYTES) {
      throw new BotConfigStoreError('lark-bots.json would exceed the maximum allowed size');
    }
    const temporaryPath = `${this.botsPath}.tmp`;
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
      renameSync(temporaryPath, this.botsPath);
      syncDirectory(directory);
      this.materialized = true;
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      safelyUnlink(temporaryPath);
      throw new BotConfigStoreError('lark-bots.json could not be atomically updated', { cause: error });
    }
  }
}

export function botConfigToBridgeConfig(baseConfig: BridgeConfig, bot: LarkBotConfig): BridgeConfig {
  return Object.freeze({
    ...baseConfig,
    botKey: bot.botKey,
    larkAppId: bot.appId,
    larkAppSecret: bot.appSecret,
    larkTenantKey: bot.tenantKey,
    larkBotOpenId: bot.botOpenId,
    larkBotName: bot.displayName,
    allowedChats: bot.allowedChats,
    authorizedUsers: bot.authorizedUsers,
    allowedApprovers: bot.allowedApprovers,
    allowGroupUserMentions: bot.allowGroupUserMentions,
    allowGroupBotMentions: bot.allowGroupBotMentions,
  });
}

export function synthesizeDefaultBot(baseConfig: BridgeConfig, now: number): LarkBotConfig {
  return Object.freeze({
    botKey: DEFAULT_BOT_KEY,
    appId: baseConfig.larkAppId,
    appSecret: baseConfig.larkAppSecret,
    enabled: true,
    tenantKey: baseConfig.larkTenantKey,
    allowedChats: Object.freeze([...baseConfig.allowedChats]),
    authorizedUsers: Object.freeze([...baseConfig.authorizedUsers]),
    allowedApprovers: Object.freeze([...baseConfig.allowedApprovers]),
    allowGroupUserMentions: baseConfig.allowGroupUserMentions !== false,
    allowGroupBotMentions: baseConfig.allowGroupBotMentions === true,
    ...(baseConfig.larkBotOpenId ? { botOpenId: baseConfig.larkBotOpenId } : {}),
    ...(baseConfig.larkBotName ? { displayName: baseConfig.larkBotName } : {}),
    source: 'legacy-env',
    createdAtMs: now,
    updatedAtMs: now,
  });
}

export function materializeDefaultBot(baseConfig: BridgeConfig, identity: BotIdentity = {}): Omit<LarkBotConfig, 'createdAtMs' | 'updatedAtMs'> {
  return normalizeBotInput({
    botKey: DEFAULT_BOT_KEY,
    appId: baseConfig.larkAppId,
    appSecret: baseConfig.larkAppSecret,
    enabled: true,
    tenantKey: baseConfig.larkTenantKey,
    allowedChats: baseConfig.allowedChats,
    authorizedUsers: baseConfig.authorizedUsers,
    allowedApprovers: baseConfig.allowedApprovers,
    allowGroupUserMentions: baseConfig.allowGroupUserMentions !== false,
    allowGroupBotMentions: baseConfig.allowGroupBotMentions === true,
    botOpenId: identity.botOpenId ?? baseConfig.larkBotOpenId,
    displayName: identity.displayName ?? baseConfig.larkBotName,
    avatarUrl: identity.avatarUrl,
    activateStatus: identity.activateStatus,
    source: 'legacy-env',
  });
}

export function generateBotKey(
  appId: string,
  existingKeys: ReadonlySet<string>,
  appIdForKey: (botKey: string) => string | undefined = () => undefined,
): string {
  const normalizedAppId = requiredAppId(appId).toLowerCase();
  const digest = createHash('sha256').update(`lark-app:${normalizedAppId}`).digest();
  const encoded = base32Url(digest).toLowerCase();
  for (let length = 12; length <= Math.min(encoded.length, MAX_BOT_KEY_LENGTH - 4); length += 4) {
    const candidate = `bot_${encoded.slice(0, length)}`;
    if (candidate === DEFAULT_BOT_KEY) {
      continue;
    }
    const existingAppId = appIdForKey(candidate);
    if (!existingKeys.has(candidate) || existingAppId?.toLowerCase() === normalizedAppId) {
      return candidate;
    }
  }
  throw new BotConfigStoreError('could not generate a unique botKey');
}

export async function hydrateBotIdentity(
  appId: string,
  appSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<BotIdentity> {
  const provider = new CachedTenantTokenProvider(appId, appSecret, fetchImpl);
  const token = await provider.getToken();
  let response: Response;
  try {
    response = await fetchImpl(BOT_INFO_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BotConfigStoreError('Feishu bot identity request failed');
  }
  if (!response.ok) {
    throw new BotConfigStoreError(`Feishu bot identity HTTP status ${response.status}`);
  }
  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BOT_INFO_BYTES) {
    throw new BotConfigStoreError('Feishu bot identity response is too large');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new BotConfigStoreError('Feishu bot identity response is invalid JSON');
  }
  const record = asRecord(payload);
  if (!record || record.code !== 0) {
    throw new BotConfigStoreError(`Feishu bot identity rejected: ${textValue(record?.msg) ?? 'unknown error'}`);
  }
  const data = asRecord(record.data);
  const bot = asRecord(record.bot) ?? asRecord(data?.bot) ?? data;
  if (!bot) {
    throw new BotConfigStoreError('Feishu bot identity response does not include bot info');
  }
  const displayName = textValue(bot.app_name) ?? textValue(bot.name);
  return Object.freeze({
    ...(textValue(bot.open_id) ? { botOpenId: textValue(bot.open_id) } : {}),
    ...(displayName ? { displayName } : {}),
    ...(textValue(bot.avatar_url) ? { avatarUrl: textValue(bot.avatar_url) } : {}),
    ...(typeof bot.activate_status === 'number' ? { activateStatus: bot.activate_status } : {}),
  });
}

function parseDocument(value: unknown): BotDocument {
  if (!isRecord(value) || hasUnknownKeys(value, ['schemaVersion', 'bots'])) {
    throw new BotConfigStoreError('lark-bots.json has an invalid document shape');
  }
  if (value.schemaVersion !== BOTS_SCHEMA_VERSION || !Array.isArray(value.bots)) {
    throw new BotConfigStoreError('lark-bots.json schema version is unsupported');
  }
  if (value.bots.length > MAX_BOT_COUNT) {
    throw new BotConfigStoreError('lark-bots.json contains too many bots');
  }
  return Object.freeze({
    schemaVersion: BOTS_SCHEMA_VERSION,
    bots: Object.freeze(value.bots.map(parseBot)),
  });
}

function parseBot(value: unknown): LarkBotConfig {
  if (!isRecord(value) || hasUnknownKeys(value, [
    'botKey',
    'appId',
    'appSecret',
    'enabled',
    'tenantKey',
    'allowedChats',
    'authorizedUsers',
    'allowedApprovers',
    'allowGroupUserMentions',
    'allowGroupBotMentions',
    'botOpenId',
    'displayName',
    'avatarUrl',
    'activateStatus',
    'source',
    'createdAtMs',
    'updatedAtMs',
  ])) {
    throw new BotConfigStoreError('lark-bots.json contains an invalid bot');
  }
  const normalized = normalizeBotInput({
    botKey: requiredBotKey(value.botKey),
    appId: requiredAppId(value.appId),
    appSecret: requiredText(value.appSecret, 'appSecret'),
    enabled: value.enabled !== false,
    tenantKey: optionalText(value.tenantKey, 'tenantKey') ?? '',
    allowedChats: stringArray(value.allowedChats, 'allowedChats'),
    authorizedUsers: stringArray(value.authorizedUsers, 'authorizedUsers'),
    allowedApprovers: stringArray(value.allowedApprovers, 'allowedApprovers'),
    allowGroupUserMentions: value.allowGroupUserMentions !== false,
    allowGroupBotMentions: value.allowGroupBotMentions === true,
    botOpenId: optionalText(value.botOpenId, 'botOpenId'),
    displayName: optionalText(value.displayName, 'displayName'),
    avatarUrl: optionalText(value.avatarUrl, 'avatarUrl'),
    activateStatus: typeof value.activateStatus === 'number' ? value.activateStatus : undefined,
    source: parseSource(value.source),
  });
  return Object.freeze({
    ...normalized,
    createdAtMs: timestampValue(value.createdAtMs, 'createdAtMs'),
    updatedAtMs: timestampValue(value.updatedAtMs, 'updatedAtMs'),
  });
}

function normalizeBotInput(
  input: Omit<LarkBotConfig, 'createdAtMs' | 'updatedAtMs'>,
): Omit<LarkBotConfig, 'createdAtMs' | 'updatedAtMs'> {
  return Object.freeze({
    botKey: requiredBotKey(input.botKey),
    appId: requiredAppId(input.appId),
    appSecret: requiredText(input.appSecret, 'appSecret'),
    enabled: input.enabled !== false,
    tenantKey: optionalText(input.tenantKey, 'tenantKey') ?? '',
    allowedChats: Object.freeze(uniqueStrings(input.allowedChats)),
    authorizedUsers: Object.freeze(uniqueStrings(input.authorizedUsers)),
    allowedApprovers: Object.freeze(uniqueStrings(input.allowedApprovers)),
    allowGroupUserMentions: input.allowGroupUserMentions !== false,
    allowGroupBotMentions: input.allowGroupBotMentions === true,
    ...(optionalText(input.botOpenId, 'botOpenId') ? { botOpenId: optionalText(input.botOpenId, 'botOpenId') } : {}),
    ...(optionalText(input.displayName, 'displayName') ? { displayName: optionalText(input.displayName, 'displayName') } : {}),
    ...(optionalText(input.avatarUrl, 'avatarUrl') ? { avatarUrl: optionalText(input.avatarUrl, 'avatarUrl') } : {}),
    ...(typeof input.activateStatus === 'number' ? { activateStatus: input.activateStatus } : {}),
    source: input.source,
  });
}

function requiredBotKey(value: unknown): string {
  const key = requiredText(value, 'botKey');
  if (key.length > MAX_BOT_KEY_LENGTH || !/^(?:default|bot_[a-z2-7][a-z2-7]{11,59})$/.test(key)) {
    throw new BotConfigStoreError('botKey is invalid');
  }
  return key;
}

function requiredAppId(value: unknown): string {
  const appId = requiredText(value, 'appId');
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new BotConfigStoreError('appId must match cli_ followed by 16 hexadecimal characters');
  }
  return appId;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value, label);
  if (!text) {
    throw new BotConfigStoreError(`${label} must be a non-blank string`);
  }
  return text;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BotConfigStoreError(`${label} must be a string when present`);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (text.length > MAX_IDENTIFIER_LENGTH || text.includes('\0')) {
    throw new BotConfigStoreError(`${label} is invalid`);
  }
  return text;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw new BotConfigStoreError(`${label} must be an array when present`);
  }
  return Object.freeze(uniqueStrings(value));
}

function uniqueStrings(values: readonly unknown[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value): value is string => (
    typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
  )).map((value) => value.trim()))]);
}

function parseSource(value: unknown): LarkBotConfigSource {
  return value === 'legacy-env' || value === 'lark-bots-json' || value === 'qr' || value === 'import'
    ? value
    : 'lark-bots-json';
}

function timestampValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BotConfigStoreError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BotConfigStoreError('Bot config clock must return a non-negative safe integer');
  }
  return value;
}

function base32Url(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function hasUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
    // Keep the original failure visible.
  }
}
