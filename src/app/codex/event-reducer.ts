import {
  MessagePhase,
  ServerNotification,
  ThreadItem,
  Turn,
} from './protocol';

export type ReducedTurnStatus = 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
export type ReducedItemStatus = 'STARTED' | 'COMPLETED';
export type ReducedItemKind =
  | 'agent_message'
  | 'reasoning_summary'
  | 'command_execution'
  | 'unknown';

export interface ReducedItem {
  readonly itemId: string;
  readonly kind: ReducedItemKind;
  readonly status: ReducedItemStatus;
  readonly phase: MessagePhase | 'unknown';
  readonly order: number;
  readonly text: string;
  readonly summaryParts: Readonly<Record<number, string>>;
  readonly command: string;
  readonly commandOutputTail: string;
}

export interface EventReducerState {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: ReducedTurnStatus;
  readonly terminal: boolean;
  readonly revision: number;
  readonly nextItemOrder: number;
  readonly commandOutputTailLimit: number;
  readonly itemLimit: number;
  readonly agentTextLimit: number;
  readonly reasoningTextLimit: number;
  readonly summaryIndexLimit: number;
  readonly turnTextLimit: number;
  readonly retainedTextLength: number;
  readonly items: Readonly<Record<string, ReducedItem>>;
  readonly errorMessage: string;
}

export interface EventReducerOptions {
  readonly commandOutputTailLimit?: number;
  readonly itemLimit?: number;
  readonly agentTextLimit?: number;
  readonly reasoningTextLimit?: number;
  readonly summaryIndexLimit?: number;
  readonly turnTextLimit?: number;
}

export interface CommandProjectionSnapshot {
  readonly itemId: string;
  readonly command: string;
  readonly outputTail: string;
  readonly completed: boolean;
}

export interface ItemProjectionSnapshot {
  readonly itemId: string;
  readonly kind: ReducedItemKind;
  readonly phase: MessagePhase | 'unknown';
  readonly completed: boolean;
}

/** Immutable event projection consumed by the CardKit projector. */
export interface EventProjectionSnapshot {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: ReducedTurnStatus;
  readonly terminal: boolean;
  readonly revision: number;
  readonly pendingAgentText: string;
  readonly commentary: string;
  readonly finalAnswer: string;
  readonly reasoningSummary: string;
  readonly commands: readonly CommandProjectionSnapshot[];
  readonly errorMessage: string;
  readonly items: readonly ItemProjectionSnapshot[];
}

interface NotificationParams {
  readonly threadId?: unknown;
  readonly turnId?: unknown;
  readonly itemId?: unknown;
  readonly delta?: unknown;
  readonly item?: unknown;
  readonly turn?: unknown;
  readonly error?: unknown;
}

const DEFAULT_COMMAND_OUTPUT_TAIL_LIMIT = 4_096;
const MAX_COMMAND_OUTPUT_TAIL_LIMIT = 64 * 1_024;
const DEFAULT_ITEM_LIMIT = 256;
const MAX_ITEM_LIMIT = 1_024;
const DEFAULT_AGENT_TEXT_LIMIT = 128 * 1_024;
const MAX_AGENT_TEXT_LIMIT = 512 * 1_024;
const DEFAULT_REASONING_TEXT_LIMIT = 64 * 1_024;
const MAX_REASONING_TEXT_LIMIT = 256 * 1_024;
const DEFAULT_SUMMARY_INDEX_LIMIT = 64;
const MAX_SUMMARY_INDEX_LIMIT = 256;
const DEFAULT_TURN_TEXT_LIMIT = 512 * 1_024;
const MAX_TURN_TEXT_LIMIT = 2 * 1_024 * 1_024;
const COMMAND_TEXT_LIMIT = 8 * 1_024;
const ERROR_MESSAGE_LIMIT = 4 * 1_024;
const ITEM_ID_LIMIT = 256;

function freezeRecord<T>(record: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(record);
}

function emptyItem(itemId: string, order: number, kind: ReducedItemKind): ReducedItem {
  return Object.freeze({
    itemId,
    kind,
    status: 'STARTED',
    phase: 'unknown',
    order,
    text: '',
    summaryParts: Object.freeze({}),
    command: '',
    commandOutputTail: '',
  });
}

function isValidItemId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ITEM_ID_LIMIT;
}

