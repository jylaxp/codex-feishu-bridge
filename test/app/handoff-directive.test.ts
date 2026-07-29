import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildHandoffEnvelopeText,
  createChildHandoffEnvelope,
  parseHandoffDirective,
  parseHandoffEnvelope,
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

test('handoff envelope round-trips through the visible group message header', () => {
  const envelope = createChildHandoffEnvelope({
    chainId: 'ch_aaaaaaaaaaaaaaaaaaaaaaaa',
    sourceBotKey: 'bot_aaaaaaaaaaaa',
    hop: 2,
    expiresAtMs: 2_000,
    visitedBotKeys: ['bot_aaaaaaaaaaaa', 'bot_bbbbbbbbbbbb'],
    seed: 'seed',
  });
  const text = `${buildHandoffEnvelopeText(envelope)}\n目标: 继续排查`;
  const parsed = parseHandoffEnvelope(text);

  assert.deepEqual(parsed?.envelope, envelope);
  assert.equal(parsed?.taskText, '目标: 继续排查');
});

test('handoff sanitizer redacts obvious secrets and local paths', () => {
  const sanitized = sanitizeHandoffField('token=abcdefabcdefabcdefabcdefabcdef /Users/jiang/secret.log');
  assert.equal(sanitized?.includes('abcdefabcdef'), false);
  assert.equal(sanitized?.includes('/Users/jiang'), false);
});
