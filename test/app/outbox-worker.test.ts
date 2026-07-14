import assert from 'node:assert/strict';
import test from 'node:test';

import { CardKitError } from '../../src/app/cards/cardkit-client';
import {
  CardOutboxWorker,
  type CardDeliveryFailure,
  type CardKitDeliveryClient,
  type CardOutboxStore,
  type TaskCardSequenceStore,
} from '../../src/app/cards/outbox-worker';
import type { CardKitJson } from '../../src/app/cards/layouts';
import type { CardOutboxRecord, TaskRecord } from '../../src/app/db/repositories';

class FakeOutbox implements CardOutboxStore {
  readonly calls: string[] = [];
  readonly claimLimits: number[] = [];
  private tasks: FakeTasks | undefined;

  public constructor(private readonly queued: CardOutboxRecord[]) {}

  public claimDue(
    _leaseOwner: string,
    _nowMs: number,
    _leaseDurationMs: number,
    limit: number,
  ): readonly CardOutboxRecord[] {
    this.calls.push('claim');
    this.claimLimits.push(limit);
    const record = this.queued.shift();
    return record ? [record] : [];
  }

  public markDelivered(): boolean {
    this.calls.push('delivered');
    return true;
  }

  public attachTasks(tasks: FakeTasks): void {
    this.tasks = tasks;
  }

  public acknowledgeDeliveredSequence(
    _id: string,
    _leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    nextSequence: number,
  ): boolean {
    if (!this.tasks?.advanceCardSequence(taskId, expectedSequence, nextSequence)) {
      return false;
    }
    return this.markDelivered();
  }

  public checkpointFinalClose(
    _id: string,
    _leaseOwner: string,
    taskId: string,
    expectedSequence: number,
    closedSequence: number,
  ): boolean {
    if (!this.tasks?.advanceCardSequence(taskId, expectedSequence, closedSequence)) {
      return false;
    }
    this.calls.push('final-close-checkpoint');
    return true;
  }

  public markRetry(
    _id: string,
    _leaseOwner: string,
    nextAttemptAtMs: number,
    errorCode: string,
  ): boolean {
    this.calls.push(`retry:${nextAttemptAtMs}:${errorCode}`);
    return true;
  }

  public markFailed(
    _id: string,
    _leaseOwner: string,
    errorCode: string,
  ): boolean {
    this.calls.push(`failed:${errorCode}`);
    return true;
  }

  public markClaimedSuperseded(): boolean {
    this.calls.push('superseded');
    return true;
  }

  public markSequenceConflict(): boolean {
    this.calls.push('sequence-conflict');
    return true;
  }
}

class FakeTasks implements TaskCardSequenceStore {
  readonly calls: string[] = [];

  public constructor(
    private task: TaskRecord | undefined,
    private readonly rejectAdvance = false,
  ) {}

  public getById(id: string): TaskRecord | undefined {
    this.calls.push(`get:${id}`);
    return this.task;
  }

  public advanceCardSequence(
    id: string,
    expectedSequence: number,
    nextSequence: number,
  ): boolean {
    this.calls.push(`advance:${expectedSequence}:${nextSequence}`);
    if (
      this.rejectAdvance
      || !this.task
      || this.task.id !== id
      || this.task.cardSequence !== expectedSequence
    ) {
      return false;
    }
    this.task = { ...this.task, cardSequence: nextSequence };
    return true;
  }
}

function outboxRecord(
  operation: string,
  overrides: Partial<CardOutboxRecord> = {},
): CardOutboxRecord {
  return {
    id: 'outbox-1',
    taskId: 'task-1',
    operation,
    projectionRevision: 1,
    cardSequence: 99,
    idempotencyKey: 'projection-1',
    payloadJson: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    state: 'IN_FLIGHT',
    attemptCount: 1,
    nextAttemptAtMs: 0,
    leaseOwner: 'worker-1',
    leaseUntilMs: 10_000,
    lastErrorCode: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    deliveredAtMs: null,
    ...overrides,
  };
}

