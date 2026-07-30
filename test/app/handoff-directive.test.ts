import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseHandoffDirective,
  sanitizeHandoffField,
} from '../../src/app/collaboration/handoff-directive';

test('handoff directive parser extracts a fenced directive and strips it from visible text', () => {
  const parsed = parseHandoffDirective([
    '搜索侧已确认价格有效。',
    '',
    '```cfb-handoff',
    'target: Order Bot',
    'task: 排查订单创建失败',
    'reason: 需要订单域判断',
    'context: requestId=req-1',
    'evidence: searchTraceId=trace-1',
    'expected: 给出下一步动作',
    '```',
  ].join('\n'));

  assert.equal(parsed?.directive.target, 'Order Bot');
  assert.equal(parsed?.directive.task, '排查订单创建失败');
  assert.equal(parsed?.directive.contextSummary, 'requestId=req-1');
  assert.equal(parsed?.visibleText, '搜索侧已确认价格有效。');
});

test('handoff sanitizer redacts obvious secrets and local paths', () => {
  const sanitized = sanitizeHandoffField('token=abcdefabcdefabcdefabcdefabcdef /Users/jiang/secret.log');
  assert.equal(sanitized?.includes('abcdefabcdef'), false);
  assert.equal(sanitized?.includes('/Users/jiang'), false);
});
