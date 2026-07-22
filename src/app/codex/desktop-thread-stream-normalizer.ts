import { isAbsolute } from 'node:path';

import type {
  DesktopJsonPatch,
  DesktopThreadStreamBroadcast,
} from './desktop-ipc-client';
import {
  collectDesktopApprovals,
  type DesktopApprovalRequest,
} from './desktop-approval-adapter';
import type {
  MessagePhase,
  ServerNotification,
  ThreadItem,
  Turn,
  TurnError,
  TurnStatus,
  UserInput,
} from './protocol';
import { DESKTOP_IPC_CONTRACT } from './desktop-ipc-contract';

type UnknownRecord = Record<string, unknown>;

/** The Desktop follower state broadcast contract pinned by the runtime probe. */
export const DESKTOP_THREAD_STREAM_PROTOCOL_VERSION = DESKTOP_IPC_CONTRACT.stateProtocolVersion;

export class DesktopThreadStreamProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DesktopThreadStreamProtocolError';
  }
}

/** Converts Desktop state snapshots/patches into canonical App Server events. */
export class DesktopThreadStreamNormalizer {
  private readonly statesByThreadId = new Map<string, UnknownRecord>();
  private readonly approvalListeners = new Set<(approval: DesktopApprovalRequest, epoch: number) => void>();
  private readonly emittedApprovalKeys = new Set<string>();
  private activeEpoch: number | undefined;

  public constructor(private readonly nowMs: () => number = Date.now) {}

  public handle(message: DesktopThreadStreamBroadcast): readonly ServerNotification[] {
    if (message.version !== DESKTOP_THREAD_STREAM_PROTOCOL_VERSION) {
      throw new DesktopThreadStreamProtocolError(
        `Unsupported Desktop thread-stream protocol version: ${message.version}`,
      );
    }
    const threadId = message.params.conversationId;
    const previous = this.statesByThreadId.get(threadId);
    const change = message.params.change;
    if (change.type === 'snapshot') {
      const current = cloneRecord(change.conversationState);
      this.statesByThreadId.set(threadId, current);
      this.emitApprovals(threadId, current);
      return diffThreadState(threadId, previous, current, this.nowMs());
    }
    if (!previous) {
      const bootstrapped = bootstrapStateFromPatches(change.patches);
      if (bootstrapped) {
        this.statesByThreadId.set(threadId, bootstrapped);
        this.emitApprovals(threadId, bootstrapped);
        return diffThreadState(threadId, undefined, bootstrapped, this.nowMs());
      }
      return [];
    }
    const current = cloneRecord(previous);
    for (const patch of change.patches) {
      applyPatch(current, patch);
    }
    this.statesByThreadId.set(threadId, current);
    this.emitApprovals(threadId, current);
    return diffThreadState(threadId, previous, current, this.nowMs());
  }

  public onApprovalRequest(
    listener: (approval: DesktopApprovalRequest, epoch: number) => void,
  ): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  public reset(): void {
    this.statesByThreadId.clear();
    this.emittedApprovalKeys.clear();
  }

  /**
   * Starts a new Desktop connection epoch. Broadcasts are only meaningful for
   * the live socket, so changing epoch discards every authoritative snapshot.
   */
  public beginEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new RangeError('Desktop connection epoch must be a positive safe integer');
    }
    if (this.activeEpoch !== epoch) {
      this.statesByThreadId.clear();
      this.emittedApprovalKeys.clear();
      this.activeEpoch = epoch;
    }
  }

  public get connectionEpoch(): number | undefined {
    return this.activeEpoch;
  }

  /** Returns whether the Desktop owner supplied a state snapshot for this thread. */
  public hasThreadSnapshot(threadId: string): boolean {
    return this.statesByThreadId.has(threadId);
  }

  /**
   * Replays the current live Desktop snapshot for its in-flight turn only.
   * This lets a newly bound Feishu chat attach to a turn that started before
   * the binding existed, without re-emitting historical terminal turns.
   */
  public activeTurnSnapshot(threadId: string): readonly ServerNotification[] {
    const state = this.statesByThreadId.get(threadId);
    if (!state) {
      return [];
    }
    const activeTurn = latestTurn(turnsById(state));
    if (!activeTurn || activeTurn.status !== 'inProgress') {
      return [];
    }
    return diffThreadState(threadId, undefined, state, this.nowMs())
      .filter((notification) => notificationTurnId(notification) === activeTurn.id);
  }

  private emitApprovals(threadId: string, state: UnknownRecord): void {
    const epoch = this.activeEpoch;
    if (!epoch) {
      return;
    }
    for (const approval of collectDesktopApprovals(threadId, state)) {
      const key = `${epoch}:${threadId}:${String(approval.requestId)}`;
      if (this.emittedApprovalKeys.has(key)) {
        continue;
      }
      this.emittedApprovalKeys.add(key);
      for (const listener of this.approvalListeners) {
        listener(approval, epoch);
      }
    }
  }
}