function taskRecord(cardSequence: number): TaskRecord {
  return {
    id: 'task-1',
    bindingId: 'binding-1',
    sourceInboxId: 'inbox-1',
    prompt: 'Run task',
    status: 'RUNNING',
    turnId: 'turn-1',
    cardId: 'card-1',
    cardMessageId: 'message-1',
    cardSequence,
    projectionRevision: 1,
    finalText: null,
    errorCode: null,
    cancelRequested: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    completedAtMs: null,
  };
}

function worker(
  outbox: FakeOutbox,
  tasks: FakeTasks,
  cardKit: CardKitDeliveryClient,
  options: {
    readonly nowMs?: number;
    readonly maxAttempts?: number;
    readonly baseRetryDelayMs?: number;
    readonly maxRetryDelayMs?: number;
    readonly onDeliveryFailed?: (failure: CardDeliveryFailure) => unknown;
  } = {},
): CardOutboxWorker {
  outbox.attachTasks(tasks);
  return new CardOutboxWorker(
    { outbox, tasks, cardKit },
    {
      workerId: 'worker-1',
      now: () => options.nowMs ?? 1_000,
      maxAttempts: options.maxAttempts,
      baseRetryDelayMs: options.baseRetryDelayMs,
      maxRetryDelayMs: options.maxRetryDelayMs,
      onDeliveryFailed: options.onDeliveryFailed,
    },
  );
}

test('UPDATE_CARD claims one row and replaces at the task acknowledged sequence', async () => {
  const order: string[] = [];
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD')]);
  const tasks = new FakeTasks(taskRecord(7));
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (cardId, card, sequence, idempotencyKey) => {
      order.push(`replace:${cardId}:${sequence}:${idempotencyKey}`);
      assert.equal(card.schema, '2.0');
      assert.equal(idempotencyKey?.length, 64);
      return sequence + 1;
    },
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };

  assert.equal(await worker(outbox, tasks, cardKit).drainOnce(), true);

  assert.deepEqual(outbox.claimLimits, [1]);
  assert.equal(order.length, 1);
  assert.match(order[0] ?? '', /^replace:card-1:7:[a-f0-9]{64}$/);
  assert.deepEqual(tasks.calls, ['get:task-1', 'advance:7:8']);
  assert.deepEqual(outbox.calls, ['claim', 'delivered']);
});

test('UPDATE_CARD reuses one stable operation UUID across delivery retries', async () => {
  const outbox = new FakeOutbox([
    outboxRecord('UPDATE_CARD', { attemptCount: 1 }),
    outboxRecord('UPDATE_CARD', { attemptCount: 2 }),
  ]);
  const tasks = new FakeTasks(taskRecord(7));
  const operationIds: string[] = [];
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (_cardId, _card, sequence, idempotencyKey) => {
      assert.ok(idempotencyKey);
      operationIds.push(idempotencyKey);
      if (operationIds.length === 1) {
        throw new CardKitError('NETWORK_RETRYABLE', 'temporary network failure');
      }
      return sequence + 1;
    },
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };
  const outboxWorker = worker(outbox, tasks, cardKit, { maxAttempts: 3 });

  assert.equal(await outboxWorker.drainOnce(), true);
  assert.equal(await outboxWorker.drainOnce(), true);

  assert.equal(operationIds.length, 2);
  assert.equal(operationIds[0], operationIds[1]);
  assert.match(operationIds[0] ?? '', /^[a-f0-9]{64}$/);
});

test('never-attempted stale revisions are superseded before delivery', async () => {
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD', {
    attemptCount: 1,
    projectionRevision: 1,
  })]);
  const currentTask = { ...taskRecord(7), projectionRevision: 2 };
  const tasks = new FakeTasks(currentTask);
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async () => assert.fail('stale projection must not be delivered'),
    closeStreaming: async () => assert.fail('stale projection must not be delivered'),
  };

  assert.equal(await worker(outbox, tasks, cardKit).drainOnce(), true);
  assert.deepEqual(outbox.calls, ['claim', 'superseded']);
});

test('reclaimed stale revisions replay the stable UUID and acknowledge sequence', async () => {
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD', {
    attemptCount: 2,
    projectionRevision: 1,
  })]);
  const currentTask = { ...taskRecord(7), projectionRevision: 2 };
  const tasks = new FakeTasks(currentTask);
  const deliveries: Array<{ readonly sequence: number; readonly operationId?: string }> = [];
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (_cardId, _card, sequence, idempotencyKey) => {
      deliveries.push({ sequence, operationId: idempotencyKey });
      return sequence + 1;
    },
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };

  assert.equal(await worker(outbox, tasks, cardKit).drainOnce(), true);

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.sequence, 7);
  assert.match(deliveries[0]?.operationId ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(tasks.calls, ['get:task-1', 'advance:7:8']);
  assert.deepEqual(outbox.calls, ['claim', 'delivered']);
});

