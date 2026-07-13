/**
 * Protocol type definitions for the Codex App Server JSON-RPC interface.
 * Based on `codex app-server generate-ts --experimental` output (v0.144.0).
 */

// ─── User Input ───────────────────────────────────────────

export type UserInput =
  | { type: 'text'; text: string; text_elements: Array<{ tag: string; [k: string]: any }> }
  | { type: 'image'; detail?: 'low' | 'high' | 'auto'; url: string }
  | { type: 'localImage'; detail?: 'low' | 'high' | 'auto'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

// ─── Thread Items ─────────────────────────────────────────

export interface TurnStatsPayload {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextLength?: number;
  apiCalls?: number;
}

export type ItemType =
  | 'userMessage'
  | 'hookPrompt'
  | 'agentMessage'
  | 'plan'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'collabAgentToolCall'
  | 'subAgentActivity'
  | 'webSearch'
  | 'imageView'
  | 'sleep'
  | 'imageGeneration'
  | 'enteredReviewMode'
  | 'exitedReviewMode'
  | 'contextCompaction';

export interface ThreadItem {
  type: ItemType;
  id: string;
  clientId?: string | null;
  // userMessage
  content?: UserInput[];
  // agentMessage
  text?: string;
  phase?: 'commentary' | 'final_answer' | string | null;
  memoryCitation?: any;
  // reasoning
  summary?: string[];
  // commandExecution
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  status?: string;
  // imageGeneration
  result?: string;
  revisedPrompt?: string;
  // fileChange
  changes?: any[];
  // mcpToolCall
  server?: string;
  tool?: string;
  toolName?: string;
  [k: string]: any;
}

// ─── Turn & Thread ────────────────────────────────────────

export interface Turn {
  id: string;
  items: ThreadItem[];
  itemsView: 'notLoaded' | 'loaded' | string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted' | string;
  error: { message?: string; code?: number; [k: string]: any } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface Thread {
  id: string;
  sessionId: string;
  name: string | null;
  preview: string;
  cwd: string;
  source: string;
  threadSource?: string;
  modelProvider: string;
  status: { type: 'idle' | 'active' | string; activeFlags?: string[] };
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
  [k: string]: any;
}

// ─── RPC Request/Response ─────────────────────────────────

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version: string };
  capabilities: {
    experimentalApi?: boolean;
    requestAttestation?: boolean;
    optOutNotificationMethods?: string[];
    [k: string]: any;
  };
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  clientUserMessageId?: string | null;
  collaborationMode?: string | null;
  model?: string | null;
  personality?: string | null;
  approvalPolicy?: string | null;
  sandboxPolicy?: { type: string; writableRoots?: string[]; networkAccess?: boolean; excludeTmpdirEnvVar?: boolean; excludeSlashTmp?: boolean } | null;
  effort?: string | null;
  summary?: string | null;
  [k: string]: any;
};

export interface TurnStartResponse {
  turn: { id: string };
  thread?: Thread;
  model?: string;
  [k: string]: any;
}

// ─── Server Notifications (subset used by bridge) ────────

export type ServerNotification =
  | { method: 'turn/started'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: Turn } }
  | { method: 'thread/started'; params: { thread: Thread } }
  | { method: 'thread/status/changed'; params: { threadId: string; status: { type: string } } }
  | { method: 'thread/tokenUsage/updated'; params: { threadId: string; turnId: string; tokenUsage: any } }
  | { method: 'thread/goal/updated'; params: any }
  | { method: 'thread/goal/cleared'; params: any }
  | { method: 'thread/name/updated'; params: any }
  | { method: 'thread/archived'; params: any }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: ThreadItem; startedAtMs: number } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: ThreadItem; completedAtMs?: number } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/reasoning/textDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number } }
  | { method: 'item/reasoning/delta'; params: { delta: string } }
  | { method: 'process/outputDelta'; params: { chunk?: string; delta?: string; threadId?: string; turnId?: string } }
  | { method: 'command/exec/outputDelta'; params: { chunk?: string; delta?: string; threadId?: string; turnId?: string } }
  | { method: 'agent/stdout'; params: { chunk?: string; turnId?: string } }
  | { method: 'agent/stderr'; params: { chunk?: string; turnId?: string } }
  | { method: 'mcpServer/startupStatus/updated'; params: any }
  | { method: 'account/rateLimits/updated'; params: any }
  | { method: 'remoteControl/status/changed'; params: any }
  | { method: 'hook/started'; params: any }
  | { method: 'hook/completed'; params: any }
  | { method: 'thread/compacted'; params: any }
  | { method: string; params: any };  // catch-all
