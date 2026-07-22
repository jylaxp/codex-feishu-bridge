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
  /** A completed volume of a still-running task; it must not remain interactive. */
  readonly continued?: boolean;
  /** Follow-up volumes omit the original prompt to preserve space for new output. */
  readonly showPrompt?: boolean;
  /** Completed process-only volumes do not repeat the final-answer placeholder. */
  readonly showFinalAnswer?: boolean;
  /** Dedicated answer volumes omit the reasoning placeholder. */
  readonly showReasoning?: boolean;
  /** Full continuation volumes omit the redundant status footer. */
  readonly showFooter?: boolean;
  readonly continuationText?: SanitizedCardText;
  /** The orchestrator already byte-sized this volume, so terminal rendering must preserve it. */
  readonly contentFitsCard?: boolean;
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

/** Builds the explicit rejection shown when a conversation queue has no capacity. */
export function createQueueFullCard(maxQueuedTasks: number): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '⚠️ 任务未接收' },
    },
    body: {
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `当前会话已有任务运行，且 ${maxQueuedTasks} 个排队位置已满。请稍后重新发送。`,
        },
      }],
    },
  };
}

/** Builds a safe user-facing reply when an inbound image cannot be prepared. */
export function createImageInputErrorCard(): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '⚠️ 图片未接收' },
    },
    body: {
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '图片下载失败、超过 20 MB，或格式不受支持。'
            + '请发送 JPG、PNG 或 WebP 图片后重试。',
        },
      }],
    },
  };
}

/** Tells the user that image metadata is held in memory and exposes one-shot actions. */
export function createImagePendingCard(_imageCount: number, actionToken: string): CardKitJson {
  return imageBatchActionCard(
    'blue',
    '🖼️ 图片已接收',
    '图片已暂存。可以继续发送图片，也可以填写可选任务描述后直接提交。',
    actionToken,
  );
}

function imageBatchActionCard(
  template: string,
  title: string,
  content: string,
  actionToken: string,
  initialTaskDescription?: string,
): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content,
          },
        },
        {
          tag: 'form',
          name: 'image_task_form',
          elements: [
            {
              tag: 'input',
              name: 'task_description',
              label: { tag: 'plain_text', content: '任务描述（可选）' },
              label_position: 'top',
              placeholder: {
                tag: 'plain_text',
                content: '例如：比较这些图片并给出修改建议',
              },
              max_length: 1_000,
              ...(initialTaskDescription
                ? { default_value: initialTaskDescription }
                : {}),
            },
            {
              tag: 'button',
              name: 'submit',
              action_type: 'form_submit',
              type: 'primary',
              width: 'fill',
              text: { tag: 'plain_text', content: '提交图片' },
              value: { action: 'image-run', token: actionToken },
            },
          ],
        },
        {
          tag: 'button',
          type: 'default',
          width: 'fill',
          text: { tag: 'plain_text', content: '取消' },
          value: { action: 'image-cancel', token: actionToken },
          confirm: {
            title: { tag: 'plain_text', content: '确认取消？' },
            text: { tag: 'plain_text', content: '取消后，当前暂存的图片不会发送给 Codex。' },
          },
        },
      ],
    },
  };
}

/** Confirms that an in-memory image batch was discarded before Codex execution. */
export function createImageBatchCancelledCard(): CardKitJson {
  return imageNoticeCard('grey', '已取消图片任务', '待提交图片已清除，没有发送给 Codex。');
}

/** Confirms that the pending image batch was accepted for background dispatch. */
export function createImageBatchSubmittedCard(): CardKitJson {
  return imageNoticeCard('green', '图片任务已提交', '图片正在发送给 Codex，请等待任务卡片更新。');
}

/** Explains that an image-batch command had no pending images to operate on. */
export function createImageBatchEmptyCard(): CardKitJson {
  return imageNoticeCard('grey', '当前没有待提交图片', '请先发送图片，再发送任务描述或 `/image-run`。');
}

/** Reports a failed button submission and offers a retry only when the batch was restored. */
export function createImageSubmissionFailedCard(
  imageCount: number,
  retryToken: string | null,
  taskDescription?: string,
): CardKitJson {
  if (!retryToken) {
    return imageNoticeCard(
      'orange',
      '⚠️ 图片任务提交失败',
      '本批图片未能提交；当前会话已经收到新的图片批次，请重新发送本批图片。',
    );
  }
  return imageBatchActionCard(
    'orange',
    '⚠️ 图片任务提交失败',
    taskDescription
      ? `已保留 ${imageCount} 张图片和任务描述，请确认后点击“提交图片”重试。`
      : `已保留 ${imageCount} 张图片，请点击“提交图片”重试。`,
    retryToken,
    taskDescription,
  );
}

