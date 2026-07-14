import { createHash } from 'node:crypto';

import { CardKitError, type CardKitClient } from './cardkit-client';
import type { CardKitJson } from './layouts';
import type {
  CardOutboxRecord,
  CardOutboxRepository,
  TaskRecord,
  TaskRepository,
} from '../db/repositories';

export interface CardOutboxStore {
  claimDue(
    leaseOwner: string,
    nowMs: number,
    leaseDurationMs: number,
    limit: number,
  ): readonly CardOutboxRecord[];
  markDelivered(id: string, leaseOwner: string, deliveredAtMs: number): boolean;
  acknowledgeDeliveredSequence(
    id: string,
    leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    nextSequence: number,
    deliveredAtMs: number,
  ): boolean;
  checkpointFinalClose(
    id: string,
    leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    closedSequence: number,
    updatedAtMs: number,
  ): boolean;
  markRetry(
    id: string,
    leaseOwner: string,
    nextAttemptAtMs: number,
    errorCode: string,
    updatedAtMs: number,
  ): boolean;
  markFailed(id: string, leaseOwner: string, errorCode: string, updatedAtMs: number): boolean;
  markClaimedSuperseded(id: string, leaseOwner: string, updatedAtMs: number): boolean;
  markSequenceConflict(id: string, leaseOwner: string, updatedAtMs: number): boolean;
}

export interface TaskCardSequenceStore {
  getById(id: string): TaskRecord | undefined;
}

export interface CardKitDeliveryClient {
  replaceCard(
    cardId: string,
    card: CardKitJson,
    sequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
  closeStreaming(
    cardId: string,
    sequence: number,
    idempotencyKey?: string,
  ): Promise<number>;
}

export interface CardOutboxWorkerDependencies {
  readonly outbox: CardOutboxStore | CardOutboxRepository;
  readonly tasks: TaskCardSequenceStore | TaskRepository;
  readonly cardKit: CardKitDeliveryClient | CardKitClient;
  readonly prepareCard?: (task: TaskRecord, card: CardKitJson) => CardKitJson;
}

export interface CardOutboxWorkerOptions {
  readonly workerId: string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: Error) => void;
  readonly onDeliveryFailed?: (failure: CardDeliveryFailure) => unknown;
}

export interface CardDeliveryFailure {
  readonly outboxId: string;
  readonly taskId: string;
  readonly errorCode: string;
}

type SupportedOperation = 'UPDATE_CARD' | 'FINALIZE_CARD' | 'FINALIZE_CARD_REPLACE';

// FINALIZE_CARD can perform three sequential network calls. Keep the lease
// comfortably above their combined request timeouts to prevent mid-flight reclaim.
const DEFAULT_LEASE_DURATION_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

/**
 * Delivers the durable CardKit outbox through one process-local writer.
 * CardKit sequence changes and delivery checkpoints are acknowledged atomically.
 */
export class CardOutboxWorker {
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly onError: (error: Error) => void;
  private readonly onDeliveryFailed: (failure: CardDeliveryFailure) => unknown;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<boolean> | undefined;

