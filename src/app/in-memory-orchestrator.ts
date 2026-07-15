import { randomUUID, timingSafeEqual } from 'node:crypto';

import { deriveTaskCancelToken } from './action-tokens';
import type { ChatThreadBinding } from './binding-store';
import { CardKitError } from './cards/cardkit-client';
import { type CardKitJson, createTaskCard } from './cards/layouts';
import {
  sanitizeCardMarkdown,
  sanitizeCardPlainText,
  sanitizeCardText,
} from './cards/sanitizer';
import type { ThreadNavigation } from './codex/app-navigation-adapter';
import { DesktopIpcRequestError, type DesktopIpcClient } from './codex/desktop-ipc-client';
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
  sendCard(chatId: string, cardId: string, idempotencyKey: string): Promise<string>;
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
  readonly uploadOutputFiles?: (answer: string, rootMessageId: string, taskId: string) => Promise<void>;
  /** Activates the exact bound Desktop conversation after an owner lookup miss. */
  readonly navigation?: ThreadNavigation;
  /** Base delay used only while waiting for a newly opened Desktop owner. */
  readonly navigationRetryDelayMs?: number;
  /** Testable base backoff for transient CardKit update failures. */
  readonly cardRetryDelayMs?: number;
  /** Resolves one unambiguous Feishu chat for a Desktop-originated turn. */
  readonly resolveBindingByThreadId?: (threadId: string) => ChatThreadBinding | undefined;
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
  readonly toolExecutions: ToolExecution[];
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
  cancelRequested: boolean;
  cardWrite: Promise<void>;
  cardRetryCount: number;
  cardRetryTimer: NodeJS.Timeout | undefined;
  terminalCleanupTimer: NodeJS.Timeout | undefined;
  updateTimer: NodeJS.Timeout | undefined;
  outputFilesUploaded: boolean;
}

interface ToolExecution {
  readonly itemId: string;
  readonly command: string;
  completed: boolean;
  failed: boolean;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['SUCCEEDED', 'FAILED', 'INTERRUPTED']);
const DEDUPE_TTL_MS = 10 * 60_000;
const TERMINAL_CARD_RETENTION_MS = 5 * 60_000;
const TEXT_LIMIT = 128 * 1024;
const MAX_CARD_RETRY_ATTEMPTS = 3;
const CARD_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_NAVIGATION_RETRY_DELAY_MS = 500;
const MAX_DESKTOP_OWNER_RETRIES = 4;

/**
 * Current-process task state. It deliberately never serializes a task, queue,
 * card reference, prompt, output, approval, or RPC identity to disk.
 */
