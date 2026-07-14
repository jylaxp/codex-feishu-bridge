import assert from 'node:assert/strict';
import test from 'node:test';

import type { DesktopThreadStreamBroadcast } from '../../src/app/codex/desktop-ipc-client';
import { DesktopThreadStreamNormalizer } from '../../src/app/codex/desktop-thread-stream-normalizer';
import {
  createEventReducerState,
  createProjectionSnapshot,
  reduceEvent,
} from '../../src/app/codex/event-reducer';

function snapshotBroadcast(): DesktopThreadStreamBroadcast {
  return {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: 11,
    params: {
      conversationId: 'thread-bound',
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [{
            id: 'turn-desktop',
            status: 'inProgress',
            input: [{ type: 'text', text: 'hello', text_elements: [] }],
            items: [
              {
                id: 'agent-final',
                type: 'agentMessage',
                phase: 'final_answer',
                status: 'inProgress',
                text: 'Hel',
              },
              {
                id: 'command-pwd',
                type: 'commandExecution',
                status: 'inProgress',
                command: 'pwd',
                aggregatedOutput: '/wo',
              },
            ],
          }],
        },
      },
    },
  };
}

function completionBroadcast(): DesktopThreadStreamBroadcast {
  return {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: 11,
    params: {
      conversationId: 'thread-bound',
      change: {
        type: 'patches',
        patches: [
          { op: 'replace', path: ['turns', 0, 'items', 0, 'text'], value: 'Hello' },
          { op: 'replace', path: ['turns', 0, 'items', 0, 'status'], value: 'completed' },
          {
            op: 'replace',
            path: ['turns', 0, 'items', 1, 'aggregatedOutput'],
            value: '/workspace',
          },
          { op: 'replace', path: ['turns', 0, 'items', 1, 'status'], value: 'completed' },
          { op: 'replace', path: ['turns', 0, 'status'], value: 'completed' },
        ],
      },
    },
  };
}

const CANONICAL_ENTITY_KEY = 'tail:1:local:canonical-turn';

function canonicalSnapshotBroadcast(): DesktopThreadStreamBroadcast {
  return {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: 11,
    params: {
      conversationId: 'thread-canonical',
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [],
          requests: [],
          turnHistory: {
            kind: 'canonical',
            history: {
              entitiesByKey: {
                [CANONICAL_ENTITY_KEY]: {
                  params: {
                    threadId: 'thread-canonical',
                    clientUserMessageId: 'feishu-message-id',
                  },
                  turnId: 'turn-canonical',
                  status: 'inProgress',
                  turnStartedAtMs: 9_000,
                  durationMs: null,
                  error: null,
                  items: [
                    {
                      id: 'canonical-agent-final',
                      type: 'agentMessage',
                      phase: 'final_answer',
                      text: 'Hel',
                    },
                    {
                      id: 'canonical-command',
                      type: 'commandExecution',
                      status: 'inProgress',
                      command: 'pwd',
                      aggregatedOutput: '/wo',
                    },
                  ],
                },
              },
              generation: 1,
              isComplete: true,
              islands: [{
                id: 'tail:1',
                entries: [{ key: CANONICAL_ENTITY_KEY, value: CANONICAL_ENTITY_KEY }],
                olderBoundary: { status: 'exhausted', boundaryId: 'tail:1:older' },
                newerBoundary: { status: 'exhausted', boundaryId: 'tail:1:newer' },
              }],
            },
          },
        },
      },
    },
  };
}

function canonicalCompletionBroadcast(): DesktopThreadStreamBroadcast {
  const entityPath = [
    'turnHistory',
    'history',
    'entitiesByKey',
    CANONICAL_ENTITY_KEY,
  ] as const;
  return {
    type: 'broadcast',
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    version: 11,
    params: {
      conversationId: 'thread-canonical',
      change: {
        type: 'patches',
        patches: [
          {
            op: 'replace',
            path: [...entityPath, 'items', 0, 'text'],
            value: 'Hello canonical',
          },
          {
            op: 'replace',
            path: [...entityPath, 'items', 1, 'aggregatedOutput'],
            value: '/workspace/canonical',
          },
          {
            op: 'replace',
            path: [...entityPath, 'items', 1, 'status'],
            value: 'completed',
          },
          { op: 'replace', path: [...entityPath, 'durationMs'], value: 2_000 },
          { op: 'replace', path: [...entityPath, 'status'], value: 'completed' },
        ],
      },
    },
  };
}

test('normalizes a Desktop snapshot and patches into canonical reducer events', () => {
  const normalizer = new DesktopThreadStreamNormalizer(() => 10_000);
  const notifications = [
    ...normalizer.handle(snapshotBroadcast()),
    ...normalizer.handle(completionBroadcast()),
  ];
  let state = createEventReducerState('thread-bound', 'turn-desktop');
  for (const notification of notifications) {
    state = reduceEvent(state, notification);
  }
  const projection = createProjectionSnapshot(state);

  assert.equal(projection.status, 'SUCCEEDED');
  assert.equal(projection.terminal, true);
  assert.equal(projection.finalAnswer, 'Hello');
  assert.deepEqual(projection.commands, [{
    itemId: 'command-pwd',
    command: 'pwd',
    outputTail: '/workspace',
    completed: true,
  }]);
  assert.equal(
    notifications.filter((notification) => notification.method === 'turn/started').length,
    1,
  );
  assert.equal(
    notifications.filter((notification) => notification.method === 'turn/completed').length,
    1,
  );
  const firstAgentDelta = notifications.find((notification) => (
    notification.method === 'item/agentMessage/delta'
  ));
  assert.equal((firstAgentDelta?.params as { readonly phase?: string }).phase, 'final_answer');
});

