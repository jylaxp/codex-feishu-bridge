import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, normalize, sep } from 'node:path';

import { type BindingStore, type ChatThreadBinding } from './binding-store';
import { createTaskCard, type CardKitJson } from './cards/layouts';
import { sanitizeCardMarkdown, sanitizeCardPlainText, sanitizeCardText } from './cards/sanitizer';
import { type ThreadNavigation } from './codex/app-navigation-adapter';
import type { Thread, ThreadItem, ThreadResumeResponse, Turn } from './codex/protocol';
import type {
  BridgeConfig,
  CardProjectionPayload,
  CardTimelineEntry,
  CardToolGroup,
  SanitizedCardText,
  TaskStatus,
} from './domain';
import type { InboundTextMessage } from './lark/intake';
import { toast } from './lark/event-server';

const PICKER_LIMIT = 99;
const TOKEN_TTL_MS = 10 * 60_000;

export interface BindingCatalogV3 {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

export interface BindingCardsV3 {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
  sendCard(chatId: string, cardId: string, idempotencyKey: string): Promise<string>;
  replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
}

export interface BindingLoggerV3 {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
  error(event: string, error: unknown, fields?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface BindingActionV3 {
  readonly tenantKey: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly operatorOpenId: string;
  readonly token: string;
}

interface ThreadChoice {
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly updatedAt: number | null;
}

interface PendingBindingCard {
  readonly cardId: string;
  readonly messageId: string;
  readonly card: CardKitJson;
  readonly choice: ThreadChoice;
  readonly expiresAtMs: number;
}

/** Stateless command surface backed only by BindingStore. */
export class ConversationBindingServiceV3 {
  private readonly consumedOpenTokens = new Map<string, number>();
  private readonly pendingBindingCards = new Map<string, PendingBindingCard>();
  private readonly pushedHistoryTurns = new Set<string>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly store: BindingStore,
    private readonly catalog: BindingCatalogV3,
    private readonly cards: BindingCardsV3,
    private readonly now: () => number = Date.now,
    private readonly navigation: ThreadNavigation | undefined = undefined,
    private readonly logger: BindingLoggerV3 | undefined = undefined,
    private readonly workspaceStateReader: () => Promise<BindingWorkspaceState> = readWorkspaceState,
    private readonly readRateLimits: (() => Promise<unknown>) | undefined = undefined,
    private readonly projectActiveDesktopTurn: ((binding: ChatThreadBinding) => Promise<boolean>) | undefined = undefined,
  ) {}

  public getBinding(tenantKey: string, chatId: string): ChatThreadBinding | undefined {
    return this.store.get(tenantKey, chatId);
  }

  public async handleCommand(message: InboundTextMessage): Promise<boolean> {
    const command = firstCommand(message.text);
    if (command === '/bind' || command === '/l' || command === '/list' || command === '/ll') {
      await this.sendPicker(message, command === '/ll');
      return true;
    }
    if (command === '/binding') {
      await this.sendStatus(message);
      return true;
    }
    if (command === '/open') {
      await this.openBoundThread(message);
      return true;
    }
    if (command === '/unbind') {
      const removed = this.store.unbind(message.tenantKey, message.chatId);
      await this.reply(message, unboundCard(removed), 'unbind');
      return true;
    }
    return false;
  }

  public async ensureBoundOrPrompt(message: InboundTextMessage): Promise<boolean> {
    if (this.getBinding(message.tenantKey, message.chatId)) {
      return true;
    }
    await this.sendPicker(message);
    return false;
  }

  public async handleCardAction(action: BindingActionV3): Promise<object> {
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return toast('你没有绑定权限', 'warning');
    }
    const payload = verifyToken(action.token, action, this.config.larkAppSecret, this.now);
    if (!payload) {
      return toast('会话选择已过期、作用域不匹配或无效，请重新 /bind', 'warning');
    }
    const revision = this.getBinding(action.tenantKey, action.chatId)?.revision ?? 0;
    if (payload.revision !== revision) {
      return toast('选择卡已过期，请重新 /bind', 'warning');
    }
    this.prunePendingBindingCards();
    const pending = this.pendingBindingCards.get(action.token);
    if (pending && pending.messageId !== action.messageId) {
      return toast('选择卡已过期，请重新 /bind', 'warning');
    }
    const choice = pending?.choice ?? await this.readThreadChoice(payload.threadId);
    const workspaceId = choice.cwd ?? this.config.codexCwd;
    const selectedCard = pending ? disabledPickerCard(pending.card, action.token) : undefined;
    const binding = this.store.bind({
      tenantKey: action.tenantKey,
      chatId: action.chatId,
      threadId: payload.threadId,
      workspaceId,
    });
    if (pending) {
      for (const [token, context] of this.pendingBindingCards) {
        if (context.cardId === pending.cardId) {
          this.pendingBindingCards.delete(token);
        }
      }
    }
    this.logger?.info('binding_action_accepted', {
      chatId: action.chatId,
      threadId: payload.threadId,
      revision: binding.revision,
    });
    void this.completeBindingSideEffects(binding, action.messageId);
    return selectedCard
      ? {
          ...toast('成功绑定到 Codex 会话', 'success'),
          card: { type: 'raw', data: selectedCard },
        }
      : toast('成功绑定到 Codex 会话', 'success');
  }