function bootstrapStateFromPatches(patches: readonly DesktopJsonPatch[]): UnknownRecord | null {
  const current: UnknownRecord = {};
  let recovered = false;
  for (const patch of patches) {
    if (patch.op === 'remove') {
      continue;
    }
    if (bootstrapTurnsPatch(current, patch) || bootstrapCanonicalTurnPatch(current, patch)) {
      recovered = true;
    }
  }
  return recovered ? current : null;
}

function bootstrapTurnsPatch(current: UnknownRecord, patch: DesktopJsonPatch): boolean {
  const [first, second] = patch.path;
  if (first !== 'turns') {
    return false;
  }
  if (patch.path.length === 1) {
    if (!Array.isArray(patch.value)) {
      return false;
    }
    current.turns = structuredClone(patch.value);
    return true;
  }
  if (
    patch.path.length !== 2
    || (second !== '-' && typeof second !== 'number' && typeof second !== 'string')
    || !looksLikeTurn(patch.value)
  ) {
    return false;
  }
  const turns = Array.isArray(current.turns) ? current.turns : [];
  turns.push(structuredClone(patch.value));
  current.turns = turns;
  return true;
}

function bootstrapCanonicalTurnPatch(current: UnknownRecord, patch: DesktopJsonPatch): boolean {
  if (patch.path.length < 4 || !looksLikeTurn(patch.value)) {
    return false;
  }
  const [turnHistoryKey, historyKey, entitiesKey, entityKey] = patch.path;
  if (
    turnHistoryKey !== 'turnHistory'
    || historyKey !== 'history'
    || entitiesKey !== 'entitiesByKey'
    || (typeof entityKey !== 'string' && typeof entityKey !== 'number')
  ) {
    return false;
  }
  const turnHistory = ensureRecord(current, 'turnHistory');
  turnHistory.kind = 'canonical';
  const history = ensureRecord(turnHistory, 'history');
  const entitiesByKey = ensureRecord(history, 'entitiesByKey');
  entitiesByKey[String(entityKey)] = structuredClone(patch.value);
  if (!Array.isArray(history.islands)) {
    history.islands = [];
  }
  return true;
}

function ensureRecord(parent: UnknownRecord, key: string): UnknownRecord {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as UnknownRecord;
  }
  const next: UnknownRecord = {};
  parent[key] = next;
  return next;
}

function looksLikeTurn(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record
    && (typeof record.id === 'string' || typeof record.turnId === 'string')
    && typeof record.status === 'string',
  );
}

function diffThreadState(
  threadId: string,
  previousState: UnknownRecord | undefined,
  currentState: UnknownRecord,
  nowMs: number,
): readonly ServerNotification[] {
  const notifications: ServerNotification[] = [];
  const previousTurns = turnsById(previousState);
  const currentTurns = turnsById(currentState);
  const currentEntries = [...currentTurns.entries()];
  const entriesToDiff = previousState
    ? currentEntries
    : currentEntries.filter(([, turn]) => !isTerminalTurn(turn)).slice(-1);
  const usageTurn = previousState
    ? latestTurn(currentTurns)
    : entriesToDiff.at(-1)?.[1];
  if (usageTurn && usageChanged(previousState, currentState)) {
    const tokenUsage = asRecord(currentState.latestTokenUsageInfo);
    if (tokenUsage) {
      notifications.push({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          turnId: usageTurn.id,
          tokenUsage,
          model: stringValue(currentState.latestModel),
        },
      });
    }
  }
  for (const [turnId, currentTurn] of entriesToDiff) {
    const previousTurn = previousTurns.get(turnId);
    if (!previousTurn) {
      notifications.push({
        method: 'turn/started',
        params: { threadId, turn: currentTurn },
      });
    }
    notifications.push(...diffItems(threadId, previousTurn, currentTurn, nowMs));
    if (isTerminalTurn(currentTurn) && !isTerminalTurn(previousTurn)) {
      notifications.push({
        method: 'turn/completed',
        params: { threadId, turn: currentTurn },
      });
    }
  }
  return notifications;
}

