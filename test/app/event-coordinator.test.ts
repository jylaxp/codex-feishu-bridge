import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppServerEventCoordinator,
  type CoordinatedTask,
  type EventCoordinatorDependencies,
  type PersistedTaskItemSnapshot,
} from '../../src/app/codex/event-coordinator';
import type { ServerNotification, ThreadItem, Turn } from '../../src/app/codex/protocol';
import type { TaskStatus } from '../../src/app/domain';

const THREAD_ID = 'thread-1';
const TURN_ID = 'turn-1';
const BINDING_ID = 'binding-1';
const TASK_ID = 'task-1';

interface ScheduledProjection {
  readonly taskId: string;
  readonly immediate: boolean;
}

interface FakeStore {
  readonly dependencies: EventCoordinatorDependencies;
  readonly items: Map<string, PersistedTaskItemSnapshot>;
  readonly scheduled: ScheduledProjection[];
  readonly transitions: Array<{
    readonly expected: TaskStatus;
    readonly next: TaskStatus;
  }>;
  getTask(): CoordinatedTask;
  setTask(task: CoordinatedTask): void;
  failNextItemUpsert(): void;
}

function notification(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params };
}

function turn(status: Turn['status'], items: ThreadItem[] = []): Turn {
  return {
    id: TURN_ID,
    items,
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? { message: 'failed internally', codexErrorInfo: null, additionalDetails: null }
      : null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function turnEvent(method: 'turn/started' | 'turn/completed', value: Turn): ServerNotification {
  return notification(method, { threadId: THREAD_ID, turn: value });
}

function itemEvent(method: string, item: ThreadItem): ServerNotification {
  return notification(method, {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item,
    completedAtMs: 2,
  });
}

function deltaEvent(method: string, itemId: string, delta: string): ServerNotification {
  return notification(method, {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId,
    delta,
    summaryIndex: 0,
    contentIndex: 0,
  });
}

function createStore(initialTurnId: string | null = TURN_ID): FakeStore {
  let task: CoordinatedTask = {
    id: TASK_ID,
    bindingId: BINDING_ID,
    status: 'STARTING',
    turnId: initialTurnId,
  };
  let failUpsert = false;
  const items = new Map<string, PersistedTaskItemSnapshot>();
  const scheduled: ScheduledProjection[] = [];
  const transitions: Array<{ expected: TaskStatus; next: TaskStatus }> = [];
  const dependencies: EventCoordinatorDependencies = {
    bindings: {
      getById(bindingId) {
        return bindingId === BINDING_ID ? { id: BINDING_ID, threadId: THREAD_ID } : undefined;
      },
    },
    tasks: {
      findByTurnId(turnId) {
        return task.turnId === turnId ? task : undefined;
      },
      getById(taskId) {
        return task.id === taskId ? task : undefined;
      },
      transition(taskId, expectedStatus, nextStatus) {
        transitions.push({ expected: expectedStatus, next: nextStatus });
        if (task.id !== taskId || task.status !== expectedStatus) {
          return false;
        }
        task = Object.freeze({ ...task, status: nextStatus });
        return true;
      },
    },
    taskItems: {
      upsert(snapshot) {
        if (failUpsert) {
          failUpsert = false;
          throw new Error('simulated persistence failure');
        }
        items.set(snapshot.itemId, snapshot);
      },
    },
    scheduleProjection(taskId, immediate) {
      scheduled.push({ taskId, immediate });
    },
    nowMs: () => 100,
  };
  return {
    dependencies,
    items,
    scheduled,
    transitions,
    getTask: () => task,
    setTask: (nextTask) => {
      task = Object.freeze(nextTask);
    },
    failNextItemUpsert: () => {
      failUpsert = true;
    },
  };
}

test('does not claim an unknown Desktop or App Server turn on a shared thread', () => {
  const store = createStore(null);
  const coordinator = new AppServerEventCoordinator(store.dependencies);

  const outcome = coordinator.handle(turnEvent('turn/started', turn('inProgress')));

  assert.equal(outcome, 'IGNORED');
  assert.equal(store.getTask().turnId, null);
  assert.equal(store.getTask().status, 'STARTING');
  assert.equal(coordinator.getProjectionSnapshot(TURN_ID), undefined);
  assert.deepEqual(store.scheduled, []);
  assert.deepEqual(store.transitions, []);
  assert.equal(store.items.size, 0);
});

test('buffers response-racing notifications and drains only after exact turn persistence', () => {
  const store = createStore(null);
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const completed = turn('completed', [
    { id: 'final-early', type: 'agentMessage', phase: 'final_answer', text: 'fast result' },
  ]);
  coordinator.beginTurnStart(TASK_ID, THREAD_ID);

  assert.equal(coordinator.handle(turnEvent('turn/started', turn('inProgress'))), 'BUFFERED');
  assert.equal(coordinator.handle(turnEvent('turn/completed', completed)), 'BUFFERED');
  assert.equal(coordinator.getBufferedNotificationCount(), 2);
  assert.equal(store.getTask().status, 'STARTING');

  store.setTask({ ...store.getTask(), turnId: TURN_ID });
  const outcomes = coordinator.drainTurnStart(TASK_ID, THREAD_ID, TURN_ID);

  assert.deepEqual(outcomes, ['SCHEDULED', 'TERMINAL']);
  assert.equal(store.getTask().status, 'SUCCEEDED');
  assert.equal(store.items.get('final-early')?.contentText, 'fast result');
  assert.equal(coordinator.getBufferedNotificationCount(), 0);
  assert.deepEqual(store.transitions, [
    { expected: 'STARTING', next: 'RUNNING' },
    { expected: 'RUNNING', next: 'SUCCEEDED' },
  ]);
});

test('never assigns a buffered same-thread external turn to the pending task', () => {
  const store = createStore(null);
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const foreignTurn: Turn = { ...turn('inProgress'), id: 'turn-foreign' };
  coordinator.beginTurnStart(TASK_ID, THREAD_ID);

  assert.equal(coordinator.handle(turnEvent('turn/started', foreignTurn)), 'BUFFERED');
  assert.equal(coordinator.handle(turnEvent('turn/started', turn('inProgress'))), 'BUFFERED');
  store.setTask({ ...store.getTask(), turnId: TURN_ID });

  assert.deepEqual(
    coordinator.drainTurnStart(TASK_ID, THREAD_ID, TURN_ID),
    ['SCHEDULED'],
  );
  assert.equal(store.getTask().turnId, TURN_ID);
  assert.equal(coordinator.getProjectionSnapshot('turn-foreign'), undefined);
  assert.equal(coordinator.getBufferedNotificationCount(), 0);
  assert.equal(coordinator.handle(turnEvent('turn/started', foreignTurn)), 'IGNORED');
});

test('bounds early notifications and expires the pending window by TTL', () => {
  const store = createStore(null);
  let nowMs = 100;
  const coordinator = new AppServerEventCoordinator({
    ...store.dependencies,
    nowMs: () => nowMs,
    earlyNotificationLimit: 2,
    earlyNotificationPerTurnLimit: 2,
    earlyNotificationTtlMs: 10,
  });
  coordinator.beginTurnStart(TASK_ID, THREAD_ID);

  for (let index = 1; index <= 3; index += 1) {
    assert.equal(coordinator.handle(notification('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: `turn-candidate-${index}`,
      itemId: `item-${index}`,
      delta: `delta-${index}`,
    })), 'BUFFERED');
  }
  assert.equal(coordinator.getBufferedNotificationCount(), 2);

  nowMs = 110;
  assert.equal(coordinator.getBufferedNotificationCount(), 0);
  assert.equal(coordinator.handle(notification('item/agentMessage/delta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'late-item',
    delta: 'late',
  })), 'IGNORED');
});

