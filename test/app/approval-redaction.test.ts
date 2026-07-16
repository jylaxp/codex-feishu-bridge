import assert from 'node:assert/strict';
import test from 'node:test';

import { redactApprovalSecrets } from '../../src/app/cards/approval-redaction';

test('approval redaction keeps ordinary card markdown unchanged and masks credential values', () => {
  const source = 'curl -H "Authorization: Bearer secret-token" "https://x.test?a=1" api_key=abc123';
  assert.equal(
    redactApprovalSecrets(source),
    'curl -H "Authorization: Bearer [REDACTED]" "https://x.test?a=1" api_key=[REDACTED]',
  );
});

test('approval redaction masks OpenAI-style secret keys', () => {
  assert.equal(
    redactApprovalSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456'),
    'OPENAI_API_KEY=[REDACTED]',
  );
});