export class InMemoryOrchestrator {
  private readonly now: () => number;
  private readonly onCardError: (error: Error) => void;
  private readonly readRateLimits: (() => Promise<unknown>) | undefined;
  private readonly uploadOutputFiles: ((answer: string, rootMessageId: string, taskId: string) => Promise<void>) | undefined;
  private readonly navigation: ThreadNavigation | undefined;
  private readonly navigationRetryDelayMs: number;
  private readonly cardRetryDelayMs: number;
  private readonly resolveBindingByThreadId:
    | ((threadId: string) => ChatThreadBinding | undefined)
    | undefined;
  private readonly tasksById = new Map<string, RuntimeTask>();
  private readonly activeByThreadId = new Map<string, RuntimeTask>();
  private readonly terminalByTurnKey = new Map<string, RuntimeTask>();
  private readonly queuesByThreadId = new Map<string, Array<{
    readonly message: InboundTextMessage;
    readonly binding: ChatThreadBinding;
  }>>();
  private readonly pendingByThreadId = new Map<string, ServerNotification[]>();
  private readonly pendingDesktopByTurnKey = new Map<string, ServerNotification[]>();
  private readonly startingDesktopTurnKeys = new Set<string>();
  private readonly processedMessageKeys = new Map<string, number>();
  private readonly inboundLocks = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly config: BridgeConfig,
    private readonly desktop: DesktopIpcClient,
    private readonly cards: InMemoryCardClient,
    options: InMemoryOrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onCardError = options.onCardError ?? (() => undefined);
    this.readRateLimits = options.readRateLimits;
    this.uploadOutputFiles = options.uploadOutputFiles;
    this.navigation = options.navigation;
    this.resolveBindingByThreadId = options.resolveBindingByThreadId;
    this.navigationRetryDelayMs = positiveDelay(
      options.navigationRetryDelayMs ?? DEFAULT_NAVIGATION_RETRY_DELAY_MS,
      'navigationRetryDelayMs',
    );
    this.cardRetryDelayMs = options.cardRetryDelayMs ?? CARD_RETRY_BASE_DELAY_MS;
  }

  public async handleInbound(
    message: InboundTextMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    return this.runExclusive(binding.threadId, () => this.handleInboundLocked(message, binding));
  }

  private async handleInboundLocked(
    message: InboundTextMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    this.pruneDedupe();
    const dedupeKey = JSON.stringify([message.eventId, message.messageId]);
    if (this.processedMessageKeys.has(dedupeKey)) {
      return 'duplicate';
    }
    const active = this.activeByThreadId.get(binding.threadId);
    let outcome: InMemoryInboundOutcome;
    if (
      active?.turnId
      && !TERMINAL.has(active.status)
      && active.message.rootMessageId === message.rootMessageId
    ) {
      try {
        await this.desktop.steerTurnTracked(buildSteer(active, message), () => undefined);
      } catch (error) {
        active.tools = deliveryFailureText(error, '补充消息');
        this.requestCardUpdate(active, true);
      }
      outcome = 'steered';
    } else if (active) {
      outcome = this.enqueue(message, binding);
    } else {
      outcome = await this.start(message, binding);
    }
    this.processedMessageKeys.set(dedupeKey, this.now());
    return outcome;
  }

  public handleNotification(notification: ServerNotification): void {
    const identity = eventIdentity(notification);
    if (!identity) {
      return;
    }
    const task = this.activeByThreadId.get(identity.threadId)
      ?? this.terminalByTurnKey.get(turnKey(identity.threadId, identity.turnId));
    if (!task) {
      this.captureDesktopOriginNotification(notification, identity);
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
    readonly operatorOpenId: string;
    readonly token: string;
  }): Promise<boolean> {
    if (!this.config.authorizedUsers.includes(action.operatorOpenId)) {
      return false;
    }
    const task = [...this.tasksById.values()].find((candidate) => (
      candidate.message.chatId === action.chatId
      && candidate.cardMessageId === action.messageId
      && secureTokenEquals(candidate.cancelToken, action.token)
      && !TERMINAL.has(candidate.status)
    ));
    if (!task) {
      return false;
    }
    if (!task.turnId) {
      task.cancelRequested = true;
      task.status = 'INTERRUPTED';
      task.completedAtMs = this.now();
      await this.flushCard(task, true);
      return true;
    }
    if (task.turnId) {
      try {
        await this.desktop.interruptTurnTracked({
          threadId: task.binding.threadId,
          turnId: task.turnId,
        }, () => undefined);
      } catch (error) {
        return this.handleInterruptDeliveryFailure(task, error);
      }
    }
    task.status = 'INTERRUPTED';
    task.completedAtMs = this.now();
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
    if (!task.turnId) {
      task.cancelRequested = true;
      task.status = 'INTERRUPTED';
      task.completedAtMs = this.now();
      await this.flushCard(task, true);
      return true;
    }
    if (task.turnId) {
      try {
        await this.desktop.interruptTurnTracked({ threadId, turnId: task.turnId }, () => undefined);
      } catch (error) {
        return this.handleInterruptDeliveryFailure(task, error);
      }
    }
    task.status = 'INTERRUPTED';
    task.completedAtMs = this.now();
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
      if (task.cardRetryTimer) {
        clearTimeout(task.cardRetryTimer);
      }
    }
    this.tasksById.clear();
    this.activeByThreadId.clear();
    this.terminalByTurnKey.clear();
    this.queuesByThreadId.clear();
    this.pendingByThreadId.clear();
    this.pendingDesktopByTurnKey.clear();
    this.startingDesktopTurnKeys.clear();
    this.processedMessageKeys.clear();
    this.inboundLocks.clear();
  }

  private async start(
    message: InboundTextMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    const id = randomUUID();
    const startedAtMs = this.now();
    const initialCard = taskCard(
      message.text,
      'CARD_CREATING',
      '',
      [],
      '',
      '',
      startedAtMs,
      undefined,
      undefined,
      binding,
    );
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
      toolExecutions: [],
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
      cancelRequested: false,
      cardWrite: Promise.resolve(),
      cardRetryCount: 0,
      cardRetryTimer: undefined,
      terminalCleanupTimer: undefined,
      updateTimer: undefined,
      outputFilesUploaded: false,
    };
    this.tasksById.set(id, task);
    this.activeByThreadId.set(binding.threadId, task);
    void this.refreshRateLimits(task);
    try {
      const turn = await this.startTurnWithDesktopOwner(task);
      task.turnId = turn.id;
      if (task.cancelRequested) {
        await this.desktop.interruptTurnTracked({
          threadId: task.binding.threadId,
          turnId: task.turnId,
        }, () => undefined);
        task.status = 'INTERRUPTED';
        task.completedAtMs ??= this.now();
        await this.flushCard(task, true);
        this.finish(task);
        return 'started';
      }
      task.status = 'RUNNING';
      this.replayPending(task);
      this.requestCardUpdate(task, true);
      return 'started';
    } catch (error) {
      task.status = task.cancelRequested ? 'INTERRUPTED' : 'FAILED';
      task.completedAtMs ??= this.now();
      task.tools = task.cancelRequested
        ? deliveryFailureText(error, '取消请求')
        : deliveryFailureText(error, '任务启动');
      await this.flushCard(task, true);
      this.finish(task);
      return 'started';
    }
  }

  /**
   * Projects a user turn created in the bound Desktop conversation. This path
   * never sends a second Desktop RPC; it only mirrors the existing turn into
   * the uniquely bound Feishu chat.
   */
  private captureDesktopOriginNotification(
    notification: ServerNotification,
    identity: { readonly threadId: string; readonly turnId: string },
  ): void {
    const binding = this.resolveBindingByThreadId?.(identity.threadId);
    if (!binding) {
      return;
    }
    const key = turnKey(identity.threadId, identity.turnId);
    const pending = this.pendingDesktopByTurnKey.get(key) ?? [];
    if (pending.length < 64) {
      pending.push(notification);
      this.pendingDesktopByTurnKey.set(key, pending);
    }
    if (notification.method !== 'turn/started' || this.startingDesktopTurnKeys.has(key)) {
      return;
    }
    const turn = (notification.params as { readonly turn?: Turn }).turn;
    const prompt = turn ? desktopPrompt(turn) : null;
    if (!turn || !prompt) {
      return;
    }
    this.startingDesktopTurnKeys.add(key);
    void this.runExclusive(identity.threadId, async () => {
      if (this.activeByThreadId.has(identity.threadId)) {
        return;
      }
      await this.startDesktopProjection(binding, turn, prompt);
    }).catch((error: unknown) => this.onCardError(toError(error))).finally(() => {
      this.startingDesktopTurnKeys.delete(key);
      if (!this.activeByThreadId.has(identity.threadId)) {
        this.pendingDesktopByTurnKey.delete(key);
      }
    });
  }

  private async startDesktopProjection(
    binding: ChatThreadBinding,
    turn: Turn,
    prompt: string,
  ): Promise<void> {
    const id = randomUUID();
    const startedAtMs = this.now();
    const cardId = await this.cards.createCard(taskCard(
      prompt,
      'RUNNING',
      '',
      [],
      '',
      '',
      startedAtMs,
      undefined,
      undefined,
      binding,
    ));
    const cardMessageId = await this.cards.sendCard(binding.chatId, cardId, `desktop:${id}`);
    const task: RuntimeTask = {
      id,
      message: desktopMessage(binding, turn, prompt, cardMessageId, startedAtMs),
      binding,
      cardId,
      cardMessageId,
      cancelToken: deriveTaskCancelToken(this.config.larkAppSecret, id),
      turnId: turn.id,
      status: 'RUNNING',
      commentary: '',
      tools: '',
      toolExecutions: [],
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
      cancelRequested: false,
      cardWrite: Promise.resolve(),
      cardRetryCount: 0,
      cardRetryTimer: undefined,
      terminalCleanupTimer: undefined,
      updateTimer: undefined,
      outputFilesUploaded: false,
    };
    this.tasksById.set(id, task);
    this.activeByThreadId.set(binding.threadId, task);
    void this.refreshRateLimits(task);
    this.replayDesktopPending(task);
    if (!TERMINAL.has(task.status)) {
      this.requestCardUpdate(task, true);
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

  /**
   * A no-client-found response is the Desktop router's proof that no owner
   * received the request. It is therefore the sole delivery error that may be
   * retried after opening the exact bound conversation.
   */
  private async startTurnWithDesktopOwner(task: RuntimeTask): Promise<Turn> {
    const start = (): Promise<Turn> => this.desktop.startTurnTracked(
      buildStart(task, this.config),
      () => undefined,
    );
    try {
      return await start();
    } catch (error) {
      if (!isMissingDesktopOwner(error) || !this.navigation) {
        throw error;
      }
      await this.navigation.openThread(task.binding.threadId);
      for (let attempt = 0; attempt < MAX_DESKTOP_OWNER_RETRIES; attempt += 1) {
        await delay(this.navigationRetryDelayMs * 2 ** attempt);
        if (task.cancelRequested) {
          throw error;
        }
        try {
          return await start();
        } catch (retryError) {
          if (!isMissingDesktopOwner(retryError) || attempt === MAX_DESKTOP_OWNER_RETRIES - 1) {
            throw retryError;
          }
        }
      }
      throw error;
    }
  }

  private handleInterruptDeliveryFailure(task: RuntimeTask, error: unknown): boolean {
    task.tools = deliveryFailureText(error, '取消请求');
    if (error instanceof DesktopIpcRequestError && error.disposition === 'PROVABLY_UNSENT') {
      this.requestCardUpdate(task, true);
      return false;
    }
    task.status = 'FAILED';
    task.completedAtMs = this.now();
    void this.flushCard(task, true).finally(() => this.finish(task));
    return false;
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

  private replayDesktopPending(task: RuntimeTask): void {
    if (!task.turnId) {
      return;
    }
    const key = turnKey(task.binding.threadId, task.turnId);
    const pending = this.pendingDesktopByTurnKey.get(key) ?? [];
    this.pendingDesktopByTurnKey.delete(key);
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
    } else if (notification.method === 'item/completed') {
      completeCommand(task, params);
    } else if (notification.method === 'item/agentMessage/delta') {
      appendToTask(
        task,
        stringField(params.phase) === 'commentary' ? 'commentary' : 'finalAnswer',
        stringField(params.delta),
      );
    } else if (notification.method === 'item/reasoning/summaryTextDelta') {
      appendToTask(task, 'commentary', stringField(params.delta));
    } else if (notification.method === 'item/commandExecution/outputDelta') {
      // Command stdout/stderr may be arbitrarily large and often contains
      // workspace data. The card keeps only a compact invocation summary.
      return;
    } else if (notification.method === 'error') {
      appendToTask(task, 'tools', stringField((params.error as Record<string, unknown> | undefined)?.message));
    } else if (notification.method === 'turn/completed') {
      const turn = params.turn as Turn;
      task.status = terminalStatus(turn.status);
      task.finalAnswer = finalAnswerFromTurn(turn);
      task.completedAtMs = this.now();
      void this.refreshRateLimits(task);
      void this.uploadFilesForSuccessfulTask(task);
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
      if (terminal && !task.streamingClosed) {
        task.cardSequence = await this.cards.closeStreaming(
          task.cardId,
          task.cardSequence,
          `task:${task.id}:close:${task.cardSequence + 1}`,
        );
        task.streamingClosed = true;
      }
      const card = taskCard(
        task.message.text,
        task.status,
        task.commentary,
        task.toolExecutions,
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
      task.cardRetryCount = 0;
    } catch (error) {
      const cardError = toError(error);
      if (error instanceof CardKitError && error.retryable && task.cardRetryCount < MAX_CARD_RETRY_ATTEMPTS) {
        this.scheduleCardRetry(task);
        return;
      }
      this.onCardError(cardError);
    }
  }

  private scheduleCardRetry(task: RuntimeTask): void {
    if (task.cardRetryTimer || !this.tasksById.has(task.id)) {
      return;
    }
    task.cardRetryCount += 1;
    const delay = this.cardRetryDelayMs * 2 ** (task.cardRetryCount - 1);
    task.cardRetryTimer = setTimeout(() => {
      task.cardRetryTimer = undefined;
      void this.flushCard(task, TERMINAL.has(task.status));
    }, delay);
    task.cardRetryTimer.unref();
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
        if (task.cardRetryTimer) {
          clearTimeout(task.cardRetryTimer);
        }
        this.terminalByTurnKey.delete(key);
        this.tasksById.delete(task.id);
      }, TERMINAL_CARD_RETENTION_MS);
      task.terminalCleanupTimer.unref();
    } else {
      if (task.cardRetryTimer) {
        clearTimeout(task.cardRetryTimer);
      }
      this.tasksById.delete(task.id);
    }
    const next = this.queuesByThreadId.get(task.binding.threadId)?.shift();
    if (!next) {
      return;
    }
    void this.runExclusive(next.binding.threadId, () => this.start(next.message, next.binding))
      .catch((error: unknown) => this.onCardError(toError(error)));
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

  private async uploadFilesForSuccessfulTask(task: RuntimeTask): Promise<void> {
    if (task.status !== 'SUCCEEDED' || task.outputFilesUploaded || !this.uploadOutputFiles) {
      return;
    }
    task.outputFilesUploaded = true;
    try {
      await this.uploadOutputFiles(task.finalAnswer, task.message.rootMessageId, task.id);
    } catch {
      // File upload is opt-in convenience output; it never changes task status.
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

  private runExclusive<TResult>(threadId: string, operation: () => Promise<TResult>): Promise<TResult> {
    const previous = this.inboundLocks.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.inboundLocks.set(threadId, current);
    void current.then(
      () => this.clearInboundLock(threadId, current),
      () => this.clearInboundLock(threadId, current),
    );
    return current;
  }

  private clearInboundLock(threadId: string, current: Promise<unknown>): void {
    if (this.inboundLocks.get(threadId) === current) {
      this.inboundLocks.delete(threadId);
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
    ...(task.binding.plan ? { collaborationMode: task.binding.plan } : {}),
    ...(task.binding.personality && task.binding.personality !== 'none'
      ? { personality: task.binding.personality }
      : {}),
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
  toolExecutions: readonly ToolExecution[],
  toolError: string,
  finalAnswer: string,
  startedAtMs: number,
  usage?: RuntimeTask,
  cancelToken?: string,
  binding?: ChatThreadBinding,
): CardKitJson {
  const terminal = TERMINAL.has(status);
  const tools = toolProjection(toolExecutions, toolError);
  const metadata = usage
    ? taskMetadataForBinding(usage.binding)
    : binding
      ? taskMetadataForBinding(binding)
      : null;
  return createTaskCard({
    status,
    cancelToken,
    payload: Object.freeze({
      title: sanitizeCardText('Codex 任务', { maxLength: 200 }),
      prompt: sanitizeCardMarkdown(prompt, { maxLength: 10_000 }),
      metadata: metadata ? sanitizeCardMarkdown(metadata, { maxLength: 1_000 }) : null,
      commentary: sanitizeCardMarkdown(commentary, { maxLength: 10_000 }),
      toolSummary: sanitizeCardPlainText(tools.text || '暂无', { maxLength: 10_000 }),
      toolCount: tools.count,
      finalAnswer: sanitizeCardMarkdown(finalAnswer, { maxLength: 10_000 }),
      footer: sanitizeCardPlainText(formatFooter(status, startedAtMs, usage), { maxLength: 500 }),
      terminal,
    }),
  });
}

function toolProjection(
  executions: readonly ToolExecution[],
  error: string,
): { readonly text: string; readonly count: number } {
  const lines = executions.map((execution, index) => {
    const state = execution.completed ? (execution.failed ? '❌' : '✅') : '⏳';
    return `${state} ${index + 1}. ${summarizeCommand(execution.command)}`;
  });
  if (error.trim()) {
    lines.push(`⚠️ ${oneLine(error, 500)}`);
  }
  return { text: lines.join('\n'), count: executions.length };
}

function summarizeCommand(command: string): string {
  return oneLine(command, 240);
}

function oneLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function taskMetadataForBinding(binding: ChatThreadBinding): string {
  const metadata: string[] = [];
  if (binding.plan === 'plan') {
    metadata.push('📝 **计划模式**: `开启`');
  }
  if (binding.personality && binding.personality !== 'none') {
    metadata.push(`🎭 **回复风格**: \`${binding.personality}\``);
  }
  if (binding.model) {
    metadata.push(`🤖 **模型**: \`${binding.model}\``);
  }
  return metadata.join(' ｜ ');
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
  task.contextTokens = numberField(last.totalTokens)
    ?? numberField(recordField(usage.total)?.totalTokens)
    ?? task.contextTokens;
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
  if (usage && (usage.inputTokens !== null || usage.outputTokens !== null)) {
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
  const entries = [formatRateLimit('7d', weeklyRateLimit(limits))]
    .filter((entry): entry is string => Boolean(entry));
  const credits = recordField(limits.credits);
  if (credits?.hasCredits === true && (typeof credits.balance === 'string' || typeof credits.balance === 'number')) {
    entries.push(`点数: ${String(credits.balance)}`);
  }
  return entries.length > 0 ? entries.join(' | ') : null;
}

/**
 * Desktop used to expose 5h as `primary` and 7d as `secondary`. With the 5h
 * window removed, the remaining weekly window is returned as `primary`.
 * Prefer the explicit duration, then preserve the prior `secondary` fallback.
 */
function weeklyRateLimit(limits: Record<string, unknown>): Record<string, unknown> | null {
  const primary = recordField(limits.primary);
  const secondary = recordField(limits.secondary);
  const candidates = [primary, secondary].filter((limit): limit is Record<string, unknown> => limit !== null);
  const weekly = candidates.find((limit) => {
    const durationMins = numberField(limit.windowDurationMins);
    return durationMins !== null && durationMins >= 6 * 24 * 60;
  });
  return weekly ?? secondary ?? primary;
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

function isMissingDesktopOwner(error: unknown): boolean {
  return error instanceof DesktopIpcRequestError && error.remoteError === 'no-client-found';
}

function positiveDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const itemId = stringField(item?.id) ?? stringField(params.itemId);
  if (
    item?.type !== 'commandExecution'
    || !itemId
    || typeof item.command !== 'string'
    || !item.command.trim()
  ) {
    return;
  }
  if (task.toolExecutions.some((execution) => execution.itemId === itemId)) {
    return;
  }
  task.toolExecutions.push({
    itemId,
    command: item.command.trim(),
    completed: false,
    failed: false,
  });
}

function completeCommand(task: RuntimeTask, params: Record<string, unknown>): void {
  const item = recordField(params.item);
  if (item?.type !== 'commandExecution') {
    return;
  }
  const itemId = stringField(item.id) ?? stringField(params.itemId);
  if (!itemId) {
    return;
  }
  const execution = task.toolExecutions.find((entry) => entry.itemId === itemId);
  if (!execution) {
    return;
  }
  execution.completed = true;
  execution.failed = numberField(item.exitCode) !== null && numberField(item.exitCode) !== 0;
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

function desktopPrompt(turn: Turn): string | null {
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
    if (item.text?.trim()) {
      return item.text.trim();
    }
    if (!Array.isArray(item.content)) {
      continue;
    }
    const prompt = item.content.map((content) => (
      typeof content === 'string' ? content : content.text
    )).join('\n').trim();
    if (prompt) {
      return prompt;
    }
  }
  return null;
}

function desktopMessage(
  binding: ChatThreadBinding,
  turn: Turn,
  prompt: string,
  cardMessageId: string,
  createdAtMs: number,
): InboundTextMessage {
  return {
    tenantKey: binding.tenantKey,
    eventId: `desktop:${binding.threadId}:${turn.id}`,
    messageId: cardMessageId,
    chatId: binding.chatId,
    rootMessageId: cardMessageId,
    senderOpenId: 'desktop',
    text: prompt,
    payloadDigest: turn.id,
    createdAtMs,
  };
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

function deliveryFailureText(error: unknown, operation: string): string {
  if (!(error instanceof DesktopIpcRequestError)) {
    return `${operation}失败；Desktop IPC 发生本地错误，Bridge 不会自动重试。`;
  }
  if (error.disposition === 'PROVABLY_UNSENT') {
    return `${operation}未发送到 ChatGPT Desktop（${error.code}）；请在连接恢复后重新发送。`;
  }
  if (error.disposition === 'DEFINITIVE_FAILURE') {
    return `${operation}被 ChatGPT Desktop 明确拒绝（${error.code}）；Bridge 不会重试。`;
  }
  return `${operation}的 Desktop 送达结果无法确认（${error.code}）；为避免重复执行，Bridge 不会自动重试。`;
}
