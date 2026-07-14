import { randomUUID, timingSafeEqual } from 'node:crypto';

import { deriveTaskCancelToken } from './action-tokens';
import type { ChatThreadBinding } from './binding-store';
import { type CardKitJson, createTaskCard } from './cards/layouts';
import { sanitizeCardText } from './cards/sanitizer';
import type { DesktopIpcClient } from './codex/desktop-ipc-client';
import type {
  ServerNotification,
  Turn,
  TurnStartParams,
  TurnSteerParams,
} from './codex/protocol';
import type { BridgeConfig, TaskStatus } from './domain';
import type { InboundTextMessage } from './lark/intake';

export interface InMemoryCardClient {
  createCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
  replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
  closeStreaming(
    cardId: string,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
}

export interface InMemoryOrchestratorOptions {
  readonly now?: () => number;
  readonly onCardError?: (error: Error) => void;
  readonly readRateLimits?: () => Promise<unknown>;
}

export type InMemoryInboundOutcome = 'started' | 'queued' | 'steered' | 'duplicate';

export interface RuntimeApprovalContext {
  readonly taskId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
}

interface RuntimeTask {
  readonly id: string;
  readonly message: InboundTextMessage;
  readonly binding: ChatThreadBinding;
  readonly cardId: string;
  readonly cardMessageId: string;
  readonly cancelToken: string;
  turnId: string | null;
  status: TaskStatus;
  commentary: string;
  tools: string;
  finalAnswer: string;
  readonly startedAtMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  apiCalls: number | null;
  rateLimitText: string | null;
  cardSequence: number;
  completedAtMs: number | null;
  streamingClosed: boolean;
  cardWrite: Promise<void>;
  terminalCleanupTimer: NodeJS.Timeout | undefined;
  updateTimer: NodeJS.Timeout | undefined;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['SUCCEEDED', 'FAILED', 'INTERRUPTED']);
const DEDUPE_TTL_MS = 10 * 60_000;
const TERMINAL_CARD_RETENTION_MS = 5 * 60_000;
const TEXT_LIMIT = 128 * 1024;

/**
 * Current-process task state. It deliberately never serializes a task, queue,
 * card reference, prompt, output, approval, or RPC identity to disk.
 */
export class InMemoryOrchestrator {
  private readonly now: () => number;
  private readonly onCardError: (error: Error) => void;
  private readonly readRateLimits: (() => Promise<unknown>) | undefined;
  private readonly tasksById = new Map<string, RuntimeTask>();
  private readonly activeByThreadId = new Map<string, RuntimeTask>();
  private readonly terminalByTurnKey = new Map<string, RuntimeTask>();
  private readonly queuesByThreadId = new Map<string, Array<{
    readonly message: InboundTextMessage;
    readonly binding: ChatThreadBinding;
  }>>();
  private readonly pendingByThreadId = new Map<string, ServerNotification[]>();
  private readonly processedMessageKeys = new Map<string, number>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly desktop: DesktopIpcClient,
    private readonly cards: InMemoryCardClient,
    options: InMemoryOrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onCardError = options.onCardError ?? (() => undefined);
    this.readRateLimits = options.readRateLimits;
  }

  public async handleInbound(
    message: InboundTextMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    this.pruneDedupe();
    const dedupeKey = JSON.stringify([message.eventId, message.messageId]);
    if (this.processedMessageKeys.has(dedupeKey)) {
      return 'duplicate';
    }
    this.processedMessageKeys.set(dedupeKey, this.now());
    const active = this.activeByThreadId.get(binding.threadId);
    if (active?.turnId && !TERMINAL.has(active.status)) {
      await this.desktop.steerTurnTracked(buildSteer(active, message), () => undefined);
      return 'steered';
    }
    if (active) {
      return this.enqueue(message, binding);
    }
    return this.start(message, binding);
  }

  public handleNotification(notification: ServerNotification): void {
    const identity = eventIdentity(notification);
    if (!identity) {
      return;
    }
    const task = this.activeByThreadId.get(identity.threadId)
      ?? this.terminalByTurnKey.get(turnKey(identity.threadId, identity.turnId));
    if (!task) {
      return;
    }
    if (!task.turnId) {
      const pending = this.pendingByThreadId.get(identity.threadId) ?? [];
      if (pending.length < 64) {
        pending.push(notification);
        this.pendingByThreadId.set(identity.threadId, pending);
      }
      return;
    }
    if (task.turnId !== identity.turnId) {
      return;
    }
    if (TERMINAL.has(task.status) && notification.method !== 'thread/tokenUsage/updated') {
      return;
    }
    this.applyNotification(task, notification);
  }

