import type { ApprovalDecision } from '../domain';

export type DesktopApprovalKind = 'command' | 'file' | 'permissions';

export interface DesktopApprovalRequest {
  readonly requestId: string | number;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly itemId: string | null;
  readonly kind: DesktopApprovalKind;
  readonly reason: string;
  readonly operationSummary: string;
  readonly availableDecisions: readonly ApprovalDecision[];
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

const DECISIONS: ReadonlySet<ApprovalDecision> = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]);

/**
 * Extracts only actionable user approvals from an authoritative Desktop state
 * snapshot. Unknown request shapes fail closed instead of becoming a Feishu
 * approval card that could send an unsafe reply to the owner runtime.
 */
export function collectDesktopApprovals(
  threadId: string,
  state: UnknownRecord,
): readonly DesktopApprovalRequest[] {
  if (!Array.isArray(state.requests)) {
    return [];
  }
  return state.requests.flatMap((candidate) => parseRequest(threadId, candidate));
}

/** Maps a parsed approval kind to the pinned Desktop follower RPC method. */
export function approvalResponseMethod(kind: DesktopApprovalKind): string {
  switch (kind) {
    case 'command':
      return 'thread-follower-command-approval-decision';
    case 'file':
      return 'thread-follower-file-approval-decision';
    case 'permissions':
      return 'thread-follower-permissions-request-approval-response';
  }
}

function parseRequest(
  threadId: string,
  candidate: unknown,
): readonly DesktopApprovalRequest[] {
  const request = asRecord(candidate);
  if (!request) {
    return [];
  }
  const requestId = request?.id;
  const method = typeof request?.method === 'string' ? request.method : '';
  if (
    (typeof requestId !== 'string' && typeof requestId !== 'number')
    || !Number.isFinite(typeof requestId === 'number' ? requestId : 0)
    || request.status === 'completed'
    || request.decision !== undefined
  ) {
    return [];
  }
  const kind = approvalKind(method);
  if (!kind) {
    return [];
  }
  const params = asRecord(request.params) ?? {};
  const availableDecisions = decisions(params.availableDecisions, kind);
  if (availableDecisions.length === 0) {
    return [];
  }
  return [Object.freeze({
    requestId,
    threadId,
    turnId: textOrNull(params.turnId),
    itemId: textOrNull(params.itemId),
    kind,
    reason: textOrEmpty(params.reason),
    operationSummary: operationSummary(kind, params),
    availableDecisions: Object.freeze(availableDecisions),
  })];
}

function approvalKind(method: string): DesktopApprovalKind | null {
  if (method === 'item/commandExecution/requestApproval') {
    return 'command';
  }
  if (method === 'item/fileChange/requestApproval') {
    return 'file';
  }
  if (method === 'permissions/requestApproval') {
    return 'permissions';
  }
  return null;
}

function decisions(value: unknown, kind: DesktopApprovalKind): ApprovalDecision[] {
  const source = Array.isArray(value)
    ? value
    : kind === 'permissions' ? ['accept', 'decline'] : ['accept', 'decline', 'cancel'];
  const result: ApprovalDecision[] = [];
  for (const candidate of source) {
    if (typeof candidate === 'string' && DECISIONS.has(candidate as ApprovalDecision)) {
      const decision = candidate as ApprovalDecision;
      if (!result.includes(decision)) {
        result.push(decision);
      }
    }
  }
  return result;
}

function operationSummary(kind: DesktopApprovalKind, params: UnknownRecord): string {
  if (kind === 'command') {
    return textOrEmpty(params.command) || '命令执行';
  }
  if (kind === 'file') {
    return textOrEmpty(params.grantRoot) || '文件变更';
  }
  return '权限请求';
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
