import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateTaskCardActions,
  TASK_CANCEL_TOKEN_PLACEHOLDER,
} from '../../src/app/cards/action-hydrator';

test('hydrates only the cancel action and leaves matching user content unchanged', () => {
  const card = {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: TASK_CANCEL_TOKEN_PLACEHOLDER },
        {
          tag: 'button',
          value: { action: 'cancel', token: TASK_CANCEL_TOKEN_PLACEHOLDER },
        },
      ],
    },
  };

  const hydrated = hydrateTaskCardActions(card, 'app-secret', 'task-id');
  const elements = (hydrated.body as { elements: Array<Record<string, unknown>> }).elements;
  const action = elements[1]?.value as Record<string, unknown>;

  assert.equal(elements[0]?.content, TASK_CANCEL_TOKEN_PLACEHOLDER);
  assert.notEqual(action.token, TASK_CANCEL_TOKEN_PLACEHOLDER);
  assert.equal(action.action, 'cancel');
});