test('FINALIZE_CARD closes, CAS advances, replaces terminal card, CAS advances, then delivers', async () => {
  const order: string[] = [];
  const outbox = new FakeOutbox([outboxRecord('FINALIZE_CARD')]);
  const tasks = new FakeTasks(taskRecord(4));
  const cardKit: CardKitDeliveryClient = {
    closeStreaming: async (_cardId, sequence, idempotencyKey) => {
      order.push(`close:${sequence}:${idempotencyKey}`);
      return sequence + 1;
    },
    replaceCard: async (_cardId, _card, sequence, idempotencyKey) => {
      order.push(`replace:${sequence}:${idempotencyKey}`);
      return sequence + 1;
    },
  };

  assert.equal(await worker(outbox, tasks, cardKit).drainOnce(), true);

  assert.equal(order.length, 2);
  assert.match(order[0] ?? '', /^close:4:[a-f0-9]{64}$/);
  assert.match(order[1] ?? '', /^replace:5:[a-f0-9]{64}$/);
  assert.notEqual(order[0]?.split(':')[2], order[1]?.split(':')[2]);
  assert.deepEqual(tasks.calls, ['get:task-1', 'advance:4:5', 'advance:5:6']);
  assert.deepEqual(outbox.calls, ['claim', 'final-close-checkpoint', 'delivered']);
});

test('retryable CardKit failures use bounded exponential backoff then fail', async () => {
  const retryError = new CardKitError('HTTP_RETRYABLE', 'rate limited');
  const retryOutbox = new FakeOutbox([
    outboxRecord('UPDATE_CARD', { attemptCount: 2 }),
  ]);
  const failingClient: CardKitDeliveryClient = {
    replaceCard: async () => { throw retryError; },
    closeStreaming: async () => { throw retryError; },
  };
  await worker(
    retryOutbox,
    new FakeTasks(taskRecord(0)),
    failingClient,
    {
      nowMs: 5_000,
      maxAttempts: 4,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1_000,
    },
  ).drainOnce();
  assert.deepEqual(retryOutbox.calls, [
    'claim',
    'retry:5200:CARDKIT_HTTP_RETRYABLE',
  ]);

  const exhaustedOutbox = new FakeOutbox([
    outboxRecord('UPDATE_CARD', { attemptCount: 4 }),
  ]);
  await worker(
    exhaustedOutbox,
    new FakeTasks(taskRecord(0)),
    failingClient,
    { maxAttempts: 4 },
  ).drainOnce();
  assert.deepEqual(exhaustedOutbox.calls, [
    'claim',
    'failed:CARDKIT_RETRY_EXHAUSTED_HTTP_RETRYABLE',
  ]);
});

test('SEQUENCE_UNKNOWN immediately becomes a non-retryable sequence conflict', async () => {
  const failures: CardDeliveryFailure[] = [];
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD')]);
  const sequenceError = new CardKitError('SEQUENCE_UNKNOWN', 'sequence rejected');
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async () => { throw sequenceError; },
    closeStreaming: async () => { throw sequenceError; },
  };

  await worker(outbox, new FakeTasks(taskRecord(3)), cardKit, {
    onDeliveryFailed: (failure) => { failures.push(failure); },
  }).drainOnce();

  assert.deepEqual(outbox.calls, ['claim', 'sequence-conflict']);
  assert.deepEqual(failures, [{
    outboxId: 'outbox-1',
    taskId: 'task-1',
    errorCode: 'CARD_SEQUENCE_CONFLICT',
  }]);
});

test('successful replace with a failed task sequence CAS becomes a sequence conflict', async () => {
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD')]);
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (_cardId, _card, sequence) => sequence + 1,
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };

  await worker(outbox, new FakeTasks(taskRecord(3), true), cardKit).drainOnce();

  assert.deepEqual(outbox.calls, ['claim', 'sequence-conflict']);
});

