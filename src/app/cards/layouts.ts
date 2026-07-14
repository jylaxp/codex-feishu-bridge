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
}

export interface ApprovalCardOptions {
  readonly title: SanitizedCardText;
  readonly operationSummary: SanitizedCardText;
  readonly reason: SanitizedCardText;
  readonly actionTokens: Readonly<Partial<Record<ApprovalDecision, string>>>;
}

const STATUS_PRESENTATION: Readonly<Record<TaskStatus, readonly [string, string]>> = {
  RECEIVED: ['indigo', '已接收任务'],
  CARD_CREATING: ['indigo', '正在创建任务卡片'],
  STARTING: ['indigo', '正在启动 Codex'],
  RUNNING: ['blue', 'Codex 执行中'],
  AWAITING_APPROVAL: ['orange', '等待审批'],
  COMPLETING: ['blue', '正在收敛执行结果'],
  QUEUED: ['orange', '任务排队中'],
  DISPATCH_UNKNOWN: ['red', '请求结果待核对'],
  RECOVERING: ['orange', '正在恢复连接'],
  NEEDS_REVIEW: ['red', '需要人工核对'],
  DELIVERY_DELAYED: ['orange', '飞书卡片投递延迟'],
  SUCCEEDED: ['green', 'Codex 执行成功'],
  FAILED: ['red', 'Codex 执行失败'],
  INTERRUPTED: ['grey', 'Codex 执行已取消'],
};

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

/** Creates the complete task card from a sanitized projection snapshot. */
export function createTaskCard(options: TaskCardOptions): CardKitJson {
  const { payload, status, cancelToken } = options;
  const [template, statusText] = STATUS_PRESENTATION[status];
  const terminal = payload.terminal;
  const elements: Array<Record<string, unknown>> = [
    markdown(`**输入**\n${payload.prompt}`, 'codex_prompt'),
    markdown(`**目标会话**\n${payload.target}`, 'codex_target'),
    { tag: 'hr' },
    markdown(`**当前状态**\n${statusText}`, 'codex_status'),
    { tag: 'hr' },
    markdown(`**执行过程**\n${payload.commentary || '等待事件...'}`, 'codex_commentary'),
    markdown(`**工具与命令**\n${payload.toolSummary || '暂无'}`, 'codex_tools'),
    { tag: 'hr' },
    markdown(`**最终结果**\n${payload.finalAnswer || '等待中...'}`, 'codex_output'),
    { tag: 'hr' },
    markdown(payload.footer, 'codex_footer'),
  ];

  if (!terminal && cancelToken) {
    elements.push({
      tag: 'button',
      type: 'danger',
      text: { tag: 'plain_text', content: '取消任务' },
      value: { action: 'cancel', token: cancelToken },
    });
  }

  return {
    schema: '2.0',
    config: terminal
      ? { wide_screen_mode: true }
      : {
          streaming_mode: true,
          update_multi: true,
          summary: { content: statusText },
        },
    header: {
      template,
      title: { tag: 'plain_text', content: payload.title || statusText },
    },
    body: { elements },
  };
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
      template: 'orange',
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      elements: [
        markdown('Codex 请求执行需要授权的操作。请确认后再选择。'),
        { tag: 'hr' },
        markdown(`**操作摘要**\n${options.operationSummary}`),
        markdown(`**申请原因**\n${options.reason || '未提供'}`),
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'stretch',
          columns: buttons.map((button) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [button],
          })),
        },
      ],
    },
  };
}
