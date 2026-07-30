import { createHash, randomUUID } from 'node:crypto';

const MAX_FIELD_LENGTH = 2_000;
const MAX_VISIBLE_TEXT_LENGTH = 32_000;
const DIRECTIVE_BLOCK_PATTERN = /```cfb-handoff\s*([\s\S]*?)```/i;
const SECRET_PATTERNS = [
  /\b(?:sk|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g,
];

export interface HandoffDirective {
  readonly target: string;
  readonly task: string;
  readonly reason?: string;
  readonly contextSummary?: string;
  readonly evidence?: string;
  readonly expectedOutput?: string;
  readonly confidence?: string;
}

export interface ParsedHandoffDirective {
  readonly directive: HandoffDirective;
  readonly visibleText: string;
}

export interface HandoffEnvelope {
  readonly chainId: string;
  readonly handoffId: string;
  readonly sourceBotKey: string;
  readonly hop: number;
  readonly expiresAtMs: number;
  readonly visitedBotKeys: readonly string[];
}

export function parseHandoffDirective(finalAnswer: string): ParsedHandoffDirective | null {
  const match = DIRECTIVE_BLOCK_PATTERN.exec(finalAnswer);
  if (!match?.[1]) {
    return null;
  }
  const fields = parseDirectiveFields(match[1]);
  const target = firstField(fields, ['target', 'bot', '目标', '目标机器人']);
  const task = firstField(fields, ['task', '任务', '目标任务']);
  if (!target || !task) {
    return null;
  }
  const visibleText = boundedText(
    `${finalAnswer.slice(0, match.index)}${finalAnswer.slice(match.index + match[0].length)}`.trim(),
    MAX_VISIBLE_TEXT_LENGTH,
  );
  return Object.freeze({
    directive: Object.freeze({
      target,
      task,
      ...(firstField(fields, ['reason', '原因']) ? { reason: firstField(fields, ['reason', '原因']) } : {}),
      ...(firstField(fields, ['context', 'contextSummary', '上下文摘要'])
        ? { contextSummary: firstField(fields, ['context', 'contextSummary', '上下文摘要']) }
        : {}),
      ...(firstField(fields, ['evidence', '证据']) ? { evidence: firstField(fields, ['evidence', '证据']) } : {}),
      ...(firstField(fields, ['expected', 'expectedOutput', '期望输出'])
        ? { expectedOutput: firstField(fields, ['expected', 'expectedOutput', '期望输出']) }
        : {}),
      ...(firstField(fields, ['confidence', '置信度'])
        ? { confidence: firstField(fields, ['confidence', '置信度']) }
        : {}),
    }),
    visibleText,
  });
}

export function createRootHandoffEnvelope(
  sourceBotKey: string,
  nowMs: number,
  ttlMs: number,
  seed: string,
): HandoffEnvelope {
  const chainId = `ch_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  return createChildHandoffEnvelope({
    chainId,
    sourceBotKey,
    hop: 1,
    expiresAtMs: nowMs + ttlMs,
    visitedBotKeys: [sourceBotKey],
    seed,
  });
}

export function createChildHandoffEnvelope(input: {
  readonly chainId: string;
  readonly sourceBotKey: string;
  readonly hop: number;
  readonly expiresAtMs: number;
  readonly visitedBotKeys: readonly string[];
  readonly seed: string;
}): HandoffEnvelope {
  return Object.freeze({
    chainId: input.chainId,
    handoffId: `hf_${createHash('sha256').update(input.seed).digest('hex').slice(0, 24)}`,
    sourceBotKey: input.sourceBotKey,
    hop: input.hop,
    expiresAtMs: input.expiresAtMs,
    visitedBotKeys: Object.freeze([...new Set(input.visitedBotKeys)]),
  });
}

export function sanitizeHandoffField(value: string | undefined, maxLength = MAX_FIELD_LENGTH): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }
  sanitized = sanitized
    .replace(/(?:^|\s)(?:\/Users|\/private|[A-Za-z]:\\)[^\s`]+/g, ' [local-path]')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return boundedText(sanitized, maxLength);
}

function parseDirectiveFields(block: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    const field = /^([^:：]{1,40})[:：]\s*(.*)$/.exec(line);
    if (field?.[1]) {
      currentKey = field[1].trim();
      entries.set(currentKey, sanitizeHandoffField(field[2] ?? '') ?? '');
      continue;
    }
    if (currentKey && line.trim()) {
      const previous = entries.get(currentKey) ?? '';
      entries.set(currentKey, sanitizeHandoffField(`${previous}\n${line}`) ?? previous);
    }
  }
  return entries;
}

function firstField(fields: ReadonlyMap<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const exact = fields.get(name);
    if (exact?.trim()) {
      return exact.trim();
    }
    const folded = [...fields.entries()].find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (folded?.[1]?.trim()) {
      return folded[1].trim();
    }
  }
  return undefined;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