function itemKind(itemType: unknown): ReducedItemKind {
  if (itemType === 'agentMessage') {
    return 'agent_message';
  }
  if (itemType === 'reasoning') {
    return 'reasoning_summary';
  }
  if (itemType === 'commandExecution') {
    return 'command_execution';
  }
  return 'unknown';
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function asThreadItem(value: unknown): ThreadItem | null {
  const record = asRecord(value);
  if (!record || !isValidItemId(record.id) || typeof record.type !== 'string') {
    return null;
  }
  return value as ThreadItem;
}

function asTurn(value: unknown): Turn | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || typeof record.status !== 'string') {
    return null;
  }
  return value as Turn;
}

function notificationParams(notification: ServerNotification): NotificationParams {
  return asRecord(notification.params) ?? {};
}

function notificationMatchesState(
  state: EventReducerState,
  params: NotificationParams,
): boolean {
  if (params.threadId !== state.threadId) {
    return false;
  }
  const turn = asTurn(params.turn);
  if (turn) {
    return turn.id === state.turnId;
  }
  return params.turnId === state.turnId;
}

function appendTail(current: string, delta: string, limit: number): string {
  const appended = current + delta;
  return appended.length <= limit ? appended : appended.slice(appended.length - limit);
}

function appendPrefix(current: string, delta: string, limit: number): string {
  if (current.length >= limit) {
    return current.slice(0, limit);
  }
  return current + delta.slice(0, limit - current.length);
}

function itemTextLength(item: ReducedItem | undefined): number {
  if (!item) {
    return 0;
  }
  return item.text.length
    + Object.values(item.summaryParts).reduce((total, part) => total + part.length, 0)
    + item.command.length
    + item.commandOutputTail.length;
}

function fitSummaryParts(
  source: Readonly<Record<number, string>>,
  indexLimit: number,
  textLimit: number,
  available: number,
): Readonly<Record<number, string>> {
  const fitted: Record<number, string> = {};
  let remaining = Math.min(textLimit, Math.max(0, available));
  const indexes = Object.keys(source)
    .map(Number)
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < indexLimit)
    .sort((left, right) => left - right);
  for (const index of indexes) {
    if (remaining === 0) {
      break;
    }
    const part = source[index];
    if (typeof part !== 'string') {
      continue;
    }
    const retained = part.slice(0, remaining);
    if (retained) {
      fitted[index] = retained;
      remaining -= retained.length;
    }
  }
  return Object.freeze(fitted);
}

function fitItemToLimits(
  state: EventReducerState,
  item: ReducedItem,
  available: number,
): ReducedItem {
  let remaining = Math.max(0, available);
  const text = item.text.slice(0, Math.min(state.agentTextLimit, remaining));
  remaining -= text.length;
  const summaryParts = fitSummaryParts(
    item.summaryParts,
    state.summaryIndexLimit,
    state.reasoningTextLimit,
    remaining,
  );
  remaining -= Object.values(summaryParts).reduce((total, part) => total + part.length, 0);
  const command = item.command.slice(0, Math.min(COMMAND_TEXT_LIMIT, remaining));
  remaining -= command.length;
  const commandOutputTail = replaceTail(
    item.commandOutputTail,
    Math.min(state.commandOutputTailLimit, remaining),
  );
  return Object.freeze({
    ...item,
    text,
    summaryParts,
    command,
    commandOutputTail,
  });
}

function boundedLimit(
  name: string,
  configured: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function replaceTail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function completedPhase(value: unknown): MessagePhase | 'unknown' {
  return value === 'commentary' || value === 'final_answer' ? value : 'unknown';
}

function sameItem(left: ReducedItem, right: ReducedItem): boolean {
  return left.itemId === right.itemId
    && left.kind === right.kind
    && left.status === right.status
    && left.phase === right.phase
    && left.order === right.order
    && left.text === right.text
    && left.command === right.command
    && left.commandOutputTail === right.commandOutputTail
    && JSON.stringify(left.summaryParts) === JSON.stringify(right.summaryParts);
}

function withItem(
  state: EventReducerState,
  item: ReducedItem,
  isNewItem: boolean,
): EventReducerState {
  const current = state.items[item.itemId];
  if (!current && isNewItem && state.nextItemOrder >= state.itemLimit) {
    return state;
  }
  const baseTextLength = state.retainedTextLength - itemTextLength(current);
  const fitted = fitItemToLimits(
    state,
    item,
    Math.max(0, state.turnTextLimit - baseTextLength),
  );
  if (current && sameItem(current, fitted)) {
    return state;
  }
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    nextItemOrder: isNewItem ? state.nextItemOrder + 1 : state.nextItemOrder,
    retainedTextLength: baseTextLength + itemTextLength(fitted),
    items: freezeRecord({ ...state.items, [item.itemId]: fitted }),
  });
}