test('retains the newest exact-turn event when global eviction removes its older bucket', () => {
  const store = createStore(null);
  const coordinator = new AppServerEventCoordinator({
    ...store.dependencies,
    earlyNotificationLimit: 2,
    earlyNotificationPerTurnLimit: 2,
  });
  coordinator.beginTurnStart(TASK_ID, THREAD_ID);
  assert.equal(coordinator.handle(deltaEvent(
    'item/agentMessage/delta',
    'actual-item',
    'old',
  )), 'BUFFERED');
  assert.equal(coordinator.handle(notification('item/agentMessage/delta', {
    threadId: THREAD_ID,
    turnId: 'turn-foreign',
    itemId: 'foreign-item',
    delta: 'foreign',
  })), 'BUFFERED');
  assert.equal(coordinator.handle(deltaEvent(
    'item/agentMessage/delta',
    'actual-item',
    'new',
  )), 'BUFFERED');

  store.setTask({ ...store.getTask(), turnId: TURN_ID });
  assert.deepEqual(coordinator.drainTurnStart(TASK_ID, THREAD_ID, TURN_ID), ['SCHEDULED']);
  assert.equal(coordinator.getBufferedNotificationCount(), 0);
});

test('ordinary deltas update memory and schedule without durable per-token writes', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);

  const outcome = coordinator.handle(deltaEvent(
    'item/agentMessage/delta',
    'agent-1',
    'draft',
  ));

  assert.equal(outcome, 'SCHEDULED');
  assert.equal(store.items.size, 0);
  assert.deepEqual(store.scheduled, [{ taskId: TASK_ID, immediate: false }]);
  assert.equal(coordinator.getProjectionSnapshot(TURN_ID)?.finalAnswer, '');
});

test('projects App Server errors immediately with a stable in-memory message', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const outcome = coordinator.handle(notification('error', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    error: {
      message: 'temporary runtime failure',
      codexErrorInfo: null,
      additionalDetails: null,
    },
    willRetry: true,
  }));

  assert.equal(outcome, 'SCHEDULED');
  assert.equal(
    coordinator.getProjectionSnapshot(TURN_ID)?.errorMessage,
    'temporary runtime failure',
  );
  assert.deepEqual(store.scheduled, [{ taskId: TASK_ID, immediate: true }]);
});