  public async cancel(action: {
    readonly chatId: string;
    readonly messageId: string;
    readonly token: string;
  }): Promise<boolean> {
    const task = [...this.tasksById.values()].find((candidate) => (
      candidate.message.chatId === action.chatId
      && candidate.cardMessageId === action.messageId
      && secureTokenEquals(candidate.cancelToken, action.token)
      && !TERMINAL.has(candidate.status)
    ));
    if (!task) {
      return false;
    }
    if (task.turnId) {
      await this.desktop.interruptTurnTracked({
        threadId: task.binding.threadId,
        turnId: task.turnId,
      }, () => undefined);
    }
    task.status = 'INTERRUPTED';
    await this.flushCard(task, true);
    this.finish(task);
    return true;
  }

  /** Cancels the current task for an authorized chat command without a card token. */
  public async cancelCurrent(chatId: string, threadId: string): Promise<boolean> {
    const task = this.activeByThreadId.get(threadId);
    if (!task || task.message.chatId !== chatId || TERMINAL.has(task.status)) {
      return false;
    }
    if (task.turnId) {
      await this.desktop.interruptTurnTracked({ threadId, turnId: task.turnId }, () => undefined);
    }
    task.status = 'INTERRUPTED';
    await this.flushCard(task, true);
    this.finish(task);
    return true;
  }

  /** Returns the source conversation for a still-live, exact Desktop turn. */
  public approvalContext(threadId: string, turnId: string | null): RuntimeApprovalContext | undefined {
    const task = this.activeByThreadId.get(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return undefined;
    }
    return Object.freeze({
      taskId: task.id,
      chatId: task.message.chatId,
      rootMessageId: task.message.rootMessageId,
    });
  }

  /** Marks an exact live turn as waiting for an in-process approval response. */
  public setAwaitingApproval(threadId: string, turnId: string | null, waiting: boolean): boolean {
    const task = this.activeByThreadId.get(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return false;
    }
    task.status = waiting ? 'AWAITING_APPROVAL' : 'RUNNING';
    this.requestCardUpdate(task, true);
    return true;
  }

  /** Ends a task after an approval response has an unknown delivery result. */
  public failForApprovalDelivery(threadId: string, turnId: string | null): void {
    const task = this.activeByThreadId.get(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return;
    }
    task.status = 'FAILED';
    task.tools = '审批结果未能确认送达 Desktop，任务已停止跟踪。';
    void this.flushCard(task, true).finally(() => this.finish(task));
  }

  /** Ends all local state on Desktop loss; it never retries or replays a turn. */
  abandonAll(): void {
    for (const task of this.tasksById.values()) {
      if (task.updateTimer) {
        clearTimeout(task.updateTimer);
      }
      if (task.terminalCleanupTimer) {
        clearTimeout(task.terminalCleanupTimer);
      }
    }
    this.tasksById.clear();
    this.activeByThreadId.clear();
    this.terminalByTurnKey.clear();
    this.queuesByThreadId.clear();
    this.pendingByThreadId.clear();
    this.processedMessageKeys.clear();
  }

  private async start(
    message: InboundTextMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    const id = randomUUID();
    const startedAtMs = this.now();
    const initialCard = taskCard(message.text, 'CARD_CREATING', '', '', '', startedAtMs);
    const cardId = await this.cards.createCard(initialCard);
    const cardMessageId = await this.cards.replyCard(message.rootMessageId, cardId, `task:${id}`);
    const task: RuntimeTask = {
      id,
      message,
      binding,
      cardId,
      cardMessageId,
      cancelToken: deriveTaskCancelToken(this.config.larkAppSecret, id),
      turnId: null,
      status: 'STARTING',
      commentary: '',
      tools: '',
      finalAnswer: '',
      startedAtMs,
      model: null,
      inputTokens: null,
      outputTokens: null,
      contextTokens: null,
      contextWindow: null,
      apiCalls: null,
      rateLimitText: null,
      cardSequence: 0,
      completedAtMs: null,
      streamingClosed: false,
      cardWrite: Promise.resolve(),
      terminalCleanupTimer: undefined,
      updateTimer: undefined,
    };
    this.tasksById.set(id, task);
    this.activeByThreadId.set(binding.threadId, task);
    void this.refreshRateLimits(task);
    try {
      const turn = await this.desktop.startTurnTracked(buildStart(task, this.config), () => undefined);
      task.turnId = turn.id;
      task.status = 'RUNNING';
      this.replayPending(task);
      this.requestCardUpdate(task, true);
      return 'started';
    } catch {
      task.status = 'FAILED';
      task.tools = 'Desktop IPC 未能确认任务执行结果。';
      await this.flushCard(task, true);
      this.finish(task);
      return 'started';
    }
  }