  public constructor(
    private readonly dependencies: CardOutboxWorkerDependencies,
    options: CardOutboxWorkerOptions,
  ) {
    this.workerId = requireNonBlank(options.workerId, 'workerId');
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      'leaseDurationMs',
    );
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      'pollIntervalMs',
    );
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      'maxAttempts',
    );
    this.baseRetryDelayMs = positiveInteger(
      options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS,
      'baseRetryDelayMs',
    );
    this.maxRetryDelayMs = positiveInteger(
      options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
      'maxRetryDelayMs',
    );
    if (this.maxRetryDelayMs < this.baseRetryDelayMs) {
      throw new RangeError('maxRetryDelayMs must be greater than or equal to baseRetryDelayMs');
    }
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.onDeliveryFailed = options.onDeliveryFailed ?? (() => undefined);
  }

  /** Starts polling. Calling start repeatedly does not create additional writers. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  /** Stops polling and waits for the active CardKit request, if any. */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.activeDrain) {
      await this.activeDrain;
    }
  }

  /** Claims and processes at most one due outbox row. */
  public async drainOnce(): Promise<boolean> {
    if (this.activeDrain) {
      return false;
    }

    const drain = this.processOne();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) {
        this.activeDrain = undefined;
      }
    }
  }

  private async processOne(): Promise<boolean> {
    const claimed = this.dependencies.outbox.claimDue(
      this.workerId,
      this.now(),
      this.leaseDurationMs,
      1,
    );
    const record = claimed[0];
    if (!record) {
      return false;
    }
    if (claimed.length !== 1) {
      throw new Error('Outbox repository returned more than the requested single row');
    }

    const operation = parseOperation(record.operation);
    if (!operation) {
      this.failRecord(record, 'UNSUPPORTED_CARD_OPERATION');
      return true;
    }

    let card: CardKitJson;
    try {
      card = parseCardPayload(record.payloadJson);
    } catch {
      this.failRecord(record, 'INVALID_CARD_PAYLOAD');
      return true;
    }

    const task = this.dependencies.tasks.getById(record.taskId);
    if (!task) {
      this.failRecord(record, 'TASK_NOT_FOUND');
      return true;
    }
    if (!task.cardId) {
      this.failRecord(record, 'CARD_NOT_ATTACHED');
      return true;
    }
    // claimDue increments attemptCount; only the first claim proves the payload was never sent.
    // Reclaimed rows must replay their stable UUID so a prior remote write can be acknowledged.
    if (
      operation === 'UPDATE_CARD'
      && record.projectionRevision < task.projectionRevision
      && record.attemptCount === 1
    ) {
      this.requireOutboxMutation(
        this.dependencies.outbox.markClaimedSuperseded(
          record.id,
          this.workerId,
          this.now(),
        ),
        'mark stale projection superseded failed',
      );
      return true;
    }

    const deliveryCard = this.dependencies.prepareCard
      ? this.dependencies.prepareCard(task, card)
      : card;
    if (operation === 'UPDATE_CARD') {
      await this.deliverUpdate(record, task, deliveryCard);
    } else if (operation === 'FINALIZE_CARD_REPLACE') {
      await this.deliverFinalReplace(record, task, deliveryCard);
    } else {
      await this.deliverFinal(record, task, deliveryCard);
    }
    return true;
  }

  private async deliverUpdate(
    record: CardOutboxRecord,
    task: TaskRecord,
    card: CardKitJson,
  ): Promise<void> {
    const currentSequence = task.cardSequence;
    let nextSequence: number;
    try {
      nextSequence = await this.dependencies.cardKit.replaceCard(
        requireCardId(task),
        card,
        currentSequence,
        cardOperationId(record, 'replace'),
      );
    } catch (error) {
      this.handleRetryableDeliveryFailure(record, error);
      return;
    }

    if (!isNextSequence(currentSequence, nextSequence)) {
      this.markSequenceConflict(record);
      return;
    }
    if (!this.acknowledgeDelivery(record, task.id, currentSequence, nextSequence)) {
      this.markSequenceConflict(record);
    }
  }

  private async deliverFinal(
    record: CardOutboxRecord,
    task: TaskRecord,
    card: CardKitJson,
  ): Promise<void> {
    const initialSequence = task.cardSequence;
    let closedSequence: number;
    try {
      closedSequence = await this.dependencies.cardKit.closeStreaming(
        requireCardId(task),
        initialSequence,
        cardOperationId(record, 'close'),
      );
    } catch (error) {
      this.handleRetryableDeliveryFailure(record, error);
      return;
    }

    if (!isNextSequence(initialSequence, closedSequence)) {
      this.markSequenceConflict(record);
      return;
    }
    if (!this.dependencies.outbox.checkpointFinalClose(
      record.id,
      this.workerId,
      task.id,
      initialSequence,
      closedSequence,
      this.now(),
    )) {
      this.markSequenceConflict(record);
      return;
    }

    await this.replaceFinalCard(record, task, card, closedSequence);
  }

  private async deliverFinalReplace(
    record: CardOutboxRecord,
    task: TaskRecord,
    card: CardKitJson,
  ): Promise<void> {
    await this.replaceFinalCard(record, task, card, task.cardSequence);
  }

  private async replaceFinalCard(
    record: CardOutboxRecord,
    task: TaskRecord,
    card: CardKitJson,
    closedSequence: number,
  ): Promise<void> {
    let terminalSequence: number;
    try {
      terminalSequence = await this.dependencies.cardKit.replaceCard(
        requireCardId(task),
        card,
        closedSequence,
        cardOperationId(record, 'final-replace'),
      );
    } catch (error) {
      this.handlePostCloseFailure(record, error);
      return;
    }

    if (!isNextSequence(closedSequence, terminalSequence)) {
      this.markSequenceConflict(record);
      return;
    }
    if (!this.acknowledgeDelivery(record, task.id, closedSequence, terminalSequence)) {
      this.markSequenceConflict(record);
    }
  }

  private handleRetryableDeliveryFailure(record: CardOutboxRecord, error: unknown): void {
    if (error instanceof CardKitError && error.kind === 'SEQUENCE_UNKNOWN') {
      this.markSequenceConflict(record);
      return;
    }
    if (error instanceof CardKitError && error.retryable) {
      if (record.attemptCount >= this.maxAttempts) {
        this.failRecord(record, `CARDKIT_RETRY_EXHAUSTED_${error.kind}`);
        return;
      }
      const nowMs = this.now();
      const nextAttemptAtMs = nowMs + this.retryDelay(record.attemptCount);
      this.requireOutboxMutation(
        this.dependencies.outbox.markRetry(
          record.id,
          this.workerId,
          nextAttemptAtMs,
          `CARDKIT_${error.kind}`,
          nowMs,
        ),
        'mark CardKit retry failed',
      );
      return;
    }
    const errorCode = error instanceof CardKitError
      ? `CARDKIT_${error.kind}`
      : 'UNEXPECTED_CARDKIT_ERROR';
    this.failRecord(record, errorCode);
  }

  private handlePostCloseFailure(record: CardOutboxRecord, error: unknown): void {
    if (
      error instanceof CardKitError
      && (error.kind === 'HTTP_FATAL' || error.kind === 'API_FATAL')
    ) {
      this.failRecord(record, `CARDKIT_${error.kind}`);
      return;
    }
    this.markSequenceConflict(record);
  }

  private acknowledgeDelivery(
    record: CardOutboxRecord,
    taskId: string,
    expectedSequence: number,
    nextSequence: number,
  ): boolean {
    return this.dependencies.outbox.acknowledgeDeliveredSequence(
      record.id,
      this.workerId,
      taskId,
      expectedSequence,
      nextSequence,
      this.now(),
    );
  }

  private markSequenceConflict(record: CardOutboxRecord): void {
    this.requireOutboxMutation(
      this.dependencies.outbox.markSequenceConflict(record.id, this.workerId, this.now()),
      'mark card sequence conflict failed',
    );
    this.notifyDeliveryFailed(record, 'CARD_SEQUENCE_CONFLICT');
  }

  private failRecord(record: CardOutboxRecord, errorCode: string): void {
    this.requireOutboxMutation(
      this.dependencies.outbox.markFailed(record.id, this.workerId, errorCode, this.now()),
      'mark card delivery failed',
    );
    this.notifyDeliveryFailed(record, errorCode);
  }

  private notifyDeliveryFailed(record: CardOutboxRecord, errorCode: string): void {
    try {
      const result = this.onDeliveryFailed(Object.freeze({
        outboxId: record.id,
        taskId: record.taskId,
        errorCode,
      }));
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Delivery state is already durable; observability callbacks cannot undo it.
    }
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return Math.min(
      this.maxRetryDelayMs,
      this.baseRetryDelayMs * (2 ** exponent),
    );
  }

  private requireOutboxMutation(success: boolean, message: string): void {
    if (!success) {
      throw new Error(message);
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let processed = false;
    try {
      processed = await this.drainOnce();
    } catch (error) {
      this.onError(toError(error));
    }
    if (this.running) {
      this.schedule(processed ? 0 : this.pollIntervalMs);
    }
  }
}

function parseOperation(value: string): SupportedOperation | undefined {
  return value === 'UPDATE_CARD'
    || value === 'FINALIZE_CARD'
    || value === 'FINALIZE_CARD_REPLACE'
    ? value
    : undefined;
}

function parseCardPayload(payloadJson: string): CardKitJson {
  const parsed: unknown = JSON.parse(payloadJson);
  if (!isPlainObject(parsed)) {
    throw new TypeError('Card outbox payload must be a plain object');
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function';
}

function isNextSequence(currentSequence: number, nextSequence: number): boolean {
  return Number.isSafeInteger(nextSequence) && nextSequence === currentSequence + 1;
}

function requireCardId(task: TaskRecord): string {
  if (!task.cardId) {
    throw new Error('Task card id is not attached');
  }
  return task.cardId;
}

function cardOperationId(record: CardOutboxRecord, stage: string): string {
  return createHash('sha256')
    .update(record.idempotencyKey)
    .update('\0')
    .update(stage)
    .digest('hex');
}

function requireNonBlank(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new RangeError(`${fieldName} must not be blank`);
  }
  return value;
}

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
