import type { TaskStatus } from '../domain';
import {
  createEventReducerState,
  createProjectionSnapshot,
  reduceEvent,
  type EventProjectionSnapshot,
  type EventReducerState,
  type ReducedItem,
} from './event-reducer';
import type { ServerNotification, ThreadItem, Turn } from './protocol';

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
]);
const HANDLED_METHODS: ReadonlySet<string> = new Set([
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'error',
]);
const ITEM_COMPLETED_METHOD = 'item/completed';
const TURN_COMPLETED_METHOD = 'turn/completed';
const IMMEDIATE_PROJECTION_METHODS: ReadonlySet<string> = new Set(['error']);
const MAX_TERMINAL_CAS_ATTEMPTS = 4;
const DEFAULT_EARLY_NOTIFICATION_TTL_MS = 120_000;
const DEFAULT_EARLY_NOTIFICATION_LIMIT = 256;
const DEFAULT_EARLY_NOTIFICATION_PER_TURN_LIMIT = 64;
const RUNNING_TRANSITION_SOURCES: ReadonlySet<TaskStatus> = new Set([
  'STARTING',
  'DISPATCH_UNKNOWN',
  'RECOVERING',
]);
const RUNNING_OR_LATER_ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'RUNNING',
  'AWAITING_APPROVAL',
  'COMPLETING',
]);

export interface CoordinatedTask {
  readonly id: string;
  readonly bindingId: string;
  readonly status: TaskStatus;
  readonly turnId: string | null;
}

export interface CoordinatedThreadBinding {
  readonly id: string;
  readonly threadId: string | null;
}

export interface TerminalTaskFields {
  readonly finalText?: string;
  readonly errorCode?: string;
}

export interface PersistedTaskItemSnapshot {
  readonly taskId: string;
  readonly itemId: string;
  readonly itemType: 'agent_message' | 'reasoning_summary' | 'command_execution';
  readonly phase?: 'commentary' | 'final_answer';
  readonly status: 'COMPLETED';
  readonly contentText: string;
  readonly terminalPayloadJson?: string;
  readonly nowMs: number;
}

/** Minimal task repository surface needed by App Server event coordination. */
export interface EventCoordinatorTaskRepository {
  findByTurnId(turnId: string): CoordinatedTask | undefined;
  getById(taskId: string): CoordinatedTask | undefined;
  transition(
    taskId: string,
    expectedStatus: TaskStatus,
    nextStatus: TaskStatus,
    updatedAtMs: number,
    terminal?: TerminalTaskFields,
  ): boolean;
}

/** Minimal thread-binding lookup needed to verify an event's owning task. */
export interface EventCoordinatorBindingRepository {
  getById(bindingId: string): CoordinatedThreadBinding | undefined;
}

/** Durable item sink. Implementations should upsert by taskId and itemId. */
export interface EventCoordinatorTaskItemRepository {
  upsert(snapshot: PersistedTaskItemSnapshot): unknown;
}

export interface EventCoordinatorDependencies {
  readonly tasks: EventCoordinatorTaskRepository;
  readonly bindings: EventCoordinatorBindingRepository;
  readonly taskItems: EventCoordinatorTaskItemRepository;
  readonly scheduleProjection: (taskId: string, immediate: boolean) => void;
  readonly nowMs?: () => number;
  readonly earlyNotificationTtlMs?: number;
  readonly earlyNotificationLimit?: number;
  readonly earlyNotificationPerTurnLimit?: number;
}

export type EventCoordinationOutcome =
  | 'IGNORED'
  | 'BUFFERED'
  | 'SCHEDULED'
  | 'FLUSHED'
  | 'TERMINAL';

interface EventIdentity {
  readonly threadId: string;
  readonly turnId: string;
  readonly turn: Turn | null;
}

interface ReductionEntry {
  readonly taskId: string;
  readonly threadId: string;
  state: EventReducerState;
}

interface ResolvedContext {
  readonly task: CoordinatedTask;
  readonly entry: ReductionEntry;
}

interface PendingTurnStart {
  readonly taskId: string;
  readonly threadId: string;
  readonly generation: number;
  readonly expiresAtMs: number;
}

interface BufferedNotification {
  readonly sequence: number;
  readonly notification: ServerNotification;
}

interface EarlyNotificationBucket {
  readonly taskId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly generation: number;
  readonly expiresAtMs: number;
  readonly notifications: BufferedNotification[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function asTurn(value: unknown): Turn | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || typeof record.status !== 'string') {
    return null;
  }
  return value as Turn;
}

