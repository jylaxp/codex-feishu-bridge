import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { deriveTaskCancelToken } from './action-tokens';
import type { ChatThreadBinding } from './binding-store';
import { CardKitError } from './cards/cardkit-client';
import { type CardKitJson, createTaskCard } from './cards/layouts';
import {
  sanitizeCardMarkdown,
  sanitizeCardPlainText,
  sanitizeCardText,
} from './cards/sanitizer';
import { DesktopIpcRequestError, type DesktopIpcClient } from './codex/desktop-ipc-client';
import type {
  ServerNotification,
  Turn,
  TurnStartParams,
  TurnSteerParams,
  UserInput,
} from './codex/protocol';
import type {
  BridgeConfig,
  CardTimelineEntry,
  CardToolGroup,
  TaskStatus,
} from './domain';
import { MAX_INBOUND_IMAGES, type InboundMessage } from './lark/intake';
import type { RuntimeTaskHealth } from './runtime-health';
import { ThreadTaskScheduler } from './task-scheduler';

/** Desktop-owned execution capabilities; App Server clients cannot satisfy this boundary. */
export type DesktopTurnClient = Pick<
  DesktopIpcClient,
  'startTurnTracked' | 'steerTurnTracked' | 'interruptTurnTracked'
>;

export interface InMemoryCardClient {
  renderCard(card: CardKitJson): Promise<CardKitJson>;
  createCard(card: CardKitJson): Promise<string>;
  createRenderedCard(card: CardKitJson): Promise<string>;
  replyCard(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<string>;
  sendCard(chatId: string, cardId: string, idempotencyKey: string): Promise<string>;
  replaceCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
  replaceRenderedCard(
    cardId: string,
    card: CardKitJson,
    acknowledgedSequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
  streamElement(
    cardId: string,
    elementId: string,
    content: string,
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
  /** Testable base backoff for transient CardKit update failures. */
  readonly cardRetryDelayMs?: number;
  /** Resolves one unambiguous Feishu chat for a Desktop-originated turn. */
  readonly resolveBindingByThreadId?: (threadId: string) => ChatThreadBinding | undefined;
  /** Reads the App Server skill catalog for the original inline @skill interaction. */
  readonly readSkills?: (cwd: string) => Promise<unknown>;
  /** Reads a ChatGPT thread title for existing bindings that predate stored titles. */
  readonly readThreadTitle?: (threadId: string) => Promise<string | null>;
  /** Reconciles Desktop state subscriptions when the live task set changes. */
  readonly onActiveThreadsChanged?: () => void;
  /** Publishes content-free task counters when queue or delivery state changes. */
  readonly onRuntimeHealthChanged?: () => void;
  /** Reports content-free Desktop delivery outcomes for logs and runtime health. */
  readonly onDesktopDeliveryOutcome?: (outcome: DesktopDeliveryOutcome) => void;
  /** Releases process-owned image files after Codex no longer needs them. */
  readonly releaseInboundImages?: (paths: readonly string[]) => void;
}

export type DesktopDeliveryOperation = 'start' | 'steer' | 'interrupt';

interface DesktopDeliveryOutcomeBase {
  readonly operation: DesktopDeliveryOperation;
  readonly threadId: string;
  readonly chatId: string;
  readonly messageId: string;
}

export type DesktopDeliveryOutcome =
  | DesktopDeliveryOutcomeBase & { readonly status: 'succeeded' }
  | DesktopDeliveryOutcomeBase & { readonly status: 'failed'; readonly error: unknown };

export type InMemoryInboundOutcome =
  | 'started'
  | 'queued'
  | 'steered'
  | 'duplicate'
  | 'abandoned'
  | 'rejected_image_limit'
  | 'rejected_queue_full';

export interface RuntimeApprovalContext {
  readonly taskId: string;
  readonly chatId: string;
  readonly rootMessageId: string;
  readonly workspaceId?: string;
}

interface RuntimeTask {
  readonly id: string;
  readonly message: InboundMessage;
  readonly binding: ChatThreadBinding;
  cardId: string;
  cardMessageId: string;
  readonly cancelToken: string;
  turnId: string | null;
  status: TaskStatus;
  commentary: string;
  lastProcessItemId: string | null;
  readonly processItemTextById: Map<string, string>;
  tools: string;
  readonly toolExecutions: ToolExecution[];
  readonly timeline: TimelineEntry[];
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
  cardDeliveryPending: boolean;
  nextToolGroupId: number;
  lastActivityKind: 'none' | 'text' | 'tool';
  cardPageNumber: number;
  readonly deliveredReasoningByItemId: Map<string, string>;
  readonly deliveredToolItemIds: Set<string>;
  readonly deliveredToolFallbackByKey: Map<string, string>;
  answerOffset: number;
  deliveredAnswerPrefix: string;
  answerRevision: boolean;
  pendingCardId: string | null;
  readonly pendingFreezes: PendingCardFreeze[];
  readonly staleCardMessageIds: Set<string>;
  readonly localImagePaths: Set<string>;
}

interface PendingCardFreeze {
  readonly cardId: string;
  readonly cardMessageId: string;
  readonly card: CardKitJson;
  readonly pageNumber: number;
  sequence: number;
  streamingClosed: boolean;
  retryCount: number;
}

interface ToolExecution {
  readonly itemId: string;
  readonly groupId: number;
  readonly command: string;
  readonly category: ActionCategory;
  readonly name: string;
  readonly actionCount: number;
  outputTail: string;
  completed: boolean;
  failed: boolean;
  revised: boolean;
}

interface TimelineEntry {
  readonly kind: 'reasoning' | 'tool';
  readonly itemId: string;
  readonly occurredAtMs: number;
  text?: string;
  execution?: ToolExecution;
}

interface TaskCardPage {
  readonly timeline: readonly CardTimelineEntry[];
  readonly timelineConsumption: readonly TimelineConsumption[];
  readonly finalAnswer: string;
  readonly kind: 'timeline' | 'answer' | 'mixed';
  readonly showPrompt: boolean;
  readonly answerRevision: boolean;
}

interface TimelineConsumption {
  readonly kind: 'reasoning' | 'tool';
  readonly itemId?: string;
  readonly text?: string;
  readonly itemIds?: readonly string[];
  readonly toolKey?: string;
}

interface ProjectedTimelineEntry {
  readonly card: CardTimelineEntry;
  readonly consumption: TimelineConsumption;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['SUCCEEDED', 'FAILED', 'INTERRUPTED']);
const DEDUPE_TTL_MS = 10 * 60_000;
const TERMINAL_CARD_RETENTION_MS = 5 * 60_000;
const PENDING_TERMINAL_CARD_RETENTION_MS = 30 * 60_000;
const TEXT_LIMIT = 128 * 1024;
const MAX_CARD_RETRY_ATTEMPTS = 3;
const CARD_RETRY_BASE_DELAY_MS = 250;
const MAX_PENDING_NOTIFICATIONS = 512;
const MAX_TOOL_OUTPUT_CHARS = 1_000;
const MAX_TIMELINE_CARD_ENTRIES = 36;
// CardKit create and full-update calls were probed against Feishu on 2026-07-22.
// Both accepted 304,089 UTF-8 bytes of rendered card JSON and rejected 304,090
// with API code 200860. Keep a small margin for server-side representation drift.
const MAX_CARD_JSON_BYTES = 300_000;
const MAX_TIMELINE_REASONING_BYTES = 6 * 1024;

/**
 * Current-process task state. It deliberately never serializes a task, queue,
 * card reference, prompt, output, approval, or RPC identity to disk.
 */
export class InMemoryOrchestrator {
  private readonly now: () => number;
  private readonly onCardError: (error: Error) => void;
  private readonly readRateLimits: (() => Promise<unknown>) | undefined;
  private readonly uploadOutputFiles: ((answer: string, rootMessageId: string, taskId: string) => Promise<void>) | undefined;
  private readonly cardRetryDelayMs: number;
  private readonly resolveBindingByThreadId:
    | ((threadId: string) => ChatThreadBinding | undefined)
    | undefined;
  private readonly readSkills: ((cwd: string) => Promise<unknown>) | undefined;
  private readonly readThreadTitle: ((threadId: string) => Promise<string | null>) | undefined;
  private readonly onActiveThreadsChanged: () => void;
  private readonly onRuntimeHealthChanged: () => void;
  private readonly onDesktopDeliveryOutcome: (outcome: DesktopDeliveryOutcome) => void;
  private readonly releaseInboundImages: (paths: readonly string[]) => void;
  private readonly tasksById = new Map<string, RuntimeTask>();
  private readonly scheduler = new ThreadTaskScheduler<RuntimeTask, {
    readonly message: InboundMessage;
    readonly binding: ChatThreadBinding;
  }>();
  private readonly terminalByTurnKey = new Map<string, RuntimeTask>();
  private readonly pendingByThreadId = new Map<string, ServerNotification[]>();
  private readonly pendingDesktopByTurnKey = new Map<string, ServerNotification[]>();
  private readonly startingDesktopTurnKeys = new Set<string>();
  private readonly processedMessageKeys = new Map<string, number>();
  private readonly inboundLocks = new Map<string, Promise<unknown>>();
  private runtimeGeneration = 0;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly desktop: DesktopTurnClient,
    private readonly cards: InMemoryCardClient,
    options: InMemoryOrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.onCardError = options.onCardError ?? (() => undefined);
    this.readRateLimits = options.readRateLimits;
    this.uploadOutputFiles = options.uploadOutputFiles;
    this.resolveBindingByThreadId = options.resolveBindingByThreadId;
    this.readSkills = options.readSkills;
    this.readThreadTitle = options.readThreadTitle;
    this.onActiveThreadsChanged = options.onActiveThreadsChanged ?? (() => undefined);
    this.onRuntimeHealthChanged = options.onRuntimeHealthChanged ?? (() => undefined);
    this.onDesktopDeliveryOutcome = options.onDesktopDeliveryOutcome ?? (() => undefined);
    this.releaseInboundImages = options.releaseInboundImages ?? (() => undefined);
    this.cardRetryDelayMs = options.cardRetryDelayMs ?? CARD_RETRY_BASE_DELAY_MS;
  }

  /** Returns the threads whose live cards still depend on Desktop state events. */
  public activeThreadIds(): readonly string[] {
    return this.scheduler.activeThreadIds();
  }

  /** Returns content-free counters for runtime health reporting. */
  public runtimeTaskHealth(): RuntimeTaskHealth {
    let pendingCardDeliveries = 0;
    for (const task of this.tasksById.values()) {
      if (task.cardDeliveryPending) {
        pendingCardDeliveries += 1;
      }
    }
    return Object.freeze({
      active: this.scheduler.activeCount,
      queued: this.scheduler.queuedCount,
      pendingCardDeliveries,
    });
  }

  /** Replays only undelivered card projections after Lark reconnects; never replays a Codex turn. */
  public resumeCardDelivery(): void {
    for (const task of this.tasksById.values()) {
      if (!task.cardDeliveryPending) {
        continue;
      }
      if (task.cardRetryTimer) {
        clearTimeout(task.cardRetryTimer);
        task.cardRetryTimer = undefined;
      }
      task.cardRetryCount = 0;
      void this.flushCard(task, TERMINAL.has(task.status));
    }
    this.onRuntimeHealthChanged();
  }

  public async handleInbound(
    message: InboundMessage,
    binding: ChatThreadBinding,
  ): Promise<InMemoryInboundOutcome> {
    const generation = this.runtimeGeneration;
    return this.runExclusive(binding.threadId, async () => {
      if (generation !== this.runtimeGeneration) {
        this.releaseMessageImages(message);
        return 'abandoned';
      }
      return this.handleInboundLocked(message, binding, generation);
    });
  }

  private async handleInboundLocked(
    message: InboundMessage,
    binding: ChatThreadBinding,
    generation: number,
  ): Promise<InMemoryInboundOutcome> {
    this.pruneDedupe();
    const dedupeKey = JSON.stringify([message.eventId, message.messageId]);
    if (this.processedMessageKeys.has(dedupeKey)) {
      this.releaseMessageImages(message);
      return 'duplicate';
    }
    ({ message, binding } = await this.resolveInlineSkill(message, binding));
    if (generation !== this.runtimeGeneration) {
      this.releaseMessageImages(message);
      return 'abandoned';
    }
    const active = this.scheduler.active(binding.threadId);
    let outcome: InMemoryInboundOutcome;
    if (
      active?.turnId
      && !TERMINAL.has(active.status)
      && active.message.rootMessageId === message.rootMessageId
    ) {
      const addedImagePaths = this.addSteerImagePaths(active, message);
      if (active.localImagePaths.size > MAX_INBOUND_IMAGES) {
        this.releaseSteerImagePaths(active, addedImagePaths);
        outcome = 'rejected_image_limit';
      } else {
        try {
          await this.desktop.steerTurnTracked(buildSteer(active, message, binding), () => undefined);
          this.reportDesktopDelivery('steer', 'succeeded', active, message.messageId);
        } catch (error) {
          this.reportDesktopDelivery('steer', 'failed', active, message.messageId, error);
          if (deliveryWasConfirmedNotUsed(error)) {
            this.releaseSteerImagePaths(active, addedImagePaths);
          }
          active.tools = deliveryFailureText(error, '补充消息');
          this.requestCardUpdate(active, true);
        }
        outcome = 'steered';
      }
    } else if (active) {
      outcome = this.enqueue(message, binding);
    } else {
      outcome = await this.start(message, binding, generation);
    }
    if (outcome !== 'rejected_queue_full' && outcome !== 'rejected_image_limit') {
      this.processedMessageKeys.set(dedupeKey, this.now());
    }
    this.onRuntimeHealthChanged();
    return outcome;
  }

  private async resolveInlineSkill(
    message: InboundMessage,
    binding: ChatThreadBinding,
  ): Promise<{ readonly message: InboundMessage; readonly binding: ChatThreadBinding }> {
    if (binding.activeSkill || !message.text.includes('@') || !this.readSkills) {
      return { message, binding };
    }
    try {
      const catalog = await this.readSkills(binding.workspaceId);
      const match = matchInlineSkill(message.text, catalog);
      if (!match) {
        return { message, binding };
      }
      return {
        message: { ...message, text: match.cleanText },
        binding: {
          ...binding,
          activeSkill: match.name,
          activeSkillPath: match.path,
        },
      };
    } catch {
      return { message, binding };
    }
  }

  public handleNotification(notification: ServerNotification): void {
    const identity = eventIdentity(notification);
    if (!identity) {
      return;
    }
    const task = this.scheduler.active(identity.threadId)
      ?? this.terminalByTurnKey.get(turnKey(identity.threadId, identity.turnId));
    if (!task) {
      this.captureDesktopOriginNotification(notification, identity);
      return;
    }
    if (!task.turnId) {
      const pending = this.pendingByThreadId.get(identity.threadId) ?? [];
      appendPendingNotification(pending, notification);
      this.pendingByThreadId.set(identity.threadId, pending);
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
      && (
        candidate.cardMessageId === action.messageId
        || candidate.pendingFreezes.some((pending) => pending.cardMessageId === action.messageId)
        || candidate.staleCardMessageIds.has(action.messageId)
      )
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
        this.reportDesktopDelivery('interrupt', 'succeeded', task, task.message.messageId);
      } catch (error) {
        this.reportDesktopDelivery('interrupt', 'failed', task, task.message.messageId, error);
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
    const task = this.scheduler.active(threadId);
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
        this.reportDesktopDelivery('interrupt', 'succeeded', task, task.message.messageId);
      } catch (error) {
        this.reportDesktopDelivery('interrupt', 'failed', task, task.message.messageId, error);
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
    const task = this.scheduler.active(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return undefined;
    }
    return Object.freeze({
      taskId: task.id,
      chatId: task.message.chatId,
      rootMessageId: task.message.rootMessageId,
      workspaceId: task.binding.workspaceId,
    });
  }

  /** Marks an exact live turn as waiting for an in-process approval response. */
  public setAwaitingApproval(threadId: string, turnId: string | null, waiting: boolean): boolean {
    const task = this.scheduler.active(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return false;
    }
    task.status = waiting ? 'AWAITING_APPROVAL' : 'RUNNING';
    this.requestCardUpdate(task, true);
    return true;
  }

  /** Ends a task after an approval response has an unknown delivery result. */
  public failForApprovalDelivery(threadId: string, turnId: string | null): void {
    const task = this.scheduler.active(threadId);
    if (!task || TERMINAL.has(task.status) || (turnId && task.turnId !== turnId)) {
      return;
    }
    task.status = 'FAILED';
    task.tools = '审批结果未能确认送达 Desktop，任务已停止跟踪。';
    void this.flushCard(task, true).finally(() => this.finish(task));
  }

  /** Ends all local state on Desktop loss; it never retries or replays a turn. */
  abandonAll(): void {
    this.runtimeGeneration += 1;
    const queued = this.scheduler.drainQueued();
    for (const item of queued) {
      this.releaseMessageImages(item.message);
    }
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
      this.releaseTaskImages(task);
    }
    this.tasksById.clear();
    const hadActiveThreads = this.scheduler.clear();
    if (hadActiveThreads) {
      this.onActiveThreadsChanged();
    }
    this.terminalByTurnKey.clear();
    this.pendingByThreadId.clear();
    this.pendingDesktopByTurnKey.clear();
    this.onRuntimeHealthChanged();
    this.startingDesktopTurnKeys.clear();
    this.processedMessageKeys.clear();
    this.inboundLocks.clear();
  }

  private async bindingWithTitle(binding: ChatThreadBinding): Promise<ChatThreadBinding> {
    if (binding.threadTitle?.trim() || !this.readThreadTitle) {
      return binding;
    }
    try {
      const title = (await this.readThreadTitle(binding.threadId))?.trim();
      return title ? { ...binding, threadTitle: title } : binding;
    } catch (error) {
      this.onCardError(toError(error));
      return binding;
    }
  }

  private async start(
    message: InboundMessage,
    binding: ChatThreadBinding,
    generation: number = this.runtimeGeneration,
  ): Promise<InMemoryInboundOutcome> {
    const taskBinding = await this.bindingWithTitle(binding);
    if (generation !== this.runtimeGeneration) {
      this.releaseMessageImages(message);
      return 'abandoned';
    }
    const id = randomUUID();
    const startedAtMs = this.now();
    const initialCard = taskCard(
      displayTaskPrompt(message),
      'CARD_CREATING',
      '',
      [],
      '',
      '',
      startedAtMs,
      undefined,
      undefined,
      taskBinding,
    );
    const cardId = await this.cards.createCard(initialCard);
    if (generation !== this.runtimeGeneration) {
      this.releaseMessageImages(message);
      return 'abandoned';
    }
    const cardMessageId = await this.cards.sendCard(message.chatId, cardId, `task:${id}`);
    if (generation !== this.runtimeGeneration) {
      this.releaseMessageImages(message);
      return 'abandoned';
    }
    const task: RuntimeTask = {
      id,
      message,
      binding: taskBinding,
      cardId,
      cardMessageId,
      cancelToken: deriveTaskCancelToken(this.config.larkAppSecret, id),
      turnId: null,
      status: 'STARTING',
      commentary: '',
      lastProcessItemId: null,
      processItemTextById: new Map(),
      tools: '',
      toolExecutions: [],
      timeline: [],
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
      cardDeliveryPending: false,
      nextToolGroupId: 0,
      lastActivityKind: 'none',
      cardPageNumber: 1,
      deliveredReasoningByItemId: new Map(),
      deliveredToolItemIds: new Set(),
      deliveredToolFallbackByKey: new Map(),
      answerOffset: 0,
      deliveredAnswerPrefix: '',
      answerRevision: false,
      pendingCardId: null,
      pendingFreezes: [],
      staleCardMessageIds: new Set(),
      localImagePaths: new Set(message.localImagePaths ?? []),
    };
    this.tasksById.set(id, task);
    this.activateTask(task);
    void this.refreshRateLimits(task);
    let turn: Turn;
    try {
      turn = await this.desktop.startTurnTracked(buildStart(task), () => undefined);
    } catch (error) {
      this.reportDesktopDelivery('start', 'failed', task, task.message.messageId, error);
      task.status = task.cancelRequested ? 'INTERRUPTED' : 'FAILED';
      task.completedAtMs ??= this.now();
      task.tools = task.cancelRequested
        ? deliveryFailureText(error, '取消请求')
        : deliveryFailureText(error, '任务启动');
      await this.flushCard(task, true);
      this.finish(task);
      return 'started';
    }

    this.reportDesktopDelivery('start', 'succeeded', task, task.message.messageId);
    task.turnId = turn.id;
    if (task.cancelRequested) {
      try {
        await this.desktop.interruptTurnTracked({
          threadId: task.binding.threadId,
          turnId: task.turnId,
        }, () => undefined);
        this.reportDesktopDelivery('interrupt', 'succeeded', task, task.message.messageId);
      } catch (error) {
        this.reportDesktopDelivery('interrupt', 'failed', task, task.message.messageId, error);
        task.tools = deliveryFailureText(error, '取消请求');
      }
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
  }

  private reportDesktopDelivery(
    operation: DesktopDeliveryOperation,
    status: DesktopDeliveryOutcome['status'],
    task: RuntimeTask,
    messageId: string,
    error?: unknown,
  ): void {
    const identity = {
      operation,
      threadId: task.binding.threadId,
      chatId: task.message.chatId,
      messageId,
    };
    try {
      if (status === 'failed') {
        this.onDesktopDeliveryOutcome({ ...identity, status, error });
        return;
      }
      this.onDesktopDeliveryOutcome({ ...identity, status });
    } catch {
      // Delivery observers are diagnostic only and must never change task semantics.
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
    appendPendingNotification(pending, notification);
    this.pendingDesktopByTurnKey.set(key, pending);
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
      if (this.scheduler.hasActive(identity.threadId)) {
        return;
      }
      await this.startDesktopProjection(binding, turn, prompt);
    }).catch((error: unknown) => this.onCardError(toError(error))).finally(() => {
      this.startingDesktopTurnKeys.delete(key);
      if (!this.scheduler.hasActive(identity.threadId)) {
        this.pendingDesktopByTurnKey.delete(key);
      }
    });
  }

  private async startDesktopProjection(
    binding: ChatThreadBinding,
    turn: Turn,
    prompt: string,
  ): Promise<void> {
    const taskBinding = await this.bindingWithTitle(binding);
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
      taskBinding,
    ));
    const cardMessageId = await this.cards.sendCard(taskBinding.chatId, cardId, `desktop:${id}`);
    const task: RuntimeTask = {
      id,
      message: desktopMessage(taskBinding, turn, prompt, cardMessageId, startedAtMs),
      binding: taskBinding,
      cardId,
      cardMessageId,
      cancelToken: deriveTaskCancelToken(this.config.larkAppSecret, id),
      turnId: turn.id,
      status: 'RUNNING',
      commentary: '',
      lastProcessItemId: null,
      processItemTextById: new Map(),
      tools: '',
      toolExecutions: [],
      timeline: [],
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
      cardDeliveryPending: false,
      nextToolGroupId: 0,
      lastActivityKind: 'none',
      cardPageNumber: 1,
      deliveredReasoningByItemId: new Map(),
      deliveredToolItemIds: new Set(),
      deliveredToolFallbackByKey: new Map(),
      answerOffset: 0,
      deliveredAnswerPrefix: '',
      answerRevision: false,
      pendingCardId: null,
      pendingFreezes: [],
      staleCardMessageIds: new Set(),
      localImagePaths: new Set(),
    };
    this.tasksById.set(id, task);
    this.activateTask(task);
    void this.refreshRateLimits(task);
    this.replayDesktopPending(task);
    if (!TERMINAL.has(task.status)) {
      this.requestCardUpdate(task, true);
    }
  }

