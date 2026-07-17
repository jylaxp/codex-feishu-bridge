import {
  ApprovalDecision,
  CardProjectionPayload,
  CardTimelineEntry,
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
  readonly availableDecisions: readonly ApprovalDecision[];
}

export interface ApprovalDecisionCardOptions {
  readonly kind: 'command' | 'file' | 'permissions';
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly cwd?: SanitizedCardText;
  readonly decision: ApprovalDecision;
  readonly availableDecisions: readonly ApprovalDecision[];
}

export interface ApprovalSummaryEntryCardOptions {
  readonly kind: 'command' | 'file' | 'permissions';
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly cwd?: SanitizedCardText;
  readonly actionTokens: Readonly<Partial<Record<ApprovalDecision, string>>>;
  readonly availableDecisions: readonly ApprovalDecision[];
  readonly decision?: ApprovalDecision;
  readonly decidedAt?: Date;
  readonly unavailable?: boolean;
}

export interface ApprovalSummaryCardOptions {
  readonly entries: readonly ApprovalSummaryEntryCardOptions[];
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
  selected?: ApprovalDecision,
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

function approvalDecisionStatus(decision: ApprovalDecision, decidedAt: Date): string {
  const formatted = formatDateTime24h(decidedAt);
  if (decision === 'accept') {
    return `✅ **审批已批准** (已于 **${formatted}** 被批准执行一次)`;
  }
  if (decision === 'acceptForSession') {
    return `🛡️ **已总是批准该操作** (已于 **${formatted}** 批准在本次会话中不再询问)`;
  }
  if (decision === 'cancel') {
    return `🛑 **任务已取消** (已于 **${formatted}** 取消该任务。)`;
  }
  return `❌ **审批已拒绝** (已于 **${formatted}** 被拒绝执行。Codex 将停止该步骤的执行。)`;
}

function approvalActionElements(
  actionTokens: Readonly<Partial<Record<ApprovalDecision, string>>>,
  availableDecisions: readonly ApprovalDecision[],
  decision?: ApprovalDecision,
  unavailable = false,
): Record<string, unknown> {
  const decisions = availableDecisions;
  const buttons = decision || unavailable
    ? decisions.map((item) => approvalDecisionButton(item, decision))
    : decisions.flatMap((item) => {
      const token = actionTokens[item];
      return token ? [approvalButton(item, token)] : [];
    });
  return approvalColumns(buttons);
}

function approvalDetailElements(options: ApprovalSummaryEntryCardOptions): Record<string, unknown>[] {
  const operationLabel = options.decision || options.unavailable
    ? '执行的操作指令'
    : '准备执行的操作指令';
  return [
    markdown(approvalMetadata(options.kind, options.operationSummary, options.cwd)),
    ...(options.reason && options.reason !== options.operationSummary
      ? [{ tag: 'hr' }, markdown(`❓ **申请原因**:\n${options.reason}`)]
      : []),
    { tag: 'hr' },
    markdown(`💻 **${operationLabel}**:\n\`\`\`text\n${options.operationSummary}\n\`\`\``),
    { tag: 'hr' },
    approvalActionElements(
      options.actionTokens,
      options.availableDecisions,
      options.decision,
      options.unavailable,
    ),
  ];
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

  const timeline = timelineElements(payload.timeline);
  if (timeline.length > 0) {
    elements.push(
      { tag: 'hr' },
      markdown('🧠 **模型推理过程**', running ? 'codex_reasoning' : undefined),
      ...timeline,
    );
  } else if (running || payload.commentary) {
    elements.push(
      { tag: 'hr' },
      markdown(
        `🧠 **模型推理过程**\n${reasoning || '等待开始...'}`,
        running ? 'codex_reasoning' : undefined,
      ),
    );
  }
  const toolPanels = timeline.length === 0 && running ? toolPanelElements(payload) : [];
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

function timelineElements(entries: readonly CardTimelineEntry[] | undefined): readonly Record<string, unknown>[] {
  if (!entries || entries.length === 0) {
    return [];
  }
  return entries.flatMap((entry, index) => {
    if (entry.kind === 'reasoning' && entry.content) {
      return [markdown(
        `📎 **[${entry.time}] 模型推理**\n${entry.content}`,
        timelineElementId('r', index),
      )];
    }
    if (entry.kind === 'tool' && entry.tool) {
      return [toolPanel(
        `🛠️ [${entry.time}] 工具执行 · ${entry.tool.count} 步`,
        entry.tool.content,
        entry.tool.count,
        timelineElementId('t', index),
        timelineElementId('c', index),
        entry.tool.icon,
        entry.tool.completed,
        entry.tool.failed,
      )];
    }
    return [];
  });
}

/** CardKit element ids must start with a letter and cannot exceed 20 characters. */
function timelineElementId(kind: 'r' | 't' | 'c', index: number): string {
  return `tl${kind}${index + 1}`;
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
        ...approvalDetailElements(options),
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
  const status = approvalDecisionStatus(options.decision, new Date());
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
        ...approvalDetailElements({
          kind: options.kind,
          operationSummary: options.operationSummary,
          reason: options.reason,
          cwd: options.cwd,
          actionTokens: {},
          availableDecisions: options.availableDecisions,
          decision: options.decision,
        }),
      ],
    },
  };
}

/** Marks a card unavailable when its decision could not reach ChatGPT Desktop. */
export function createApprovalUnavailableCard(options: ApprovalCardOptions): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'carmine',
      title: { tag: 'plain_text', content: '⚠️ 审批未能送达 Desktop' },
    },
    body: {
      elements: [
        markdown('该审批结果未能确认送达 ChatGPT Desktop。为避免重复或错误授权，全部操作按钮已禁用。'),
        { tag: 'hr' },
        ...approvalDetailElements({ ...options, unavailable: true }),
      ],
    },
  };
}

/** Creates one updatable approval tray for all approvals raised by a task. */
export function createApprovalSummaryCard(options: ApprovalSummaryCardOptions): CardKitJson {
  const waitingCount = options.entries.filter((entry) => !entry.decision && !entry.unavailable).length;
  const elements: Record<string, unknown>[] = [
    markdown(
      waitingCount > 0
        ? `🚨 此任务有 **${waitingCount}** 项待确认的敏感操作。请逐项作出决定。`
        : '✅ 此任务的全部安全审批都已处理。',
    ),
  ];
  for (const [index, entry] of options.entries.entries()) {
    const state = entry.decision
      ? approvalDecisionStatus(entry.decision, entry.decidedAt ?? new Date())
      : entry.unavailable
        ? '⚠️ **审批结果未能送达 Desktop，按钮已禁用**'
      : '⏳ **等待审批决定**';
    elements.push(
      { tag: 'hr' },
      markdown(`**审批 ${index + 1}**\n${state}`),
      { tag: 'hr' },
      ...approvalDetailElements(entry),
    );
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: waitingCount > 0 ? 'violet' : 'green',
      title: { tag: 'plain_text', content: '⚡️ Codex 安全审批申请' },
    },
    body: { elements },
  };
}
