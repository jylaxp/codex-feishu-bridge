import type { CardKitJson } from './layouts';
import {
  createBoundSuccessCard as createOriginalBoundSuccessCard,
  createGoalCard as createOriginalGoalCard,
  createHelpCard as createOriginalHelpCard,
  createMcpCard as createOriginalMcpCard,
  createSkillsCard as createOriginalSkillsCard,
  createStatusCard as createOriginalStatusCard,
} from './original-templates';

export interface CommandSelectOption {
  readonly label: string;
  readonly token: string;
}

export interface StatusCardInput {
  readonly name: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly personality: string | undefined;
  readonly planMode: boolean;
  readonly model: string | undefined;
  readonly activeSkill: string | undefined;
  readonly goal: unknown;
}

/** Extends the original help card with the Bridge image-input workflow. */
export function createHelpCard(_allowedShellCommands: readonly string[]): CardKitJson {
  const card = createOriginalHelpCard() as MutableCard;
  card.body.elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: '🖼️ **图片任务**\n'
        + '- 图文消息会作为一个任务直接提交。\n'
        + '- 单独发送的图片会暂存，可继续追加图片。\n'
        + '- 在图片回执卡片中填写可选任务描述，再点击“提交图片”；留空时仅提交图片。\n'
        + '- 使用图片回执卡片的“取消”按钮可清除当前批次。\n'
        + '- 兼容指令：`/image-run` 提交，`/image-cancel` 取消。\n'
        + '- 每个任务最多 8 张图片，支持 JPG、PNG、WebP，单张不超过 20 MB。',
    },
  });
  return card as unknown as CardKitJson;
}

/** Returns the original model picker; only the invisible option values use opaque action tokens. */
export function createModelPickerCard(options: readonly CommandSelectOption[]): CardKitJson {
  if (options.length === 0) {
    return simpleStatusCard(
      '⚠️ 缓存未找到',
      'orange',
      '未找到 Codex 的模型缓存文件。请手动使用 `/model <名称>` 指定。',
    );
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '🤖 选择大模型' },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '请从以下列表中选择一个模型，该模型将应用于当前会话：',
        },
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '点击下拉选择模型...' },
          options: options.map((option) => ({
            text: { tag: 'plain_text', content: option.label },
            value: option.token,
          })),
          value: { action: 'model' },
        },
      ],
    },
  };
}

/** Returns the original application's MCP card unchanged. */
export function createMcpCard(value: unknown): CardKitJson {
  return createOriginalMcpCard(value) as CardKitJson;
}

/**
 * Returns the original application's skill card. Only action identifiers and
 * option values are adapted to the new in-memory command channel.
 */
export function createSkillsCard(
  value: unknown,
  cwd: string,
  options: readonly CommandSelectOption[],
  selectedSkill?: string,
): CardKitJson {
  const card = createOriginalSkillsCard(value, cwd, selectedSkill) as MutableCard;
  const select = card.body.elements.find((element) => element.tag === 'select_static');
  if (select) {
    select.value = { action: 'skill' };
    const originalOptions = Array.isArray(select.options) ? select.options : [];
    select.options = originalOptions.map((option, index) => ({
      ...option,
      ...(options[index] ? { value: options[index].token } : {}),
    }));
  }
  return card as unknown as CardKitJson;
}

/** Returns the original application's goal card unchanged. */
export function createGoalCard(value: unknown): CardKitJson {
  const record = asRecord(value);
  return createOriginalGoalCard(record?.goal ?? value) as CardKitJson;
}

/** Returns the original application's status card and intentionally ignores new UI-only fields. */
export function createStatusCard(input: StatusCardInput): CardKitJson {
  return createOriginalStatusCard({
    name: input.name,
    threadId: input.threadId,
    cwd: input.cwd,
    personality: input.personality ?? 'none',
    planMode: input.planMode,
    goal: asRecord(input.goal)?.goal ?? input.goal,
  }) as CardKitJson;
}

/** Returns the original application's successful binding card unchanged. */
export function createBoundSuccessCard(
  threadName: string,
  threadId: string,
  cwd?: string,
): CardKitJson {
  return createOriginalBoundSuccessCard(threadName, threadId, cwd) as CardKitJson;
}

export function flattenSkills(value: unknown): readonly {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly path: string;
}[] {
  const entries = arrayData(value);
  const skills = entries.flatMap((entry) => {
    const record = asRecord(entry);
    return Array.isArray(record?.skills) ? record.skills : [];
  }).flatMap((candidate) => {
    const skill = asRecord(candidate);
    const name = text(skill?.name);
    if (!name) return [];
    return [{
      name,
      description: text(skill?.shortDescription) ?? text(skill?.description) ?? '',
      scope: text(skill?.scope) ?? 'global',
      path: text(skill?.path) ?? '',
    }];
  });
  return Object.freeze(skills.sort((left, right) => left.name.localeCompare(right.name)));
}

interface MutableCard {
  readonly schema: string;
  readonly config: Record<string, unknown>;
  readonly header: Record<string, unknown>;
  readonly body: {
    readonly elements: MutableCardElement[];
  };
}

interface MutableCardElement extends Record<string, unknown> {
  readonly tag?: string;
  value?: unknown;
  options?: Array<Record<string, unknown>>;
}

function simpleStatusCard(title: string, template: string, content: string): CardKitJson {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: {
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content },
      }],
    },
  };
}

function arrayData(value: unknown): readonly unknown[] {
  const record = asRecord(value);
  return Array.isArray(record?.data) ? record.data : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