function getOrCreateItem(
  state: EventReducerState,
  itemId: string,
  kind: ReducedItemKind,
): readonly [ReducedItem, boolean] {
  const existing = state.items[itemId];
  if (existing) {
    return [existing, false];
  }
  return [emptyItem(itemId, state.nextItemOrder, kind), true];
}

function reduceItemStarted(
  state: EventReducerState,
  params: NotificationParams,
): EventReducerState {
  const protocolItem = asThreadItem(params.item);
  if (!protocolItem) {
    return state;
  }
  const kind = itemKind(protocolItem.type);
  if (kind === 'unknown') {
    return state;
  }
  const [current, isNew] = getOrCreateItem(state, protocolItem.id, kind);
  if (current.status === 'COMPLETED') {
    return state;
  }
  const next: ReducedItem = {
    ...current,
    kind,
    text: kind === 'agent_message'
      && !current.text
      && typeof protocolItem.text === 'string'
      ? protocolItem.text
      : current.text,
    command: kind === 'command_execution' && typeof protocolItem.command === 'string'
      ? protocolItem.command
      : current.command,
  };
  return withItem(state, next, isNew);
}

function reduceAgentDelta(
  state: EventReducerState,
  params: NotificationParams,
): EventReducerState {
  if (!isValidItemId(params.itemId) || typeof params.delta !== 'string') {
    return state;
  }
  const [current, isNew] = getOrCreateItem(state, params.itemId, 'agent_message');
  if (current.status === 'COMPLETED') {
    return state;
  }
  const growthBudget = Math.max(0, state.turnTextLimit - state.retainedTextLength);
  const textLimit = Math.min(state.agentTextLimit, current.text.length + growthBudget);
  return withItem(
    state,
    {
      ...current,
      kind: 'agent_message',
      text: appendPrefix(current.text, params.delta, textLimit),
    },
    isNew,
  );
}

function reduceSummaryDelta(
  state: EventReducerState,
  params: NotificationParams,
): EventReducerState {
  const record = params as NotificationParams & { readonly summaryIndex?: unknown };
  if (
    !isValidItemId(record.itemId)
    || typeof record.delta !== 'string'
    || typeof record.summaryIndex !== 'number'
    || !Number.isSafeInteger(record.summaryIndex)
    || record.summaryIndex < 0
    || record.summaryIndex >= state.summaryIndexLimit
  ) {
    return state;
  }
  const [current, isNew] = getOrCreateItem(state, record.itemId, 'reasoning_summary');
  if (current.status === 'COMPLETED') {
    return state;
  }
  const previousPart = current.summaryParts[record.summaryIndex] ?? '';
  const currentReasoningLength = Object.values(current.summaryParts)
    .reduce((total, part) => total + part.length, 0);
  const growthBudget = Math.min(
    Math.max(0, state.reasoningTextLimit - currentReasoningLength),
    Math.max(0, state.turnTextLimit - state.retainedTextLength),
  );
  const summaryParts = Object.freeze({
    ...current.summaryParts,
    [record.summaryIndex]: appendPrefix(
      previousPart,
      record.delta,
      previousPart.length + growthBudget,
    ),
  });
  return withItem(
    state,
    { ...current, kind: 'reasoning_summary', summaryParts },
    isNew,
  );
}

function reduceCommandDelta(
  state: EventReducerState,
  params: NotificationParams,
): EventReducerState {
  if (!isValidItemId(params.itemId) || typeof params.delta !== 'string') {
    return state;
  }
  const [current, isNew] = getOrCreateItem(state, params.itemId, 'command_execution');
  if (current.status === 'COMPLETED') {
    return state;
  }
  return withItem(
    state,
    {
      ...current,
      kind: 'command_execution',
      commandOutputTail: appendTail(
        current.commandOutputTail,
        params.delta,
        state.commandOutputTailLimit,
      ),
    },
    isNew,
  );
}