/** Rejects an image batch before any resource download begins. */
export function createImageCountErrorCard(maximumImages: number): CardKitJson {
  return imageNoticeCard(
    'orange',
    '⚠️ 图片数量已达上限',
    `一个任务最多接收 ${maximumImages} 张图片。`
      + '请先发送任务描述，或点击图片回执卡片中的“提交图片”。',
  );
}

/** Rejects an excessive burst without allowing the per-conversation promise chain to grow forever. */
export function createImageInputOverloadedCard(): CardKitJson {
  return imageNoticeCard(
    'orange',
    '⚠️ 图片消息处理繁忙',
    '当前会话短时间内输入过多。请等待现有消息处理完成后，再发送未处理的内容。',
  );
}

function imageNoticeCard(template: string, title: string, content: string): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content },
      }],
    },
  };
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
  const live = !payload.terminal && !options.continued;
  const reasoning = live
    ? withCursor(activityText(payload.commentary, '', true), true)
    : options.contentFitsCard ? payload.commentary : truncateText(
        payload.commentary,
        10_000,
        '\n\n... (由于长度限制，后续推理过程已被截断) ...',
      );
  const answer = live
    ? withCursor(payload.finalAnswer || '等待中...', true)
    : options.contentFitsCard ? payload.finalAnswer || '无最终文本输出' : truncateText(
        payload.finalAnswer || '无最终文本输出',
        10_000,
        '\n\n... (由于长度限制，后续输出已被截断，请在 IDE 中查看完整内容) ...',
      );
  const title = payload.title || (live ? '🌌 Codex Remote Control' : terminalTitle(status, options.historical));
  const elements: Record<string, unknown>[] = [];

  if (options.showPrompt !== false) {
    elements.push(markdown(`**📥 输入 Prompt**\n> ${payload.prompt}`, live ? 'codex_prompt' : undefined));
  } else {
    elements.push(markdown('📚 **任务续页**'));
  }

  if (payload.metadata) {
    elements.push(markdown(payload.metadata, live ? 'codex_metadata' : undefined));
  }

  const timeline = options.showReasoning === false ? [] : timelineElements(payload.timeline);
  if (options.showReasoning !== false && timeline.length > 0) {
    elements.push(
      { tag: 'hr' },
      markdown('🧠 **模型推理过程**', live ? 'codex_reasoning' : undefined),
      ...timeline,
    );
  } else if (options.showReasoning !== false && (live || payload.commentary)) {
    elements.push(
      { tag: 'hr' },
      markdown(
        `🧠 **模型推理过程**\n${reasoning || '等待开始...'}`,
        live ? 'codex_reasoning' : undefined,
      ),
    );
  }
  const toolPanels = options.showReasoning !== false && timeline.length === 0 && live
    ? toolPanelElements(payload)
    : [];
  if (toolPanels.length > 0) {
    elements.push(
      { tag: 'hr' },
      ...toolPanels,
    );
  }
  if (options.showFinalAnswer !== false) {
    elements.push(
      live ? { tag: 'hr', element_id: 'codex_output_hr' } : { tag: 'hr' },
      markdown(`✨ **最终结果输出**\n${answer}`, live ? 'codex_output' : undefined),
    );
  }
  if (options.showFooter !== false) {
    elements.push(
      { tag: 'hr' },
      markdown(`📊 ${payload.footer}`, live ? 'codex_footer' : undefined),
    );
  }
  if (options.continuationText) {
    elements.push({ tag: 'hr' }, markdown(options.continuationText));
  }
  if (live && options.cancelToken) {
    elements.push(
      { tag: 'hr', element_id: 'codex_cancel_hr' },
      {
        tag: 'button',
        type: 'danger',
        width: 'fill',
        text: { tag: 'plain_text', content: '🛑 停止任务' },
        value: { action: 'cancel', token: options.cancelToken },
        element_id: 'codex_cancel',
        confirm: {
          title: { tag: 'plain_text', content: '确认停止任务？' },
          text: {
            tag: 'plain_text',
            content: '停止后当前 Codex 任务会被中断，已执行的操作不会自动回滚。',
          },
        },
      },
    );
  }

  return {
    schema: '2.0',
    config: live
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
        `[${entry.time}] ${entry.tool.title}`,
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
  _completed = true,
  failed = false,
): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    element_id: elementId,
    expanded: false,
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