function latestTurn(turns: ReadonlyMap<string, Turn>): Turn | undefined {
  const values = [...turns.values()];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const turn = values[index];
    if (turn?.status === 'inProgress') {
      return turn;
    }
  }
  return values[values.length - 1];
}

function notificationTurnId(notification: ServerNotification): string | undefined {
  const params = asRecord(notification.params);
  return stringValue(params?.turnId)
    ?? stringValue(asRecord(params?.turn)?.id)
    ?? undefined;
}

function usageChanged(previous: UnknownRecord | undefined, current: UnknownRecord): boolean {
  return JSON.stringify(previous?.latestTokenUsageInfo ?? null)
    !== JSON.stringify(current.latestTokenUsageInfo ?? null);
}

function diffItems(
  threadId: string,
  previousTurn: Turn | undefined,
  currentTurn: Turn,
  nowMs: number,
): readonly ServerNotification[] {
  const notifications: ServerNotification[] = [];
  const previousItems = new Map((previousTurn?.items ?? []).map((item) => [item.id, item]));
  for (const currentItem of currentTurn.items) {
    const previousItem = previousItems.get(currentItem.id);
    if (!previousItem) {
      notifications.push({
        method: 'item/started',
        params: {
          threadId,
          turnId: currentTurn.id,
          item: currentItem,
          startedAtMs: nowMs,
        },
      });
    }
    notifications.push(...itemDeltas(threadId, currentTurn.id, previousItem, currentItem));
    if (
      isCompletedItem(currentItem, currentTurn)
      && !isCompletedItem(previousItem, previousTurn)
    ) {
      notifications.push({
        method: 'item/completed',
        params: {
          threadId,
          turnId: currentTurn.id,
          item: currentItem,
          completedAtMs: nowMs,
        },
      });
    }
  }
  return notifications;
}

function itemDeltas(
  threadId: string,
  turnId: string,
  previousItem: ThreadItem | undefined,
  currentItem: ThreadItem,
): readonly ServerNotification[] {
  if (currentItem.type === 'agentMessage') {
    const delta = suffixDelta(previousItem?.text ?? '', currentItem.text ?? '');
    return delta
      ? [{
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: currentItem.id,
            delta,
            ...(currentItem.phase ? { phase: currentItem.phase } : {}),
          },
        }]
      : [];
  }
  if (currentItem.type === 'reasoning') {
    return reasoningDeltas(threadId, turnId, previousItem, currentItem);
  }
  if (currentItem.type === 'commandExecution') {
    const before = previousItem?.aggregatedOutput ?? '';
    const after = currentItem.aggregatedOutput ?? '';
    const delta = suffixDelta(before, after);
    if (delta) {
      return [{
        method: 'item/commandExecution/outputDelta',
        params: { threadId, turnId, itemId: currentItem.id, delta },
      }];
    }
  }
  return [];
}

function reasoningDeltas(
  threadId: string,
  turnId: string,
  previousItem: ThreadItem | undefined,
  currentItem: ThreadItem,
): readonly ServerNotification[] {
  const previousSummary = previousItem?.summary ?? [];
  const currentSummary = currentItem.summary ?? [];
  const notifications: ServerNotification[] = [];
  for (let index = 0; index < currentSummary.length; index += 1) {
    const current = currentSummary[index] ?? '';
    const previous = previousSummary[index] ?? '';
    const delta = suffixDelta(previous, current);
    if (delta) {
      notifications.push({
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId,
          turnId,
          itemId: currentItem.id,
          delta,
          summaryIndex: index,
        },
      });
    }
  }
  if (currentSummary.length === 0) {
    const delta = suffixDelta(reasoningContent(previousItem), reasoningContent(currentItem));
    if (delta) {
      notifications.push({
        method: 'item/reasoning/textDelta',
        params: {
          threadId,
          turnId,
          itemId: currentItem.id,
          delta,
        },
      });
    }
  }
  return notifications;
}

