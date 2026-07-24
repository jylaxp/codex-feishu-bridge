import {
  AppServerProtocolValidationError,
  type AppServerControlPlaneMethod,
  type AppServerProtocolAdapter,
} from './app-server-protocol-adapter';
import type { AppServerProtocolProfileId } from './app-server-protocol-registry';

type JsonRecord = Readonly<Record<string, unknown>>;

const SUPPORTED_METHODS: ReadonlySet<string> = new Set<AppServerControlPlaneMethod>([
  'thread/list',
  'thread/read',
  'thread/resume',
  'thread/start',
  'thread/fork',
  'thread/name/set',
  'thread/archive',
  'thread/goal/get',
  'thread/goal/set',
  'thread/goal/clear',
  'thread/compact/start',
  'skills/list',
  'mcpServerStatus/list',
  'account/rateLimits/read',
  'turn/start',
]);

/**
 * Creates the shared validator proven against both exact 0.144.3 and
 * 0.145.0-alpha.18 schemas, plus their smoke-verified adapter aliases.
 */
export function createAppServerProtocolValidator(
  profileId: AppServerProtocolProfileId,
  mapRequest: (
    method: AppServerControlPlaneMethod,
    params: unknown,
  ) => unknown = (_method, params) => params,
): AppServerProtocolAdapter {
  return Object.freeze({
    profileId,
    supports(method: string): method is AppServerControlPlaneMethod {
      return SUPPORTED_METHODS.has(method);
    },
    mapRequest,
    parseResponse(method: AppServerControlPlaneMethod, response: unknown): unknown {
      switch (method) {
        case 'thread/list': {
          parseThreadList(response);
          return response;
        }
        case 'thread/read': {
          parseThreadMetadata(requiredRecord(response).thread);
          return response;
        }
        case 'thread/resume': {
          parseThreadLifecycle(response, true);
          return response;
        }
        case 'thread/start':
        case 'thread/fork': {
          parseThreadLifecycle(response, false);
          return response;
        }
        case 'thread/name/set':
        case 'thread/archive':
        case 'thread/compact/start': {
          requiredRecord(response);
          return response;
        }
        case 'thread/goal/get': {
          parseGoalResponse(response, true);
          return response;
        }
        case 'thread/goal/set': {
          parseGoalResponse(response, false);
          return response;
        }
        case 'thread/goal/clear': {
          requiredBoolean(requiredRecord(response).cleared);
          return response;
        }
        case 'skills/list': {
          parseSkills(response);
          return response;
        }
        case 'mcpServerStatus/list': {
          parseMcpServers(response);
          return response;
        }
        case 'account/rateLimits/read': {
          parseRateLimits(response);
          return response;
        }
        case 'turn/start': {
          parseTurn(requiredRecord(response).turn);
          return response;
        }
      }
    },
  });
}

function parseThreadList(value: unknown): JsonRecord {
  const response = requiredRecord(value);
  return {
    data: requiredArray(response.data).map(parseThreadMetadata),
  };
}

function parseThreadLifecycle(value: unknown, resume: boolean): JsonRecord {
  const response = requiredRecord(value);
  const result: Record<string, unknown> = {
    thread: resume ? parseResumedThread(response.thread) : parseThreadIdentity(response.thread),
  };
  if (resume) {
    result.model = requiredString(response.model);
  }
  return result;
}

function parseThreadIdentity(value: unknown): JsonRecord {
  return { id: requiredString(requiredRecord(value).id) };
}

function parseThreadMetadata(value: unknown): JsonRecord {
  const thread = requiredRecord(value);
  const result: Record<string, unknown> = {
    id: requiredString(thread.id),
    preview: requiredString(thread.preview),
    cwd: requiredString(thread.cwd),
    updatedAt: requiredFiniteNumber(thread.updatedAt),
    status: parseThreadStatus(thread.status),
  };
  if (thread.name !== undefined) {
    result.name = requiredNullableString(thread.name);
  }
  return result;
}

function parseResumedThread(value: unknown): JsonRecord {
  const thread = requiredRecord(value);
  return {
    id: requiredString(thread.id),
    turns: requiredArray(thread.turns).map(parseTurn),
  };
}

function parseThreadStatus(value: unknown): JsonRecord {
  const status = requiredRecord(value);
  const type = requiredString(status.type);
  if (type === 'notLoaded' || type === 'idle' || type === 'systemError') {
    return { type };
  }
  if (type === 'active') {
    return { type };
  }
  invalid();
}

function parseTurn(value: unknown): JsonRecord {
  const turn = requiredRecord(value);
  const status = requiredString(turn.status);
  if (!['completed', 'interrupted', 'failed', 'inProgress'].includes(status)) {
    invalid();
  }
  const result: Record<string, unknown> = {
    id: requiredString(turn.id),
    items: requiredArray(turn.items).map(parseThreadItem),
    status,
  };
  if (turn.error !== undefined) {
    result.error = parseTurnError(turn.error);
  }
  copyOptionalNullableNumber(turn, result, 'startedAt');
  copyOptionalNullableNumber(turn, result, 'completedAt');
  copyOptionalNullableNumber(turn, result, 'durationMs');
  return result;
}

function parseTurnError(value: unknown): JsonRecord | null {
  if (value === null) {
    return null;
  }
  const error = requiredRecord(value);
  return {
    message: requiredString(error.message),
  };
}

