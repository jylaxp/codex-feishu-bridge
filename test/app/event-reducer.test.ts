import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEventReducerState,
  createProjectionSnapshot,
  reduceEvent,
} from '../../src/app/codex/event-reducer';
import { ServerNotification, ThreadItem, Turn } from '../../src/app/codex/protocol';

const THREAD_ID = 'thread-1';
const TURN_ID = 'turn-1';

function notification(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params };
}

function completedItem(item: ThreadItem): ServerNotification {
  return notification('item/completed', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item,
    completedAtMs: 2,
  });
}

function completedTurn(status: Turn['status'] = 'completed'): ServerNotification {
  const turn: Turn = {
    id: TURN_ID,
    items: [],
    itemsView: 'full',
    status,
    error: status === 'failed'
      ? { message: 'turn failed', codexErrorInfo: null, additionalDetails: null }
      : null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
  return notification('turn/completed', { threadId: THREAD_ID, turn });
}

test('routes agent text only after item/completed supplies the authoritative phase', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID);
  state = reduceEvent(state, notification('item/agentMessage/delta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'agent-1',
    delta: 'draft delta',
  }));
  state = reduceEvent(state, notification('item/started', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: 'agent-1', type: 'agentMessage', phase: 'final_answer' },
    startedAtMs: 1,
  }));

  let snapshot = createProjectionSnapshot(state);
  assert.equal(snapshot.pendingAgentText, 'draft delta');
  assert.equal(snapshot.commentary, '');
  assert.equal(snapshot.finalAnswer, '');

  state = reduceEvent(state, completedItem({
    id: 'agent-1',
    type: 'agentMessage',
    phase: 'commentary',
    text: 'authoritative commentary',
  }));
  snapshot = createProjectionSnapshot(state);
  assert.equal(snapshot.pendingAgentText, '');
  assert.equal(snapshot.commentary, 'authoritative commentary');
  assert.equal(snapshot.finalAnswer, '');
});

test('supports completed agent items arriving before item/started and preserves item order', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID);
  const finalEvent = completedItem({
    id: 'agent-final',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'final answer',
  });
  state = reduceEvent(state, finalEvent);
  const afterCompletion = state;
  state = reduceEvent(state, notification('item/started', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: 'agent-final', type: 'agentMessage', phase: 'commentary' },
    startedAtMs: 3,
  }));

  assert.strictEqual(state, afterCompletion);
  assert.equal(createProjectionSnapshot(state).finalAnswer, 'final answer');
});

test('projects reasoning summaries and discards raw reasoning text deltas', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID);
  state = reduceEvent(state, notification('item/reasoning/summaryTextDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'reason-1',
    summaryIndex: 0,
    delta: 'public summary',
  }));
  const beforeRawReasoning = state;
  state = reduceEvent(state, notification('item/reasoning/textDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'reason-1',
    contentIndex: 0,
    delta: 'hidden chain of thought',
  }));

  assert.strictEqual(state, beforeRawReasoning);
  const snapshot = createProjectionSnapshot(state);
  assert.equal(snapshot.reasoningSummary, 'public summary');
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden chain of thought/);

  state = reduceEvent(state, completedItem({
    id: 'reason-1',
    type: 'reasoning',
    summary: ['authoritative ', 'summary'],
  }));
  assert.equal(createProjectionSnapshot(state).reasoningSummary, 'authoritative summary');
});

test('keeps only a bounded command output tail and accepts deltas before item/started', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID, { commandOutputTailLimit: 8 });
  state = reduceEvent(state, notification('item/commandExecution/outputDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'command-1',
    delta: '12345',
  }));
  state = reduceEvent(state, notification('item/commandExecution/outputDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'command-1',
    delta: '67890',
  }));
  state = reduceEvent(state, notification('item/started', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: { id: 'command-1', type: 'commandExecution', command: 'npm test' },
    startedAtMs: 1,
  }));

  let command = createProjectionSnapshot(state).commands[0];
  assert.equal(command?.outputTail, '34567890');
  assert.equal(command?.command, 'npm test');

  state = reduceEvent(state, completedItem({
    id: 'command-1',
    type: 'commandExecution',
    command: 'npm test',
    aggregatedOutput: 'abcdefghijk',
  }));
  command = createProjectionSnapshot(state).commands[0];
  assert.equal(command?.outputTail, 'defghijk');
  assert.equal(command?.completed, true);
});

test('enforces hard item and per-agent text limits', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID, {
    itemLimit: 2,
    agentTextLimit: 5,
  });
  for (const itemId of ['agent-1', 'agent-2', 'agent-3']) {
    state = reduceEvent(state, notification('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId,
      delta: '123456789',
    }));
  }

  assert.equal(Object.keys(state.items).length, 2);
  assert.equal(state.items['agent-1']?.text, '12345');
  assert.equal(state.items['agent-2']?.text, '12345');
  assert.equal(state.items['agent-3'], undefined);
});