test('completed items flush only safe commentary, reasoning, final, and command partitions', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);

  coordinator.handle(deltaEvent(
    'item/reasoning/summaryTextDelta',
    'reason-1',
    'safe summary',
  ));
  coordinator.handle(deltaEvent(
    'item/reasoning/textDelta',
    'reason-1',
    'private chain of thought',
  ));
  coordinator.handle(itemEvent('item/completed', {
    id: 'reason-1',
    type: 'reasoning',
    summary: ['safe summary'],
  }));
  coordinator.handle(itemEvent('item/completed', {
    id: 'commentary-1',
    type: 'agentMessage',
    phase: 'commentary',
    text: 'working',
  }));
  coordinator.handle(deltaEvent(
    'item/commandExecution/outputDelta',
    'command-1',
    'passed',
  ));
  coordinator.handle(itemEvent('item/completed', {
    id: 'command-1',
    type: 'commandExecution',
    command: 'npm test',
    aggregatedOutput: 'passed',
  }));
  coordinator.handle(itemEvent('item/completed', {
    id: 'final-1',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'done',
  }));

  assert.equal(store.items.get('reason-1')?.itemType, 'reasoning_summary');
  assert.equal(store.items.get('reason-1')?.contentText, 'safe summary');
  assert.equal(store.items.get('commentary-1')?.phase, 'commentary');
  assert.equal(store.items.get('final-1')?.phase, 'final_answer');
  assert.equal(store.items.get('command-1')?.contentText, 'npm test\npassed');
  assert.doesNotMatch(JSON.stringify([...store.items.values()]), /private chain of thought/);
  assert.ok(store.scheduled.every((request) => !request.immediate));
});

test('turn/completed recovers authoritative items, converges task status, and flushes immediately', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const completed = turn('completed', [
    { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'final result' },
    { id: 'reason-1', type: 'reasoning', summary: ['visible summary'] },
  ]);

  const outcome = coordinator.handle(turnEvent('turn/completed', completed));

  assert.equal(outcome, 'TERMINAL');
  assert.equal(store.getTask().status, 'SUCCEEDED');
  assert.equal(store.items.get('final-1')?.contentText, 'final result');
  assert.equal(store.items.get('reason-1')?.contentText, 'visible summary');
  assert.deepEqual(store.scheduled, [{ taskId: TASK_ID, immediate: true }]);
  assert.deepEqual(store.transitions, [{ expected: 'STARTING', next: 'SUCCEEDED' }]);
  assert.equal(coordinator.getProjectionSnapshot(TURN_ID), undefined);

  const lateOutcome = coordinator.handle(deltaEvent(
    'item/agentMessage/delta',
    'late-agent',
    'late data',
  ));
  assert.equal(lateOutcome, 'IGNORED');
  assert.equal(store.items.has('late-agent'), false);
  assert.equal(store.scheduled.length, 1);
});

test('terminal compare-and-set reloads and retries after a concurrent status change', () => {
  const store = createStore();
  const originalTransition = store.dependencies.tasks.transition.bind(store.dependencies.tasks);
  let firstAttempt = true;
  store.dependencies.tasks.transition = (taskId, expected, next, nowMs, fields) => {
    if (firstAttempt) {
      firstAttempt = false;
      store.setTask({ ...store.getTask(), status: 'COMPLETING' });
      store.transitions.push({ expected, next });
      return false;
    }
    return originalTransition(taskId, expected, next, nowMs, fields);
  };
  const coordinator = new AppServerEventCoordinator(store.dependencies);

  coordinator.handle(turnEvent('turn/completed', turn('failed')));

  assert.equal(store.getTask().status, 'FAILED');
  assert.deepEqual(store.transitions, [
    { expected: 'STARTING', next: 'FAILED' },
    { expected: 'COMPLETING', next: 'FAILED' },
  ]);
});

test('mismatched thread events and terminal tasks are ignored', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const wrongThread = notification('item/agentMessage/delta', {
    threadId: 'thread-other',
    turnId: TURN_ID,
    itemId: 'agent-1',
    delta: 'wrong',
  });

  assert.equal(coordinator.handle(wrongThread), 'IGNORED');
  store.setTask({ ...store.getTask(), status: 'SUCCEEDED' });
  assert.equal(coordinator.handle(deltaEvent(
    'item/agentMessage/delta',
    'agent-1',
    'late',
  )), 'IGNORED');
  assert.equal(store.scheduled.length, 0);
});

test('a failed item flush can be retried without losing the completion event', () => {
  const store = createStore();
  const coordinator = new AppServerEventCoordinator(store.dependencies);
  const completed = itemEvent('item/completed', {
    id: 'final-1',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'retryable result',
  });
  store.failNextItemUpsert();

  assert.throws(() => coordinator.handle(completed), /simulated persistence failure/);
  assert.equal(store.items.size, 0);
  assert.equal(coordinator.handle(completed), 'FLUSHED');
  assert.equal(store.items.get('final-1')?.contentText, 'retryable result');
});