function reasoningContent(item: ThreadItem | undefined): string {
  if (!item?.content) {
    return item?.text ?? '';
  }
  return item.content.map((part) => (
    typeof part === 'string' ? part : part.type === 'text' ? part.text : ''
  )).join('');
}

function turnsById(state: UnknownRecord | undefined): ReadonlyMap<string, Turn> {
  const turns = turnValues(state);
  const result = new Map<string, Turn>();
  for (const value of turns) {
    const turn = normalizeTurn(value);
    if (turn) {
      result.set(turn.id, turn);
    }
  }
  return result;
}

function turnValues(state: UnknownRecord | undefined): readonly unknown[] {
  const turns = Array.isArray(state?.turns) ? state.turns : [];
  if (turns.length > 0) {
    return turns;
  }
  const turnHistory = asRecord(state?.turnHistory);
  const history = asRecord(turnHistory?.history);
  const entitiesByKey = asRecord(history?.entitiesByKey);
  if (turnHistory?.kind !== 'canonical' || !entitiesByKey) {
    return turns;
  }
  const ordered: unknown[] = [];
  const visitedKeys = new Set<string>();
  const islands = Array.isArray(history?.islands) ? history.islands : [];
  for (const islandValue of islands) {
    const island = asRecord(islandValue);
    const entries = Array.isArray(island?.entries) ? island.entries : [];
    for (const entryValue of entries) {
      const entry = asRecord(entryValue);
      const key = stringValue(entry?.value) ?? stringValue(entry?.key);
      if (!key || visitedKeys.has(key) || !(key in entitiesByKey)) {
        continue;
      }
      visitedKeys.add(key);
      ordered.push(entitiesByKey[key]);
    }
  }
  for (const [key, value] of Object.entries(entitiesByKey)) {
    if (!visitedKeys.has(key)) {
      ordered.push(value);
    }
  }
  return ordered;
}

function normalizeTurn(value: unknown): Turn | null {
  const record = asRecord(value);
  const id = stringValue(record?.id) ?? stringValue(record?.turnId);
  const status = turnStatus(record?.status);
  if (!record || !id || !status) {
    return null;
  }
  const items = Array.isArray(record.items)
    ? record.items
        .map((item, index) => normalizeItem(item, `desktop:${id}:${index}`))
        .filter((item): item is ThreadItem => item !== null)
    : [];
  const startedAt = nullableNumber(record.startedAt)
    ?? nullableNumber(record.turnStartedAtMs);
  const durationMs = nullableNumber(record.durationMs);
  const completedAt = nullableNumber(record.completedAt)
    ?? (status !== 'inProgress' && startedAt !== null && durationMs !== null
      ? startedAt + durationMs
      : null);
  const params = asRecord(record.params);
  const rawInput = Array.isArray(record.input)
    ? record.input
    : Array.isArray(params?.input) ? params.input : undefined;
  return {
    id,
    ...(rawInput ? { input: normalizeUserInputs(rawInput) } : {}),
    items,
    itemsView: items.length > 0 ? 'full' : 'notLoaded',
    status,
    error: normalizeTurnError(record.error),
    startedAt,
    completedAt,
    durationMs,
  };
}

function normalizeUserInputs(value: readonly unknown[]): readonly UserInput[] {
  const inputs: UserInput[] = [];
  for (const input of value) {
    const record = asRecord(input);
    if (record?.type === 'text' && typeof record.text === 'string') {
      inputs.push({
        type: 'text',
        text: record.text,
        text_elements: [],
      });
    } else if (
      record?.type === 'localImage'
      && typeof record.path === 'string'
      && isAbsolute(record.path)
    ) {
      inputs.push({ type: 'localImage', path: record.path });
    }
  }
  return inputs;
}

