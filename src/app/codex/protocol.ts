/**
 * Narrow Codex App Server protocol contracts used by the bridge.
 *
 * The field names in this file follow `codex-cli 0.144.3` generated with
 * `codex app-server generate-ts --experimental`.
 */

export type RequestId = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcRequest<TParams = unknown> {
  id: RequestId;
  method: string;
  params?: TParams;
}

export interface RpcSuccessResponse<TResult = unknown> {
  id: RequestId;
  result: TResult;
}

export interface RpcErrorResponse {
  id: RequestId;
  error: RpcError;
}

export type RpcResponse<TResult = unknown> = RpcSuccessResponse<TResult> | RpcErrorResponse;

export interface RpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface InitializedNotification {
  method: 'initialized';
}

export interface TextElement {
  byteRange: {
    start: number;
    end: number;
  };
  placeholder: string | null;
}

export interface TextUserInput {
  type: 'text';
  text: string;
  text_elements: TextElement[];
}

export interface SkillUserInput {
  type: 'skill';
  name: string;
  path: string;
}

export type UserInput = TextUserInput | SkillUserInput;

export type ApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WorkspaceWriteSandboxPolicy {
  type: 'workspaceWrite';
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
}

export type SandboxPolicy =
  | WorkspaceWriteSandboxPolicy
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'dangerFullAccess' }
  | { type: 'externalSandbox'; networkAccess: 'restricted' | 'enabled' };

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  ephemeral?: boolean | null;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandbox?: SandboxMode | null;
  excludeTurns?: boolean;
}

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: ApprovalPolicy | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  collaborationMode?: string | null;
  personality?: string | null;
}

export interface TurnSteerParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  expectedTurnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type MessagePhase = 'commentary' | 'final_answer';
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

export interface ThreadItem {
  id: string;
  type: string;
  text?: string;
  phase?: MessagePhase | null;
  summary?: string[];
  content?: string[] | UserInput[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  [key: string]: unknown;
}

export interface Turn {
  id: string;
  /** Original user input when the runtime exposes it in a Desktop turn snapshot. */
  input?: readonly UserInput[];
  items: ThreadItem[];
  itemsView: 'notLoaded' | 'summary' | 'full';
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface Thread {
  id: string;
  sessionId: string;
  preview: string;
  cwd: string;
  modelProvider: string;
  status:
    | { type: 'notLoaded' | 'idle' | 'systemError' }
    | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> };
  name: string | null;
  turns: Turn[];
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
}

export interface ThreadResumeResponse extends ThreadStartResponse {
  initialTurnsPage: unknown | null;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: 'created_at' | 'updated_at' | 'recency_at' | null;
  sortDirection?: 'asc' | 'desc' | null;
  modelProviders?: string[] | null;
  sourceKinds?: Array<
    | 'cli'
    | 'vscode'
    | 'exec'
    | 'appServer'
    | 'subAgent'
    | 'subAgentReview'
    | 'subAgentCompact'
    | 'subAgentThreadSpawn'
    | 'subAgentOther'
    | 'unknown'
  > | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
  parentThreadId?: string | null;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnSteerResponse {
  turnId: string;
}

export type TurnInterruptResponse = Record<string, never>;

export type CoreServerNotification =
  | { method: 'thread/started'; params: { thread: Thread } }
  | {
      method: 'thread/status/changed';
      params: { threadId: string; status: Thread['status'] };
    }
  | {
      method: 'thread/tokenUsage/updated';
      params: { threadId: string; turnId: string; tokenUsage: unknown; model: string | null };
    }
  | { method: 'turn/started'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: Turn } }
  | {
      method: 'item/started';
      params: { threadId: string; turnId: string; item: ThreadItem; startedAtMs: number };
    }
  | {
      method: 'item/completed';
      params: { threadId: string; turnId: string; item: ThreadItem; completedAtMs: number };
    }
  | {
      method: 'item/agentMessage/delta';
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: 'item/reasoning/summaryTextDelta';
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        summaryIndex: number;
      };
    }
  | {
      method: 'item/reasoning/textDelta';
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
        contentIndex: number;
      };
    }
  | {
      method: 'item/commandExecution/outputDelta';
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | {
      method: 'error';
      params: {
        error: TurnError;
        willRetry: boolean;
        threadId: string;
        turnId: string;
      };
    };

export type ServerNotification = CoreServerNotification | RpcNotification;

export type CommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: string[];
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: string;
          action: 'allow' | 'deny';
        };
      };
    }
  | 'decline'
  | 'cancel';

export type FileApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  availableDecisions?: CommandApprovalDecision[] | null;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export type ApprovalServerRequest =
  | {
      id: RequestId;
      method: 'item/commandExecution/requestApproval';
      params: CommandExecutionRequestApprovalParams;
    }
  | {
      id: RequestId;
      method: 'item/fileChange/requestApproval';
      params: FileChangeRequestApprovalParams;
    };

export type ServerRequest = ApprovalServerRequest | RpcRequest;

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandApprovalDecision;
}

export interface FileChangeRequestApprovalResponse {
  decision: FileApprovalDecision;
}
