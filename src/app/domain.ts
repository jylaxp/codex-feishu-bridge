/**
 * Immutable domain contracts for the clean-slate Feishu/App Server bridge.
 *
 * These types deliberately contain no Desktop, legacy-session, or mutable
 * collection concepts. Runtime services persist state transitions and replace
 * whole values rather than mutating shared objects in place.
 */

export type TaskStatus =
  | 'RECEIVED'
  | 'CARD_CREATING'
  | 'STARTING'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'COMPLETING'
  | 'QUEUED'
  | 'DISPATCH_UNKNOWN'
  | 'RECOVERING'
  | 'NEEDS_REVIEW'
  | 'DELIVERY_DELAYED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'INTERRUPTED';

export type TaskItemStatus = 'STARTED' | 'COMPLETED' | 'FAILED';

declare const sanitizedCardTextBrand: unique symbol;

/** Text that has crossed the CardKit sanitizer boundary. */
export type SanitizedCardText = string & {
  readonly [sanitizedCardTextBrand]: true;
};

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CardProjectionPayload {
  readonly title: SanitizedCardText;
  readonly target: SanitizedCardText;
  readonly prompt: SanitizedCardText;
  readonly commentary: SanitizedCardText;
  readonly toolSummary: SanitizedCardText;
  readonly finalAnswer: SanitizedCardText;
  readonly footer: SanitizedCardText;
  readonly terminal: boolean;
}

export interface BridgeConfig {
  readonly larkAppId: string;
  readonly larkAppSecret: string;
  readonly larkTenantKey: string;
  readonly allowedChats: readonly string[];
  readonly authorizedUsers: readonly string[];
  readonly allowedApprovers: readonly string[];
  readonly appServerMode: 'owned_stdio' | 'managed_proxy';
  readonly appServerSocketPath: string | null;
  readonly codexBin: string;
  readonly codexCwd: string;
  readonly allowedWorkspaceRoots: readonly string[];
  /** Current runtime home; only .env and bindings.json are persistent state. */
  readonly configHome?: string;
  /** @deprecated Legacy SQLite data directory. New runtime never uses this path. */
  readonly dataDir?: string;
  readonly maxTextLength: number;
  readonly cardUpdateIntervalMs: number;
  readonly maxQueuedTasks: number;
}

export interface DataDirectoryLayout {
  readonly rootDir: string;
  readonly databasePath: string;
  readonly logDir: string;
  readonly temporaryDir: string;
}

export interface PreflightResult {
  readonly config: BridgeConfig;
  readonly configHome: string;
  readonly dataDirectory: DataDirectoryLayout;
  readonly nodeVersion: string;
}