test('projects the current Desktop token usage state for the active turn', () => {
  const normalizer = new DesktopThreadStreamNormalizer();
  const broadcast = snapshotBroadcast();
  const change = broadcast.params.change;
  if (change.type !== 'snapshot') {
    throw new Error('snapshot fixture must provide state');
  }
  const state = change.conversationState as Record<string, unknown>;
  state.latestModel = 'gpt-5.6-sol';
  state.latestTokenUsageInfo = {
    last: { inputTokens: 12, outputTokens: 34, totalTokens: 56 },
    total: { inputTokens: 120, outputTokens: 340, totalTokens: 560 },
    modelContextWindow: 200_000,
  };

  const usage = normalizer.handle(broadcast).find((notification) => (
    notification.method === 'thread/tokenUsage/updated'
  ));
  assert.deepEqual(usage, {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-bound',
      turnId: 'turn-desktop',
      tokenUsage: state.latestTokenUsageInfo,
      model: 'gpt-5.6-sol',
    },
  });
});

test('normalizes the current Desktop canonical turnHistory snapshot and patches', () => {
  const normalizer = new DesktopThreadStreamNormalizer(() => 11_000);
  const notifications = [
    ...normalizer.handle(canonicalSnapshotBroadcast()),
    ...normalizer.handle(canonicalCompletionBroadcast()),
  ];
  let state = createEventReducerState('thread-canonical', 'turn-canonical');
  for (const notification of notifications) {
    state = reduceEvent(state, notification);
  }
  const projection = createProjectionSnapshot(state);

  assert.equal(projection.status, 'SUCCEEDED');
  assert.equal(projection.terminal, true);
  assert.equal(projection.finalAnswer, 'Hello canonical');
  assert.deepEqual(projection.commands, [{
    itemId: 'canonical-command',
    command: 'pwd',
    outputTail: '/workspace/canonical',
    completed: true,
  }]);
  assert.equal(
    notifications.filter((notification) => notification.method === 'turn/started').length,
    1,
  );
  assert.equal(
    notifications.filter((notification) => notification.method === 'turn/completed').length,
    1,
  );
  assert.equal(
    notifications.some((notification) => (
      notification.method === 'item/completed'
      && (notification.params as { readonly item?: { readonly id?: string } }).item?.id
        === 'canonical-agent-final'
    )),
    true,
  );
});

test('ignores patches until an authoritative snapshot exists', () => {
  const normalizer = new DesktopThreadStreamNormalizer();

  assert.deepEqual(normalizer.handle(completionBroadcast()), []);
});

test('clears authoritative state when the Desktop connection epoch changes', () => {
  const normalizer = new DesktopThreadStreamNormalizer();
  normalizer.beginEpoch(1);
  normalizer.handle(snapshotBroadcast());

  normalizer.beginEpoch(2);

  assert.equal(normalizer.connectionEpoch, 2);
  assert.deepEqual(normalizer.handle(completionBroadcast()), []);
});

test('emits one scoped Desktop approval per epoch from authoritative state', () => {
  const normalizer = new DesktopThreadStreamNormalizer();
  const approvals: unknown[] = [];
  normalizer.beginEpoch(7);
  normalizer.onApprovalRequest((approval, epoch) => approvals.push({ approval, epoch }));
  const broadcast = snapshotBroadcast();
  const change = broadcast.params.change;
  if (change.type !== 'snapshot') {
    throw new Error('snapshot fixture must provide an authoritative state');
  }
  const state = change.conversationState as Record<string, unknown>;
  state.requests = [{
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      turnId: 'turn-desktop', itemId: 'command-pwd', command: 'pwd', reason: 'Need permission',
      availableDecisions: ['accept', 'decline'],
    },
  }];

  normalizer.handle(broadcast);
  normalizer.handle(broadcast);

  assert.deepEqual(approvals, [{
    epoch: 7,
    approval: {
      requestId: 'approval-1', threadId: 'thread-bound', turnId: 'turn-desktop',
      itemId: 'command-pwd', kind: 'command', reason: 'Need permission', operationSummary: 'pwd',
      availableDecisions: ['accept', 'decline'],
    },
  }]);
});

test('does not synthesize a suffix delta when Desktop rewrites existing text', () => {
  const normalizer = new DesktopThreadStreamNormalizer();
  normalizer.handle(snapshotBroadcast());
  const rewrite = completionBroadcast();
  const notifications = normalizer.handle({
    ...rewrite,
    params: {
      ...rewrite.params,
      change: {
        type: 'patches',
        patches: [{
          op: 'replace',
          path: ['turns', 0, 'items', 0, 'text'],
          value: 'Rewritten',
        }],
      },
    },
  });

  assert.equal(
    notifications.some((notification) => notification.method === 'item/agentMessage/delta'),
    false,
  );
});

test('does not replay every historical turn from the first Desktop snapshot', () => {
  const normalizer = new DesktopThreadStreamNormalizer();
  const snapshot = snapshotBroadcast();
  const notifications = normalizer.handle({
    ...snapshot,
    params: {
      ...snapshot.params,
      change: {
        type: 'snapshot',
        conversationState: {
          turns: [
            {
              id: 'turn-historical',
              status: 'completed',
              items: [{ type: 'agentMessage', text: 'old answer' }],
            },
            {
              id: 'turn-current',
              status: 'inProgress',
              items: [{ type: 'agentMessage', text: 'current answer' }],
            },
          ],
        },
      },
    },
  });

  assert.equal(
    notifications.some((notification) => (
      (notification.params as { readonly turnId?: string }).turnId === 'turn-historical'
    )),
    false,
  );
  const started = notifications.find((notification) => notification.method === 'item/started');
  assert.equal(
    (started?.params as { readonly item?: { readonly id?: string } }).item?.id,
    'desktop:turn-current:0',
  );
});
