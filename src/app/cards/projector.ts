import { CardProjectionPayload, SanitizedCardText, TaskStatus } from '../domain';
import { BridgeConfig } from '../domain';
import { BridgeDatabase } from '../db/database';
import { BridgeRepositories } from '../db/repositories';
import { TaskItemRecord, TaskRecord, ThreadBindingRecord } from '../db/repositories';
import { EventProjectionSnapshot } from '../codex/event-reducer';
import { CardKitJson, createTaskCard } from './layouts';
import { sanitizeCardText } from './sanitizer';
import { TASK_CANCEL_TOKEN_PLACEHOLDER } from './action-hydrator';

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED',
]);
export const MAX_TASK_CARD_JSON_BYTES = 29 * 1_024;

const CARD_BUDGET_TRUNCATION_NOTICE = '\n（内容因卡片大小限制已截断）';
const TASK_CANCEL_TOKEN_BYTES = 43;
type DynamicPayloadField = 'prompt' | 'commentary' | 'toolSummary' | 'finalAnswer';

export interface TaskProjection {
  readonly payload: CardProjectionPayload;
  readonly card: CardKitJson;
}

export interface TaskProjectionOptions {
  readonly maxTextLength: number;
  readonly cancelToken?: string;
  readonly liveSnapshot?: EventProjectionSnapshot;
  readonly targetLabel?: string;
}

