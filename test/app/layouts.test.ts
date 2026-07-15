import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createApprovalCard,
  createApprovalDecisionCard,
  createTaskCard,
} from '../../src/app/cards/layouts';
import {
  sanitizeCardMarkdown,
  sanitizeCardPlainText,
  sanitizeCardText,
} from '../../src/app/cards/sanitizer';

test('task card preserves the original Remote Control streaming layout', () => {
  const card = createTaskCard({
    status: 'RUNNING',
    cancelToken: 'opaque-cancel-token',
    payload: {
      title: sanitizeCardText('Codex task'),
      prompt: sanitizeCardMarkdown('**implement feature**'),
      commentary: sanitizeCardMarkdown('**checking files**'),
      toolSummary: sanitizeCardPlainText('✅ 1. rg: completed'),
      toolCount: 1,
      finalAnswer: sanitizeCardText(''),
      footer: sanitizeCardPlainText('task ref: abc'),
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
  assert.match(serialized, /\*\*implement feature\*\*/);
  assert.match(serialized, /\*\*checking files\*\*/);
  assert.match(serialized, /rg: completed/);
  assert.match(serialized, /工具执行 · 1 步/);
  assert.doesNotMatch(serialized, /当前状态|执行过程|目标会话/);
  assert.match(serialized, /opaque-cancel-token/);
  assert.match(serialized, /🛑 停止任务/);
  assert.match(serialized, /collapsible_panel/);

  const body = card.body as { readonly elements: readonly Record<string, unknown>[] };
  const footer = body.elements.find((element) => element.element_id === 'codex_footer');
  assert.deepStrictEqual(footer, {
    tag: 'div',
    text: { tag: 'plain_text', content: '📊 task ref: abc' },
    element_id: 'codex_footer',
  });

  const toolPanel = body.elements.find((element) => element.element_id === 'codex_tools_panel');
  assert.deepStrictEqual(toolPanel, {
    tag: 'collapsible_panel',
    element_id: 'codex_tools_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: '🛠️ 工具执行 · 1 步' },
    },
    elements: [{
      tag: 'div',
      text: { tag: 'plain_text', content: '✅ 1. rg: completed' },
      element_id: 'codex_tools',
    }],
  });
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

test('historical terminal task card marks the restored history title only', () => {
  const card = createTaskCard({
    status: 'SUCCEEDED',
    historical: true,
    payload: {
      title: sanitizeCardText('history'),
      prompt: sanitizeCardText('prompt'),
      commentary: sanitizeCardText(''),
      toolSummary: sanitizeCardText('暂无'),
      finalAnswer: sanitizeCardText('result'),
      footer: sanitizeCardText('finished'),
      terminal: true,
    },
  });

  assert.match(JSON.stringify(card), /\[历史\] ✅ Codex 执行成功/);
});

test('approval buttons carry decision-bound opaque tokens only', () => {
  const card = createApprovalCard({
    title: sanitizeCardText('审批'),
    kind: 'command',
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
  assert.match(serialized, /风险评估/);
  assert.match(serialized, /准备执行的操作指令/);
  assert.doesNotMatch(serialized, /threadId|turnId|itemId|requestId|cwd/);
});

test('terminal approval card preserves operation context with disabled decisions', () => {
  const card = createApprovalDecisionCard({
    kind: 'command',
    operationSummary: sanitizeCardText('git status'),
    reason: sanitizeCardText('需要检查工作区'),
    decision: 'accept',
    availableDecisions: ['accept', 'acceptForSession', 'decline'],
  });

  const serialized = JSON.stringify(card);
  assert.match(serialized, /审批已批准/);
  assert.match(serialized, /操作类型/);
  assert.match(serialized, /执行的操作指令/);
  assert.match(serialized, /已批准/);
  assert.match(serialized, /disabled/);
});