function eventIdentity(notification: ServerNotification): EventIdentity | null {
  if (!HANDLED_METHODS.has(notification.method)) {
    return null;
  }
  const params = asRecord(notification.params);
  if (!params || typeof params.threadId !== 'string') {
    return null;
  }
  const turn = asTurn(params.turn);
  const turnId = turn?.id ?? params.turnId;
  if (typeof turnId !== 'string') {
    return null;
  }
  return Object.freeze({ threadId: params.threadId, turnId, turn });
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

function terminalTaskStatus(snapshot: EventProjectionSnapshot): TaskStatus | null {
  if (snapshot.status === 'SUCCEEDED') {
    return 'SUCCEEDED';
  }
  if (snapshot.status === 'FAILED') {
    return 'FAILED';
  }
  if (snapshot.status === 'INTERRUPTED') {
    return 'INTERRUPTED';
  }
  return null;
}

function terminalFields(
  status: TaskStatus,
  snapshot: EventProjectionSnapshot,
): TerminalTaskFields {
  const finalText = snapshot.finalAnswer || undefined;
  if (status === 'FAILED') {
    return Object.freeze({ finalText, errorCode: 'APP_SERVER_TURN_FAILED' });
  }
  if (status === 'INTERRUPTED') {
    return Object.freeze({ finalText, errorCode: 'APP_SERVER_TURN_INTERRUPTED' });
  }
  return Object.freeze({ finalText });
}

function reasoningSummary(item: ReducedItem): string {
  return Object.keys(item.summaryParts)
    .map(Number)
    .sort((left, right) => left - right)
    .map((index) => item.summaryParts[index] ?? '')
    .join('');
}

function commandText(item: ReducedItem): string {
  if (item.command && item.commandOutputTail) {
    return `${item.command}\n${item.commandOutputTail}`;
  }
  return item.command || item.commandOutputTail;
}

function persistedItem(
  taskId: string,
  item: ReducedItem,
  nowMs: number,
): PersistedTaskItemSnapshot | null {
  if (item.status !== 'COMPLETED') {
    return null;
  }
  if (item.kind === 'agent_message') {
    if (item.phase !== 'commentary' && item.phase !== 'final_answer') {
      return null;
    }
    return Object.freeze({
      taskId,
      itemId: item.itemId,
      itemType: item.kind,
      phase: item.phase,
      status: 'COMPLETED',
      contentText: item.text,
      nowMs,
    });
  }
  if (item.kind === 'reasoning_summary') {
    return Object.freeze({
      taskId,
      itemId: item.itemId,
      itemType: item.kind,
      status: 'COMPLETED',
      contentText: reasoningSummary(item),
      nowMs,
    });
  }
  if (item.kind === 'command_execution') {
    return Object.freeze({
      taskId,
      itemId: item.itemId,
      itemType: item.kind,
      status: 'COMPLETED',
      contentText: commandText(item),
      terminalPayloadJson: JSON.stringify({
        command: item.command,
        outputTail: item.commandOutputTail,
      }),
      nowMs,
    });
  }
  return null;
}

/** Coordinates App Server notifications into reduced durable task state. */
export class AppServerEventCoordinator {
  private readonly reductionsByTurnId = new Map<string, ReductionEntry>();
  private readonly pendingTurnStartsByThreadId = new Map<string, PendingTurnStart>();
  private readonly earlyNotificationsByTurn = new Map<string, EarlyNotificationBucket>();
  private readonly nowMs: () => number;
  private readonly earlyNotificationTtlMs: number;
  private readonly earlyNotificationLimit: number;
  private readonly earlyNotificationPerTurnLimit: number;
  private earlyNotificationCount = 0;
  private nextEarlyNotificationSequence = 1;
  private nextPendingGeneration = 1;

  public constructor(private readonly dependencies: EventCoordinatorDependencies) {
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.earlyNotificationTtlMs = positiveInteger(
      dependencies.earlyNotificationTtlMs ?? DEFAULT_EARLY_NOTIFICATION_TTL_MS,
      'Early notification TTL',
    );
    this.earlyNotificationLimit = positiveInteger(
      dependencies.earlyNotificationLimit ?? DEFAULT_EARLY_NOTIFICATION_LIMIT,
      'Early notification limit',
    );
    this.earlyNotificationPerTurnLimit = Math.min(
      positiveInteger(
        dependencies.earlyNotificationPerTurnLimit
          ?? DEFAULT_EARLY_NOTIFICATION_PER_TURN_LIMIT,
        'Early per-turn notification limit',
      ),
      this.earlyNotificationLimit,
    );
  }

  /** Opens a short fail-closed window for notifications emitted before turn/start responds. */
  public beginTurnStart(taskId: string, threadId: string): void {
    requireIdentifier(taskId, 'Task');
    requireIdentifier(threadId, 'Thread');
    const nowMs = this.nowMs();
    this.pruneEarlyNotifications(nowMs);
    const current = this.pendingTurnStartsByThreadId.get(threadId);
    if (current && current.taskId !== taskId) {
      throw new Error('A different task already has a pending turn/start for this thread');
    }
    this.clearBufferedThread(threadId);
    const generation = this.nextPendingGeneration;
    this.nextPendingGeneration += 1;
    this.pendingTurnStartsByThreadId.set(threadId, {
      taskId,
      threadId,
      generation,
      expiresAtMs: boundedExpiry(nowMs, this.earlyNotificationTtlMs),
    });
  }

  /** Drops an unfinished start window without ever assigning its events by thread alone. */
  public abandonTurnStart(taskId: string, threadId: string): void {
    const pending = this.pendingTurnStartsByThreadId.get(threadId);
    if (!pending || pending.taskId !== taskId) {
      return;
    }
    this.pendingTurnStartsByThreadId.delete(threadId);
    this.clearBufferedThread(threadId);
  }

  /** Replays only the exact turn identity after TaskOrchestrator has persisted that identity. */
  public drainTurnStart(
    taskId: string,
    threadId: string,
    turnId: string,
  ): readonly EventCoordinationOutcome[] {
    requireIdentifier(taskId, 'Task');
    requireIdentifier(threadId, 'Thread');
    requireIdentifier(turnId, 'Turn');
    this.pruneEarlyNotifications(this.nowMs());
    const pending = this.pendingTurnStartsByThreadId.get(threadId);
    if (!pending || pending.taskId !== taskId) {
      return [];
    }

    const bucket = this.earlyNotificationsByTurn.get(earlyNotificationKey(threadId, turnId));
    const notifications = bucket
      && bucket.taskId === taskId
      && bucket.generation === pending.generation
      ? [...bucket.notifications].sort((left, right) => left.sequence - right.sequence)
      : [];
    this.pendingTurnStartsByThreadId.delete(threadId);
    // This also discards any same-thread external turn observed during the pending window.
    this.clearBufferedThread(threadId);

    const task = this.dependencies.tasks.findByTurnId(turnId);
    const binding = task ? this.dependencies.bindings.getById(task.bindingId) : undefined;
    if (!task || task.id !== taskId || binding?.threadId !== threadId) {
      return [];
    }
    return notifications.map(({ notification }) => this.handle(notification));
  }

  /** Returns the bounded buffer size after applying TTL expiry. */
  public getBufferedNotificationCount(): number {
    this.pruneEarlyNotifications(this.nowMs());
    return this.earlyNotificationCount;
  }

  /** Handles one notification synchronously and returns its durability boundary. */
  public handle(notification: ServerNotification): EventCoordinationOutcome {
    this.pruneEarlyNotifications(this.nowMs());
    const identity = eventIdentity(notification);
    if (!identity) {
      return 'IGNORED';
    }
    const context = this.resolveContext(identity);
    if (!context) {
      return this.bufferEarlyNotification(identity, notification) ? 'BUFFERED' : 'IGNORED';
    }
    if (isTerminalTaskStatus(context.task.status) || context.entry.state.terminal) {
      return 'IGNORED';
    }
    if (
      notification.method === 'turn/started'
      && !this.convergeRunningTask(context.task.id)
    ) {
      return 'IGNORED';
    }

    const reducedState = this.reduceNotification(context.entry.state, notification, identity);
    if (reducedState === context.entry.state) {
      return 'IGNORED';
    }
    if (notification.method === ITEM_COMPLETED_METHOD) {
      this.flushItems(context.task.id, reducedState);
      context.entry.state = reducedState;
      this.dependencies.scheduleProjection(context.task.id, false);
      return 'FLUSHED';
    }
    if (notification.method === TURN_COMPLETED_METHOD) {
      return this.completeTurn(context, reducedState);
    }

    context.entry.state = reducedState;
    this.dependencies.scheduleProjection(
      context.task.id,
      IMMEDIATE_PROJECTION_METHODS.has(notification.method),
    );
    return 'SCHEDULED';
  }

  /** Returns an immutable in-memory snapshot for diagnostics or projection. */
  public getProjectionSnapshot(turnId: string): EventProjectionSnapshot | undefined {
    const entry = this.reductionsByTurnId.get(turnId);
    return entry ? createProjectionSnapshot(entry.state) : undefined;
  }

  /** Returns the current in-memory projection for one durable task. */
  public getTaskProjectionSnapshot(taskId: string): EventProjectionSnapshot | undefined {
    for (const entry of this.reductionsByTurnId.values()) {
      if (entry.taskId === taskId) {
        return createProjectionSnapshot(entry.state);
      }
    }
    return undefined;
  }

  private resolveContext(identity: EventIdentity): ResolvedContext | null {
    const task = this.dependencies.tasks.findByTurnId(identity.turnId);
    if (!task || task.turnId !== identity.turnId) {
      return null;
    }
    const binding = this.dependencies.bindings.getById(task.bindingId);
    if (!binding || binding.threadId !== identity.threadId) {
      return null;
    }
    if (isTerminalTaskStatus(task.status)) {
      return null;
    }
    const entry = this.getOrCreateEntry(task, identity);
    return entry ? Object.freeze({ task, entry }) : null;
  }

  private bufferEarlyNotification(
    identity: EventIdentity,
    notification: ServerNotification,
  ): boolean {
    // A known turn that failed normal ownership checks must never enter the early buffer.
    if (this.dependencies.tasks.findByTurnId(identity.turnId)) {
      return false;
    }
    const pending = this.pendingTurnStartsByThreadId.get(identity.threadId);
    if (!pending) {
      return false;
    }

    const key = earlyNotificationKey(identity.threadId, identity.turnId);
    let bucket = this.earlyNotificationsByTurn.get(key);
    if (!bucket || bucket.generation !== pending.generation || bucket.taskId !== pending.taskId) {
      if (bucket) {
        this.removeEarlyNotificationBucket(key, bucket);
      }
      bucket = {
        taskId: pending.taskId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        generation: pending.generation,
        expiresAtMs: pending.expiresAtMs,
        notifications: [],
      };
      this.earlyNotificationsByTurn.set(key, bucket);
    }

    if (bucket.notifications.length >= this.earlyNotificationPerTurnLimit) {
      bucket.notifications.shift();
      this.earlyNotificationCount -= 1;
    }
    while (this.earlyNotificationCount >= this.earlyNotificationLimit) {
      this.evictOldestEarlyNotification();
    }
    // Global eviction can remove this bucket when it contains the oldest sole
    // event. Reattach the still-current generation before appending the new one.
    if (this.earlyNotificationsByTurn.get(key) !== bucket) {
      this.earlyNotificationsByTurn.set(key, bucket);
    }
    bucket.notifications.push({
      sequence: this.nextEarlyNotificationSequence,
      notification,
    });
    this.nextEarlyNotificationSequence += 1;
    this.earlyNotificationCount += 1;
    return true;
  }

  private pruneEarlyNotifications(nowMs: number): void {
    for (const [threadId, pending] of this.pendingTurnStartsByThreadId) {
      if (pending.expiresAtMs <= nowMs) {
        this.pendingTurnStartsByThreadId.delete(threadId);
        this.clearBufferedThread(threadId);
      }
    }
    for (const [key, bucket] of this.earlyNotificationsByTurn) {
      if (bucket.expiresAtMs <= nowMs) {
        this.removeEarlyNotificationBucket(key, bucket);
      }
    }
  }

  private clearBufferedThread(threadId: string): void {
    for (const [key, bucket] of this.earlyNotificationsByTurn) {
      if (bucket.threadId === threadId) {
        this.removeEarlyNotificationBucket(key, bucket);
      }
    }
  }

  private removeEarlyNotificationBucket(key: string, bucket: EarlyNotificationBucket): void {
    if (this.earlyNotificationsByTurn.get(key) !== bucket) {
      return;
    }
    this.earlyNotificationsByTurn.delete(key);
    this.earlyNotificationCount -= bucket.notifications.length;
  }

  private evictOldestEarlyNotification(): void {
    let oldestKey: string | undefined;
    let oldestBucket: EarlyNotificationBucket | undefined;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.earlyNotificationsByTurn) {
      const sequence = bucket.notifications[0]?.sequence;
      if (sequence !== undefined && sequence < oldestSequence) {
        oldestKey = key;
        oldestBucket = bucket;
        oldestSequence = sequence;
      }
    }
    if (!oldestKey || !oldestBucket) {
      this.earlyNotificationCount = 0;
      return;
    }
    oldestBucket.notifications.shift();
    this.earlyNotificationCount -= 1;
    if (oldestBucket.notifications.length === 0) {
      this.earlyNotificationsByTurn.delete(oldestKey);
    }
  }

  private getOrCreateEntry(
    task: CoordinatedTask,
    identity: EventIdentity,
  ): ReductionEntry | null {
    const existing = this.reductionsByTurnId.get(identity.turnId);
    if (existing) {
      return existing.taskId === task.id && existing.threadId === identity.threadId
        ? existing
        : null;
    }
    const entry: ReductionEntry = {
      taskId: task.id,
      threadId: identity.threadId,
      state: createEventReducerState(identity.threadId, identity.turnId),
    };
    this.reductionsByTurnId.set(identity.turnId, entry);
    return entry;
  }

  private reduceNotification(
    state: EventReducerState,
    notification: ServerNotification,
    identity: EventIdentity,
  ): EventReducerState {
    if (notification.method !== TURN_COMPLETED_METHOD || !identity.turn) {
      return reduceEvent(state, notification);
    }
    let nextState = state;
    if (Array.isArray(identity.turn.items)) {
      for (const item of identity.turn.items) {
        nextState = reduceEvent(nextState, this.completedItemEvent(identity, item));
      }
    }
    return reduceEvent(nextState, notification);
  }

  private completedItemEvent(identity: EventIdentity, item: ThreadItem): ServerNotification {
    return {
      method: ITEM_COMPLETED_METHOD,
      params: {
        threadId: identity.threadId,
        turnId: identity.turnId,
        item,
        completedAtMs: this.nowMs(),
      },
    };
  }

  private flushItems(taskId: string, state: EventReducerState): void {
    const nowMs = this.nowMs();
    const orderedItems = Object.values(state.items)
      .sort((left, right) => left.order - right.order);
    for (const item of orderedItems) {
      const snapshot = persistedItem(taskId, item, nowMs);
      if (snapshot) {
        this.dependencies.taskItems.upsert(snapshot);
      }
    }
  }

  private completeTurn(
    context: ResolvedContext,
    state: EventReducerState,
  ): EventCoordinationOutcome {
    const snapshot = createProjectionSnapshot(state);
    const nextStatus = terminalTaskStatus(snapshot);
    if (!nextStatus) {
      return 'IGNORED';
    }
    this.flushItems(context.task.id, state);
    this.convergeTerminalTask(context.task.id, nextStatus, snapshot);
    this.dependencies.scheduleProjection(context.task.id, true);
    // Terminal content is durable before projection is scheduled, so the live
    // reducer can be released instead of retaining every completed turn.
    this.reductionsByTurnId.delete(state.turnId);
    return 'TERMINAL';
  }

  private convergeRunningTask(taskId: string): boolean {
    let current = this.dependencies.tasks.getById(taskId);
    for (let attempt = 0; attempt < MAX_TERMINAL_CAS_ATTEMPTS; attempt += 1) {
      if (!current || isTerminalTaskStatus(current.status)) {
        return false;
      }
      if (RUNNING_OR_LATER_ACTIVE_STATUSES.has(current.status)) {
        return true;
      }
      if (!RUNNING_TRANSITION_SOURCES.has(current.status)) {
        return false;
      }
      if (this.dependencies.tasks.transition(
        taskId,
        current.status,
        'RUNNING',
        this.nowMs(),
      )) {
        return true;
      }
      current = this.dependencies.tasks.getById(taskId);
    }
    return current !== undefined && RUNNING_OR_LATER_ACTIVE_STATUSES.has(current.status);
  }

  private convergeTerminalTask(
    taskId: string,
    nextStatus: TaskStatus,
    snapshot: EventProjectionSnapshot,
  ): void {
    let current = this.dependencies.tasks.getById(taskId);
    for (let attempt = 0; attempt < MAX_TERMINAL_CAS_ATTEMPTS; attempt += 1) {
      if (!current) {
        throw new Error('Task disappeared during terminal state convergence');
      }
      if (isTerminalTaskStatus(current.status)) {
        return;
      }
      const transitioned = this.dependencies.tasks.transition(
        taskId,
        current.status,
        nextStatus,
        this.nowMs(),
        terminalFields(nextStatus, snapshot),
      );
      if (transitioned) {
        return;
      }
      current = this.dependencies.tasks.getById(taskId);
    }
    if (current && isTerminalTaskStatus(current.status)) {
      return;
    }
    throw new Error('Task terminal state did not converge after compare-and-set retries');
  }
}

function earlyNotificationKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function requireIdentifier(value: string, label: string): void {
  if (!value.trim()) {
    throw new TypeError(`${label} identity must not be blank`);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedExpiry(nowMs: number, ttlMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError('Event coordinator clock must return a non-negative safe integer');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, nowMs + ttlMs);
}
