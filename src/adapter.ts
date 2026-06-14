import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import WebSocket from 'ws';
import * as crypto from 'crypto';

const IS_LITTLE_ENDIAN = os.endianness() === 'LE';

export interface CodexThread {
  id: string;
  name: string;
  preview: string;
  cwd?: string;
}

export interface CodexThreadAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  onNotification(handler: (message: any) => void): void;
  onExit(handler: () => void): void;
  listThreads(limit?: number): Promise<CodexThread[]>;
  startRemoteControlTurn(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    workspaceKind?: 'project' | 'projectless';
    input?: any[];
    collaborationMode?: string | null;
    personality?: string | null;
  }): Promise<string>;
}

export class LocalAppServerAdapter implements CodexThreadAdapter {
  private childProcess?: ChildProcess;
  private ws?: WebSocket;
  private reader?: readline.Interface;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (err: any) => void }>();
  private nextId = 1;
  private notificationHandlers: Array<(message: any) => void> = [];
  private exitHandlers: Array<() => void> = [];

  private ipcClient: net.Socket | null = null;
  private ipcClientId: string | null = null;
  private pendingIpcRequests = new Map<string, {
    resolve: (turnId: string | null) => void;
    timeout: NodeJS.Timeout;
  }>();
  private ipcConnectionPromise: Promise<net.Socket | null> | null = null;
  private threadStates = new Map<string, any>();
  private lastAgentMessageTexts = new Map<string, string>();
  private lastCommandOutputs = new Map<string, string>();

  constructor(private options: { socketPath?: string } = {}) {}

  async connect(): Promise<void> {
    const defaultSocketPath = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
    const socketPath = this.options.socketPath || defaultSocketPath;

    // Proactively check if the socket is alive using a net connection
    let isSocketAlive = false;
    if (fs.existsSync(socketPath)) {
      isSocketAlive = await new Promise<boolean>((resolve) => {
        const socket = net.createConnection(socketPath);
        socket.on('connect', () => {
          socket.end();
          resolve(true);
        });
        socket.on('error', () => {
          resolve(false);
        });
      });

      if (!isSocketAlive) {
        console.log(`Socket file found at ${socketPath} but it is dead (Connection Refused). Cleaning it up...`);
        try {
          fs.unlinkSync(socketPath);
        } catch (err) {
          console.error(`Failed to delete dead socket file:`, err);
        }
      }
    }

    if (isSocketAlive) {
      console.log(`Connecting to existing socket via WebSocket: ${socketPath}`);
      this.ws = new WebSocket('ws://codex-app-server/', {
        perMessageDeflate: false,
        createConnection: () => {
          return net.createConnection(socketPath);
        }
      });

      this.ws.on('message', (data) => {
        const trimmed = data.toString().trim();
        if (!trimmed) return;
        this.handleMessageLine(trimmed);
      });

      this.ws.on('error', (err) => {
        console.error('WebSocket connection error:', err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket connection closed: ${code} - ${reason}`);
        this.cleanup();
      });

      await new Promise<void>((resolve, reject) => {
        this.ws!.on('open', () => {
          resolve();
        });
        this.ws!.on('error', (err) => {
          reject(err);
        });
      });
    } else {
      console.log(`Socket not found or dead at ${socketPath}. Launching standalone App Server...`);
      this.childProcess = spawn('codex', ['app-server', '--listen', 'stdio://']);

      this.childProcess.on('error', (err) => {
        console.error('Failed to start codex subprocess:', err);
      });

      this.childProcess.stderr?.on('data', (data) => {
        const msg = data.toString().trim();
        console.error(`[Codex App Server Stderr]: ${msg}`);
        // Also propagate stderr as a notification to any listeners
        this.notificationHandlers.forEach(handler => {
          handler({ method: 'agent/stderr', params: { chunk: msg } });
        });
      });

      this.reader = readline.createInterface({
        input: this.childProcess.stdout!,
        terminal: false
      });

      this.reader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this.handleMessageLine(trimmed);
      });

      // Handle unexpected process exit
      this.childProcess.on('exit', (code, signal) => {
        console.log(`Codex subprocess exited with code ${code} and signal ${signal}`);
        this.cleanup();
      });
    }

    // Send initialize request to the App Server
    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'feishu-bridge',
          title: 'Feishu Bot Bridge',
          version: '1.0.0'
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: []
        }
      });
      console.log('Codex App Server initialized.');
    } catch (e: any) {
      console.error('Failed to initialize Codex App Server:', e);
      this.cleanup();
      throw e;
    }
  }

  disconnect(): void {
    this.cleanup();
  }

  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  private handleMessageLine(line: string): void {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && message.id !== null) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          this.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(message.error);
          } else {
            pending.resolve(message.result);
          }
        } else {
          // This is a request from Codex App Server (e.g. approval request)
          this.notificationHandlers.forEach(handler => {
            try {
              handler(message);
            } catch (e) {
              console.error('Error in notification handler:', e);
            }
          });
        }
      } else {
        // Notification event from App Server
        this.notificationHandlers.forEach(handler => {
          try {
            handler(message);
          } catch (e) {
            console.error('Error in notification handler:', e);
          }
        });
      }
    } catch (e) {
      console.error('Failed to parse JSON line from Codex:', line, e);
    }
  }

  private cleanup(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = undefined;
    }
    if (this.reader) {
      this.reader.close();
      this.reader = undefined;
    }
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = undefined;
    }
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    // Clean up persistent IPC client
    if (this.ipcClient) {
      try {
        this.ipcClient.destroy();
      } catch (e) {}
      this.ipcClient = null;
    }
    this.ipcClientId = null;
    for (const [reqId, pending] of this.pendingIpcRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingIpcRequests.clear();
    this.ipcConnectionPromise = null;

    // Trigger and clear exit handlers
    const handlers = this.exitHandlers;
    this.exitHandlers = [];
    handlers.forEach(h => {
      try { h(); } catch (e) { console.error('Error in exit handler:', e); }
    });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    const doRequest = () => {
      const id = this.nextId++;
      const reqObj = { jsonrpc: '2.0', id, method, params };

      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }, timeoutMs);

        this.pendingRequests.set(id, {
          resolve: (v: any) => { clearTimeout(timer); resolve(v); },
          reject: (e: any) => { clearTimeout(timer); reject(e); }
        });
        if (this.ws) {
          this.ws.send(JSON.stringify(reqObj));
        } else if (this.childProcess && this.childProcess.stdin) {
          this.childProcess.stdin.write(JSON.stringify(reqObj) + '\n');
        } else {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error("Transport disconnected"));
        }
      });
    };

    try {
      return await doRequest();
    } catch (e: any) {
      const threadId = params?.threadId;
      if (
        typeof threadId === 'string' &&
        method !== 'thread/resume' &&
        e?.message &&
        e.message.toLowerCase().includes('thread not found')
      ) {
        console.log(`Auto-resuming thread ${threadId} due to error: ${e.message}`);
        try {
          await this.request('thread/resume', { threadId });
          console.log(`Resumed thread ${threadId} successfully, retrying ${method}...`);
          return await doRequest();
        } catch (resumeErr) {
          console.warn(`Failed to auto-resume thread ${threadId}:`, resumeErr);
          throw e; // throw original error
        }
      }
      throw e;
    }
  }

  onNotification(handler: (message: any) => void): void {
    this.notificationHandlers.push(handler);
  }

  async listThreads(limit: number = 50): Promise<CodexThread[]> {
    const result = await this.request('thread/list', { limit, archived: false });
    if (!result || !Array.isArray(result.data)) {
      return [];
    }

    const isValidDeletionTime = (val: any): boolean => {
      if (!val || val === "null" || val === "0001-01-01T00:00:00Z" || val === "0000-00-00 00:00:00") {
        return false;
      }
      const parsed = Date.parse(val);
      return !isNaN(parsed) && parsed > 0;
    };

    return result.data
      .filter((t: any) => {
        if (t.deleted === true || t.isDeleted === true || t.is_deleted === true) return false;
        if (t.archived === true) return false;
        if (isValidDeletionTime(t.deletedAt) || isValidDeletionTime(t.deleted_at)) return false;
        return true;
      })
      .map((t: any) => ({
        id: t.id,
        name: t.name || t.preview || "未命名会话",
        preview: t.preview || "",
        cwd: t.cwd || t.workspacePath || t.workspace || ""
      }));
  }

  respond(id: number | string, result: any): void {
    const resp = { jsonrpc: '2.0', id, result };
    if (this.ws) {
      this.ws.send(JSON.stringify(resp));
    } else if (this.childProcess && this.childProcess.stdin) {
      this.childProcess.stdin.write(JSON.stringify(resp) + '\n');
    }
  }

  private async getIpcClient(): Promise<net.Socket | null> {
    if (this.ipcClient && this.ipcClient.writable) {
      return this.ipcClient;
    }
    if (this.ipcConnectionPromise) {
      return this.ipcConnectionPromise;
    }

    this.ipcConnectionPromise = new Promise<net.Socket | null>((resolve) => {
      const systemTmpDir = os.tmpdir();
      const codexIpcDir = path.join(systemTmpDir, 'codex-ipc');
      let socketPath = '';
      
      if (fs.existsSync(codexIpcDir)) {
        const files = fs.readdirSync(codexIpcDir);
        const sockFile = files.find(f => (f.startsWith('ipc-') && f.endsWith('.sock')) || f === 'ipc.sock');
        if (sockFile) {
          socketPath = path.join(codexIpcDir, sockFile);
        }
      }
      
      if (!socketPath) {
        logToFile('[IPC] No desktop IPC socket found.');
        this.ipcConnectionPromise = null;
        resolve(null);
        return;
      }

      logToFile(`[IPC] Connecting to Desktop IPC socket: ${socketPath}`);
      const client = net.createConnection(socketPath);
      let rxBuffer = Buffer.alloc(0);
      let expectedLen: number | null = null;

      const connectionTimeout = setTimeout(() => {
        logToFile('[IPC] Connection to Desktop IPC socket timed out.');
        client.destroy();
        this.ipcConnectionPromise = null;
        resolve(null);
      }, 5000);

      const writeMessage = (obj: any) => this.writeIpcMessage(client, obj);

      client.on('connect', () => {
        clearTimeout(connectionTimeout);
        logToFile('[IPC] Connected to Desktop IPC socket. Sending initialize...');
        writeMessage({
          type: 'request',
          requestId: crypto.randomUUID(),
          method: 'initialize',
          params: { clientType: 'vscode' }
        });
      });

      client.on('data', (data) => {
        rxBuffer = Buffer.concat([rxBuffer, data]);
        while (true) {
          if (expectedLen === null) {
            if (rxBuffer.length < 4) break;
            if (IS_LITTLE_ENDIAN) {
              expectedLen = rxBuffer.readUInt32LE(0);
            } else {
              expectedLen = rxBuffer.readUInt32BE(0);
            }
            rxBuffer = rxBuffer.subarray(4);
          }
          if (rxBuffer.length < expectedLen) break;
          const msgBytes = rxBuffer.subarray(0, expectedLen);
          rxBuffer = rxBuffer.subarray(expectedLen);
          expectedLen = null;
          
          const msgStr = msgBytes.toString('utf8');
          try {
            const msg = JSON.parse(msgStr);
            logToFile(`[IPC Received]: ${msgStr}`);
            
            if (msg.type === 'response' && msg.method === 'initialize') {
              if (msg.resultType === 'success' && msg.result?.clientId) {
                this.ipcClientId = msg.result.clientId;
                this.ipcClient = client;
                this.ipcConnectionPromise = null;
                logToFile(`[IPC] Initialized successfully. clientId: ${this.ipcClientId}`);
                resolve(client);
              } else {
                logToFile(`[IPC] Initialize failed: ${JSON.stringify(msg)}`);
                client.destroy();
              }
            } else if (msg.type === 'response' && msg.requestId) {
              const pending = this.pendingIpcRequests.get(msg.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                this.pendingIpcRequests.delete(msg.requestId);
                const resTurnId = msg.result?.turnId || msg.result?.result?.turn?.id;
                if (msg.resultType === 'success' && resTurnId) {
                  pending.resolve(resTurnId);
                } else {
                  logToFile(`[IPC] Request failed for ${msg.requestId}: ${JSON.stringify(msg)}`);
                  pending.resolve(null);
                }
              }
            } else if (msg.type === 'broadcast' && msg.method === 'thread-stream-state-changed') {
              this.handleIpcThreadStreamStateChanged(msg);
            }
          } catch (e: any) {
            logToFile(`[IPC] Failed to parse message: ${e.message}`);
          }
        }
      });

      client.on('error', (err) => {
        logToFile(`[IPC] Socket error: ${err.message}`);
        clearTimeout(connectionTimeout);
        if (this.ipcConnectionPromise) {
          this.ipcConnectionPromise = null;
          resolve(null);
        }
      });

      client.on('close', () => {
        logToFile('[IPC] Socket closed.');
        clearTimeout(connectionTimeout);
        
        // Fail all pending requests
        for (const [reqId, pending] of this.pendingIpcRequests.entries()) {
          clearTimeout(pending.timeout);
          pending.resolve(null);
        }
        this.pendingIpcRequests.clear();
        
        this.ipcClient = null;
        this.ipcClientId = null;
        if (this.ipcConnectionPromise) {
          this.ipcConnectionPromise = null;
          resolve(null);
        }
      });
    });

    return this.ipcConnectionPromise;
  }

  private async tryDesktopIpcStartTurn(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    workspaceKind?: 'project' | 'projectless';
    input?: any[];
    collaborationMode?: string | null;
    personality?: string | null;
  }): Promise<string | null> {
    if (process.env.NODE_ENV === 'test') {
      console.log('Skipping Desktop IPC start turn in test environment.');
      return null;
    }

    const client = await this.getIpcClient();
    if (!client || !this.ipcClientId) {
      logToFile('[IPC] Failed to get connected IPC client.');
      return null;
    }

    const turnParams = {
      threadId: options.threadId,
      clientUserMessageId: 'bridge-' + crypto.randomUUID(),
      input: options.input || [{ type: 'text', text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      collaborationMode: options.collaborationMode || null,
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [options.cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      },
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      permissions: null,
      model: null,
      serviceTier: null,
      effort: null,
      summary: 'none',
      personality: options.personality || null,
      responsesapiClientMetadata: { 
        workspace_kind: options.workspaceKind || 'project' 
      },
      attachments: [],
      commentAttachments: []
    };

    const reqId = crypto.randomUUID();
    logToFile(`[IPC] Sending thread-follower-start-turn for thread: ${options.threadId}, requestId: ${reqId}`);

    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        logToFile(`[IPC] Request ${reqId} timed out.`);
        this.pendingIpcRequests.delete(reqId);
        resolve(null);
      }, 30000);

      this.pendingIpcRequests.set(reqId, { resolve, timeout });

      const writeMessage = (obj: any) => this.writeIpcMessage(client, obj);

      writeMessage({
        type: 'request',
        requestId: reqId,
        sourceClientId: this.ipcClientId,
        version: 1,
        method: 'thread-follower-start-turn',
        params: {
          conversationId: options.threadId,
          turnStartParams: turnParams
        },
        timeoutMs: 30000
      });
    });
  }

  async startRemoteControlTurn(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    workspaceKind?: 'project' | 'projectless';
    input?: any[];
    collaborationMode?: string | null;
    personality?: string | null;
  }): Promise<string> {
    // Proactively resume/load the thread first on WS to ensure we subscribe to its event stream
    try {
      console.log(`Pre-loading thread ${options.threadId} via thread/resume...`);
      await this.request('thread/resume', { threadId: options.threadId });
    } catch (e) {
      console.warn(`Failed to preload thread ${options.threadId} via thread/resume:`, e);
    }

    // Attempt to launch the turn via Desktop IPC first (so that Desktop UI is updated)
    try {
      const ipcTurnId = await this.tryDesktopIpcStartTurn(options);
      if (ipcTurnId) {
        console.log(`Successfully started turn via Desktop IPC. turnId: ${ipcTurnId}`);
        return ipcTurnId;
      }
    } catch (e) {
      console.warn('Error starting turn via Desktop IPC, falling back to standard WebSocket request:', e);
    }

    console.log('Falling back to standard websocket turn/start...');
    const result = await this.request('turn/start', {
      threadId: options.threadId,
      cwd: options.cwd,
      collaborationMode: options.collaborationMode || null,
      personality: options.personality || null,
      input: options.input || [{ type: "text", text: options.prompt, text_elements: [] }]
    });
    if (!result || !result.turn || !result.turn.id) {
      throw new Error(`Invalid turn/start response: ${JSON.stringify(result)}`);
    }
    return result.turn.id;
  }

  private handleIpcThreadStreamStateChanged(msg: any) {
    const params = msg.params;
    if (!params) return;
    const threadId = params.conversationId || params.threadId;
    if (!threadId) return;

    if (!this.threadStates.has(threadId)) {
      this.threadStates.set(threadId, { turns: [] });
    }
    const state = this.threadStates.get(threadId);

    const change = params.change;
    if (!change) return;

    if (change.type === 'snapshot') {
      const conversationState = change.conversationState || { turns: [] };
      this.threadStates.set(threadId, conversationState);
      for (const key of this.lastAgentMessageTexts.keys()) {
        if (key.startsWith(threadId + '-')) {
          this.lastAgentMessageTexts.delete(key);
        }
      }
      for (const key of this.lastCommandOutputs.keys()) {
        if (key.startsWith(threadId + '-')) {
          this.lastCommandOutputs.delete(key);
        }
      }
      // Populate text and command output tracking from snapshot to avoid duplication
      if (Array.isArray(conversationState.turns)) {
        conversationState.turns.forEach((turn: any, turnIdx: number) => {
          if (turn && Array.isArray(turn.items)) {
            turn.items.forEach((item: any, itemIdx: number) => {
              if (item) {
                if (item.type === 'agentMessage' && typeof item.text === 'string') {
                  const textKey = `${threadId}-${turnIdx}-${itemIdx}`;
                  this.lastAgentMessageTexts.set(textKey, item.text);
                } else if (item.type === 'reasoning' && typeof item.text === 'string') {
                  const textKey = `${threadId}-${turnIdx}-${itemIdx}`;
                  this.lastAgentMessageTexts.set(textKey, item.text);
                } else if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
                  const outputKey = `${threadId}-${turnIdx}-${itemIdx}`;
                  this.lastCommandOutputs.set(outputKey, item.aggregatedOutput);
                }
              }
            });
          }
        });
      }
      if (Array.isArray(conversationState.requests)) {
        conversationState.requests.forEach((requestVal: any) => {
          if (requestVal && requestVal.method && requestVal.id !== undefined) {
            logToFile(`[IPC Snapshot] Intercepted request: ${JSON.stringify(requestVal)}`);
            this.emitNotification({
              id: requestVal.id,
              method: requestVal.method,
              params: {
                ...requestVal.params,
                threadId: threadId
              },
              isIpc: true
            });
          }
        });
      }
    } else if (change.type === 'patches' && Array.isArray(change.patches)) {
      for (const patch of change.patches) {
        if (!patch || !Array.isArray(patch.path)) continue;
        
        const path = patch.path;
        if (path[0] === 'requests') {
          if (patch.op === 'add') {
            const requestVal = patch.value;
            if (requestVal && requestVal.method && requestVal.id !== undefined) {
              logToFile(`[IPC Patch add] Intercepted requests: ${JSON.stringify(requestVal)}`);
              this.emitNotification({
                id: requestVal.id,
                method: requestVal.method,
                params: {
                  ...requestVal.params,
                  threadId: threadId
                },
                isIpc: true
              });
            }
          } else if (patch.op === 'replace' && Array.isArray(patch.value)) {
            patch.value.forEach((requestVal: any) => {
              if (requestVal && requestVal.method && requestVal.id !== undefined) {
                logToFile(`[IPC Patch replace] Intercepted requests: ${JSON.stringify(requestVal)}`);
                this.emitNotification({
                  id: requestVal.id,
                  method: requestVal.method,
                  params: {
                    ...requestVal.params,
                    threadId: threadId
                  },
                  isIpc: true
                });
              }
            });
          }
        }

        if (path[0] === 'turns' && typeof path[1] === 'number') {
          const turnIndex = path[1];
          const beforeTurn = state.turns[turnIndex] ? { ...state.turns[turnIndex] } : null;

          this.applyJsonPatch(state, patch);

          const afterTurn = state.turns[turnIndex];
          if (!afterTurn) continue;

          const turnId = afterTurn.turnId || afterTurn.id;

          const emitTurnStartedAndPrompt = () => {
            this.emitNotification({
              method: 'turn/started',
              params: { threadId, turnId, turn: { id: turnId } }
            });

            // Extract prompt text and emit userMessage item/started notification
            const inputElements = afterTurn.input || [];
            const textElement = inputElements.find((el: any) => el.type === 'text');
            const promptText = textElement ? textElement.text : '';
            if (promptText) {
              this.emitNotification({
                method: 'item/started',
                params: {
                  threadId,
                  turnId,
                  item: {
                    type: 'userMessage',
                    content: [{ type: 'text', text: promptText }]
                  }
                }
              });
            }
          };

          if (patch.op === 'add' && path.length === 2 && afterTurn && afterTurn.status === 'inProgress') {
            emitTurnStartedAndPrompt();
          }

          if (path[2] === 'status') {
            const beforeStatus = beforeTurn ? beforeTurn.status : null;
            const afterStatus = afterTurn.status;
            if (beforeStatus !== afterStatus && afterStatus) {
              if (afterStatus === 'inProgress') {
                emitTurnStartedAndPrompt();
              } else if (afterStatus === 'completed' || afterStatus === 'failed' || afterStatus === 'interrupted') {
                this.emitNotification({
                  method: 'turn/completed',
                  params: { 
                    threadId, 
                    turnId, 
                    turn: { id: turnId, status: afterStatus },
                    error: afterTurn.error || (afterStatus === 'failed' ? { message: 'Turn execution failed' } : null)
                  }
                });
                // Clean up tracking for this turn to prevent memory leak
                for (const key of this.lastAgentMessageTexts.keys()) {
                  if (key.startsWith(`${threadId}-${turnIndex}-`)) {
                    this.lastAgentMessageTexts.delete(key);
                  }
                }
                for (const key of this.lastCommandOutputs.keys()) {
                  if (key.startsWith(`${threadId}-${turnIndex}-`)) {
                    this.lastCommandOutputs.delete(key);
                  }
                }
              }
            }
          }

          if (path[2] === 'input') {
            const inputElements = afterTurn.input || [];
            const textElement = inputElements.find((el: any) => el.type === 'text');
            const promptText = textElement ? textElement.text : '';
            if (promptText) {
              this.emitNotification({
                method: 'item/started',
                params: {
                  threadId,
                  turnId,
                  item: {
                    type: 'userMessage',
                    content: [{ type: 'text', text: promptText }]
                  }
                }
              });
            }
          }

          if (path[2] === 'items' && typeof path[3] === 'number' && path[4] === 'text') {
            const itemIndex = path[3];
            const item = afterTurn.items[itemIndex];
            if (item) {
              if (item.type === 'agentMessage') {
                const textKey = `${threadId}-${turnIndex}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = patch.value || '';
                if (newText.length > oldText.length) {
                  const delta = newText.slice(oldText.length);
                  this.lastAgentMessageTexts.set(textKey, newText);
                  if (item.phase === 'commentary') {
                    this.emitNotification({
                      method: 'item/reasoning/delta',
                      params: { threadId, turnId, delta }
                    });
                  } else {
                    this.emitNotification({
                      method: 'item/agentMessage/delta',
                      params: { threadId, turnId, delta }
                    });
                  }
                }
              } else if (item.type === 'reasoning') {
                const textKey = `${threadId}-${turnIndex}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = patch.value || '';
                if (newText.length > oldText.length) {
                  const delta = newText.slice(oldText.length);
                  this.lastAgentMessageTexts.set(textKey, newText);
                  this.emitNotification({
                    method: 'item/reasoning/delta',
                    params: { threadId, turnId, delta }
                  });
                }
              }
            }
          }

          if (path[2] === 'items' && typeof path[3] === 'number' && path[4] === 'aggregatedOutput') {
            const itemIndex = path[3];
            const item = afterTurn.items[itemIndex];
            if (item && item.type === 'commandExecution') {
              const outputKey = `${threadId}-${turnIndex}-${itemIndex}`;
              const oldOutput = this.lastCommandOutputs.get(outputKey) || '';
              const newOutput = patch.value || '';
              if (newOutput.length > oldOutput.length) {
                const delta = newOutput.slice(oldOutput.length);
                this.lastCommandOutputs.set(outputKey, newOutput);
                this.emitNotification({
                  method: 'agent/stderr',
                  params: { chunk: delta }
                });
              }
            }
          }

          if (path[2] === 'items' && typeof path[3] === 'number' && path.length === 4) {
            const itemIndex = path[3];
            const item = patch.value;
            if (item) {
              if (item.type === 'agentMessage' && item.text) {
                const textKey = `${threadId}-${turnIndex}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = item.text || '';
                if (newText.length > oldText.length) {
                  const delta = newText.slice(oldText.length);
                  this.lastAgentMessageTexts.set(textKey, newText);
                  if (item.phase === 'commentary') {
                    this.emitNotification({
                      method: 'item/reasoning/delta',
                      params: { threadId, turnId, delta }
                    });
                  } else {
                    this.emitNotification({
                      method: 'item/agentMessage/delta',
                      params: { threadId, turnId, delta }
                    });
                  }
                }
              } else if (item.type === 'reasoning' && item.text) {
                const textKey = `${threadId}-${turnIndex}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = item.text || '';
                if (newText.length > oldText.length) {
                  const delta = newText.slice(oldText.length);
                  this.lastAgentMessageTexts.set(textKey, newText);
                  this.emitNotification({
                    method: 'item/reasoning/delta',
                    params: { threadId, turnId, delta }
                  });
                }
              } else if (item.type === 'commandExecution' && item.aggregatedOutput) {
                const outputKey = `${threadId}-${turnIndex}-${itemIndex}`;
                const oldOutput = this.lastCommandOutputs.get(outputKey) || '';
                const newOutput = item.aggregatedOutput || '';
                if (newOutput.length > oldOutput.length) {
                  const delta = newOutput.slice(oldOutput.length);
                  this.lastCommandOutputs.set(outputKey, newOutput);
                  this.emitNotification({
                    method: 'agent/stderr',
                    params: { chunk: delta }
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  private applyJsonPatch(obj: any, patch: { op: string; path: (string | number)[]; value: any }) {
    const path = patch.path;
    if (path.length === 0) return;
    
    let curr = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (curr[key] === undefined) {
        const nextKey = path[i + 1];
        curr[key] = typeof nextKey === 'number' ? [] : {};
      }
      curr = curr[key];
    }
    
    const lastKey = path[path.length - 1];
    if (patch.op === 'add') {
      if (Array.isArray(curr) && typeof lastKey === 'number') {
        curr.splice(lastKey, 0, patch.value);
      } else {
        curr[lastKey] = patch.value;
      }
    } else if (patch.op === 'replace') {
      curr[lastKey] = patch.value;
    } else if (patch.op === 'remove') {
      if (Array.isArray(curr) && typeof lastKey === 'number') {
        curr.splice(lastKey, 1);
      } else {
        delete curr[lastKey];
      }
    }
  }

  async respondIpcApproval(options: {
    threadId: string;
    requestId: string | number;
    method: string;
    decision: string;
  }): Promise<boolean> {
    const client = await this.getIpcClient();
    if (!client || !this.ipcClientId) {
      logToFile('[IPC] Failed to get connected IPC client for approval response.');
      return false;
    }

    let ipcMethod = '';
    let params: any = {
      conversationId: options.threadId,
      requestId: options.requestId,
    };

    const methodLower = options.method.toLowerCase();
    if (methodLower.includes('command')) {
      ipcMethod = 'thread-follower-command-approval-decision';
      params.decision = options.decision;
    } else if (methodLower.includes('filechange') || methodLower.includes('file')) {
      ipcMethod = 'thread-follower-file-approval-decision';
      params.decision = options.decision;
    } else if (methodLower.includes('permissions')) {
      ipcMethod = 'thread-follower-permissions-request-approval-response';
      params.response = { decision: options.decision };
    } else {
      logToFile(`[IPC] Unknown approval method: ${options.method}`);
      return false;
    }

    const reqId = crypto.randomUUID();
    logToFile(`[IPC] Sending ${ipcMethod} for request ${options.requestId}, decision ${options.decision}`);

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        logToFile(`[IPC] Approval response request ${reqId} timed out.`);
        this.pendingIpcRequests.delete(reqId);
        resolve(false);
      }, 10000);

      this.pendingIpcRequests.set(reqId, {
        resolve: () => {
          resolve(true);
        },
        timeout
      });

      const writeMessage = (obj: any) => this.writeIpcMessage(client, obj);

      writeMessage({
        type: 'request',
        requestId: reqId,
        sourceClientId: this.ipcClientId,
        version: 1,
        method: ipcMethod,
        params,
        timeoutMs: 10000
      });
    });
  }

  private writeIpcMessage(client: net.Socket, obj: any): void {
    const jsonStr = JSON.stringify(obj);
    const msgBuffer = Buffer.from(jsonStr, 'utf8');
    const lenBuffer = Buffer.alloc(4);
    if (IS_LITTLE_ENDIAN) {
      lenBuffer.writeUInt32LE(msgBuffer.length, 0);
    } else {
      lenBuffer.writeUInt32BE(msgBuffer.length, 0);
    }
    client.write(Buffer.concat([lenBuffer, msgBuffer]));
  }

  private emitNotification(msg: any) {
    this.notificationHandlers.forEach(handler => {
      try {
        handler(msg);
      } catch (e) {
        console.error('Error in propagated notification handler:', e);
      }
    });
  }
}

export function logToFile(msg: string) {
  try {
    const logPath = path.join(os.homedir(), '.codex', 'bridge_debug.log');
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_SIZE) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch (_) {}
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}
