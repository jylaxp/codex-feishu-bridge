import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalCard, createTaskCard } from '../../src/app/cards/layouts';
import { sanitizeCardText } from '../../src/app/cards/sanitizer';

test('task card preserves the original Remote Control streaming layout', () => {
  const card = createTaskCard({
    status: 'RUNNING',
    cancelToken: 'opaque-cancel-token',
    payload: {
      title: sanitizeCardText('Codex task'),
      prompt: sanitizeCardText('implement feature'),
      commentary: sanitizeCardText('checking files'),
      toolSummary: sanitizeCardText('rg: completed'),
      finalAnswer: sanitizeCardText(''),
      footer: sanitizeCardText('task ref: abc'),
      terminal: false,
    },
  });

  const serialized = JSON.stringify(card);
  assert.match(serialized, /🌌 Codex Remote Control/);
  assert.match(serialized, /📥 输入 Prompt/);
  assert.match(serialized, /codex_reasoning/);
  assert.match(serialized, /codex_output/);
  assert.match(serialized, /📊 task ref/);
  assert.match(serialized, /codex_footer/);
  assert.match(serialized, /工具与命令/);
  assert.match(serialized, /rg\\\\: completed/);
  assert.doesNotMatch(serialized, /当前状态|执行过程|目标会话|opaque-cancel-token/);
});

test('terminal card omits an empty inference section like the original card renderer', () => {
  const card = createTaskCard({
    status: 'SUCCEEDED',
    payload: {
      title: sanitizeCardText('done'),
      prompt: sanitizeCardText('prompt'),
      commentary: sanitizeCardText(''),
      toolSummary: sanitizeCardText('暂无'),
      finalAnswer: sanitizeCardText('result'),
      footer: sanitizeCardText('finished'),
      terminal: true,
    },
  });

  assert.doesNotMatch(JSON.stringify(card), /模型推理过程/);
});

test('terminal task card has no action token and closes streaming mode', () => {
  const card = createTaskCard({
    status: 'SUCCEEDED',
    cancelToken: 'must-not-render',
    payload: {
      title: sanitizeCardText('done'),
      prompt: sanitizeCardText('prompt'),
      commentary: sanitizeCardText('complete'),
      toolSummary: sanitizeCardText('none'),
      finalAnswer: sanitizeCardText('result'),
      footer: sanitizeCardText('finished'),
      terminal: true,
    },
  });

  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /must-not-render/);
  assert.doesNotMatch(serialized, /streaming_mode/);
  assert.match(serialized, /✅ Codex 执行成功/);
});

test('approval buttons carry decision-bound opaque tokens only', () => {
  const card = createApprovalCard({
    title: sanitizeCardText('审批'),
    operationSummary: sanitizeCardText('npm test'),
    reason: sanitizeCardText('需要本地 socket'),
    actionTokens: {
      accept: 'token-accept',
      acceptForSession: 'token-accept-for-session',
      decline: 'token-decline',
      cancel: 'token-cancel',
    },
  });

  const serialized = JSON.stringify(card);
  assert.match(serialized, /token-accept/);
  assert.match(serialized, /token-accept-for-session/);
  assert.match(serialized, /token-decline/);
  assert.match(serialized, /token-cancel/);
  assert.match(serialized, /本会话批准/);
  assert.doesNotMatch(serialized, /threadId|turnId|itemId|requestId|cwd/);
});