function parseThreadItem(value: unknown): JsonRecord {
  const item = requiredRecord(value);
  const result: Record<string, unknown> = {
    id: requiredString(item.id),
    type: requiredString(item.type),
  };
  copyOptionalString(item, result, 'text');
  copyOptionalNullableString(item, result, 'phase');
  copyOptionalString(item, result, 'command');
  copyOptionalString(item, result, 'cwd');
  copyOptionalString(item, result, 'status');
  copyOptionalNullableString(item, result, 'aggregatedOutput');
  copyOptionalNullableNumber(item, result, 'exitCode');
  copyOptionalStringArray(item, result, 'summary');
  if (item.content !== undefined) {
    result.content = requiredArray(item.content).map(parseItemContent);
  }
  return result;
}

function parseItemContent(value: unknown): string | JsonRecord {
  if (typeof value === 'string') {
    return value;
  }
  const content = requiredRecord(value);
  const type = requiredString(content.type);
  if (type !== 'text') {
    return { type };
  }
  return {
    type,
    text: requiredString(content.text),
  };
}

function parseGoalResponse(value: unknown, nullable: boolean): JsonRecord {
  const response = requiredRecord(value);
  if (nullable && response.goal === null) {
    return { goal: null };
  }
  return { goal: parseGoal(response.goal) };
}

function parseGoal(value: unknown): JsonRecord {
  const goal = requiredRecord(value);
  const status = requiredString(goal.status);
  if (!['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status)) {
    invalid();
  }
  return {
    objective: requiredString(goal.objective),
    status,
    tokenBudget: requiredNullableFiniteNumber(goal.tokenBudget),
    tokensUsed: requiredFiniteNumber(goal.tokensUsed),
    timeUsedSeconds: requiredFiniteNumber(goal.timeUsedSeconds),
    createdAt: requiredFiniteNumber(goal.createdAt),
    updatedAt: requiredFiniteNumber(goal.updatedAt),
  };
}

function parseSkills(value: unknown): JsonRecord {
  const response = requiredRecord(value);
  return {
    data: requiredArray(response.data).map((candidate) => {
      const entry = requiredRecord(candidate);
      return {
        skills: requiredArray(entry.skills).map(parseSkill),
      };
    }),
  };
}

function parseSkill(value: unknown): JsonRecord {
  const skill = requiredRecord(value);
  const result: Record<string, unknown> = {
    name: requiredString(skill.name),
    description: requiredString(skill.description),
    path: requiredString(skill.path),
    scope: requiredString(skill.scope),
  };
  if (skill.shortDescription !== undefined) {
    result.shortDescription = requiredString(skill.shortDescription);
  }
  return result;
}

function parseMcpServers(value: unknown): JsonRecord {
  const response = requiredRecord(value);
  return {
    data: requiredArray(response.data).map((candidate) => {
      const server = requiredRecord(candidate);
      return {
        name: requiredString(server.name),
        authStatus: requiredString(server.authStatus),
      };
    }),
  };
}

function parseRateLimits(value: unknown): JsonRecord {
  const response = requiredRecord(value);
  const result: Record<string, unknown> = {
    rateLimits: parseRateLimitSnapshot(response.rateLimits),
  };
  if (response.rateLimitsByLimitId !== undefined) {
    result.rateLimitsByLimitId = response.rateLimitsByLimitId === null
      ? null
      : parseRateLimitsById(response.rateLimitsByLimitId);
  }
  return result;
}

function parseRateLimitsById(value: unknown): JsonRecord {
  const source = requiredRecord(value);
  return Object.fromEntries(Object.entries(source).map(([key, snapshot]) => (
    [key, parseRateLimitSnapshot(snapshot)]
  )));
}

function parseRateLimitSnapshot(value: unknown): JsonRecord {
  const snapshot = requiredRecord(value);
  const result: Record<string, unknown> = {};
  copyOptionalNullableString(snapshot, result, 'planType');
  if (snapshot.primary !== undefined) {
    result.primary = snapshot.primary === null ? null : parseRateLimitWindow(snapshot.primary);
  }
  if (snapshot.secondary !== undefined) {
    result.secondary = snapshot.secondary === null ? null : parseRateLimitWindow(snapshot.secondary);
  }
  if (snapshot.credits !== undefined) {
    result.credits = snapshot.credits === null ? null : parseCredits(snapshot.credits);
  }
  return result;
}

function parseRateLimitWindow(value: unknown): JsonRecord {
  const window = requiredRecord(value);
  return {
    usedPercent: requiredFiniteNumber(window.usedPercent),
    windowDurationMins: requiredNullableFiniteNumber(window.windowDurationMins),
    resetsAt: requiredNullableFiniteNumber(window.resetsAt),
  };
}

function parseCredits(value: unknown): JsonRecord {
  const credits = requiredRecord(value);
  const balance = credits.balance;
  if (balance !== null && typeof balance !== 'string' && typeof balance !== 'number') {
    invalid();
  }
  return {
    hasCredits: requiredBoolean(credits.hasCredits),
    balance,
  };
}

function requiredRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid();
  }
  return value as JsonRecord;
}

function requiredArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid();
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    invalid();
  }
  return value;
}

function requiredNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value);
}

function requiredFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid();
  }
  return value;
}

function requiredNullableFiniteNumber(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return requiredFiniteNumber(value);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    invalid();
  }
  return value;
}

function copyOptionalString(source: JsonRecord, target: Record<string, unknown>, key: string): void {
  if (source[key] !== undefined) {
    target[key] = requiredString(source[key]);
  }
}

function copyOptionalNullableString(
  source: JsonRecord,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = requiredNullableString(source[key]);
  }
}

function copyOptionalNullableNumber(
  source: JsonRecord,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = requiredNullableFiniteNumber(source[key]);
  }
}

function copyOptionalStringArray(
  source: JsonRecord,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = requiredArray(source[key]).map(requiredString);
  }
}

function invalid(): never {
  throw new AppServerProtocolValidationError();
}
