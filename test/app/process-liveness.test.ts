import assert from 'node:assert/strict';
import test from 'node:test';

import { isProcessAlive } from '../../src/app/process-liveness';

test('process liveness treats only ESRCH as proof of absence', () => {
  const permissionDenied = Object.assign(new Error('not permitted'), { code: 'EPERM' });
  const missing = Object.assign(new Error('missing'), { code: 'ESRCH' });

  assert.equal(isProcessAlive(1, () => {
    throw permissionDenied;
  }), true);
  assert.equal(isProcessAlive(2, () => {
    throw missing;
  }), false);
  assert.equal(isProcessAlive(3, () => true), true);
});