function authoritativeSummary(
  item: ThreadItem,
  indexLimit: number,
  textLimit: number,
): Readonly<Record<number, string>> | null {
  if (!Array.isArray(item.summary)) {
    return null;
  }
  const parts: Record<number, string> = {};
  let remaining = textLimit;
  const length = Math.min(item.summary.length, indexLimit);
  for (let index = 0; index < length && remaining > 0; index += 1) {
    const part = item.summary[index];
    if (typeof part === 'string' && part) {
      const retained = part.slice(0, remaining);
      parts[index] = retained;
      remaining -= retained.length;
    }
  }
  return Object.freeze(parts);
}

function reduceItemCompleted(
  state: EventReducerState,
  params: NotificationParams,
): EventReducerState {
  const protocolItem = asThreadItem(params.item);
  if (!protocolItem) {
    return state;
  }
  const kind = itemKind(protocolItem.type);
  if (kind === 'unknown') {
    return state;
  }
  const [current, isNew] = getOrCreateItem(state, protocolItem.id, kind);
  let next: ReducedItem = { ...current, kind, status: 'COMPLETED' };

  if (kind === 'agent_message') {
    next = {
      ...next,
      phase: completedPhase(protocolItem.phase),
      text: typeof protocolItem.text === 'string' ? protocolItem.text : current.text,
    };
  } else if (kind === 'reasoning_summary') {
    next = {
      ...next,
      summaryParts: authoritativeSummary(
        protocolItem,
        state.summaryIndexLimit,
        state.reasoningTextLimit,
      ) ?? current.summaryParts,
    };
  } else if (kind === 'command_execution') {
    next = {
      ...next,
      command: typeof protocolItem.command === 'string' ? protocolItem.command : current.command,
      commandOutputTail: typeof protocolItem.aggregatedOutput === 'string'
        ? replaceTail(protocolItem.aggregatedOutput, state.commandOutputTailLimit)
        : current.commandOutputTail,
    };
  }

  return withItem(state, next, isNew);
}

function terminalStatus(turn: Turn): ReducedTurnStatus | null {
  if (turn.status === 'interrupted') {
    return 'INTERRUPTED';
  }
  if (turn.status === 'failed' || turn.error) {
    return 'FAILED';
  }
  if (turn.status === 'completed') {
    return 'SUCCEEDED';
  }
  return null;
}

function reduceTurnCompleted(state: EventReducerState, turn: Turn): EventReducerState {
  const status = terminalStatus(turn);
  if (!status) {
    return state;
  }
  const requestedErrorMessage = turn.error?.message ?? state.errorMessage;
  const baseTextLength = state.retainedTextLength - state.errorMessage.length;
  const errorMessage = requestedErrorMessage.slice(
    0,
    Math.min(ERROR_MESSAGE_LIMIT, Math.max(0, state.turnTextLimit - baseTextLength)),
  );
  if (state.terminal && state.status === status && state.errorMessage === errorMessage) {
    return state;
  }
  return Object.freeze({
    ...state,
    status,
    terminal: true,
    errorMessage,
    retainedTextLength: baseTextLength + errorMessage.length,
    revision: state.revision + 1,
  });
}

/** Creates an immutable state for exactly one App Server turn. */
export function createEventReducerState(
  threadId: string,
  turnId: string,
  options: EventReducerOptions = {},
): EventReducerState {
  if (!threadId || !turnId) {
    throw new TypeError('threadId and turnId are required');
  }
  const commandOutputTailLimit = boundedLimit(
    'commandOutputTailLimit',
    options.commandOutputTailLimit,
    DEFAULT_COMMAND_OUTPUT_TAIL_LIMIT,
    MAX_COMMAND_OUTPUT_TAIL_LIMIT,
  );
  const itemLimit = boundedLimit(
    'itemLimit',
    options.itemLimit,
    DEFAULT_ITEM_LIMIT,
    MAX_ITEM_LIMIT,
  );
  const agentTextLimit = boundedLimit(
    'agentTextLimit',
    options.agentTextLimit,
    DEFAULT_AGENT_TEXT_LIMIT,
    MAX_AGENT_TEXT_LIMIT,
  );
  const reasoningTextLimit = boundedLimit(
    'reasoningTextLimit',
    options.reasoningTextLimit,
    DEFAULT_REASONING_TEXT_LIMIT,
    MAX_REASONING_TEXT_LIMIT,
  );
  const summaryIndexLimit = boundedLimit(
    'summaryIndexLimit',
    options.summaryIndexLimit,
    DEFAULT_SUMMARY_INDEX_LIMIT,
    MAX_SUMMARY_INDEX_LIMIT,
  );
  const turnTextLimit = boundedLimit(
    'turnTextLimit',
    options.turnTextLimit,
    DEFAULT_TURN_TEXT_LIMIT,
    MAX_TURN_TEXT_LIMIT,
  );
  return Object.freeze({
    threadId,
    turnId,
    status: 'STARTING',
    terminal: false,
    revision: 0,
    nextItemOrder: 0,
    commandOutputTailLimit,
    itemLimit,
    agentTextLimit,
    reasoningTextLimit,
    summaryIndexLimit,
    turnTextLimit,
    retainedTextLength: 0,
    items: freezeRecord<ReducedItem>({}),
    errorMessage: '',
  });
}