  public async handleOpenAction(action: BindingActionV3): Promise<object> {
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return toast('你没有打开会话的权限', 'warning');
    }
    const payload = verifyToken(action.token, action, this.config.larkAppSecret, this.now);
    const binding = this.getBinding(action.tenantKey, action.chatId);
    if (!payload || !binding || payload.threadId !== binding.threadId || payload.revision !== binding.revision) {
      return toast('会话打开操作已过期，请重新发送 /binding', 'warning');
    }
    this.pruneConsumedOpenTokens();
    if (this.consumedOpenTokens.has(action.token)) {
      return toast('会话打开操作已使用，请重新发送 /binding', 'warning');
    }
    this.consumedOpenTokens.set(action.token, this.now() + TOKEN_TTL_MS);
    return this.openThread(binding.threadId);
  }

  private async sendPicker(message: InboundTextMessage, table = false): Promise<void> {
    const response = await this.catalog.request<unknown>('thread/list', {
      limit: PICKER_LIMIT,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    const binding = this.getBinding(message.tenantKey, message.chatId);
    const choices = await this.includeCurrentBinding(parseChoices(response), binding);
    const revision = binding?.revision ?? 0;
    const entries = choices.map((choice) => ({
      choice,
      token: createToken(choice.id, revision, message, this.config.larkAppSecret, this.now),
    }));
    const card = await pickerCard(entries, table, binding?.threadId, await this.workspaceStateReader());
    const cardId = await this.cards.createCard(card);
    const messageId = await this.cards.sendCard(
      message.chatId,
      cardId,
      `binding:${message.eventId}:${table ? 'picker-table' : 'picker'}`,
    );
    const expiresAtMs = this.now() + TOKEN_TTL_MS;
    for (const entry of entries) {
      this.pendingBindingCards.set(entry.token, Object.freeze({
        cardId,
        messageId,
        card,
        choice: entry.choice,
        expiresAtMs,
      }));
    }
  }

  private async includeCurrentBinding(
    choices: readonly ThreadChoice[],
    binding: ChatThreadBinding | undefined,
  ): Promise<readonly ThreadChoice[]> {
    if (!binding || choices.some((choice) => choice.id === binding.threadId)) {
      return choices;
    }
    let title = '当前绑定会话';
    try {
      const response = asRecord(await this.catalog.request<unknown>('thread/read', {
        threadId: binding.threadId,
        includeTurns: false,
      }));
      const thread = asRecord(response?.thread) ?? response;
      if (typeof thread?.name === 'string' && thread.name.trim()) {
        title = thread.name.trim();
      }
    } catch {
      // The stored binding remains selectable even if its metadata is temporarily unavailable.
    }
    return Object.freeze([{
      id: binding.threadId,
      title,
      cwd: binding.workspaceId,
      updatedAt: null,
    }, ...choices]);
  }

  private async sendStatus(message: InboundTextMessage): Promise<void> {
    const binding = this.getBinding(message.tenantKey, message.chatId);
    const token = binding
      ? createToken(binding.threadId, binding.revision, message, this.config.larkAppSecret, this.now)
      : undefined;
    await this.reply(message, statusCard(binding, token), 'status');
  }

  private async openBoundThread(message: InboundTextMessage): Promise<void> {
    const binding = this.getBinding(message.tenantKey, message.chatId);
    if (!binding) {
      await this.sendStatus(message);
      return;
    }
    const result = await this.openThread(binding.threadId);
    await this.reply(message, openResultCard(result), 'open');
  }

  private async completeBindingSideEffects(
    binding: ChatThreadBinding,
    messageId: string,
  ): Promise<void> {
    if (this.getBinding(binding.tenantKey, binding.chatId)?.revision !== binding.revision) {
      return;
    }
    try {
      if (await this.projectActiveDesktopTurn?.(binding)) {
        this.logger?.info('binding_active_turn_projected', {
          chatId: binding.chatId,
          threadId: binding.threadId,
        });
        return;
      }
    } catch (error) {
      this.logger?.warn('binding_active_turn_projection_failed', {
        chatId: binding.chatId,
        threadId: binding.threadId,
      });
      this.logger?.error('binding_active_turn_projection_error', error, {
        chatId: binding.chatId,
        threadId: binding.threadId,
      });
    }
    await this.pushLatestHistoryCard(
      binding,
      `history:${messageId}:${binding.threadId}`,
      'card_action',
    );
  }

  private async openThread(threadId: string): Promise<{ readonly type: 'success' | 'warning' }> {
    if (!this.navigation) {
      return { type: 'warning' };
    }
    try {
      await this.navigation.openThread(threadId);
      return { type: 'success' };
    } catch {
      return { type: 'warning' };
    }
  }

  private async pushLatestHistoryCard(
    binding: ChatThreadBinding,
    idempotencyPrefix: string,
    source: 'picker' | 'card_action',
  ): Promise<void> {
    try {
      this.logger?.info('history_push_started', {
        source,
        chatId: binding.chatId,
        threadId: binding.threadId,
      });
      const response = await this.catalog.request<ThreadResumeResponse>('thread/resume', {
        threadId: binding.threadId,
        excludeTurns: false,
      });
      const newestTurn = response.thread.turns.at(-1);
      if (newestTurn?.status === 'inProgress') {
        this.logger?.info('history_push_skipped_active_turn', {
          source,
          chatId: binding.chatId,
          threadId: binding.threadId,
          turnId: newestTurn.id,
        });
        return;
      }
      const turn = latestTerminalTurn(response.thread);
      if (!turn) {
        this.logger?.warn('history_push_no_terminal_turn', {
          source,
          chatId: binding.chatId,
          threadId: binding.threadId,
          turnCount: Array.isArray(response.thread.turns) ? response.thread.turns.length : 0,
        });
        return;
      }
      const historyKey = `${binding.threadId.length}:${binding.threadId}${turn.id.length}:${turn.id}`;
      if (this.pushedHistoryTurns.has(historyKey)) {
        return;
      }
      const rateLimitText = this.readRateLimits
        ? formatHistoryRateLimits(await this.readRateLimits().catch(() => null))
        : null;
      const card = createHistoryTaskCard(turn, response.model, rateLimitText);
      const cardId = await this.cards.createCard(card);
      await this.cards.sendCard(binding.chatId, cardId, `${idempotencyPrefix}:${turn.id}`);
      this.pushedHistoryTurns.add(historyKey);
      this.logger?.info('history_push_sent', {
        source,
        chatId: binding.chatId,
        threadId: binding.threadId,
        turnId: turn.id,
      });
    } catch (error) {
      this.logger?.error('history_push_failed', error, {
        source,
        chatId: binding.chatId,
        threadId: binding.threadId,
      });
    }
  }

  private async reply(message: InboundTextMessage, card: CardKitJson, operation: string): Promise<void> {
    const cardId = await this.cards.createCard(card);
    await this.cards.sendCard(message.chatId, cardId, `binding:${message.eventId}:${operation}`);
  }

  private async readThreadChoice(threadId: string): Promise<ThreadChoice> {
    const response = asRecord(await this.catalog.request<unknown>('thread/read', {
      threadId,
      includeTurns: false,
    }));
    const thread = asRecord(response?.thread) ?? response;
    if (!thread) {
      throw new Error('Selected thread is no longer available');
    }
    return Object.freeze({
      id: threadId,
      title: typeof thread.name === 'string' && thread.name.trim() ? thread.name.trim() : '未命名会话',
      cwd: typeof thread.cwd === 'string' && thread.cwd.trim() ? thread.cwd : null,
      updatedAt: normalizeUpdatedAt(thread.updatedAt),
    });
  }

  private pruneConsumedOpenTokens(): void {
    const now = this.now();
    for (const [token, expiresAtMs] of this.consumedOpenTokens) {
      if (expiresAtMs < now) {
        this.consumedOpenTokens.delete(token);
      }
    }
  }

  private prunePendingBindingCards(): void {
    const now = this.now();
    for (const [token, pending] of this.pendingBindingCards) {
      if (pending.expiresAtMs < now) {
        this.pendingBindingCards.delete(token);
      }
    }
  }
}

function latestTerminalTurn(thread: Thread): Turn | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn && (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted')) {
      return turn;
    }
  }
  return null;
}