  private enqueue(message: InboundTextMessage, binding: ChatThreadBinding): InMemoryInboundOutcome {
    const queue = this.queuesByThreadId.get(binding.threadId) ?? [];
    if (queue.length >= this.config.maxQueuedTasks) {
      return 'queued';
    }
    queue.push({ message, binding });
    this.queuesByThreadId.set(binding.threadId, queue);
    return 'queued';
  }

  private replayPending(task: RuntimeTask): void {
    const pending = this.pendingByThreadId.get(task.binding.threadId) ?? [];
    this.pendingByThreadId.delete(task.binding.threadId);
    for (const notification of pending) {
      const identity = eventIdentity(notification);
      if (identity?.turnId === task.turnId) {
        this.applyNotification(task, notification);
      }
    }
  }

  private applyNotification(task: RuntimeTask, notification: ServerNotification): void {
    const params = notification.params as Record<string, unknown>;
    if (notification.method === 'thread/tokenUsage/updated') {
      applyUsage(task, params);
    } else if (notification.method === 'item/started') {
      appendStartedCommand(task, params);
    } else if (notification.method === 'item/agentMessage/delta') {
      appendToTask(
        task,
        stringField(params.phase) === 'commentary' ? 'commentary' : 'finalAnswer',
        stringField(params.delta),
      );
    } else if (notification.method === 'item/reasoning/summaryTextDelta') {
      appendToTask(task, 'commentary', stringField(params.delta));
    } else if (notification.method === 'item/commandExecution/outputDelta') {
      appendToTask(task, 'tools', stringField(params.delta));
    } else if (notification.method === 'error') {
      appendToTask(task, 'tools', stringField((params.error as Record<string, unknown> | undefined)?.message));
    } else if (notification.method === 'turn/completed') {
      const turn = params.turn as Turn;
      task.status = terminalStatus(turn.status);
      task.finalAnswer = finalAnswerFromTurn(turn);
      task.completedAtMs = this.now();
      void this.refreshRateLimits(task);
      void this.flushCard(task, true).finally(() => this.finish(task));
      return;
    }
    this.requestCardUpdate(task, false);
  }

  private requestCardUpdate(task: RuntimeTask, immediate: boolean): void {
    if (task.updateTimer) {
      clearTimeout(task.updateTimer);
      task.updateTimer = undefined;
    }
    if (immediate) {
      void this.flushCard(task, TERMINAL.has(task.status));
      return;
    }
    task.updateTimer = setTimeout(() => {
      task.updateTimer = undefined;
      void this.flushCard(task, TERMINAL.has(task.status));
    }, this.config.cardUpdateIntervalMs);
    task.updateTimer.unref();
  }

  private async flushCard(task: RuntimeTask, terminal: boolean): Promise<void> {
    const write = task.cardWrite.then(
      () => this.writeCard(task, terminal),
      () => this.writeCard(task, terminal),
    );
    task.cardWrite = write;
    await write;
  }

  private async writeCard(task: RuntimeTask, terminal: boolean): Promise<void> {
    if (!this.tasksById.has(task.id)) {
      return;
    }
    try {
      const card = taskCard(
        task.message.text,
        task.status,
        task.commentary,
        task.tools,
        task.finalAnswer,
        task.startedAtMs,
        task,
        terminal ? undefined : task.cancelToken,
      );
      task.cardSequence = await this.cards.replaceCard(
        task.cardId,
        card,
        task.cardSequence,
        `task:${task.id}:${task.cardSequence + 1}`,
      );
      if (terminal && !task.streamingClosed) {
        task.cardSequence = await this.cards.closeStreaming(
          task.cardId,
          task.cardSequence,
          `task:${task.id}:close:${task.cardSequence + 1}`,
        );
        task.streamingClosed = true;
      }
    } catch (error) {
      this.onCardError(toError(error));
    }
  }