/** Purely reduces one notification; unknown, mismatched, and post-terminal events are ignored. */
export function reduceEvent(
  state: EventReducerState,
  notification: ServerNotification,
): EventReducerState {
  if (state.terminal || !notification || typeof notification.method !== 'string') {
    return state;
  }
  const params = notificationParams(notification);
  if (!notificationMatchesState(state, params)) {
    return state;
  }

  switch (notification.method) {
    case 'turn/started': {
      if (state.status === 'RUNNING') {
        return state;
      }
      return Object.freeze({ ...state, status: 'RUNNING', revision: state.revision + 1 });
    }
    case 'turn/completed': {
      const turn = asTurn(params.turn);
      return turn ? reduceTurnCompleted(state, turn) : state;
    }
    case 'item/started':
      return reduceItemStarted(state, params);
    case 'item/completed':
      return reduceItemCompleted(state, params);
    case 'item/agentMessage/delta':
      return reduceAgentDelta(state, params);
    case 'item/reasoning/summaryTextDelta':
      return reduceSummaryDelta(state, params);
    case 'item/reasoning/textDelta':
      return state;
    case 'item/commandExecution/outputDelta':
      return reduceCommandDelta(state, params);
    case 'error': {
      const error = asRecord(params.error);
      const requestedMessage = error && typeof error.message === 'string' ? error.message : '';
      const baseTextLength = state.retainedTextLength - state.errorMessage.length;
      const message = requestedMessage.slice(
        0,
        Math.min(ERROR_MESSAGE_LIMIT, Math.max(0, state.turnTextLimit - baseTextLength)),
      );
      if (!message || message === state.errorMessage) {
        return state;
      }
      return Object.freeze({
        ...state,
        errorMessage: message,
        retainedTextLength: baseTextLength + message.length,
        revision: state.revision + 1,
      });
    }
    default:
      return state;
  }
}

function sortedItems(state: EventReducerState): readonly ReducedItem[] {
  return Object.freeze(
    Object.values(state.items).sort((left, right) => left.order - right.order),
  );
}

function summaryText(item: ReducedItem): string {
  return Object.keys(item.summaryParts)
    .map(Number)
    .sort((left, right) => left - right)
    .map((index) => item.summaryParts[index] ?? '')
    .join('');
}

/** Builds a deeply immutable, renderer-neutral CardKit projection snapshot. */
export function createProjectionSnapshot(state: EventReducerState): EventProjectionSnapshot {
  const items = sortedItems(state);
  const pendingAgentText = items
    .filter((item) => item.kind === 'agent_message' && item.phase === 'unknown')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  const commentary = items
    .filter((item) => item.kind === 'agent_message' && item.phase === 'commentary')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  const finalAnswer = items
    .filter((item) => item.kind === 'agent_message' && item.phase === 'final_answer')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n');
  const reasoningSummary = items
    .filter((item) => item.kind === 'reasoning_summary')
    .map(summaryText)
    .filter(Boolean)
    .join('\n\n');
  const commands = Object.freeze(
    items
      .filter((item) => item.kind === 'command_execution')
      .map((item) => Object.freeze({
        itemId: item.itemId,
        command: item.command,
        outputTail: item.commandOutputTail,
        completed: item.status === 'COMPLETED',
      })),
  );
  const itemSnapshots = Object.freeze(items.map((item) => Object.freeze({
    itemId: item.itemId,
    kind: item.kind,
    phase: item.phase,
    completed: item.status === 'COMPLETED',
  })));

  return Object.freeze({
    threadId: state.threadId,
    turnId: state.turnId,
    status: state.status,
    terminal: state.terminal,
    revision: state.revision,
    pendingAgentText,
    commentary,
    finalAnswer,
    reasoningSummary,
    commands,
    errorMessage: state.errorMessage,
    items: itemSnapshots,
  });
}