function normalizeItem(value: unknown, fallbackId: string): ThreadItem | null {
  const record = asRecord(value);
  const id = stringValue(record?.id) ?? stringValue(record?.itemId) ?? fallbackId;
  const type = stringValue(record?.type);
  if (!record || !id || !type) {
    return null;
  }
  return {
    ...record,
    id,
    type,
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(messagePhase(record.phase) ? { phase: messagePhase(record.phase) } : {}),
    ...(Array.isArray(record.summary) ? { summary: record.summary.map(slateText) } : {}),
    ...(typeof record.command === 'string' ? { command: record.command } : {}),
    ...(typeof record.aggregatedOutput === 'string'
      ? { aggregatedOutput: record.aggregatedOutput }
      : {}),
    ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
  };
}

function applyPatch(root: UnknownRecord, patch: DesktopJsonPatch): void {
  if (patch.path.length === 0) {
    return;
  }
  let parent: unknown = root;
  for (let index = 0; index < patch.path.length - 1; index += 1) {
    parent = childAt(parent, patch.path[index]);
    if (!parent || typeof parent !== 'object') {
      return;
    }
  }
  const key = patch.path[patch.path.length - 1];
  if (key === undefined || !parent || typeof parent !== 'object') {
    return;
  }
  if (Array.isArray(parent)) {
    applyArrayPatch(parent, key, patch);
    return;
  }
  if (typeof key !== 'string') {
    return;
  }
  const record = parent as UnknownRecord;
  if (patch.op === 'remove') {
    delete record[key];
  } else {
    record[key] = structuredClone(patch.value);
  }
}

function applyArrayPatch(array: unknown[], key: string | number, patch: DesktopJsonPatch): void {
  if (patch.op === 'add' && key === '-') {
    array.push(structuredClone(patch.value));
    return;
  }
  const index = typeof key === 'number' ? key : Number(key);
  if (!Number.isSafeInteger(index) || index < 0) {
    return;
  }
  if (patch.op === 'add') {
    array.splice(index, 0, structuredClone(patch.value));
  } else if (patch.op === 'replace' && index < array.length) {
    array[index] = structuredClone(patch.value);
  } else if (patch.op === 'remove' && index < array.length) {
    array.splice(index, 1);
  }
}

function childAt(parent: unknown, key: string | number | undefined): unknown {
  if (key === undefined || !parent || typeof parent !== 'object') {
    return undefined;
  }
  if (Array.isArray(parent)) {
    const index = typeof key === 'number' ? key : Number(key);
    return Number.isSafeInteger(index) && index >= 0 ? parent[index] : undefined;
  }
  return typeof key === 'string' ? (parent as UnknownRecord)[key] : undefined;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): UnknownRecord {
  return structuredClone(value) as UnknownRecord;
}

function suffixDelta(previous: string, current: string): string {
  return current.startsWith(previous) ? current.slice(previous.length) : '';
}

function isTerminalTurn(turn: Turn | undefined): boolean {
  return Boolean(turn && turn.status !== 'inProgress');
}

function isCompletedItem(
  item: ThreadItem | undefined,
  turn: Turn | undefined,
): boolean {
  return Boolean(item && (
    item.status === 'completed'
    || item.status === 'failed'
    || item.status === 'interrupted'
    || isTerminalTurn(turn)
  ));
}

function turnStatus(value: unknown): TurnStatus | null {
  return value === 'inProgress'
    || value === 'completed'
    || value === 'failed'
    || value === 'interrupted'
    ? value
    : null;
}

function messagePhase(value: unknown): MessagePhase | null {
  return value === 'commentary' || value === 'final_answer' ? value : null;
}

function normalizeTurnError(value: unknown): TurnError | null {
  const record = asRecord(value);
  if (!record || typeof record.message !== 'string') {
    return null;
  }
  return {
    message: record.message,
    codexErrorInfo: record.codexErrorInfo ?? null,
    additionalDetails: typeof record.additionalDetails === 'string'
      ? record.additionalDetails
      : null,
  };
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function slateText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(slateText).join('');
  }
  const record = asRecord(value);
  if (!record) {
    return '';
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  return Array.isArray(record.children) ? record.children.map(slateText).join('') : '';
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}