  private enqueue(message: InboundMessage, binding: ChatThreadBinding): InMemoryInboundOutcome {
    if (!this.scheduler.enqueue(binding.threadId, { message, binding }, this.config.maxQueuedTasks)) {
      this.releaseMessageImages(message);
      return 'rejected_queue_full';
    }
    return 'queued';
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
      appendStartedTool(task, params, this.now());
    } else if (notification.method === 'item/completed') {
      completeTool(task, params, this.now());
      completeAgentMessage(task, params, this.now());
    } else if (notification.method === 'item/agentMessage/delta') {
      const phase = stringField(params.phase);
      const delta = stringField(params.delta);
      const commentary = phase === 'commentary';
      const appended = commentary
        ? appendProcessDelta(task, params, delta, this.now())
        : appendToTask(task, 'finalAnswer', delta);
      if (appended) {
        task.lastActivityKind = 'text';
      }
      if (appended && !commentary) {
        this.requestAnswerStream(task);
        return;
      }
    } else if (notification.method === 'item/reasoning/summaryTextDelta') {
      if (appendProcessDelta(task, params, stringField(params.delta), this.now())) {
        task.lastActivityKind = 'text';
      }
    } else if (notification.method === 'item/reasoning/textDelta') {
      if (appendProcessDelta(task, params, stringField(params.delta), this.now())) {
        task.lastActivityKind = 'text';
      }
    } else if (notification.method === 'item/commandExecution/outputDelta') {
      appendToolOutput(task, params, stringField(params.delta), this.now());
    } else if (notification.method === 'error') {
      appendToTask(task, 'tools', stringField((params.error as Record<string, unknown> | undefined)?.message));
    } else if (notification.method === 'turn/completed') {
      const turn = params.turn as Turn;
      task.status = terminalStatus(turn.status);
      const terminalAnswer = finalAnswerFromTurn(turn);
      if (terminalAnswer) {
        task.finalAnswer = terminalAnswer;
      }
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

  private requestAnswerStream(task: RuntimeTask): void {
    // Full-card projection is required here because an answer delta may cross
    // the active volume's byte boundary and must create a continuation card.
    this.requestCardUpdate(task, false);
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
    task.cardDeliveryPending = true;
    this.onRuntimeHealthChanged();
    try {
      reconcileAnswerCursor(task);
      let pages = await taskCardPages(task, this.cards);
      while (pages.length > 1) {
        const currentPage = pages[0];
        const nextPage = pages[1];
        if (!currentPage || !nextPage) {
          break;
        }
        await this.continueCard(task, currentPage, nextPage);
        pages = await taskCardPages(task, this.cards);
      }
      if (terminal && !task.streamingClosed) {
        task.cardSequence = await this.cards.closeStreaming(
          task.cardId,
          task.cardSequence,
          `task:${task.id}:close:${task.cardSequence + 1}`,
        );
        task.streamingClosed = true;
      }
      const currentPage = pages[0] ?? emptyTaskCardPage(task.cardPageNumber === 1);
      const card = await renderedTaskPageCard(
        task,
        this.cards,
        currentPage,
        task.cardPageNumber - 1,
        true,
        terminal,
      );
      task.cardSequence = await this.cards.replaceRenderedCard(
        task.cardId,
        card,
        task.cardSequence,
        `task:${task.id}:${task.cardSequence + 1}`,
      );
      task.cardRetryCount = 0;
      await this.drainPendingFreezes(task);
      task.cardDeliveryPending = task.pendingFreezes.length > 0;
      this.onRuntimeHealthChanged();
      if (terminal && this.terminalByTurnKey.get(
        turnKey(task.binding.threadId, task.turnId ?? ''),
      ) === task) {
        this.scheduleTerminalCleanup(task, TERMINAL_CARD_RETENTION_MS);
      }
    } catch (error) {
      const cardError = toError(error);
      if (error instanceof CardKitError && error.retryable && task.cardRetryCount < MAX_CARD_RETRY_ATTEMPTS) {
        this.scheduleCardRetry(task);
        return;
      }
      this.onCardError(cardError);
    }
  }

  private async continueCard(
    task: RuntimeTask,
    currentPage: TaskCardPage,
    nextPage: TaskCardPage,
  ): Promise<void> {
    const nextPageNumber = task.cardPageNumber + 1;
    if (!task.pendingCardId) {
      const nextCard = await renderedTaskPageCard(
        task,
        this.cards,
        nextPage,
        nextPageNumber - 1,
        true,
        false,
      );
      task.pendingCardId = await this.cards.createRenderedCard(nextCard);
    }
    const frozenCard = await renderedTaskPageCard(
      task,
      this.cards,
      currentPage,
      task.cardPageNumber - 1,
      false,
      false,
    );
    const cardMessageId = await this.cards.sendCard(
      task.message.chatId,
      task.pendingCardId,
      `task:${task.id}:page:${nextPageNumber}`,
    );
    task.pendingFreezes.push({
      cardId: task.cardId,
      cardMessageId: task.cardMessageId,
      card: frozenCard,
      pageNumber: task.cardPageNumber,
      sequence: task.cardSequence,
      streamingClosed: task.streamingClosed,
      retryCount: 0,
    });
    task.cardId = task.pendingCardId;
    task.cardMessageId = cardMessageId;
    task.cardPageNumber = nextPageNumber;
    task.pendingCardId = null;
    task.cardSequence = 0;
    task.streamingClosed = false;
    consumeTaskCardPage(task, currentPage);
  }

  private async drainPendingFreezes(task: RuntimeTask): Promise<void> {
    while (task.pendingFreezes.length > 0) {
      const pending = task.pendingFreezes[0];
      if (!pending) {
        return;
      }
      try {
        if (!pending.streamingClosed) {
          pending.sequence = await this.cards.closeStreaming(
            pending.cardId,
            pending.sequence,
            `task:${task.id}:page:${pending.pageNumber}:close`,
          );
          pending.streamingClosed = true;
        }
        pending.sequence = await this.cards.replaceRenderedCard(
          pending.cardId,
          pending.card,
          pending.sequence,
          `task:${task.id}:page:${pending.pageNumber}:freeze`,
        );
        task.pendingFreezes.shift();
      } catch (error) {
        pending.retryCount += 1;
        if (
          error instanceof CardKitError
          && error.retryable
          && pending.retryCount <= MAX_CARD_RETRY_ATTEMPTS
        ) {
          this.scheduleCardRetry(task);
          return;
        }
        task.pendingFreezes.shift();
        task.staleCardMessageIds.add(pending.cardMessageId);
        this.onCardError(toError(error));
      }
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
    this.releaseTaskImages(task);
    let activeTaskRemoved = false;
    activeTaskRemoved = this.scheduler.release(task.binding.threadId, task);
    if (task.turnId) {
      const key = turnKey(task.binding.threadId, task.turnId);
      this.terminalByTurnKey.set(key, task);
      this.scheduleTerminalCleanup(
        task,
        task.cardDeliveryPending
          ? PENDING_TERMINAL_CARD_RETENTION_MS
          : TERMINAL_CARD_RETENTION_MS,
      );
    } else {
      if (task.cardRetryTimer) {
        clearTimeout(task.cardRetryTimer);
      }
      this.tasksById.delete(task.id);
    }
    const next = this.scheduler.takeNext(task.binding.threadId);
    this.onRuntimeHealthChanged();
    if (!next) {
      if (activeTaskRemoved) {
        this.onActiveThreadsChanged();
      }
      return;
    }
    // Keep the Desktop follower subscription stable while ownership passes to
    // the next queued task for the same thread. Its activation will publish the
    // refreshed active-thread snapshot after the new turn starts.
    const generation = this.runtimeGeneration;
    void this.runExclusive(
      next.binding.threadId,
      () => this.start(next.message, next.binding, generation),
    )
      .catch((error: unknown) => this.onCardError(toError(error)));
  }

  private scheduleTerminalCleanup(task: RuntimeTask, delayMs: number): void {
    if (!task.turnId) {
      return;
    }
    if (task.terminalCleanupTimer) {
      clearTimeout(task.terminalCleanupTimer);
    }
    const key = turnKey(task.binding.threadId, task.turnId);
    task.terminalCleanupTimer = setTimeout(() => {
      if (task.cardRetryTimer) {
        clearTimeout(task.cardRetryTimer);
      }
      this.terminalByTurnKey.delete(key);
      this.tasksById.delete(task.id);
      this.onRuntimeHealthChanged();
    }, delayMs);
    task.terminalCleanupTimer.unref();
  }

  private activateTask(task: RuntimeTask): void {
    this.scheduler.activate(task.binding.threadId, task);
    this.onActiveThreadsChanged();
    this.onRuntimeHealthChanged();
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

  private releaseMessageImages(message: InboundMessage): void {
    if (message.localImagePaths?.length) {
      this.releaseInboundImages(message.localImagePaths);
    }
  }

  private releaseTaskImages(task: RuntimeTask): void {
    if (task.localImagePaths.size === 0) {
      return;
    }
    const paths = [...task.localImagePaths];
    task.localImagePaths.clear();
    this.releaseInboundImages(paths);
  }

  private addSteerImagePaths(task: RuntimeTask, message: InboundMessage): readonly string[] {
    const addedPaths: string[] = [];
    for (const path of message.localImagePaths ?? []) {
      if (!task.localImagePaths.has(path)) {
        task.localImagePaths.add(path);
        addedPaths.push(path);
      }
    }
    return addedPaths;
  }

  private releaseSteerImagePaths(task: RuntimeTask, paths: readonly string[]): void {
    if (paths.length === 0) {
      return;
    }
    for (const path of paths) {
      task.localImagePaths.delete(path);
    }
    this.releaseInboundImages(paths);
  }
}

function buildStart(task: RuntimeTask): TurnStartParams {
  return {
    threadId: task.binding.threadId,
    clientUserMessageId: task.message.messageId,
    input: taskInput(task.message.text, task.binding, task.message.localImagePaths),
    cwd: task.binding.workspaceId,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'dangerFullAccess' },
    ...(task.binding.model ? { model: task.binding.model } : {}),
    ...(task.binding.plan ? { collaborationMode: task.binding.plan } : {}),
    ...(task.binding.personality && task.binding.personality !== 'none'
      ? { personality: task.binding.personality }
      : {}),
  };
}

function buildSteer(
  task: RuntimeTask,
  message: InboundMessage,
  binding: ChatThreadBinding,
): TurnSteerParams {
  return {
    threadId: task.binding.threadId,
    expectedTurnId: task.turnId as string,
    clientUserMessageId: message.messageId,
    input: taskInput(message.text, binding, message.localImagePaths),
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
  view?: {
    readonly timeline: readonly CardTimelineEntry[];
    readonly finalAnswer: string;
    readonly pageNumber: number;
    readonly active: boolean;
    readonly showPrompt: boolean;
    readonly showFinalAnswer: boolean;
    readonly showReasoning: boolean;
    readonly answerRevision: boolean;
  },
): CardKitJson {
  const terminal = TERMINAL.has(status);
  const tools = view && (view.timeline.length > 0 || !view.showReasoning)
    ? { text: '', count: 0, groups: Object.freeze([]) }
    : toolProjection(toolExecutions, toolError);
  const projectedFinalAnswer = status === 'FAILED' && !finalAnswer.trim() && toolError.trim()
    ? toolError
    : finalAnswer;
  const metadata = usage
    ? taskMetadataForBinding(usage.binding)
    : binding
      ? taskMetadataForBinding(binding)
      : null;
  return createTaskCard({
    status,
    cancelToken,
    continued: view ? !view.active : false,
    showPrompt: view?.showPrompt,
    showFinalAnswer: view?.showFinalAnswer,
    showReasoning: view?.showReasoning,
    showFooter: !(view && !view.active),
    contentFitsCard: Boolean(view),
    continuationText: view?.answerRevision
      ? sanitizeCardMarkdown('⚠️ **最终结果修订版**：此前流式草稿无法撤回，请以本页及后续修订版卡片为准。')
      : view && !view.active
        ? sanitizeCardMarkdown(`➡️ 本页已满，后续内容见第 ${view.pageNumber + 1} 张卡片。`)
        : undefined,
    payload: Object.freeze({
      title: sanitizeCardText(
        taskPageTitle(usage?.binding ?? binding, view?.pageNumber ?? 1),
        { maxLength: 80 },
      ),
      prompt: sanitizeCardMarkdown(prompt, { maxLength: 4_000 }),
      metadata: metadata ? sanitizeCardMarkdown(metadata, { maxLength: 1_000 }) : null,
      commentary: sanitizeCardMarkdown(
        removeDesktopInternalProgress(commentary) ?? '',
        { maxLength: 10_000 },
      ),
      toolSummary: sanitizeCardPlainText(tools.text || '暂无', { maxLength: 10_000 }),
      toolCount: tools.count,
      toolGroups: tools.groups,
      timeline: view?.timeline ?? (usage
        ? timelineEntriesProjection(usage).map((entry) => entry.card)
        : Object.freeze([])),
      finalAnswer: sanitizeCardMarkdown(view?.finalAnswer ?? projectedFinalAnswer, {
        maxLength: view ? undefined : 10_000,
      }),
      footer: sanitizeCardPlainText(
        `${formatFooter(status, startedAtMs, usage)} · 第 ${view?.pageNumber ?? 1} 页`,
        { maxLength: 500 },
      ),
      terminal,
    }),
  });
}

function taskPageCard(
  task: RuntimeTask,
  page: TaskCardPage,
  pageIndex: number,
  active: boolean,
  terminal: boolean,
): CardKitJson {
  const status = terminal
    ? task.status
    : TERMINAL.has(task.status) ? 'COMPLETING' : task.status;
  return taskCard(
    displayTaskPrompt(task.message),
    status,
    '',
    task.toolExecutions,
    task.tools,
    page.finalAnswer,
    task.startedAtMs,
    task,
    active && !terminal && !TERMINAL.has(task.status) ? task.cancelToken : undefined,
    undefined,
    {
      timeline: page.timeline,
      finalAnswer: page.finalAnswer,
      pageNumber: pageIndex + 1,
      active,
      showPrompt: page.showPrompt,
      showFinalAnswer: page.kind !== 'timeline' || active,
      showReasoning: page.kind !== 'answer',
      answerRevision: page.answerRevision,
    },
  );
}

function taskCardTitle(binding: ChatThreadBinding | undefined): string {
  return truncateDisplayWidth(binding?.threadTitle?.trim() || 'Codex 任务', 24);
}

function taskPageTitle(binding: ChatThreadBinding | undefined, pageNumber: number): string {
  const title = taskCardTitle(binding);
  return pageNumber > 1 ? `${title} · 续 ${pageNumber - 1}` : title;
}

function truncateDisplayWidth(value: string, maxWidth: number): string {
  let width = 0;
  let result = '';
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > maxWidth) {
      return appendEllipsisWithinWidth(result, width, maxWidth);
    }
    width += characterWidth;
    result += character;
  }
  return result;
}

function displayWidth(character: string): number {
  return /[^\x00-\xff]/.test(character) ? 2 : 1;
}

function appendEllipsisWithinWidth(value: string, width: number, maxWidth: number): string {
  const ellipsis = '…';
  const ellipsisWidth = displayWidth(ellipsis);
  const characters = [...value];
  let nextWidth = width;
  while (characters.length > 0 && nextWidth + ellipsisWidth > maxWidth) {
    const character = characters.pop();
    if (!character) {
      break;
    }
    nextWidth -= displayWidth(character);
  }
  return `${characters.join('')}${ellipsis}`;
}

function timelineEntriesProjection(task: RuntimeTask): readonly ProjectedTimelineEntry[] {
  const projected: ProjectedTimelineEntry[] = [];
  let toolEntries: TimelineEntry[] = [];
  const flushTools = (): void => {
    if (toolEntries.length === 0) {
      return;
    }
    const executions = toolEntries.flatMap((entry) => entry.execution ? [entry.execution] : []);
    const first = toolEntries[0];
    toolEntries = [];
    if (!first || executions.length === 0) {
      return;
    }
    const tool = toolGroupForExecutions(executions);
    const toolKey = executions.map((execution) => execution.itemId).join('\u0000');
    const fallbackText = `${tool.title}\n${tool.content}`;
    const deliveredFallback = task.deliveredToolFallbackByKey.get(toolKey) ?? '';
    if (deliveredFallback) {
      const remainingFallback = fallbackText.startsWith(deliveredFallback)
        ? fallbackText.slice(deliveredFallback.length)
        : '';
      const chunks = splitUtf8Text(remainingFallback, MAX_TIMELINE_REASONING_BYTES);
      chunks.forEach((content, index) => {
        projected.push(Object.freeze({
          card: Object.freeze({
            kind: 'reasoning',
            time: sanitizeCardPlainText(formatTimelineTime(first.occurredAtMs), { maxLength: 16 }),
            content: sanitizeCardMarkdown(content),
          }),
          consumption: Object.freeze({
            kind: 'tool',
            toolKey,
            text: content,
            itemIds: index === chunks.length - 1
              ? Object.freeze(executions.map((execution) => execution.itemId))
              : Object.freeze([]),
          }),
        }));
      });
      return;
    }
    projected.push(Object.freeze({
      card: Object.freeze({
        kind: 'tool',
        time: sanitizeCardPlainText(formatTimelineTime(first.occurredAtMs), { maxLength: 16 }),
        tool,
      }),
      consumption: Object.freeze({
        kind: 'tool',
        toolKey,
        itemIds: Object.freeze(executions.map((execution) => execution.itemId)),
      }),
    }));
  };

  for (const entry of task.timeline) {
    if (
      entry.kind === 'tool'
      && entry.execution
      && !task.deliveredToolItemIds.has(entry.itemId)
    ) {
      const prior = toolEntries.at(-1)?.execution;
      if (prior && prior.groupId !== entry.execution.groupId) {
        flushTools();
      }
      toolEntries.push(entry);
      continue;
    }
    flushTools();
    if (entry.kind !== 'reasoning' || !entry.text) {
      continue;
    }
    const visibleText = removeDesktopInternalProgress(entry.text) ?? '';
    if (!visibleText) {
      continue;
    }
    const delivered = task.deliveredReasoningByItemId.get(entry.itemId) ?? '';
    if (delivered && !visibleText.startsWith(delivered)) {
      continue;
    }
    const remainingText = visibleText.slice(delivered.length);
    if (!remainingText) {
      continue;
    }
    const time = sanitizeCardPlainText(formatTimelineTime(entry.occurredAtMs), { maxLength: 16 });
    for (const content of splitUtf8Text(remainingText, MAX_TIMELINE_REASONING_BYTES)) {
      projected.push(Object.freeze({
        card: Object.freeze({
          kind: 'reasoning',
          time,
          content: sanitizeCardMarkdown(content),
        }),
        consumption: Object.freeze({
          kind: 'reasoning',
          itemId: entry.itemId,
          text: content,
        }),
      }));
    }
  }
  flushTools();
  return Object.freeze(projected);
}

async function taskCardPages(
  task: RuntimeTask,
  cards: InMemoryCardClient,
): Promise<readonly TaskCardPage[]> {
  const pageIndex = task.cardPageNumber - 1;
  const projectedTimeline = timelineEntriesProjection(task);
  const timelinePages = await paginateTimeline(task, cards, projectedTimeline, pageIndex);
  let answer = projectedTaskAnswer(task).slice(task.answerOffset);
  if (!answer) {
    return timelinePages.length > 0
      ? timelinePages
      : [emptyTaskCardPage(task.cardPageNumber === 1)];
  }
  if (timelinePages.length > 0) {
    const lastIndex = timelinePages.length - 1;
    const lastTimelinePage = timelinePages[lastIndex];
    if (lastTimelinePage) {
      const answerPrefix = await fittingAnswerPrefix(
        task,
        cards,
        answer,
        pageIndex + lastIndex,
        lastTimelinePage.showPrompt,
        lastTimelinePage.timeline,
      );
      if (answerPrefix) {
        timelinePages[lastIndex] = Object.freeze({
          ...lastTimelinePage,
          finalAnswer: answerPrefix,
          kind: 'mixed',
          answerRevision: task.answerRevision,
        });
        answer = answer.slice(answerPrefix.length);
      }
    }
  }
  if (!answer) {
    return Object.freeze(timelinePages);
  }
  const answerPages = await paginateAnswer(
    task,
    cards,
    answer,
    pageIndex + timelinePages.length,
  );
  return Object.freeze([...timelinePages, ...answerPages]);
}

async function paginateTimeline(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  entries: readonly ProjectedTimelineEntry[],
  startingPageIndex: number,
): Promise<TaskCardPage[]> {
  if (entries.length === 0) {
    return [];
  }
  const pages: TaskCardPage[] = [];
  const remainingEntries = [...entries];
  let current: ProjectedTimelineEntry[] = [];
  while (remainingEntries.length > 0) {
    const entry = remainingEntries.shift();
    if (!entry) {
      continue;
    }
    const candidate = [...current, entry];
    const pageIndex = startingPageIndex + pages.length;
    const showPrompt = pageIndex === 0;
    const page = timelinePage(candidate, showPrompt);
    const exceedsLimit = candidate.length > MAX_TIMELINE_CARD_ENTRIES
      || !await taskPageFits(task, cards, page, pageIndex);
    if (current.length > 0 && exceedsLimit) {
      pages.push(timelinePage(current, showPrompt));
      current = [];
      remainingEntries.unshift(entry);
      continue;
    }
    if (current.length === 0 && exceedsLimit && showPrompt) {
      pages.push(emptyTaskCardPage(true));
      remainingEntries.unshift(entry);
      continue;
    }
    if (current.length === 0 && exceedsLimit) {
      const split = await splitOversizedTimelineEntry(task, cards, entry, pageIndex, showPrompt);
      if (!split) {
        throw new Error(`CardKit timeline page ${pageIndex + 1} has no usable content capacity`);
      }
      current = [split.head];
      if (split.tail) {
        remainingEntries.unshift(split.tail);
      }
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) {
    pages.push(timelinePage(current, startingPageIndex + pages.length === 0));
  }
  return pages;
}

async function splitOversizedTimelineEntry(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  entry: ProjectedTimelineEntry,
  pageIndex: number,
  showPrompt: boolean,
): Promise<{ readonly head: ProjectedTimelineEntry; readonly tail?: ProjectedTimelineEntry } | null> {
  const rawText = entry.consumption.kind === 'reasoning'
    ? entry.consumption.text ?? ''
    : entry.consumption.text
      ?? `${entry.card.tool?.title ?? '工具执行'}\n${entry.card.tool?.content ?? ''}`;
  const characters = [...rawText];
  let lower = 1;
  let upper = characters.length;
  let fitted = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = projectedTimelineTextPart(entry, characters.slice(0, middle).join(''), false);
    if (await taskPageFits(task, cards, timelinePage([candidate], showPrompt), pageIndex)) {
      fitted = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  if (fitted === 0) {
    return null;
  }
  const headText = characters.slice(0, fitted).join('');
  const tailText = characters.slice(fitted).join('');
  return Object.freeze({
    head: projectedTimelineTextPart(entry, headText, tailText.length === 0),
    ...(tailText
      ? { tail: projectedTimelineTextPart(entry, tailText, true) }
      : {}),
  });
}

function projectedTimelineTextPart(
  source: ProjectedTimelineEntry,
  text: string,
  finalPart: boolean,
): ProjectedTimelineEntry {
  const time = source.card.time;
  if (source.consumption.kind === 'reasoning') {
    return Object.freeze({
      card: Object.freeze({ kind: 'reasoning', time, content: sanitizeCardMarkdown(text) }),
      consumption: Object.freeze({
        kind: 'reasoning',
        itemId: source.consumption.itemId,
        text,
      }),
    });
  }
  return Object.freeze({
    card: Object.freeze({ kind: 'reasoning', time, content: sanitizeCardMarkdown(text) }),
    consumption: Object.freeze({
      kind: 'tool',
      toolKey: source.consumption.toolKey,
      text,
      itemIds: finalPart ? source.consumption.itemIds : Object.freeze([]),
    }),
  });
}

async function paginateAnswer(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  answer: string,
  startingPageIndex: number,
): Promise<readonly TaskCardPage[]> {
  const pages: TaskCardPage[] = [];
  let remaining = answer;
  while (remaining) {
    const pageIndex = startingPageIndex + pages.length;
    const showPrompt = pageIndex === 0;
    const prefix = await fittingAnswerPrefix(task, cards, remaining, pageIndex, showPrompt, []);
    if (!prefix) {
      throw new Error(`CardKit answer page ${pageIndex + 1} has no usable content capacity`);
    }
    pages.push(Object.freeze({
      timeline: Object.freeze([]),
      timelineConsumption: Object.freeze([]),
      finalAnswer: prefix,
      kind: 'answer',
      showPrompt,
      answerRevision: task.answerRevision,
    }));
    remaining = remaining.slice(prefix.length);
  }
  return Object.freeze(pages);
}

async function fittingAnswerPrefix(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  answer: string,
  pageIndex: number,
  showPrompt: boolean,
  timeline: readonly CardTimelineEntry[],
): Promise<string> {
  const characters = [...answer];
  let lower = 1;
  let upper = characters.length;
  let fitted = 0;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = characters.slice(0, middle).join('');
    const page: TaskCardPage = {
      timeline,
      timelineConsumption: Object.freeze([]),
      finalAnswer: candidate,
      kind: timeline.length > 0 ? 'mixed' : 'answer',
      showPrompt,
      answerRevision: task.answerRevision,
    };
    if (await taskPageFits(task, cards, page, pageIndex)) {
      fitted = middle;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return characters.slice(0, fitted).join('');
}

async function taskPageFits(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  page: TaskCardPage,
  pageIndex: number,
): Promise<boolean> {
  const rendered = await cards.renderCard(taskPageCard(task, page, pageIndex, true, false));
  return Buffer.byteLength(
    JSON.stringify(rendered),
    'utf8',
  ) <= MAX_CARD_JSON_BYTES;
}

async function renderedTaskPageCard(
  task: RuntimeTask,
  cards: InMemoryCardClient,
  page: TaskCardPage,
  pageIndex: number,
  active: boolean,
  terminal: boolean,
): Promise<CardKitJson> {
  const rendered = await cards.renderCard(taskPageCard(task, page, pageIndex, active, terminal));
  const bytes = Buffer.byteLength(JSON.stringify(rendered), 'utf8');
  if (bytes > MAX_CARD_JSON_BYTES) {
    throw new Error(`CardKit page ${pageIndex + 1} exceeds ${MAX_CARD_JSON_BYTES} bytes after rendering`);
  }
  return rendered;
}

function timelinePage(
  timeline: readonly ProjectedTimelineEntry[],
  showPrompt: boolean,
): TaskCardPage {
  return Object.freeze({
    timeline: Object.freeze(timeline.map((entry) => entry.card)),
    timelineConsumption: Object.freeze(timeline.map((entry) => entry.consumption)),
    finalAnswer: '',
    kind: 'timeline',
    showPrompt,
    answerRevision: false,
  });
}

function emptyTaskCardPage(showPrompt: boolean): TaskCardPage {
  return timelinePage([], showPrompt);
}

function consumeTaskCardPage(task: RuntimeTask, page: TaskCardPage): void {
  for (const consumption of page.timelineConsumption) {
    if (consumption.kind === 'tool') {
      if (consumption.toolKey && consumption.text) {
        const delivered = task.deliveredToolFallbackByKey.get(consumption.toolKey) ?? '';
        task.deliveredToolFallbackByKey.set(consumption.toolKey, `${delivered}${consumption.text}`);
      }
      for (const itemId of consumption.itemIds ?? []) {
        task.deliveredToolItemIds.add(itemId);
      }
      continue;
    }
    if (!consumption.itemId || !consumption.text) {
      continue;
    }
    const delivered = task.deliveredReasoningByItemId.get(consumption.itemId) ?? '';
    task.deliveredReasoningByItemId.set(consumption.itemId, `${delivered}${consumption.text}`);
  }
  pruneDeliveredTimeline(task);
  task.answerOffset += page.finalAnswer.length;
  task.deliveredAnswerPrefix += page.finalAnswer;
}

function reconcileAnswerCursor(task: RuntimeTask): void {
  const answer = projectedTaskAnswer(task);
  if (answer.startsWith(task.deliveredAnswerPrefix)) {
    return;
  }
  // Frozen draft pages cannot be retracted. A divergent terminal snapshot is
  // therefore delivered from the beginning as an explicitly labelled revision.
  task.answerOffset = 0;
  task.deliveredAnswerPrefix = '';
  task.answerRevision = true;
}

function pruneDeliveredTimeline(task: RuntimeTask): void {
  for (let index = task.timeline.length - 1; index >= 0; index -= 1) {
    const entry = task.timeline[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === 'tool' && task.deliveredToolItemIds.has(entry.itemId)) {
      task.timeline.splice(index, 1);
      continue;
    }
    if (entry.kind !== 'reasoning' || !entry.text) {
      continue;
    }
    const visibleText = removeDesktopInternalProgress(entry.text) ?? '';
    const delivered = task.deliveredReasoningByItemId.get(entry.itemId) ?? '';
    if (!visibleText || delivered === visibleText || (delivered && !visibleText.startsWith(delivered))) {
      task.timeline.splice(index, 1);
    }
  }
}

function projectedTaskAnswer(task: RuntimeTask): string {
  const answer = task.status === 'FAILED' && !task.finalAnswer.trim() && task.tools.trim()
    ? task.tools
    : task.finalAnswer;
  return sanitizeCardMarkdown(answer);
}

function splitUtf8Text(value: string, maxBytes: number): readonly string[] {
  if (!value) {
    return [];
  }
  const chunks: string[] = [];
  let characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (characters.length > 0 && bytes + characterBytes > maxBytes) {
      chunks.push(characters.join(''));
      characters = [];
      bytes = 0;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  if (characters.length > 0) {
    chunks.push(characters.join(''));
  }
  return Object.freeze(chunks);
}

function toolGroupForExecutions(executions: readonly ToolExecution[]): CardToolGroup {
  const count = executions.reduce((total, execution) => total + execution.actionCount, 0);
  const revised = executions.some((execution) => execution.revised);
  return Object.freeze({
    title: sanitizeCardPlainText(
      `${revised ? '🛠️ 工具执行更新' : '🛠️ 工具执行'} · ${count} 步`,
      { maxLength: 100 },
    ),
    content: sanitizeCardMarkdown(toolExecutionContent(executions), { maxLength: 4_000 }),
    count,
    icon: 'api-app_outlined',
    completed: executions.every((execution) => execution.completed),
    failed: executions.some((execution) => execution.failed),
  });
}

function formatTimelineTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function toolProjection(
  executions: readonly ToolExecution[],
  error: string,
): {
  readonly text: string;
  readonly count: number;
  readonly groups: readonly CardToolGroup[];
} {
  const grouped = new Map<number, ToolExecution[]>();
  for (const execution of executions) {
    const group = grouped.get(execution.groupId) ?? [];
    group.push(execution);
    grouped.set(execution.groupId, group);
  }
  const groups: CardToolGroup[] = [...grouped.values()].map((group) => {
    return toolGroupForExecutions(group);
  });
  const lines = executions.map((execution, index) => {
    const state = execution.completed ? (execution.failed ? '❌' : '✅') : '⏳';
    return `${state} ${index + 1}. ${summarizeCommand(execution.command)}`;
  });
  if (error.trim()) {
    lines.push(`⚠️ ${oneLine(error, 500)}`);
  }
  if (error.trim() && groups.length === 0) {
    groups.push(Object.freeze({
      title: sanitizeCardPlainText('🛠️ 工具与命令', { maxLength: 100 }),
      content: sanitizeCardPlainText(`⚠️ ${oneLine(error, 500)}`, { maxLength: 1_000 }),
      count: 0,
    }));
  }
  return { text: lines.join('\n'), count: executions.length, groups };
}

function summarizeCommand(command: string): string {
  return oneLine(command, 240);
}

function toolExecutionContent(executions: readonly ToolExecution[]): string {
  return executions.map((execution) => {
    const output = execution.outputTail.trim();
    return output
      ? `- \`${execution.command}\`\n\`\`\`text\n${output}\n\`\`\``
      : `- \`${execution.command}\``;
  }).join('\n');
}

type ActionCategory = keyof ActionCounts;

interface ActionCounts {
  searches: number;
  reads: number;
  edits: number;
  skills: number;
  runs: number;
}

function categorizeCommand(command: string): { readonly category: ActionCategory; readonly name: string } {
  const normalized = command.trim();
  if (normalized.startsWith('rg ') || normalized.startsWith('grep ') || normalized.startsWith('find ')) {
    return { category: 'searches', name: normalized };
  }
  if (
    normalized.startsWith('cat ')
    || normalized.startsWith('head ')
    || normalized.startsWith('less ')
    || normalized.startsWith('tail ')
  ) {
    return { category: 'reads', name: normalized };
  }
  if (normalized.startsWith('sed ') || normalized.startsWith('awk ') || normalized.startsWith('echo ')) {
    return { category: 'edits', name: normalized };
  }
  return { category: 'runs', name: normalized };
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
    const labels: Readonly<Record<string, string>> = { friendly: '亲和', pragmatic: '务实' };
    metadata.push(`🎭 **回复风格**: \`${labels[binding.personality] ?? binding.personality}\``);
  }
  if (binding.activeSkill) {
    metadata.push(`✨ **调用的技能**: \`${binding.activeSkill}\``);
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
): boolean {
  if (!delta) {
    return false;
  }
  const next = task[field] + delta;
  task[field] = field === 'finalAnswer' || next.length <= TEXT_LIMIT
    ? next
    : next.slice(-TEXT_LIMIT);
  return true;
}

function appendProcessDelta(
  task: RuntimeTask,
  params: Record<string, unknown>,
  delta: string | null,
  nowMs: number,
  includeTimeline = true,
): boolean {
  if (!delta) {
    return false;
  }
  const itemId = stringField(params.itemId);
  const separator = task.commentary && itemId && task.lastProcessItemId !== itemId
    ? '\n\n'
    : '';
  const appended = appendToTask(task, 'commentary', `${separator}${delta}`);
  if (appended && itemId && includeTimeline) {
    task.lastProcessItemId = itemId;
    const currentText = `${task.processItemTextById.get(itemId) ?? ''}${delta}`;
    task.processItemTextById.set(itemId, currentText);
    const visibleText = removeDesktopInternalProgress(currentText) ?? '';
    replaceReasoningTimelineEntry(
      task,
      itemId,
      visibleText,
      numberField(params.startedAtMs) ?? nowMs,
    );
  }
  return appended;
}

function completeAgentMessage(
  task: RuntimeTask,
  params: Record<string, unknown>,
  nowMs: number,
): void {
  const item = recordField(params.item);
  const itemId = stringField(item?.id) ?? stringField(params.itemId);
  if (!item || !itemId || item.type !== 'agentMessage' || item.phase !== 'commentary') {
    return;
  }
  const text = threadItemText(item as Turn['items'][number]);
  task.processItemTextById.set(itemId, text);
  replaceReasoningTimelineEntry(
    task,
    itemId,
    removeDesktopInternalProgress(text) ?? '',
    numberField(params.completedAtMs) ?? nowMs,
  );
}

function replaceReasoningTimelineEntry(
  task: RuntimeTask,
  itemId: string,
  text: string,
  occurredAtMs: number,
): void {
  for (let index = task.timeline.length - 1; index >= 0; index -= 1) {
    const entry = task.timeline[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === 'reasoning' && entry.itemId === itemId) {
      if (text) {
        entry.text = text;
      } else {
        task.timeline.splice(index, 1);
      }
      return;
    }
  }
  if (text) {
    task.timeline.push({
      kind: 'reasoning',
      itemId,
      occurredAtMs,
      text,
    });
  }
}

/** Drops Desktop-only English progress labels while keeping the model's visible text unchanged. */
function removeDesktopInternalProgress(value: string | null): string | null {
  if (!value) {
    return null;
  }
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

function appendStartedTool(task: RuntimeTask, params: Record<string, unknown>, nowMs: number): void {
  const item = recordField(params.item);
  const itemId = stringField(item?.id) ?? stringField(params.itemId);
  const descriptor = toolDescriptor(item);
  if (!itemId || !descriptor) {
    return;
  }
  if (task.toolExecutions.some((execution) => execution.itemId === itemId)) {
    return;
  }
  if (task.lastActivityKind !== 'tool') {
    task.nextToolGroupId += 1;
  }
  task.lastActivityKind = 'tool';
  const execution: ToolExecution = {
    itemId,
    groupId: task.nextToolGroupId,
    command: descriptor.command,
    category: descriptor.category,
    name: descriptor.name,
    actionCount: descriptor.count,
    outputTail: '',
    completed: false,
    failed: false,
    revised: false,
  };
  task.toolExecutions.push(execution);
  task.timeline.push({
    kind: 'tool',
    itemId,
    occurredAtMs: numberField(params.startedAtMs) ?? nowMs,
    execution,
  });
}

function appendToolOutput(
  task: RuntimeTask,
  params: Record<string, unknown>,
  delta: string | null,
  nowMs: number,
): void {
  const itemId = stringField(params.itemId);
  if (!itemId || !delta) {
    return;
  }
  const execution = task.toolExecutions.find((entry) => entry.itemId === itemId);
  if (!execution) {
    return;
  }
  const output = `${execution.outputTail}${delta}`;
  execution.outputTail = output.length <= MAX_TOOL_OUTPUT_CHARS
    ? output
    : output.slice(-MAX_TOOL_OUTPUT_CHARS);
  reopenDeliveredTool(task, execution, nowMs);
}

function completeTool(task: RuntimeTask, params: Record<string, unknown>, nowMs: number): void {
  const item = recordField(params.item);
  if (!item || !toolDescriptor(item)) {
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
  const exitCode = numberField(item.exitCode);
  execution.failed = (exitCode !== null && exitCode !== 0) || item.status === 'failed';
  reopenDeliveredTool(task, execution, nowMs);
}

function reopenDeliveredTool(task: RuntimeTask, execution: ToolExecution, nowMs: number): void {
  if (!task.deliveredToolItemIds.delete(execution.itemId)) {
    return;
  }
  execution.revised = true;
  for (const key of task.deliveredToolFallbackByKey.keys()) {
    if (key.split('\u0000').includes(execution.itemId)) {
      task.deliveredToolFallbackByKey.delete(key);
    }
  }
  if (!task.timeline.some((entry) => entry.kind === 'tool' && entry.itemId === execution.itemId)) {
    task.timeline.push({
      kind: 'tool',
      itemId: execution.itemId,
      occurredAtMs: nowMs,
      execution,
    });
  }
}

function toolDescriptor(item: Record<string, unknown> | null): {
  readonly category: ActionCategory;
  readonly name: string;
  readonly command: string;
  readonly count: number;
} | null {
  if (!item || typeof item.type !== 'string') return null;
  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) && item.changes.length > 0 ? item.changes.length : 1;
    return { category: 'edits', name: 'fileChange', command: 'fileChange', count };
  }
  if (item.type === 'mcpToolCall') {
    const server = stringField(item.server) ?? '';
    const tool = stringField(item.tool) ?? 'unknown_tool';
    const name = server ? `${server}.${tool}` : tool;
    return { category: 'skills', name, command: name, count: 1 };
  }
  if (item.type === 'toolCall') {
    const name = stringField(item.toolName) ?? stringField(item.tool) ?? 'unknown_tool';
    return { category: 'skills', name, command: name, count: 1 };
  }
  if (item.type === 'dynamicToolCall') {
    const name = stringField(item.toolName) ?? stringField(item.tool) ?? 'dynamicToolCall';
    return { category: 'skills', name, command: name, count: 1 };
  }
  if (item.type === 'collabAgentToolCall') {
    const name = stringField(item.action) ?? stringField(item.tool) ?? stringField(item.toolName)
      ?? 'collabAgentToolCall';
    return { category: 'skills', name, command: name, count: 1 };
  }
  if (item.type === 'subAgentActivity') {
    const name = stringField(item.description) ?? stringField(item.text) ?? 'subAgentActivity';
    return { category: 'skills', name, command: oneLine(name, 240), count: 1 };
  }
  if (item.type === 'webSearch') {
    const query = stringField(item.query) ?? stringField(item.text) ?? 'webSearch';
    return { category: 'searches', name: query, command: `webSearch: ${oneLine(query, 220)}`, count: 1 };
  }
  if (item.type === 'imageView') {
    const path = stringField(item.path) ?? stringField(item.imagePath) ?? 'imageView';
    return { category: 'reads', name: path, command: `imageView: ${oneLine(path, 220)}`, count: 1 };
  }
  if (item.type === 'imageGeneration') {
    const prompt = stringField(item.revisedPrompt) ?? stringField(item.prompt) ?? 'imageGeneration';
    return { category: 'skills', name: prompt, command: `imageGeneration: ${oneLine(prompt, 210)}`, count: 1 };
  }
  if (item.type === 'sleep') {
    return { category: 'runs', name: 'sleep', command: 'sleep', count: 1 };
  }
  if (item.type === 'commandExecution') {
    const command = stringField(item.command);
    if (!command) return null;
    const action = categorizeCommand(command);
    return { category: action.category, name: action.name, command, count: 1 };
  }
  return null;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId.length}:${threadId}${turnId.length}:${turnId}`;
}

function appendPendingNotification(
  pending: ServerNotification[],
  notification: ServerNotification,
): void {
  if (pending.length >= MAX_PENDING_NOTIFICATIONS) {
    pending.shift();
  }
  pending.push(notification);
}

function finalAnswerFromTurn(turn: Turn): string {
  return turn.items
    .filter((item) => item.type === 'agentMessage' && (
      item.phase === 'final_answer' || !item.phase
    ))
    .map(threadItemText)
    .filter(Boolean)
    .join('');
}

function threadItemText(item: Turn['items'][number]): string {
  if (item.text?.trim()) {
    return item.text;
  }
  if (!Array.isArray(item.content)) {
    return '';
  }
  return item.content.map((content) => (
    typeof content === 'string' ? content : content.type === 'text' ? content.text : ''
  )).join('');
}

function desktopPrompt(turn: Turn): string | null {
  const inputs = desktopTurnInputs(turn);
  const localImagePaths = [...new Set(inputs.flatMap((input) => (
    typeof input !== 'string' && input.type === 'localImage' ? [input.path] : []
  )))];
  const text = inputs.map((input) => (
    typeof input === 'string' ? input : input.type === 'text' ? input.text : ''
  )).filter(Boolean).join('\n');
  const prompt = stripDesktopAttachmentEnvelope(text, localImagePaths.length > 0);
  const images = localImagePaths.map((path, index) => (
    `![输入图片 ${index + 1}](${pathToFileURL(path).href})`
  ));
  const projected = [prompt, ...images].filter(Boolean).join('\n\n').trim();
  return projected || null;
}

function desktopTurnInputs(turn: Turn): readonly (UserInput | string)[] {
  if (turn.input?.length) {
    return turn.input;
  }
  for (const item of turn.items) {
    if (item.type !== 'userMessage' && item.type !== 'user_message') {
      continue;
    }
    if (Array.isArray(item.content) && item.content.length > 0) {
      return item.content;
    }
    if (item.text?.trim()) {
      return [item.text];
    }
  }
  return [];
}

function stripDesktopAttachmentEnvelope(text: string, hasLocalImages: boolean): string {
  const trimmed = text.trim();
  if (!hasLocalImages || !trimmed) {
    return trimmed;
  }
  const filesHeader = /^#\s+Files mentioned by the user:\s*$/m.exec(trimmed);
  const requestHeader = /^##\s+My request for Codex:\s*$/m.exec(trimmed);
  const request = filesHeader?.index === 0
    && requestHeader?.index !== undefined
    && requestHeader.index > filesHeader.index
    ? trimmed.slice(requestHeader.index + requestHeader[0].length)
    : trimmed;
  return request
    .split(/\r?\n/)
    .filter((line) => !/^<\/?image(?:\s[^>]*)?>\s*$/.test(line.trim()))
    .join('\n')
    .trim();
}

function desktopMessage(
  binding: ChatThreadBinding,
  turn: Turn,
  prompt: string,
  cardMessageId: string,
  createdAtMs: number,
): InboundMessage {
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

function taskInput(
  prompt: string,
  binding: ChatThreadBinding,
  localImagePaths: readonly string[] = [],
): UserInput[] {
  const text = { type: 'text' as const, text: prompt, text_elements: [] };
  const images: UserInput[] = localImagePaths.map((path) => ({ type: 'localImage', path }));
  const textInput: UserInput[] = prompt ? [text] : [];
  if (!binding.activeSkill) {
    return textInput.length > 0 || images.length > 0 ? [...textInput, ...images] : [text];
  }
  if (!binding.activeSkillPath) {
    return [{ ...text, text: `@${binding.activeSkill}${prompt ? ` ${prompt}` : ''}` }, ...images];
  }
  return [
    { type: 'skill', name: binding.activeSkill, path: binding.activeSkillPath },
    ...textInput,
    ...images,
  ];
}

function displayTaskPrompt(message: InboundMessage): string {
  if (message.text.trim()) {
    return message.text;
  }
  return (message.localImagePaths?.length ?? 0) > 0
    ? '🖼️ 仅图片，未填写任务描述'
    : '';
}

interface InlineSkillMatch {
  readonly name: string;
  readonly path: string;
  readonly cleanText: string;
}

function matchInlineSkill(text: string, catalog: unknown): InlineSkillMatch | null {
  const skills = flattenSkillCatalog(catalog).sort((left, right) => right.name.length - left.name.length);
  for (const skill of skills) {
    const mention = `@${skill.name}`;
    const index = text.toLocaleLowerCase().indexOf(mention.toLocaleLowerCase());
    if (index < 0) {
      continue;
    }
    const before = index === 0 ? ' ' : text[index - 1] ?? ' ';
    const afterIndex = index + mention.length;
    const after = afterIndex >= text.length ? ' ' : text[afterIndex] ?? ' ';
    if (!isMentionBoundary(before) || !isMentionBoundary(after)) {
      continue;
    }
    const cleanText = `${text.slice(0, index)}${text.slice(afterIndex)}`.replace(/\s+/g, ' ').trim();
    return { ...skill, cleanText };
  }
  return null;
}

function flattenSkillCatalog(value: unknown): Array<{ readonly name: string; readonly path: string }> {
  const root = recordField(value);
  const entries = Array.isArray(root?.data) ? root.data : [];
  const skills: Array<{ readonly name: string; readonly path: string }> = [];
  for (const entry of entries) {
    const entryRecord = recordField(entry);
    const entrySkills = Array.isArray(entryRecord?.skills) ? entryRecord.skills : [];
    for (const candidate of entrySkills) {
      const skill = recordField(candidate);
      const name = stringField(skill?.name);
      const path = stringField(skill?.path);
      if (name && path) {
        skills.push({ name, path });
      }
    }
  }
  return skills;
}

function isMentionBoundary(value: string): boolean {
  return /[\s\p{P}]/u.test(value);
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
    return `${operation}未发送到 ChatGPT Desktop（${deliveryFailureCode(error)}）；请打开绑定任务后重新发送。`;
  }
  if (error.disposition === 'DEFINITIVE_FAILURE') {
    return `${operation}被 ChatGPT Desktop 明确拒绝（${deliveryFailureCode(error)}）；Bridge 不会重试。`;
  }
  return `${operation}的 Desktop 送达结果无法确认（${deliveryFailureCode(error)}）；为避免重复执行，Bridge 不会自动重试。`;
}

function deliveryWasConfirmedNotUsed(error: unknown): boolean {
  return !(error instanceof DesktopIpcRequestError)
    || error.disposition !== 'OUTCOME_UNKNOWN';
}

function deliveryFailureCode(error: DesktopIpcRequestError): string {
  return error.remoteError ?? error.code;
}
