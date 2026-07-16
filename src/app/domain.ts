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

export interface CardToolGroup {
  readonly title: SanitizedCardText;
  readonly content: SanitizedCardText;
  readonly count: number;
  readonly icon?: string;
  readonly completed?: boolean;
  readonly failed?: boolean;
}

/** One ordered and timestamped activity in a task card. */
export interface CardTimelineEntry {
  readonly kind: 'reasoning' | 'tool';
  readonly time: SanitizedCardText;
  readonly content?: SanitizedCardText;
  readonly tool?: CardToolGroup;
}

export interface CardProjectionPayload {
  readonly title: SanitizedCardText;
  readonly prompt: SanitizedCardText;
  readonly metadata?: SanitizedCardText | null;
  readonly commentary: SanitizedCardText;
  readonly toolSummary: SanitizedCardText;
  /** Number of tool calls represented by the collapsed tools panel. */
  readonly toolCount?: number;
  /** Ordered collapsed tool rows. Preferred over the legacy aggregate summary. */
  readonly toolGroups?: readonly CardToolGroup[];
  /** Ordered activity stream; replaces separated text and tool sections when present. */
  readonly timeline?: readonly CardTimelineEntry[];
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
  /** Explicitly trusted local executables for /cmd, /run and /shell. */
  readonly allowedShellCommands?: readonly string[];
  readonly appServerMode: 'owned_stdio' | 'managed_proxy';
  readonly appServerSocketPath: string | null;
  readonly codexBin: string;
  /** Default working directory. Task execution itself uses full-machine access. */
  readonly codexCwd: string;
  /** Current runtime home; only .env and bindings.json are persistent state. */
  readonly configHome?: string;
  readonly maxTextLength: number;
  readonly cardUpdateIntervalMs: number;
  readonly maxQueuedTasks: number;
  /** Shared in-memory TTL for account/rate-limit reads. */
  readonly rateLimitQueryIntervalMs: number;
  /** Legacy opt-in operational log switch. Logs never contain task payloads. */
  readonly logToFile: boolean;
  /** Optional log filename/path, resolved beneath the Bridge config home. */
  readonly logFilePath: string | null;
  /** Retains the old opt-in output-file upload setting for the Lark adapter. */
  readonly enableAutoFileUpload: boolean;
}

export interface RuntimeDirectoryLayout {
  readonly rootDir: string;
  readonly temporaryDir: string;
}

export interface PreflightResult {
  readonly config: BridgeConfig;
  readonly configHome: string;
  readonly runtimeDirectory: RuntimeDirectoryLayout;
  readonly nodeVersion: string;
}
