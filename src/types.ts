export interface SessionDb {
  [feishuChatId: string]: {
    threadId: string;
    threadName: string;
    cwd?: string;
    lastPushedTurnId?: string;
    personality?: 'friendly' | 'pragmatic' | 'none';
    planMode?: boolean;
    model?: string;
    activeSkill?: { name: string; path: string } | null;
    lastSkillsCardMessageId?: string | null;
  };
}

export interface TurnStats {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextLength?: number;
  apiCalls?: number;
}

export interface ActionCluster {
  id: string;
  panelId: string;
  markdownId: string;
  startedAt: number;
  lastUpdatedAt: number;
  completed: boolean;
  counts: {
    searches: number;
    reads: number;
    edits: number;
    skills: number;
    runs: number;
  };
  details: string[];
}

export interface ActiveTurn {
  chatId: string;
  messageId: string;
  cardId?: string;
  threadId: string;
  prompt: string;
  answer?: string;
  reasoning?: string;
  logs: string[];
  status: 'running' | 'success' | 'failed' | 'interrupted';
  dirty: boolean;
  updating?: boolean;
  activeStream?: 'reasoning' | 'answer' | string;
  startedAt?: number;
  completedAt?: number;
  stats: TurnStats;
  sequence: number;
  isHistory?: boolean;
  skillName?: string;
  collaborationMode?: string | null;
  personality?: string | null;
  streamingClosed?: boolean;
  commandOutputTail?: string;
  activeToolPanels?: Record<string, string>;
  currentActionCluster?: ActionCluster;
  clusterCount?: number;
  rateLimitStr?: string;
  lastFullUpdateAt?: number;
  lastSentValues?: Record<string, string>;
  commandExecutionCount?: number;
  hasLoggedFoldMessage?: boolean;
  pendingReasoningHeader?: string;
  lastRateLimitQueryAt?: number;
  filesUploaded?: boolean;
}

export interface ActiveApproval {
  requestId: number | string;
  chatId: string;
  threadId: string;
  turnId: string;
  approvalType: string;
  summary: string;
  cwd: string;
  reason?: string;
  isIpc?: boolean;
  approvalMethod?: string;
  createdAt?: number;
}