function createHistoryTaskCard(
  turn: Turn,
  model: string | null | undefined,
  rateLimitText: string | null,
): CardKitJson {
  const status = taskStatusFromTurn(turn);
  const stats = extractHistoryStats(turn);
  if (model) {
    stats.model = model;
  }
  const payload: CardProjectionPayload = {
    title: sanitizeCardText('Codex 历史任务', { maxLength: 200 }),
    prompt: sanitizeCardMarkdown(promptFromTurn(turn) ?? '无输入文本', { maxLength: 10_000 }),
    metadata: sanitizeCardMarkdown(historyMetadata(turn), { maxLength: 1_000 }) || null,
    commentary: sanitizeCardMarkdown(commentaryFromTurn(turn), { maxLength: 10_000 }),
    toolSummary: sanitizeCardPlainText(toolSummaryFromTurn(turn), { maxLength: 10_000 }),
    toolCount: toolCountFromTurn(turn),
    timeline: historyTimelineFromTurn(turn),
    finalAnswer: sanitizeCardMarkdown(finalAnswerFromTurn(turn) || failureTextFromTurn(turn), { maxLength: 10_000 }),
    footer: sanitizeCardPlainText(historyFooter(turn, status, stats, rateLimitText), { maxLength: 1_000 }),
    terminal: true,
  };
  return createTaskCard({ status, payload, historical: true });
}

