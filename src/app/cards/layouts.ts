import {
  ApprovalDecision,
  CardProjectionPayload,
  SanitizedCardText,
  TaskStatus,
} from '../domain';

export type CardKitJson = Readonly<Record<string, unknown>>;

export interface TaskCardOptions {
  readonly payload: CardProjectionPayload;
  readonly status: TaskStatus;
  readonly cancelToken?: string;
  readonly historical?: boolean;
}

export interface ApprovalCardOptions {
  readonly title: SanitizedCardText;
  readonly kind: 'command' | 'file' | 'permissions';
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly actionTokens: Readonly<Partial<Record<ApprovalDecision, string>>>;
}

export interface ApprovalDecisionCardOptions {
  readonly kind: 'command' | 'file' | 'permissions';
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly decision: ApprovalDecision;
  readonly availableDecisions: readonly ApprovalDecision[];
}

function markdown(content: SanitizedCardText | string, elementId?: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: content || ' ',
    ...(elementId ? { element_id: elementId } : {}),
  };
}

function plainText(content: SanitizedCardText | string, elementId?: string): Record<string, unknown> {
  return {
    tag: 'div',
    text: { tag: 'plain_text', content: content || ' ' },
    ...(elementId ? { element_id: elementId } : {}),
  };
}

function approvalButton(
  decision: ApprovalDecision,
  token: string,
): Record<string, unknown> {
  const labels: Readonly<Record<ApprovalDecision, string>> = {
    accept: '批准一次',
    acceptForSession: '本会话批准',
    decline: '拒绝',
    cancel: '取消任务',
  };
  return {
    tag: 'button',
    type: decision === 'accept' || decision === 'acceptForSession'
      ? 'primary'
      : decision === 'decline' ? 'danger' : 'default',
    width: 'fill',
    text: { tag: 'plain_text', content: labels[decision] },
    value: { action: 'approval', token },
  };
}

function approvalDecisionButton(
  decision: ApprovalDecision,
  selected: ApprovalDecision,
): Record<string, unknown> {
  const labels: Readonly<Record<ApprovalDecision, string>> = {
    accept: decision === selected ? '🟢 已批准 (Approved)' : '批准 (Approve)',
    acceptForSession: decision === selected ? '🛡️ 已总是批准' : '总是批准 (Always)',
    decline: decision === selected ? '🔴 已拒绝 (Denied)' : '拒绝 (Deny)',
    cancel: decision === selected ? '🛑 已取消任务' : '取消任务',
  };
  return {
    tag: 'button',
    type: decision === selected && (decision === 'accept' || decision === 'acceptForSession')
      ? 'primary'
      : decision === selected && decision === 'decline' ? 'danger' : 'default',
    width: 'fill',
    disabled: true,
    text: { tag: 'plain_text', content: labels[decision] },
    value: {},
  };
}

function approvalRisk(kind: ApprovalCardOptions['kind'], summary: SanitizedCardText): {
  readonly template: string;
  readonly text: string;
} {
  const text = `${kind} ${summary}`.toLowerCase();
  if (/\b(rm|delete|curl|wget)\b|https?:\/\/|token|secret/i.test(text)) {
    return { template: 'carmine', text: "<font color='red'><b>高风险 ⚠️ (包含敏感词或命令)</b></font>" };
  }
  if (kind === 'command') {
    return { template: 'orange', text: "<font color='orange'><b>中风险 ⚡️ (执行命令)</b></font>" };
  }
  return { template: 'violet', text: '低风险 ✅' };
}

function approvalMetadata(kind: ApprovalCardOptions['kind'], summary: SanitizedCardText): string {
  const risk = approvalRisk(kind, summary);
  return `📌 **操作类型**: \`${kind}\`\n🛡️ **风险评估**: ${risk.text}`;
}

function approvalColumns(buttons: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    columns: buttons.map((button) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [button],
    })),
  };
}

/** Creates the complete task card from a sanitized projection snapshot. */
export function createTaskCard(options: TaskCardOptions): CardKitJson {
  const { payload, status } = options;
  const running = !payload.terminal;
  const reasoning = withCursor(activityText(payload.commentary, '', running), running);
  const answer = withCursor(
    payload.finalAnswer || (running ? '等待中...' : '无最终文本输出'),
    running,
  );
  const title = running ? '🌌 Codex Remote Control' : terminalTitle(status, options.historical);
  const elements: Record<string, unknown>[] = [
    markdown(`**📥 输入 Prompt**\n> ${payload.prompt}`, 'codex_prompt'),
  ];

  if (payload.metadata) {
    elements.push(markdown(payload.metadata, 'codex_metadata'));
  }

  if (running || payload.commentary) {
    elements.push(
      { tag: 'hr' },
      markdown(`🧠 **模型推理过程**\n${reasoning || '等待开始...'}`, 'codex_reasoning'),
    );
  }
  if (payload.toolSummary && payload.toolSummary !== '暂无') {
    elements.push(
      { tag: 'hr' },
      toolPanel(payload.toolSummary, payload.toolCount ?? 0),
    );
  }
  elements.push(
    { tag: 'hr', element_id: 'codex_output_hr' },
    markdown(`✨ **最终结果输出**\n${answer}`, 'codex_output'),
    { tag: 'hr' },
    plainText(`📊 ${payload.footer}`, 'codex_footer'),
  );
  if (running && options.cancelToken) {
    elements.push(
      { tag: 'hr', element_id: 'codex_cancel_hr' },
      {
        tag: 'button',
        type: 'danger',
        width: 'fill',
        text: { tag: 'plain_text', content: '🛑 停止任务' },
        value: { action: 'cancel', token: options.cancelToken },
        element_id: 'codex_cancel',
      },
    );
  }

  return {
    schema: '2.0',
    config: running
      ? {
          streaming_mode: true,
          update_multi: true,
          summary: { content: 'Codex 执行进度' },
          streaming_config: {
            print_frequency_ms: { default: 30, android: 30, ios: 30, PC: 30 },
            print_step: { default: 3, android: 3, ios: 3, PC: 3 },
            print_strategy: 'delay',
          },
        }
      : { wide_screen_mode: true },
    header: {
      template: headerTemplate(status),
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements,
    },
  };
}

