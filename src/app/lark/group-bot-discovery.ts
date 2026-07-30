import type { LarkBotConfig } from '../bot-config-store';
import type {
  ExternalBotDirectoryBotInput,
  ExternalBotDirectoryGroupInput,
  ExternalBotDirectoryStore,
} from '../external-bot-directory';
import { CachedTenantTokenProvider } from './client';

const GROUP_BOTS_ENDPOINT_PREFIX = 'https://open.feishu.cn/open-apis/im/v1/chats';
const DEFAULT_REFRESH_THROTTLE_MS = 5 * 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface GroupBotDiscoveryLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface GroupBotDiscoveryOptions {
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly refreshThrottleMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly localBots: () => readonly LarkBotConfig[];
  readonly logger?: GroupBotDiscoveryLogger;
}

interface GroupBotsApiPayload {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

interface GroupBotRecord {
  readonly bot_id?: unknown;
  readonly bot_name?: unknown;
}

export interface GroupBotDiscoveryRefreshInput {
  readonly sourceBot: LarkBotConfig;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly force?: boolean;
}

export interface GroupBotDiscoveryRefreshResult {
  readonly refreshed: boolean;
  readonly externalBotCount: number;
}

/** Refreshes the external-bot directory from Feishu's group robot list API. */
export class GroupBotDiscoveryService {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshThrottleMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly localBots: () => readonly LarkBotConfig[];
  private readonly logger: GroupBotDiscoveryLogger | undefined;
  private readonly lastRefreshByGroup = new Map<string, number>();

  public constructor(
    private readonly directory: ExternalBotDirectoryStore,
    options: GroupBotDiscoveryOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshThrottleMs = options.refreshThrottleMs ?? DEFAULT_REFRESH_THROTTLE_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.localBots = options.localBots;
    this.logger = options.logger;
  }

  public async refreshGroup(input: GroupBotDiscoveryRefreshInput): Promise<GroupBotDiscoveryRefreshResult> {
    const refreshKey = `${input.sourceBot.botKey}\0${input.tenantKey}\0${input.chatId}`;
    const now = safeNow(this.now);
    const lastRefreshAtMs = this.lastRefreshByGroup.get(refreshKey);
    if (
      !input.force
      && lastRefreshAtMs !== undefined
      && lastRefreshAtMs + this.refreshThrottleMs > now
    ) {
      return {
        refreshed: false,
        externalBotCount: this.directory.listForGroup(
          input.sourceBot.botKey,
          input.tenantKey,
          input.chatId,
        ).length,
      };
    }

    const discovered = await this.fetchGroupBots(input.sourceBot, input.chatId);
    const localOpenIds = new Set(this.localBots()
      .map((bot) => bot.botOpenId)
      .filter((value): value is string => Boolean(value)));
    const externalBots = discovered.filter((bot) => !localOpenIds.has(bot.botOpenId));
    const saved = this.directory.replaceGroup(Object.freeze({
      sourceBotKey: input.sourceBot.botKey,
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      bots: externalBots,
    } satisfies ExternalBotDirectoryGroupInput));
    this.lastRefreshByGroup.set(refreshKey, now);
    this.logger?.info('lark_group_bots_discovered', {
      botKey: input.sourceBot.botKey,
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      externalBotCount: saved.length,
    });
    return { refreshed: true, externalBotCount: saved.length };
  }

  public removeGroup(sourceBotKey: string, tenantKey: string, chatId: string): number {
    const removed = this.directory.removeGroup(sourceBotKey, tenantKey, chatId);
    this.lastRefreshByGroup.delete(`${sourceBotKey}\0${tenantKey}\0${chatId}`);
    if (removed > 0) {
      this.logger?.info('lark_group_bots_directory_removed', {
        botKey: sourceBotKey,
        tenantKey,
        chatId,
        removed,
      });
    }
    return removed;
  }

  private async fetchGroupBots(
    sourceBot: LarkBotConfig,
    chatId: string,
  ): Promise<readonly ExternalBotDirectoryBotInput[]> {
    const provider = new CachedTenantTokenProvider(sourceBot.appId, sourceBot.appSecret, this.fetchImpl);
    const token = await provider.getToken();
    const encodedChatId = encodeURIComponent(chatId);
    let response: Response;
    try {
      response = await this.fetchImpl(`${GROUP_BOTS_ENDPOINT_PREFIX}/${encodedChatId}/members/bots`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.fetchTimeoutMs),
      });
    } catch (error) {
      this.logger?.warn('lark_group_bots_fetch_failed', {
        botKey: sourceBot.botKey,
        chatId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw new GroupBotDiscoveryError('Feishu group bot list request failed', { cause: error });
    }
    if (!response.ok) {
      throw new GroupBotDiscoveryError(`Feishu group bot list HTTP status ${response.status}`);
    }
    const payload = await parsePayload(response);
    if (payload.code !== undefined && payload.code !== 0) {
      throw new GroupBotDiscoveryError(`Feishu group bot list rejected: ${textValue(payload.msg) ?? 'unknown error'}`);
    }
    const data = isRecord(payload.data) ? payload.data : {};
    const items = Array.isArray(data.items) ? data.items : [];
    return Object.freeze(items.flatMap((candidate): ExternalBotDirectoryBotInput[] => {
      const record = isRecord(candidate) ? candidate as GroupBotRecord : null;
      const botOpenId = textValue(record?.bot_id);
      const displayName = textValue(record?.bot_name);
      if (!botOpenId || !displayName) {
        return [];
      }
      return [Object.freeze({ botOpenId, displayName })];
    }));
  }
}

export class GroupBotDiscoveryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GroupBotDiscoveryError';
  }
}

async function parsePayload(response: Response): Promise<GroupBotsApiPayload> {
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > 512 * 1024) {
    throw new GroupBotDiscoveryError('Feishu group bot list response is too large');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new GroupBotDiscoveryError('Feishu group bot list response is invalid JSON', { cause: error });
  }
  return isRecord(payload) ? payload : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GroupBotDiscoveryError('Current time must be a non-negative safe integer');
  }
  return value;
}
