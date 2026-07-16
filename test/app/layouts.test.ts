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
    tag: 'markdown',
    content: '📊 task ref: abc',
    element_id: 'codex_footer',
  });

  const toolPanel = body.elements.find((element) => element.element_id === 'codex_tools_panel');
  assert.deepStrictEqual(toolPanel, {
    tag: 'collapsible_panel',
    element_id: 'codex_tools_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: '🛠️ 工具执行 · 1 步' },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon', token: 'api-app_outlined', color: 'grey', size: '16px 16px',
      },
      icon_position: 'left',
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '4px 8px 4px 8px',
    elements: [{
      tag: 'markdown',
      content: '✅ 1. rg: completed',
      element_id: 'codex_tools',
    }],
  });
});

test('task card renders tool groups as separate collapsed rows', () => {
  const card = createTaskCard({
    status: 'RUNNING',
    payload: {
      title: sanitizeCardText('Codex task'),
      prompt: sanitizeCardMarkdown('review'),
      commentary: sanitizeCardMarkdown('checking'),
      toolSummary: sanitizeCardPlainText('legacy fallback'),
      toolGroups: [
        {
          title: sanitizeCardPlainText('group 1'),
          content: sanitizeCardPlainText('⏳ 1. rg --files\n✅ 2. sed -n 1,20p file'),
          count: 2,
        },
        {
          title: sanitizeCardPlainText('group 2'),
          content: sanitizeCardPlainText('⏳ 1. git diff'),
          count: 1,
        },
      ],
      finalAnswer: sanitizeCardText(''),
      footer: sanitizeCardPlainText('running'),
      terminal: false,
    },
  });

  const body = card.body as { readonly elements: readonly Record<string, unknown>[] };
  const panels = body.elements.filter((element) => element.tag === 'collapsible_panel');

  assert.equal(panels.length, 2);
  assert.deepStrictEqual(
    panels.map((panel) => (
      (panel.header as { readonly title: { readonly content: string } }).title.content
    )),
    ['group 1', 'group 2'],
  );
  assert.match(JSON.stringify(card), /rg --files/);
  assert.match(JSON.stringify(card), /git diff/);
});

test('task card keeps the legacy aggregate tool panel when no tool groups exist', () => {
  const card = createTaskCard({
    status: 'RUNNING',
    payload: {
      title: sanitizeCardText('Codex task'),
      prompt: sanitizeCardMarkdown('review'),
      commentary: sanitizeCardMarkdown('checking'),
      toolSummary: sanitizeCardPlainText('✅ 1. rg --files'),
      toolCount: 1,
      finalAnswer: sanitizeCardText(''),
      footer: sanitizeCardPlainText('running'),
      terminal: false,
    },
  });

  const body = card.body as { readonly elements: readonly Record<string, unknown>[] };
  const panels = body.elements.filter((element) => element.tag === 'collapsible_panel');

  assert.equal(panels.length, 1);
  assert.match(JSON.stringify(card), /工具执行 · 1 步/);
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
      toolSummary: sanitizeCardText('✅ 1. rg --files'),
      toolCount: 1,
      finalAnswer: sanitizeCardText('result'),
      footer: sanitizeCardText('finished'),
      terminal: true,
    },
  });

  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /must-not-render/);
  assert.doesNotMatch(serialized, /streaming_mode/);
  assert.doesNotMatch(serialized, /collapsible_panel|codex_prompt|codex_reasoning|codex_output|codex_footer/);
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

  assert.match(JSON.stringify(card), /📜 \[历史\] ✅ Codex 执行成功/);
  assert.equal((card.header as { readonly template: string }).template, 'indigo');
});

test('terminal task card uses the original truncation copy for reasoning and output', () => {
  const card = createTaskCard({
    status: 'SUCCEEDED',
    payload: {
      title: sanitizeCardText('done'),
      prompt: sanitizeCardText('prompt'),
      commentary: sanitizeCardText('r'.repeat(10_001)),
      toolSummary: sanitizeCardText('暂无'),
      finalAnswer: sanitizeCardText('a'.repeat(10_001)),
      footer: sanitizeCardText('finished'),
      terminal: true,
    },
  });

  const serialized = JSON.stringify(card);
  assert.match(serialized, /由于长度限制，后续推理过程已被截断/);
  assert.match(serialized, /由于长度限制，后续输出已被截断，请在 IDE 中查看完整内容/);
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
  assert.doesNotMatch(serialized, /token-cancel/);
  assert.match(serialized, /总是批准/);
  assert.match(serialized, /风险评估/);
  assert.match(serialized, /准备执行的操作指令/);
  assert.doesNotMatch(serialized, /threadId|turnId|itemId|requestId/);
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
