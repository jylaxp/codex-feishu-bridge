import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeCardMarkdown,
  sanitizeCardPlainText,
  sanitizeCardText,
} from '../../src/app/cards/sanitizer';

test('preserves original card content without escaping or replacement', () => {
  const content = String.raw`price/compare C:\project\app **bold** [文档](https://example.test) \| \, sk-example`;

  assert.strictEqual(sanitizeCardText(content), content);
  assert.strictEqual(sanitizeCardPlainText(content), content);
  assert.strictEqual(sanitizeCardMarkdown(content), content);
});

test('does not truncate original content through the compatibility adapter', () => {
  const content = 'x'.repeat(100);

  assert.strictEqual(sanitizeCardText(content, { maxLength: 10 }), content);
});