test('bounds reasoning text and rejects summary indexes outside the configured range', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID, {
    reasoningTextLimit: 5,
    summaryIndexLimit: 2,
  });
  state = reduceEvent(state, notification('item/reasoning/summaryTextDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'reason-1',
    summaryIndex: 0,
    delta: 'abcd',
  }));
  state = reduceEvent(state, notification('item/reasoning/summaryTextDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'reason-1',
    summaryIndex: 1,
    delta: 'efgh',
  }));
  const beforeOutOfRange = state;
  state = reduceEvent(state, notification('item/reasoning/summaryTextDelta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'reason-1',
    summaryIndex: 2,
    delta: 'must be ignored',
  }));

  assert.strictEqual(state, beforeOutOfRange);
  assert.equal(createProjectionSnapshot(state).reasoningSummary, 'abcde');

  state = reduceEvent(state, completedItem({
    id: 'reason-1',
    type: 'reasoning',
    summary: ['1234', '5678', 'must not be retained'],
  }));
  assert.equal(createProjectionSnapshot(state).reasoningSummary, '12345');
  assert.deepEqual(Object.keys(state.items['reason-1']?.summaryParts ?? {}), ['0', '1']);
});

test('enforces one aggregate turn text budget across items and authoritative completion', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID, {
    agentTextLimit: 10,
    turnTextLimit: 12,
  });
  state = reduceEvent(state, notification('item/agentMessage/delta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'agent-1',
    delta: '1234567890-extra',
  }));
  state = reduceEvent(state, notification('item/agentMessage/delta', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'agent-2',
    delta: 'abcdefghij-extra',
  }));

  assert.equal(state.retainedTextLength, 12);
  assert.equal(state.items['agent-1']?.text, '1234567890');
  assert.equal(state.items['agent-2']?.text, 'ab');

  state = reduceEvent(state, completedItem({
    id: 'agent-2',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'authoritative text that exceeds every limit',
  }));
  assert.equal(state.retainedTextLength, 12);
  assert.equal(state.items['agent-2']?.text, 'au');
  assert.equal(createProjectionSnapshot(state).finalAnswer, 'au');
});

test('rejects reducer options that exceed hard safety ceilings', () => {
  const unsafeLimit = Number.MAX_SAFE_INTEGER;
  for (const options of [
    { itemLimit: unsafeLimit },
    { agentTextLimit: unsafeLimit },
    { reasoningTextLimit: unsafeLimit },
    { summaryIndexLimit: unsafeLimit },
    { turnTextLimit: unsafeLimit },
  ]) {
    assert.throws(
      () => createEventReducerState(THREAD_ID, TURN_ID, options),
      RangeError,
    );
  }
});

test('is idempotent for repeated lifecycle events and authoritative completion', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID);
  const event = completedItem({
    id: 'agent-1',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'only once',
  });
  state = reduceEvent(state, event);
  const afterFirst = state;
  state = reduceEvent(state, event);

  assert.strictEqual(state, afterFirst);
  assert.equal(createProjectionSnapshot(state).finalAnswer, 'only once');
});

test('terminal state is immutable and duplicate terminal events are ignored', () => {
  let state = createEventReducerState(THREAD_ID, TURN_ID);
  state = reduceEvent(state, completedTurn('completed'));
  const terminalState = state;
  assert.equal(createProjectionSnapshot(state).status, 'SUCCEEDED');

  state = reduceEvent(state, completedTurn('completed'));
  assert.strictEqual(state, terminalState);
  state = reduceEvent(state, completedItem({
    id: 'late-agent',
    type: 'agentMessage',
    phase: 'final_answer',
    text: 'late answer',
  }));
  assert.strictEqual(state, terminalState);
  assert.equal(createProjectionSnapshot(state).finalAnswer, '');
});

test('safely ignores unknown and mismatched events and returns immutable snapshots', () => {
  const initial = createEventReducerState(THREAD_ID, TURN_ID);
  let state = reduceEvent(initial, notification('future/event', { payload: 'ignored' }));
  assert.strictEqual(state, initial);
  state = reduceEvent(state, notification('item/agentMessage/delta', {
    itemId: 'agent-without-identity',
    delta: 'must be ignored',
  }));
  assert.strictEqual(state, initial);
  state = reduceEvent(state, notification('item/agentMessage/delta', {
    threadId: 'other-thread',
    turnId: TURN_ID,
    itemId: 'agent-1',
    delta: 'wrong task',
  }));
  assert.strictEqual(state, initial);

  const snapshot = createProjectionSnapshot(state);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.items));
  assert.ok(Object.isFrozen(snapshot.commands));
});

test('ignores malformed turn completion that does not carry a terminal status', () => {
  const initial = createEventReducerState(THREAD_ID, TURN_ID);
  const state = reduceEvent(initial, completedTurn('inProgress'));

  assert.strictEqual(state, initial);
  assert.equal(createProjectionSnapshot(state).status, 'STARTING');
});

test('maps failed and interrupted terminal statuses', () => {
  let failed = createEventReducerState(THREAD_ID, TURN_ID);
  failed = reduceEvent(failed, completedTurn('failed'));
  assert.equal(createProjectionSnapshot(failed).status, 'FAILED');
  assert.equal(createProjectionSnapshot(failed).errorMessage, 'turn failed');

  let interrupted = createEventReducerState(THREAD_ID, TURN_ID);
  interrupted = reduceEvent(interrupted, completedTurn('interrupted'));
  assert.equal(createProjectionSnapshot(interrupted).status, 'INTERRUPTED');
});