  private finish(task: RuntimeTask): void {
    if (!TERMINAL.has(task.status)) {
      return;
    }
    if (task.updateTimer) {
      clearTimeout(task.updateTimer);
    }
    if (this.activeByThreadId.get(task.binding.threadId) === task) {
      this.activeByThreadId.delete(task.binding.threadId);
    }
    if (task.turnId) {
      const key = turnKey(task.binding.threadId, task.turnId);
      this.terminalByTurnKey.set(key, task);
      task.terminalCleanupTimer = setTimeout(() => {
        this.terminalByTurnKey.delete(key);
        this.tasksById.delete(task.id);
      }, TERMINAL_CARD_RETENTION_MS);
      task.terminalCleanupTimer.unref();
    } else {
      this.tasksById.delete(task.id);
    }
    const next = this.queuesByThreadId.get(task.binding.threadId)?.shift();
    if (!next) {
      return;
    }
    void this.start(next.message, next.binding);
  }

  private async refreshRateLimits(task: RuntimeTask): Promise<void> {
    if (!this.readRateLimits) {
      return;
    }
    try {
      const text = formatRateLimits(await this.readRateLimits());
      if (!text || !this.tasksById.has(task.id)) {
        return;
      }
      task.rateLimitText = text;
      this.requestCardUpdate(task, true);
    } catch {
      // Usage display is optional; never affect the task execution path.
    }
  }

  private pruneDedupe(): void {
    const cutoff = this.now() - DEDUPE_TTL_MS;
    for (const [key, receivedAtMs] of this.processedMessageKeys) {
      if (receivedAtMs < cutoff) {
        this.processedMessageKeys.delete(key);
      }
    }
  }
}

function buildStart(task: RuntimeTask, config: BridgeConfig): TurnStartParams {
  return {
    threadId: task.binding.threadId,
    clientUserMessageId: task.message.messageId,
    input: [{ type: 'text', text: task.message.text, text_elements: [] }],
    cwd: task.binding.workspaceId,
    runtimeWorkspaceRoots: [...config.allowedWorkspaceRoots],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [...config.allowedWorkspaceRoots],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    ...(task.binding.model ? { model: task.binding.model } : {}),
  };
}

function buildSteer(task: RuntimeTask, message: InboundTextMessage): TurnSteerParams {
  return {
    threadId: task.binding.threadId,
    expectedTurnId: task.turnId as string,
    clientUserMessageId: message.messageId,
    input: [{ type: 'text', text: message.text, text_elements: [] }],
  };
}

function taskCard(
  prompt: string,
  status: TaskStatus,
  commentary: string,
  tools: string,
  finalAnswer: string,
  startedAtMs: number,
  usage?: RuntimeTask,
  cancelToken?: string,
): CardKitJson {
  const terminal = TERMINAL.has(status);
  return createTaskCard({
    status,
    cancelToken,
    payload: Object.freeze({
      title: sanitizeCardText('Codex 任务', { maxLength: 200 }),
      prompt: sanitizeCardText(prompt, { maxLength: 10_000 }),
      commentary: sanitizeCardText(commentary, { maxLength: 10_000 }),
      toolSummary: sanitizeCardText(tools || '暂无', { maxLength: 10_000 }),
      finalAnswer: sanitizeCardText(finalAnswer, { maxLength: 10_000 }),
      footer: sanitizeCardText(formatFooter(status, startedAtMs, usage), { maxLength: 500 }),
      terminal,
    }),
  });
}

function applyUsage(task: RuntimeTask, params: Record<string, unknown>): void {
  const usage = recordField(params.tokenUsage);
  const last = usage ? recordField(usage.last) : null;
  if (!usage || !last) {
    return;
  }
  task.model = stringField(params.model) ?? task.model;
  task.inputTokens = numberField(last.inputTokens) ?? task.inputTokens;
  task.outputTokens = numberField(last.outputTokens) ?? task.outputTokens;
  task.contextTokens = numberField(last.totalTokens) ?? task.contextTokens;
  task.contextWindow = numberField(usage.modelContextWindow) ?? task.contextWindow;
  task.apiCalls = firstNumber(
    params.apiCalls,
    usage.apiCalls,
    usage.requestCount,
    last.apiCalls,
    last.requestCount,
  ) ?? task.apiCalls;
}