function toolPanel(content: SanitizedCardText, count: number): Record<string, unknown> {
  const title = count > 0 ? `🛠️ 工具执行 · ${count} 步` : '🛠️ 工具与命令';
  return {
    tag: 'collapsible_panel',
    element_id: 'codex_tools_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: title },
    },
    elements: [plainText(content, 'codex_tools')],
  };
}

function activityText(
  commentary: SanitizedCardText,
  toolSummary: SanitizedCardText | '',
  running: boolean,
): string {
  const sections: string[] = [commentary, toolSummary];
  if (sections.length === 0 && running) {
    return '等待开始...';
  }
  return sections.filter(Boolean).join('\n\n---\n\n');
}

function withCursor(value: string, running: boolean): string {
  if (!running || !value || value === '等待中...') {
    return value;
  }
  return `${value} ▍`;
}

function headerTemplate(status: TaskStatus): string {
  if (status === 'FAILED') {
    return 'red';
  }
  if (status === 'INTERRUPTED') {
    return 'grey';
  }
  return status === 'SUCCEEDED' ? 'green' : 'indigo';
}

function terminalTitle(status: TaskStatus, historical = false): string {
  const prefix = historical ? '[历史] ' : '';
  if (status === 'SUCCEEDED') {
    return `${prefix}✅ Codex 执行成功`;
  }
  if (status === 'INTERRUPTED') {
    return `${prefix}🛑 Codex 执行已取消`;
  }
  return `${prefix}❌ Codex 执行失败`;
}

/** Creates an approval card whose buttons expose opaque tokens only. */
export function createApprovalCard(options: ApprovalCardOptions): CardKitJson {
  const decisions: ApprovalDecision[] = [
    'accept',
    'acceptForSession',
    'decline',
    'cancel',
  ];
  const buttons = decisions.flatMap((decision) => {
    const token = options.actionTokens[decision];
    return token ? [approvalButton(decision, token)] : [];
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: approvalRisk(options.kind, options.operationSummary).template,
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      elements: [
        markdown('🚨 Codex 正在尝试执行敏感操作，需要您进行确认授权：'),
        { tag: 'hr' },
        markdown(approvalMetadata(options.kind, options.operationSummary)),
        ...(options.reason && options.reason !== options.operationSummary
          ? [{ tag: 'hr' }, markdown(`❓ **申请原因**:\n${options.reason}`)]
          : []),
        { tag: 'hr' },
        markdown(`💻 **准备执行的操作指令**:\n\`\`\`text\n${options.operationSummary}\n\`\`\``),
        { tag: 'hr' },
        approvalColumns(buttons),
      ],
    },
  };
}

/** Replaces a consumed approval card with the same operation details and no live actions. */
export function createApprovalDecisionCard(options: ApprovalDecisionCardOptions): CardKitJson {
  const accepted = options.decision === 'accept' || options.decision === 'acceptForSession';
  const title = options.decision === 'accept'
    ? '✅ 审批已批准'
    : options.decision === 'acceptForSession'
      ? '🛡️ 审批已总是批准'
      : options.decision === 'cancel'
        ? '🛑 任务已取消'
        : '❌ 审批已拒绝';
  const status = options.decision === 'accept'
    ? '✅ **审批已批准**（本次操作）'
    : options.decision === 'acceptForSession'
      ? '🛡️ **审批已总是批准**（本会话）'
      : options.decision === 'cancel'
        ? '🛑 **已取消任务**'
        : '❌ **审批已拒绝**';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: accepted ? 'green' : 'grey',
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [
        markdown(status),
        { tag: 'hr' },
        markdown(approvalMetadata(options.kind, options.operationSummary)),
        ...(options.reason && options.reason !== options.operationSummary
          ? [{ tag: 'hr' }, markdown(`❓ **申请原因**:\n${options.reason}`)]
          : []),
        { tag: 'hr' },
        markdown(`💻 **执行的操作指令**:\n\`\`\`text\n${options.operationSummary}\n\`\`\``),
        { tag: 'hr' },
        approvalColumns(options.availableDecisions.map((decision) => (
          approvalDecisionButton(decision, options.decision)
        ))),
      ],
    },
  };
}
