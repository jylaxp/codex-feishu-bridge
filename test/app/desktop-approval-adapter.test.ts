import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalResponseMethod,
  collectDesktopApprovals,
} from '../../src/app/codex/desktop-approval-adapter';

test('collects only active Desktop command approvals with supported decisions', () => {
  const approvals = collectDesktopApprovals('thread-1', {
    requests: [
      {
        id: 'request-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          turnId: 'turn-1',
          itemId: 'item-1',
          command: 'git status',
          reason: 'Need to inspect the workspace',
          availableDecisions: ['accept', 'acceptForSession', 'decline', 'ignored'],
        },
      },
      { id: 'done', method: 'item/fileChange/requestApproval', status: 'completed', params: {} },
      { id: 'unknown', method: 'unknown/request', params: {} },
    ],
  });

  assert.deepEqual(approvals, [{
    requestId: 'request-1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    kind: 'command',
    reason: 'Need to inspect the workspace',
    operationSummary: 'git status',
    availableDecisions: ['accept', 'acceptForSession', 'decline'],
  }]);
});

test('maps each supported approval kind to its pinned follower response method', () => {
  assert.equal(
    approvalResponseMethod('command'),
    'thread-follower-command-approval-decision',
  );
  assert.equal(
    approvalResponseMethod('file'),
    'thread-follower-file-approval-decision',
  );
  assert.equal(
    approvalResponseMethod('permissions'),
    'thread-follower-permissions-request-approval-response',
  );
});