test('FINALIZE_CARD never retries an uncertain failure after closeStreaming succeeds', async () => {
  const outbox = new FakeOutbox([outboxRecord('FINALIZE_CARD')]);
  const networkError = new CardKitError('NETWORK_RETRYABLE', 'connection lost');
  const cardKit: CardKitDeliveryClient = {
    closeStreaming: async (_cardId, sequence) => sequence + 1,
    replaceCard: async () => { throw networkError; },
  };

  await worker(outbox, new FakeTasks(taskRecord(10)), cardKit).drainOnce();

  assert.deepEqual(outbox.calls, ['claim', 'final-close-checkpoint', 'sequence-conflict']);
});

test('reclaimed FINALIZE_CARD_REPLACE resumes after the durable close checkpoint', async () => {
  const order: string[] = [];
  const outbox = new FakeOutbox([outboxRecord('FINALIZE_CARD_REPLACE')]);
  const tasks = new FakeTasks(taskRecord(12));
  const cardKit: CardKitDeliveryClient = {
    closeStreaming: async () => assert.fail('checkpointed finalization must not close twice'),
    replaceCard: async (_cardId, _card, sequence, idempotencyKey) => {
      order.push(`replace:${sequence}:${idempotencyKey}`);
      return sequence + 1;
    },
  };

  await worker(outbox, tasks, cardKit).drainOnce();

  assert.equal(order.length, 1);
  assert.match(order[0] ?? '', /^replace:12:[a-f0-9]{64}$/);
  assert.deepEqual(tasks.calls, ['get:task-1', 'advance:12:13']);
  assert.deepEqual(outbox.calls, ['claim', 'delivered']);
});

test('rejects non-object JSON payloads before calling CardKit', async () => {
  const failures: CardDeliveryFailure[] = [];
  const outbox = new FakeOutbox([
    outboxRecord('UPDATE_CARD', { payloadJson: '[]' }),
  ]);
  let cardKitCalled = false;
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async () => {
      cardKitCalled = true;
      return 1;
    },
    closeStreaming: async () => {
      cardKitCalled = true;
      return 1;
    },
  };

  await worker(outbox, new FakeTasks(taskRecord(0)), cardKit, {
    onDeliveryFailed: (failure) => {
      failures.push(failure);
      throw new Error('observability sink unavailable');
    },
  }).drainOnce();

  assert.equal(cardKitCalled, false);
  assert.deepEqual(outbox.calls, ['claim', 'failed:INVALID_CARD_PAYLOAD']);
  assert.deepEqual(failures, [{
    outboxId: 'outbox-1',
    taskId: 'task-1',
    errorCode: 'INVALID_CARD_PAYLOAD',
  }]);
});

test('concurrent drains share one process-local writer and claim only once', async () => {
  const outbox = new FakeOutbox([outboxRecord('UPDATE_CARD')]);
  let resolveReplace: ((sequence: number) => void) | undefined;
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (_cardId, _card, sequence) => new Promise<number>((resolve) => {
      resolveReplace = () => resolve(sequence + 1);
    }),
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };
  const activeWorker = worker(outbox, new FakeTasks(taskRecord(0)), cardKit);

  const firstDrain = activeWorker.drainOnce();
  assert.equal(await activeWorker.drainOnce(), false);
  assert.deepEqual(outbox.claimLimits, [1]);
  assert.ok(resolveReplace);
  resolveReplace(1);
  assert.equal(await firstDrain, true);
});

test('accepts a plain object payload with a null-free JSON prototype', async () => {
  const payload: CardKitJson = { schema: '2.0' };
  const outbox = new FakeOutbox([
    outboxRecord('UPDATE_CARD', { payloadJson: JSON.stringify(payload) }),
  ]);
  const cardKit: CardKitDeliveryClient = {
    replaceCard: async (_cardId, card, sequence) => {
      assert.deepEqual(card, payload);
      return sequence + 1;
    },
    closeStreaming: async () => assert.fail('UPDATE_CARD must not close streaming'),
  };

  await worker(outbox, new FakeTasks(taskRecord(0)), cardKit).drainOnce();
  assert.deepEqual(outbox.calls, ['claim', 'delivered']);
});