interface HistoryStats {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextLength?: number;
  apiCalls?: number;
}

function historyMetadata(turn: Turn): string {
  const metadata: string[] = [];
  const skill = turn.input?.find((input) => input.type === 'skill');
  if (skill?.type === 'skill') {
    metadata.push(`✨ **调用的技能**: \`${skill.name}\``);
  }
  const raw = turn as Turn & { readonly collaborationMode?: string | null; readonly personality?: string | null };
  if (raw.collaborationMode === 'plan') {
    metadata.push('📝 **计划模式**: `开启`');
  }
  if (raw.personality && raw.personality !== 'none') {
    const labels: Readonly<Record<string, string>> = { friendly: '亲和', pragmatic: '务实' };
    metadata.push(`🎭 **回复风格**: \`${labels[raw.personality] ?? raw.personality}\``);
  }
  return metadata.join(' ｜ ');
}

function historyFooter(
  turn: Turn,
  status: TaskStatus,
  stats: HistoryStats,
  rateLimitText: string | null,
): string {
  const state = status === 'SUCCEEDED' ? '✅ 已完成'
    : status === 'INTERRUPTED' ? '🛑 已取消' : '❌ 失败';
  const parts = [state];
  const durationMs = turn.durationMs ?? durationBetween(turn.startedAt, turn.completedAt);
  if (durationMs !== null) {
    parts.push(`耗时 ${formatHistoryDuration(durationMs)}`);
  }
  if (stats.model) {
    parts.push(stats.model);
  }
  if (stats.inputTokens !== undefined || stats.outputTokens !== undefined) {
    parts.push(`↑ ${formatHistoryCount(stats.inputTokens)} ↓ ${formatHistoryCount(stats.outputTokens)}`);
  }
  if (stats.contextTokens !== undefined && stats.contextLength) {
    const percent = Math.round((stats.contextTokens / stats.contextLength) * 100);
    parts.push(
      `上下文 ${formatHistoryCount(stats.contextTokens)}/${formatHistoryCount(stats.contextLength)} (${percent}%)`,
    );
  }
  if (stats.apiCalls !== undefined) {
    parts.push(`API ${stats.apiCalls}`);
  }
  const footer = parts.join(' · ');
  return rateLimitText ? `${footer}\n窗口用量: ${rateLimitText}` : footer;
}

