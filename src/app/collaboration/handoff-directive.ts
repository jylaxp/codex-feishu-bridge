import { createHash, randomUUID } from 'node:crypto';

const MAX_FIELD_LENGTH = 2_000;
const MAX_VISIBLE_TEXT_LENGTH = 32_000;
const DIRECTIVE_BLOCK_PATTERN = /```cfb-handoff\s*([\s\S]*?)```/i;
const HEADER_PATTERN = /^\[cfb-handoff v1\s+([^\]]+)\]\s*$/m;
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

export interface ParsedHandoffEnvelope {
  readonly envelope: HandoffEnvelope;
  readonly taskText: string;
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

export function parseHandoffEnvelope(text: string): ParsedHandoffEnvelope | null {
  const match = HEADER_PATTERN.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const params = parseHeaderParams(match[1]);
  const chainId = validOpaqueId(params.get('chain'));
  const handoffId = validOpaqueId(params.get('handoff'));
  const sourceBotKey = validBotKey(params.get('from'));
  const hop = integerValue(params.get('hop'));
  const expiresAtMs = integerValue(params.get('ttl'));
  if (!chainId || !handoffId || !sourceBotKey || hop === null || expiresAtMs === null) {
    return null;
  }
  const visitedBotKeys = (params.get('visited') ?? sourceBotKey)
    .split(',')
    .map((value) => validBotKey(value))
    .filter((value): value is string => value !== null);
  const taskText = text.replace(match[0], '').trim();
  if (!taskText) {
    return null;
  }
  return Object.freeze({
    envelope: Object.freeze({
      chainId,
      handoffId,
      sourceBotKey,
      hop,
      expiresAtMs,
      visitedBotKeys: Object.freeze([...new Set(visitedBotKeys)]),
    }),
    taskText,
  });
}

export function buildHandoffEnvelopeText(envelope: HandoffEnvelope): string {
  const fields = [
    `chain=${envelope.chainId}`,
    `handoff=${envelope.handoffId}`,
    `from=${envelope.sourceBotKey}`,
    `hop=${envelope.hop}`,
    `ttl=${envelope.expiresAtMs}`,
    `visited=${envelope.visitedBotKeys.join(',')}`,
  ].join(' ');
  return `[cfb-handoff v1 ${fields}]`;
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

function parseHeaderParams(source: string): ReadonlyMap<string, string> {
  const params = new Map<string, string>();
  for (const token of source.split(/\s+/)) {
    const index = token.indexOf('=');
    if (index <= 0) {
      continue;
    }
    params.set(token.slice(0, index), token.slice(index + 1));
  }
  return params;
}

function validOpaqueId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{3,64}$/.test(value) ? value : null;
}

function validBotKey(value: string | undefined): string | null {
  return value && /^(?:default|bot_[a-z2-7][a-z2-7]{11,59})$/.test(value) ? value : null;
}

function integerValue(value: string | undefined): number | null {
  if (!value || !/^\d{1,16}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