function joinContent(items: readonly TaskItemRecord[]): string {
  return items
    .map((item) => item.contentText?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function sanitize(value: string, maximum: number): SanitizedCardText {
  return sanitizeCardText(value, { maxLength: maximum });
}

function mergeProjectionText(persisted: string, live: string): string {
  if (!persisted) {
    return live;
  }
  if (!live || persisted.includes(live)) {
    return persisted;
  }
  if (live.includes(persisted)) {
    return live;
  }
  return `${persisted}\n\n${live}`;
}

function statusFooter(task: TaskRecord): string {
  const reference = task.id.slice(0, 8);
  if (task.errorCode) {
    return `任务 ${reference} · 状态 ${task.status} · 错误 ${task.errorCode}`;
  }
  return `任务 ${reference} · 状态 ${task.status}`;
}

function cardJsonBytes(card: CardKitJson): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

function renderedCard(
  payload: CardProjectionPayload,
  status: TaskStatus,
  cancelToken: string | undefined,
): CardKitJson {
  return createTaskCard({ payload, status, cancelToken });
}

function deliveryByteBudget(cancelToken: string | undefined): number {
  if (cancelToken !== TASK_CANCEL_TOKEN_PLACEHOLDER) {
    return MAX_TASK_CARD_JSON_BYTES;
  }
  return MAX_TASK_CARD_JSON_BYTES
    - Math.max(0, TASK_CANCEL_TOKEN_BYTES - Buffer.byteLength(cancelToken, 'utf8'));
}

function candidateWithinBudget(
  payload: CardProjectionPayload,
  field: DynamicPayloadField,
  candidate: SanitizedCardText,
  status: TaskStatus,
  cancelToken: string | undefined,
  maximumBytes: number,
): boolean {
  return cardJsonBytes(renderedCard(
    Object.freeze({ ...payload, [field]: candidate }),
    status,
    cancelToken,
  )) <= maximumBytes;
}

function fitFieldToCardBudget(
  payload: CardProjectionPayload,
  field: DynamicPayloadField,
  source: SanitizedCardText,
  status: TaskStatus,
  cancelToken: string | undefined,
  maximumBytes: number,
): SanitizedCardText {
  if (!source || candidateWithinBudget(
    payload,
    field,
    source,
    status,
    cancelToken,
    maximumBytes,
  )) {
    return source;
  }

  const codePoints = Array.from(source);
  let lowerBound = 1;
  let upperBound = codePoints.length - 1;
  let best = '' as SanitizedCardText;
  while (lowerBound <= upperBound) {
    const middle = Math.floor((lowerBound + upperBound) / 2);
    const candidate = (
      `${codePoints.slice(0, middle).join('')}${CARD_BUDGET_TRUNCATION_NOTICE}`
    ) as SanitizedCardText;
    if (candidateWithinBudget(
      payload,
      field,
      candidate,
      status,
      cancelToken,
      maximumBytes,
    )) {
      best = candidate;
      lowerBound = middle + 1;
    } else {
      upperBound = middle - 1;
    }
  }
  return best;
}

function fitProjectionToCardBudget(
  source: CardProjectionPayload,
  status: TaskStatus,
  cancelToken: string | undefined,
): TaskProjection {
  const maximumBytes = deliveryByteBudget(cancelToken);
  const completeCard = renderedCard(source, status, cancelToken);
  if (cardJsonBytes(completeCard) <= maximumBytes) {
    return Object.freeze({ payload: source, card: completeCard });
  }

  let payload: CardProjectionPayload = Object.freeze({
    ...source,
    prompt: '' as SanitizedCardText,
    commentary: '' as SanitizedCardText,
    toolSummary: '' as SanitizedCardText,
    finalAnswer: '' as SanitizedCardText,
  });
  const priority: readonly DynamicPayloadField[] = source.terminal
    ? ['finalAnswer', 'prompt', 'commentary', 'toolSummary']
    : ['prompt', 'commentary', 'toolSummary', 'finalAnswer'];
  for (const field of priority) {
    payload = Object.freeze({
      ...payload,
      [field]: fitFieldToCardBudget(
        payload,
        field,
        source[field],
        status,
        cancelToken,
        maximumBytes,
      ),
    });
  }
  const card = renderedCard(payload, status, cancelToken);
  if (cardJsonBytes(card) > maximumBytes) {
    throw new RangeError('Fixed task card content exceeds the CardKit byte budget');
  }
  return Object.freeze({ payload, card });
}

/** Builds one complete sanitized card snapshot from durable reduced state. */
export function buildTaskProjection(
  task: TaskRecord,
  items: readonly TaskItemRecord[],
  options: TaskProjectionOptions,
): TaskProjection {
  const commentaryItems = items.filter((item) => (
    item.itemType === 'reasoning_summary'
    || (item.itemType === 'agent_message' && item.phase === 'commentary')
  ));
  const toolItems = items.filter((item) => (
    item.itemType === 'command_execution'
    || item.itemType === 'file_change'
    || item.itemType === 'tool_call'
    || item.itemType === 'error'
  ));
  const finalItems = items.filter((item) => (
    item.itemType === 'agent_message' && item.phase === 'final_answer'
  ));
  const persistedCommentary = joinContent(commentaryItems);
  const persistedToolSummary = joinContent(toolItems);
  const persistedFinalAnswer = joinContent(finalItems) || task.finalText || '';
  const liveCommentary = options.liveSnapshot
    ? [
        options.liveSnapshot.reasoningSummary,
        options.liveSnapshot.commentary,
        options.liveSnapshot.pendingAgentText,
      ].filter(Boolean).join('\n\n')
    : '';
  const liveToolSummary = options.liveSnapshot
    ? [
        ...options.liveSnapshot.commands.map((command) => (
          [command.command, command.outputTail].filter(Boolean).join('\n')
        )),
        options.liveSnapshot.errorMessage
          ? `App Server 错误：${options.liveSnapshot.errorMessage}`
          : '',
      ].filter(Boolean).join('\n\n')
    : '';
  const terminal = TERMINAL_STATUSES.has(task.status as TaskStatus);
  const finalText = options.liveSnapshot?.finalAnswer || persistedFinalAnswer;
  const payload: CardProjectionPayload = Object.freeze({
    title: sanitize('Codex 任务', 200),
    target: sanitize(options.targetLabel ?? '未记录', 200),
    prompt: sanitize(task.prompt, options.maxTextLength),
    commentary: sanitize(
      mergeProjectionText(persistedCommentary, liveCommentary),
      options.maxTextLength,
    ),
    toolSummary: sanitize(
      mergeProjectionText(persistedToolSummary, liveToolSummary),
      options.maxTextLength,
    ),
    finalAnswer: sanitize(finalText, options.maxTextLength),
    footer: sanitize(statusFooter(task), 500),
    terminal,
  });

  return fitProjectionToCardBudget(
    payload,
    task.status as TaskStatus,
    terminal ? undefined : options.cancelToken,
  );
}

/**
 * Coalesces projection requests per task while preserving immediate terminal
 * flushes. It does not perform IO itself and never runs two flushes for the
 * same task concurrently.
 */
export class ProjectionCoalescer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly requestedAgain = new Set<string>();

  public constructor(
    private readonly intervalMs: number,
    private readonly flush: (taskId: string) => Promise<void>,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError('Projection interval must be a positive integer');
    }
  }

  public request(taskId: string, immediate = false): void {
    const currentTimer = this.timers.get(taskId);
    if (immediate && currentTimer) {
      clearTimeout(currentTimer);
      this.timers.delete(taskId);
    }
    if (this.running.has(taskId)) {
      this.requestedAgain.add(taskId);
      return;
    }
    if (immediate) {
      this.run(taskId);
      return;
    }
    if (currentTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.run(taskId);
    }, this.intervalMs);
    timer.unref();
    this.timers.set(taskId, timer);
  }

  public async drain(): Promise<void> {
    while (this.timers.size > 0 || this.running.size > 0 || this.requestedAgain.size > 0) {
      for (const [taskId, timer] of this.timers) {
        clearTimeout(timer);
        this.timers.delete(taskId);
        this.run(taskId);
      }
      await Promise.all([...this.running.values()]);
    }
  }

  public stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.requestedAgain.clear();
  }

  private run(taskId: string): void {
    const operation = this.flush(taskId).catch((error: unknown) => {
      this.onError(error instanceof Error ? error : new Error('Card projection failed'));
    }).finally(() => {
      if (this.running.get(taskId) !== operation) {
        return;
      }
      this.running.delete(taskId);
      if (this.requestedAgain.delete(taskId)) {
        this.request(taskId, true);
      }
    });
    this.running.set(taskId, operation);
  }
}

const CANCELLABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'CARD_CREATING',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'QUEUED',
  'RECOVERING',
]);

/** Persists coalesced complete-card snapshots into the durable CardKit outbox. */
export class DurableCardProjector {
  private readonly coalescer: ProjectionCoalescer;

  public constructor(
    private readonly database: BridgeDatabase,
    private readonly config: BridgeConfig,
    intervalMs: number = config.cardUpdateIntervalMs,
    private readonly now: () => number = Date.now,
    onError: (error: Error) => void = () => undefined,
    private readonly liveSnapshotProvider: (
      taskId: string,
    ) => EventProjectionSnapshot | undefined = () => undefined,
  ) {
    this.coalescer = new ProjectionCoalescer(
      intervalMs,
      (taskId) => this.flush(taskId),
      onError,
    );
  }

  public request(taskId: string, immediate = false): void {
    this.coalescer.request(taskId, immediate);
  }

  public drain(): Promise<void> {
    return this.coalescer.drain();
  }

  public stop(): void {
    this.coalescer.stop();
  }

  private async flush(taskId: string): Promise<void> {
    this.database.transaction((executor) => {
      const repositories = new BridgeRepositories(executor);
      const task = repositories.tasks.getById(taskId);
      if (!task?.cardId) {
        return;
      }
      const binding = repositories.threadBindings.getById(task.bindingId);
      if (!binding) {
        throw new Error('Task projection has no durable thread binding');
      }
      const terminal = TERMINAL_STATUSES.has(task.status as TaskStatus);
      const terminalIdempotencyKey = `${task.id}:terminal`;
      if (terminal && repositories.cardOutbox.findByIdempotencyKey(terminalIdempotencyKey)) {
        return;
      }

      const cancelToken = CANCELLABLE_STATUSES.has(task.status as TaskStatus)
        && !task.cancelRequested
        ? TASK_CANCEL_TOKEN_PLACEHOLDER
        : undefined;
      const projection = buildTaskProjection(
        task,
        repositories.taskItems.listByTaskId(task.id),
        {
          maxTextLength: this.config.maxTextLength,
          cancelToken,
          targetLabel: describeTaskTarget(binding),
          liveSnapshot: this.liveSnapshotProvider(task.id),
        },
      );
      const nowMs = this.now();
      const revision = repositories.tasks.incrementProjectionRevision(task.id, nowMs);
      if (revision === undefined) {
        throw new Error('Task projection revision could not be incremented');
      }
      repositories.cardOutbox.supersedePendingBeforeRevision(task.id, revision, nowMs);
      const operation = terminal ? 'FINALIZE_CARD' : 'UPDATE_CARD';
      repositories.cardOutbox.enqueue({
        taskId: task.id,
        operation,
        projectionRevision: revision,
        cardSequence: task.cardSequence,
        idempotencyKey: terminal ? terminalIdempotencyKey : `${task.id}:projection:${revision}`,
        payloadJson: JSON.stringify(projection.card),
        nowMs,
      });
    });
  }
}

/** Produces a bounded non-secret label for the task's effective immutable target. */
export function describeTaskTarget(binding: ThreadBindingRecord): string {
  const workspaceName = binding.workspacePath
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? '未知工作区';
  const threadId = binding.threadId ?? '未分配';
  const fingerprint = threadId.length <= 12
    ? threadId
    : `${threadId.slice(0, 6)}…${threadId.slice(-6)}`;
  return `工作区：${workspaceName} · 会话标识：${fingerprint}`;
}