function extractHistoryStats(value: unknown): HistoryStats {
  const stats: HistoryStats = {};
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8) return;
    const record = asRecord(candidate);
    if (!record) {
      if (Array.isArray(candidate)) candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    stats.model ??= firstHistoryString(record, ['model', 'model_name', 'modelName', 'model_id', 'modelId']);
    stats.inputTokens ??= firstHistoryNumber(record, [
      'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'tokens_in', 'tokensIn',
    ]);
    stats.outputTokens ??= firstHistoryNumber(record, [
      'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens', 'tokens_out', 'tokensOut',
    ]);
    stats.contextTokens ??= firstHistoryNumber(record, [
      'context_tokens', 'contextTokens', 'context_used_tokens', 'contextUsedTokens', 'total_tokens', 'totalTokens',
    ]);
    stats.contextLength ??= firstHistoryNumber(record, [
      'context_length', 'contextLength', 'context_window', 'contextWindow', 'modelContextWindow',
      'max_context_tokens', 'maxContextTokens',
    ]);
    stats.apiCalls ??= firstHistoryNumber(record, [
      'api_calls', 'apiCalls', 'api_requests', 'apiRequests', 'request_count', 'requestCount',
    ]);
    for (const [key, entry] of Object.entries(record)) {
      if (key !== 'total' || depth === 0) visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return stats;
}

function firstHistoryString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstHistoryNumber(record: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function durationBetween(startedAt: number | null, completedAt: number | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const multiplier = Math.max(startedAt, completedAt) < 100_000_000_000 ? 1_000 : 1;
  return Math.max(0, (completedAt - startedAt) * multiplier);
}

function formatHistoryDuration(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.floor(seconds % 60).toString().padStart(2, '0')}s`;
}

function formatHistoryCount(value?: number): string {
  if (value === undefined) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatHistoryRateLimits(response: unknown): string | null {
  const root = asRecord(response);
  const byLimitId = asRecord(root?.rateLimitsByLimitId);
  const limits = asRecord(asRecord(byLimitId?.codex) ?? root?.rateLimits);
  if (!limits) return null;
  const candidates = [asRecord(limits.primary), asRecord(limits.secondary)]
    .filter((limit): limit is Record<string, unknown> => limit !== null);
  const weekly = candidates.find((limit) => {
    const duration = firstHistoryNumber(limit, ['windowDurationMins']);
    return duration !== undefined && duration >= 6 * 24 * 60;
  }) ?? asRecord(limits.secondary) ?? asRecord(limits.primary);
  if (!weekly) return null;
  const usedPercent = firstHistoryNumber(weekly, ['usedPercent']);
  if (usedPercent === undefined) return null;
  const resetsAt = firstHistoryNumber(weekly, ['resetsAt']);
  const reset = resetsAt === undefined ? '' : ` (${formatHistoryResetTime(resetsAt)})`;
  return `7d: ${usedPercent}%${reset}`;
}

function formatHistoryResetTime(timestamp: number): string {
  const date = new Date(timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp);
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function taskStatusFromTurn(turn: Turn): TaskStatus {
  if (turn.status === 'completed') {
    return 'SUCCEEDED';
  }
  if (turn.status === 'interrupted') {
    return 'INTERRUPTED';
  }
  return 'FAILED';
}

function promptFromTurn(turn: Turn): string | null {
  const inputPrompt = (turn.input ?? [])
    .filter((input) => input.type === 'text')
    .map((input) => input.text)
    .join('\n')
    .trim();
  if (inputPrompt) {
    return inputPrompt;
  }
  for (const item of turn.items) {
    if (item.type !== 'userMessage' && item.type !== 'user_message') {
      continue;
    }
    const text = textFromItem(item);
    if (text) {
      return text;
    }
  }
  return null;
}

function commentaryFromTurn(turn: Turn): string {
  let commentary = '';
  for (const item of turn.items) {
    if ((isAgentMessage(item) && item.phase === 'commentary') || item.type === 'reasoning') {
      const text = visibleHistoryReasoning(item);
      if (text) {
        commentary += `${commentary ? '\n\n' : ''}${text}`;
      }
    }
  }
  return commentary;
}

function finalAnswerFromTurn(turn: Turn): string {
  return turn.items
    .filter((item) => isAgentMessage(item) && item.phase === 'final_answer')
    .map(textFromItem)
    .filter(Boolean)
    .join('\n');
}

function failureTextFromTurn(turn: Turn): string {
  if (turn.error?.message) {
    return turn.error.message;
  }
  if (turn.status === 'interrupted') {
    return '任务已取消';
  }
  return '';
}

function toolSummaryFromTurn(turn: Turn): SanitizedCardText {
  const lines = turn.items.flatMap((item, index) => {
    if (!isToolItem(item)) {
      return [];
    }
    const command = typeof item.command === 'string' && item.command.trim()
      ? item.command.trim().replace(/\s+/g, ' ')
      : item.type;
    const marker = item.exitCode === 0 || item.status === 'completed' ? '✅' : '🛠️';
    return [`${marker} ${index + 1}. ${truncateOneLine(command, 240)}`];
  });
  return sanitizeCardPlainText(lines.join('\n') || '暂无', { maxLength: 10_000 });
}

function toolCountFromTurn(turn: Turn): number {
  return turn.items.filter(isToolItem).length;
}

function isAgentMessage(item: ThreadItem): boolean {
  return item.type === 'agentMessage' || item.type === 'agent_message';
}

function isToolItem(item: ThreadItem): boolean {
  return [
    'commandExecution',
    'command_execution',
    'mcpToolCall',
    'fileChange',
    'toolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'imageGeneration',
  ].includes(item.type);
}

function textFromItem(item: ThreadItem): string {
  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.trim();
  }
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content.map((content) => {
    if (typeof content === 'string') {
      return content;
    }
    return content.type === 'text' ? content.text : '';
  }).join('\n').trim();
}

function historyTimelineFromTurn(turn: Turn): readonly CardTimelineEntry[] {
  const timeline: CardTimelineEntry[] = [];
  let group: ThreadItem[] = [];
  const time = sanitizeCardPlainText(historyTimelineTime(turn.startedAt), { maxLength: 16 });
  const flushTools = (): void => {
    if (group.length === 0) {
      return;
    }
    timeline.push(Object.freeze({
      kind: 'tool',
      time,
      tool: historyToolGroup(group),
    }));
    group = [];
  };
  for (const item of turn.items) {
    if (isToolItem(item)) {
      group.push(item);
      continue;
    }
    flushTools();
    if (!((isAgentMessage(item) && item.phase === 'commentary') || item.type === 'reasoning')) {
      continue;
    }
    const text = visibleHistoryReasoning(item);
    if (text) {
      timeline.push(Object.freeze({
        kind: 'reasoning',
        time,
        content: sanitizeCardMarkdown(text, { maxLength: 4_000 }),
      }));
    }
  }
  flushTools();
  return boundedHistoryTimeline(timeline);
}

function boundedHistoryTimeline(entries: readonly CardTimelineEntry[]): readonly CardTimelineEntry[] {
  const maxEntries = 20;
  const maxCharacters = 24_000;
  const result: CardTimelineEntry[] = [];
  let characters = 0;
  for (const entry of entries) {
    const size = entry.kind === 'reasoning'
      ? entry.content?.length ?? 0
      : (entry.tool?.title.length ?? 0) + (entry.tool?.content.length ?? 0);
    if (result.length >= maxEntries || characters + size > maxCharacters) {
      const time = entries.at(-1)?.time
        ?? sanitizeCardPlainText(historyTimelineTime(null), { maxLength: 16 });
      const marker = Object.freeze({
        kind: 'reasoning' as const,
        time,
        content: sanitizeCardMarkdown('… 更早的历史过程因卡片长度限制未在飞书展示。', { maxLength: 100 }),
      });
      if (result.length >= maxEntries) {
        result.splice(result.length - 1, 1, marker);
      } else {
        result.push(marker);
      }
      break;
    }
    result.push(entry);
    characters += size;
  }
  return Object.freeze(result);
}

function historyToolGroup(items: readonly ThreadItem[]): CardToolGroup {
  const content = items.map((item) => {
    const command = historyToolCommand(item);
    const output = boundedHistoryOutput(item.aggregatedOutput);
    return output ? `- \`${command}\`\n\`\`\`text\n${output}\n\`\`\`` : `- \`${command}\``;
  }).join('\n');
  return Object.freeze({
    title: sanitizeCardPlainText(`🛠️ 工具执行 · ${items.length} 步`, { maxLength: 100 }),
    content: sanitizeCardMarkdown(content, { maxLength: 4_000 }),
    count: items.length,
    icon: 'api-app_outlined',
    completed: items.every((item) => item.status === 'completed' || item.exitCode === 0),
    failed: items.some((item) => (
      item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    )),
  });
}

