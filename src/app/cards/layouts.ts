import {
  ApprovalDecision,
  CardProjectionPayload,
  SanitizedCardText,
  TaskStatus,
} from '../domain';
import { formatDateTime24h } from './original-common';

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
  readonly cwd?: SanitizedCardText;
  readonly actionTokens: Readonly<Partial<Record<ApprovalDecision, string>>>;
}

export interface ApprovalDecisionCardOptions {
  readonly kind: 'command' | 'file' | 'permissions';
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly cwd?: SanitizedCardText;
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

function approvalButton(
  decision: ApprovalDecision,
  token: string,
): Record<string, unknown> {
  const labels: Readonly<Record<ApprovalDecision, string>> = {
    accept: '🟢 批准 (Approve)',
    acceptForSession: '🛡️ 总是批准 (Always)',
    decline: '🔴 拒绝 (Deny)',
    cancel: '🛑 取消任务',
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

function approvalMetadata(
  kind: ApprovalCardOptions['kind'],
  summary: SanitizedCardText,
  cwd?: SanitizedCardText,
): string {
  const risk = approvalRisk(kind, summary);
  return `📌 **操作类型**: \`${kind}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${risk.text}`;
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
  const reasoning = running
    ? withCursor(activityText(payload.commentary, '', true), true)
    : truncateText(
        payload.commentary,
        10_000,
        '\n\n... (由于长度限制，后续推理过程已被截断) ...',
      );
  const answer = running
    ? withCursor(payload.finalAnswer || '等待中...', true)
    : truncateText(
        payload.finalAnswer || '无最终文本输出',
        10_000,
        '\n\n... (由于长度限制，后续输出已被截断，请在 IDE 中查看完整内容) ...',
      );
  const title = running ? '🌌 Codex Remote Control' : terminalTitle(status, options.historical);
  const elements: Record<string, unknown>[] = [
    markdown(`**📥 输入 Prompt**\n> ${payload.prompt}`, running ? 'codex_prompt' : undefined),
  ];

  if (payload.metadata) {
    elements.push(markdown(payload.metadata, running ? 'codex_metadata' : undefined));
  }

  if (running || payload.commentary) {
    elements.push(
      { tag: 'hr' },
      markdown(
        `🧠 **模型推理过程**\n${reasoning || '等待开始...'}`,
        running ? 'codex_reasoning' : undefined,
      ),
    );
  }
  const toolPanels = running ? toolPanelElements(payload) : [];
  if (toolPanels.length > 0) {
    elements.push(
      { tag: 'hr' },
      ...toolPanels,
    );
  }
  elements.push(
    running ? { tag: 'hr', element_id: 'codex_output_hr' } : { tag: 'hr' },
    markdown(`✨ **最终结果输出**\n${answer}`, running ? 'codex_output' : undefined),
    { tag: 'hr' },
    markdown(`📊 ${payload.footer}`, running ? 'codex_footer' : undefined),
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
      template: headerTemplate(status, options.historical),
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements,
    },
  };
}

function toolPanelElements(payload: CardProjectionPayload): readonly Record<string, unknown>[] {
  if (payload.toolGroups && payload.toolGroups.length > 0) {
    return payload.toolGroups.map((group, index) => toolPanel(
      group.title,
      group.content,
      group.count,
      index === 0 ? 'codex_tools_panel' : `codex_tools_panel_${index + 1}`,
      index === 0 ? 'codex_tools' : `codex_tools_${index + 1}`,
      group.icon,
      group.completed,
      group.failed,
    ));
  }
  if (payload.toolSummary && payload.toolSummary !== '暂无') {
    const count = payload.toolCount ?? 0;
    return [toolPanel(
      count > 0 ? `🛠️ 工具执行 · ${count} 步` : '🛠️ 工具与命令',
      payload.toolSummary,
      count,
      'codex_tools_panel',
      'codex_tools',
      'api-app_outlined',
      true,
      false,
    )];
  }
  return [];
}

function toolPanel(
  title: SanitizedCardText | string,
  content: SanitizedCardText,
  _count: number,
  elementId: string,
  contentElementId: string,
  icon = 'api-app_outlined',
  completed = true,
  failed = false,
): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    expanded: !completed,
    header: {
      title: { tag: 'plain_text', content: title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: icon, color: 'grey', size: '16px 16px' },
      icon_position: 'left',
    },
    border: { color: failed ? 'red' : 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '4px 8px 4px 8px',
    elements: [markdown(content, contentElementId)],
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

function headerTemplate(status: TaskStatus, historical = false): string {
  if (historical) {
    return 'indigo';
  }
  if (status === 'FAILED') {
    return 'red';
  }
  if (status === 'INTERRUPTED') {
    return 'grey';
  }
  return status === 'SUCCEEDED' ? 'green' : 'indigo';
}

function terminalTitle(status: TaskStatus, historical = false): string {
  const prefix = historical ? '📜 [历史] ' : '';
  if (status === 'SUCCEEDED') {
    return `${prefix}✅ Codex 执行成功`;
  }
  if (status === 'INTERRUPTED') {
    return `${prefix}🛑 Codex 执行已取消`;
  }
  return `${prefix}❌ Codex 执行失败`;
}

function truncateText(text: string, limit: number, suffix: string): string {
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}${suffix}`;
}

/** Creates an approval card whose buttons expose opaque tokens only. */
export function createApprovalCard(options: ApprovalCardOptions): CardKitJson {
  const decisions: ApprovalDecision[] = [
    'accept',
    'acceptForSession',
    'decline',
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
      title: { tag: 'plain_text', content: '⚡️ Codex 安全审批申请' },
    },
    body: {
      elements: [
        markdown('🚨 Codex 正在尝试在您的系统上执行以下敏感操作，需要您进行确认授权：'),
        { tag: 'hr' },
        markdown(approvalMetadata(options.kind, options.operationSummary, options.cwd)),
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
      : '❌ 审批已拒绝';
  const decidedAt = formatDateTime24h(new Date());
  const status = options.decision === 'accept'
    ? `✅ **审批已批准** (已于 **${decidedAt}** 被批准执行一次)`
    : options.decision === 'acceptForSession'
      ? `🛡️ **已总是批准该操作** (已于 **${decidedAt}** 批准在本次会话中不再询问)`
      : `❌ **审批已拒绝** (已于 **${decidedAt}** 被拒绝执行。Codex 将停止该步骤的执行。)`;
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
        markdown(approvalMetadata(options.kind, options.operationSummary, options.cwd)),
        ...(options.reason && options.reason !== options.operationSummary
          ? [{ tag: 'hr' }, markdown(`❓ **申请原因**:\n${options.reason}`)]
          : []),
        { tag: 'hr' },
        markdown(`💻 **执行的操作指令**:\n\`\`\`text\n${options.operationSummary}\n\`\`\``),
        { tag: 'hr' },
        approvalColumns((['accept', 'acceptForSession', 'decline'] as const).map((decision) => (
          approvalDecisionButton(decision, options.decision)
        ))),
      ],
    },
  };
}
