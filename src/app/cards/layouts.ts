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
  const { payload, status } = options;
  const running = !payload.terminal;
  const reasoning = payload.commentary || '等待开始...';
  const answer = payload.finalAnswer || (running ? '等待中...' : '无最终文本输出');
  const title = running ? '🌌 Codex Remote Control' : terminalTitle(status);

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
      elements: [
        markdown(`**📥 输入 Prompt**\n> ${payload.prompt}`, 'codex_prompt'),
        { tag: 'hr' },
        markdown(`🧠 **模型推理过程**\n${reasoning}`, 'codex_reasoning'),
        { tag: 'hr', element_id: 'codex_output_hr' },
        markdown(`✨ **最终结果输出**\n${answer}`, 'codex_output'),
        { tag: 'hr' },
        markdown(`📊 ${payload.footer}`, 'codex_footer'),
      ],
    },
  };
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

function terminalTitle(status: TaskStatus): string {
  if (status === 'SUCCEEDED') {
    return '✅ Codex 执行成功';
  }
  if (status === 'INTERRUPTED') {
    return '🛑 Codex 执行已取消';
  }
  return '❌ Codex 执行失败';
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