function historyToolCommand(item: ThreadItem): string {
  if (typeof item.command === 'string' && item.command.trim()) {
    return item.command.trim();
  }
  const candidate = [item.toolName, item.tool, item.description, item.query, item.path]
    .find((value) => typeof value === 'string' && value.trim());
  return typeof candidate === 'string' ? candidate : item.type;
}

function boundedHistoryOutput(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  return text.length <= 1_000 ? text : text.slice(-1_000);
}

function visibleHistoryReasoning(item: ThreadItem): string {
  const text = item.type === 'reasoning' && Array.isArray(item.summary)
    ? item.summary.join('\n')
    : textFromItem(item);
  return removeHistoryInternalProgress(text);
}

function removeHistoryInternalProgress(value: string): string {
  const lines = value.split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !isDesktopInternalProgressLine(line));
  const text = lines.join('\n');
  return text
    .replace(desktopInternalProgressPattern(), '')
    .replace(/\*{2,}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isDesktopInternalProgressLine(value: string): boolean {
  const line = value.trim();
  if (!line || /[\u3400-\u9fff]/.test(line)) {
    return false;
  }
  const normalized = line.replace(/[`*_]/g, '').trim();
  if (!normalized) {
    return true;
  }
  return desktopInternalProgressPattern().test(normalized)
    || /^[a-z]+(?:[\s-]+[a-z0-9./]+){0,8}$/i.test(normalized);
}

function desktopInternalProgressPattern(): RegExp {
  return /(?:\*+\s*)?\b(?:preparing|planning|designing|implementing|finalizing|inspecting|assessing|fixing|analyzing|searching|reading|loading|validating|identifying|verifying|evaluating)\b[^\u3400-\u9fff\n]*/gi;
}

function historyTimelineTime(timestamp: number | null): string {
  const raw = timestamp ?? Date.now();
  const date = new Date(raw < 100_000_000_000 ? raw * 1_000 : raw);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function truncateOneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function firstCommand(text: string): string {
  return text.trim().split(/\s+/, 1)[0] ?? '';
}

async function pickerCard(
  entries: readonly { readonly choice: ThreadChoice; readonly token: string }[],
  table: boolean,
  currentBoundThreadId?: string,
  workspaceState: BindingWorkspaceState = emptyWorkspaceState(),
): Promise<CardKitJson> {
  const filteredEntries = entries.filter(({ choice }) => {
    if (currentBoundThreadId && choice.id === currentBoundThreadId) return true;
    if (workspaceState.projectlessThreadIds.includes(choice.id)) return true;
    return Boolean(choice.cwd && workspaceState.savedWorkspaces.some((workspace) => (
      pathWithinWorkspace(choice.cwd as string, workspace)
    )));
  });
  const sortedEntries = [...filteredEntries].sort((left, right) => {
    const leftGlobal = workspaceState.projectlessThreadIds.includes(left.choice.id);
    const rightGlobal = workspaceState.projectlessThreadIds.includes(right.choice.id);
    if (leftGlobal !== rightGlobal) return leftGlobal ? -1 : 1;
    if (leftGlobal) {
      return left.choice.title.localeCompare(right.choice.title, 'zh-CN', { numeric: true });
    }
    const projectOrder = projectName(left.choice, workspaceState)
      .localeCompare(projectName(right.choice, workspaceState), 'zh-CN', { numeric: true });
    return projectOrder !== 0
      ? projectOrder
      : left.choice.title.localeCompare(right.choice.title, 'zh-CN', { numeric: true });
  });
  const options = sortedEntries.map((entry, index) => ({
    text: {
      tag: 'plain_text',
      content: table ? tablePickerLabel(entry.choice, index) : pickerOptionLabel(entry.choice, workspaceState),
    },
    value: entry.token,
  }));
  const elements: Record<string, unknown>[] = [{
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: table
        ? '请查看下方的活跃会话列表，并在底部的下拉菜单中选择对应序号以绑定至当前聊天。'
        : '请从下方下拉菜单中选择一个 Codex 活跃会话绑定至当前聊天。选项已按本地项目分组：',
    },
  }];
  if (table) {
    elements.push({
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      header_style: { bold: true, text_align: 'left' },
      columns: [
        { name: 'col_name', display_name: '会话名称', data_type: 'text' },
        { name: 'col_project', display_name: '所属项目', data_type: 'text' },
      ],
      rows: sortedEntries.map((entry, index) => ({
        col_name: `[${index + 1}] ${entry.choice.title}`,
        col_project: workspaceState.projectlessThreadIds.includes(entry.choice.id)
          ? '🌐 全局会话'
          : projectName(entry.choice, workspaceState),
      })),
    });
  }
  elements.push({
    tag: 'select_static',
    element_id: 'bind_select_dropdown',
    placeholder: { tag: 'plain_text', content: table ? '选择要绑定的会话序号...' : '选择 Codex 会话...' },
    value: { action: 'binding' },
    options,
  });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'indigo',
      title: { tag: 'plain_text', content: table ? '📂 Codex 绑定会话 (Table 视图)' : '📂 Codex 绑定会话' },
    },
    body: { elements },
  };
}

function disabledPickerCard(card: CardKitJson, selectedToken: string): CardKitJson {
  const body = asRecord(card.body);
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  return {
    ...card,
    body: {
      ...body,
      elements: elements.map((candidate) => {
        const element = asRecord(candidate);
        if (element?.tag !== 'select_static') {
          return candidate;
        }
        const options = Array.isArray(element.options) ? element.options : [];
        const selectedOption = options.find((option) => asRecord(option)?.value === selectedToken);
        const selectedText = asRecord(asRecord(selectedOption)?.text)?.content;
        return {
          ...element,
          element_id: 'bind_select_locked',
          disabled: true,
          initial_option: typeof selectedText === 'string' ? selectedText : '',
          options: selectedOption ? [selectedOption] : options,
        };
      }),
    },
  };
}

function statusCard(binding: ChatThreadBinding | undefined, token: string | undefined): CardKitJson {
  if (!binding) {
    return baseCard('ChatGPT 会话绑定', 'orange', [{
      tag: 'markdown',
      content: '当前飞书会话尚未绑定 ChatGPT 会话。发送 `/bind` 进行选择。',
    }]);
  }
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: `当前已绑定会话：${shortId(binding.threadId)}\n工作区：${binding.workspaceId}`,
  }];
  if (token) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '在 ChatGPT 中打开此会话' },
      type: 'primary',
      value: { action: 'open', token },
    });
  }
  return baseCard('ChatGPT 会话绑定', 'green', elements);
}

function openResultCard(result: { readonly type: 'success' | 'warning' }): CardKitJson {
  return baseCard('ChatGPT 会话', result.type === 'success' ? 'green' : 'orange', [{
    tag: 'markdown',
    content: result.type === 'success'
      ? '已请求在 ChatGPT Desktop 中打开当前绑定会话。'
      : '当前未能打开 ChatGPT Desktop 会话；绑定未受影响，可稍后再次发送 `/open`。',
  }]);
}

function unboundCard(removed: boolean): CardKitJson {
  return baseCard('ChatGPT 会话绑定', 'orange', [{
    tag: 'markdown',
    content: removed ? '已解除当前飞书会话的 ChatGPT 绑定。' : '当前飞书会话没有可解除的绑定。',
  }]);
}

function baseCard(
  title: string,
  template: string,
  elements: readonly Record<string, unknown>[],
): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { elements },
  };
}

function parseChoices(value: unknown): readonly ThreadChoice[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.data)) {
    return [];
  }
  return record.data.slice(0, PICKER_LIMIT).flatMap((candidate) => {
    const item = asRecord(candidate);
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || id.length > 512) {
      return [];
    }
    return [{
      id,
      title: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '未命名会话',
      cwd: typeof item?.cwd === 'string' && item.cwd.trim() ? item.cwd : null,
      updatedAt: normalizeUpdatedAt(item?.updatedAt),
    }];
  });
}

function pickerOptionLabel(choice: ThreadChoice, state: BindingWorkspaceState): string {
  const global = state.projectlessThreadIds.includes(choice.id);
  const label = global
    ? `🌐 ${choice.title} (全局)`
    : projectName(choice, state)
      ? `💬 ${choice.title} (📁 ${projectName(choice, state)})`
      : `💬 ${choice.title}`;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

function tablePickerLabel(choice: ThreadChoice, index: number): string {
  const label = `#${index + 1} ➜ ${choice.title}`;
  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

export interface BindingWorkspaceState {
  readonly savedWorkspaces: readonly string[];
  readonly workspaceLabels: Readonly<Record<string, string>>;
  readonly projectlessThreadIds: readonly string[];
}

async function readWorkspaceState(): Promise<BindingWorkspaceState> {
  const statePath = join(homedir(), '.codex', '.codex-global-state.json');
  try {
    if (!(await stat(statePath)).isFile()) return emptyWorkspaceState();
    const state = asRecord(JSON.parse(await readFile(statePath, 'utf8')));
    return {
      savedWorkspaces: stringArray(state?.['electron-saved-workspace-roots'] ?? state?.['project-order']),
      workspaceLabels: stringRecord(state?.['electron-workspace-root-labels']),
      projectlessThreadIds: stringArray(state?.['projectless-thread-ids']),
    };
  } catch {
    return emptyWorkspaceState();
  }
}

function emptyWorkspaceState(): BindingWorkspaceState {
  return { savedWorkspaces: [], workspaceLabels: {}, projectlessThreadIds: [] };
}

function projectName(choice: ThreadChoice, state: BindingWorkspaceState): string {
  if (!choice.cwd) return '';
  const workspace = state.savedWorkspaces.find((candidate) => pathWithinWorkspace(choice.cwd as string, candidate));
  return workspace ? state.workspaceLabels[workspace] ?? basename(workspace) : basename(choice.cwd);
}

function pathWithinWorkspace(cwd: string, workspace: string): boolean {
  const normalizedCwd = normalize(cwd).toLowerCase();
  const normalizedWorkspace = normalize(workspace).toLowerCase();
  return normalizedCwd === normalizedWorkspace || normalizedCwd.startsWith(`${normalizedWorkspace}${sep}`);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string'
  )));
}

function normalizeUpdatedAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function createToken(
  threadId: string,
  revision: number,
  message: InboundTextMessage,
  secret: string,
  now: () => number,
): string {
  const payload = Buffer.from(JSON.stringify({
    threadId,
    revision,
    tenantKey: message.tenantKey,
    chatId: message.chatId,
    expiresAtMs: now() + TOKEN_TTL_MS,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(
  token: string,
  action: BindingActionV3,
  secret: string,
  now: () => number,
): { readonly threadId: string; readonly revision: number } | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!secureEquals(expected, signature)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      typeof parsed.threadId !== 'string'
      || typeof parsed.revision !== 'number'
      || typeof parsed.tenantKey !== 'string'
      || typeof parsed.chatId !== 'string'
      || typeof parsed.expiresAtMs !== 'number'
      || parsed.tenantKey !== action.tenantKey
      || parsed.chatId !== action.chatId
      || parsed.expiresAtMs < now()
    ) {
      return null;
    }
    return { threadId: parsed.threadId, revision: parsed.revision };
  } catch {
    return null;
  }
}

function secureEquals(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}