function formatFooter(status: TaskStatus, startedAtMs: number, usage?: RuntimeTask): string {
  const state = status === 'SUCCEEDED' ? '✅ 已完成'
    : status === 'FAILED' ? '❌ 失败'
      : status === 'INTERRUPTED' ? '🛑 已取消' : '⏳ 运行中';
  const completedAtMs = usage?.completedAtMs ?? Date.now();
  const parts = [state, `耗时 ${formatDuration(completedAtMs - startedAtMs)}`];
  if (usage?.model) parts.push(usage.model);
  if (usage?.inputTokens !== null || usage?.outputTokens !== null) {
    parts.push(`↑ ${formatCount(usage?.inputTokens)} ↓ ${formatCount(usage?.outputTokens)}`);
  }
  if (usage?.contextTokens !== null && usage?.contextWindow) {
    const percent = Math.round((usage.contextTokens / usage.contextWindow) * 100);
    parts.push(`上下文 ${formatCount(usage.contextTokens)}/${formatCount(usage.contextWindow)} (${percent}%)`);
  }
  if (usage?.apiCalls !== null && usage?.apiCalls !== undefined) {
    parts.push(`API ${usage?.apiCalls}`);
  }
  return usage?.rateLimitText ? `${parts.join(' · ')}\n窗口用量: ${usage.rateLimitText}` : parts.join(' · ');
}

function formatRateLimits(response: unknown): string | null {
  const root = recordField(response);
  const byLimitId = root ? recordField(root.rateLimitsByLimitId) : null;
  const limits = (byLimitId ? recordField(byLimitId.codex) : null) ?? (root ? recordField(root.rateLimits) : null);
  if (!limits) {
    return null;
  }
  const entries = [
    formatRateLimit('5h', recordField(limits.primary)),
    formatRateLimit('7d', recordField(limits.secondary)),
  ].filter((entry): entry is string => Boolean(entry));
  const credits = recordField(limits.credits);
  if (credits?.hasCredits === true && (typeof credits.balance === 'string' || typeof credits.balance === 'number')) {
    entries.push(`点数: ${String(credits.balance)}`);
  }
  return entries.length > 0 ? entries.join(' | ') : null;
}

function formatRateLimit(label: string, limit: Record<string, unknown> | null): string | null {
  if (!limit) {
    return null;
  }
  const usedPercent = numberField(limit.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  const resetsAt = numberField(limit.resetsAt);
  const reset = resetsAt === null ? '' : ` (${formatResetTime(resetsAt)})`;
  return `${label}: ${usedPercent}%${reset}`;
}

function formatResetTime(timestamp: number): string {
  const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
  const date = new Date(milliseconds);
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatDuration(durationMs: number): string {
  return durationMs < 60_000 ? `${(durationMs / 1000).toFixed(1)}s`
    : `${Math.floor(durationMs / 60_000)}m${Math.floor((durationMs % 60_000) / 1000).toString().padStart(2, '0')}s`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}

function recordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = numberField(value);
    if (number !== null) {
      return number;
    }
  }
  return null;
}

function eventIdentity(notification: ServerNotification): { threadId: string; turnId: string } | null {
  const params = notification.params as Record<string, unknown>;
  const threadId = stringField(params.threadId);
  const turn = params.turn as Turn | undefined;
  const turnId = stringField(turn?.id) ?? stringField(params.turnId);
  return threadId && turnId ? { threadId, turnId } : null;
}

function appendToTask(
  task: RuntimeTask,
  field: 'commentary' | 'tools' | 'finalAnswer',
  delta: string | null,
): void {
  if (!delta) {
    return;
  }
  const next = task[field] + delta;
  task[field] = next.length > TEXT_LIMIT ? next.slice(-TEXT_LIMIT) : next;
}

function appendStartedCommand(task: RuntimeTask, params: Record<string, unknown>): void {
  const item = recordField(params.item);
  if (item?.type !== 'commandExecution' || typeof item.command !== 'string' || !item.command.trim()) {
    return;
  }
  const command = item.command.trim();
  if (task.tools.includes(command)) {
    return;
  }
  const next = task.tools
    ? `${task.tools}\n\n---\n🛠️ 运行命令: ${command}`
    : `🛠️ 运行命令: ${command}`;
  task.tools = next.length > TEXT_LIMIT ? next.slice(-TEXT_LIMIT) : next;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId.length}:${threadId}${turnId.length}:${turnId}`;
}

function finalAnswerFromTurn(turn: Turn): string {
  return turn.items
    .filter((item) => item.type === 'agentMessage' && item.phase === 'final_answer')
    .map((item) => item.text ?? '')
    .join('');
}

function terminalStatus(status: Turn['status']): TaskStatus {
  return status === 'completed' ? 'SUCCEEDED' : status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
}

function secureTokenEquals(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Card update failed');
}
