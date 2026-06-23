import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import WebSocket from 'ws';
import * as crypto from 'crypto';

const IS_LITTLE_ENDIAN = os.endianness() === 'LE';

export function get24HourTimeStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime24h(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

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
  cleanupThreadState?(threadId: string): void;
}

export class LocalAppServerAdapter implements CodexThreadAdapter {
  private childProcess?: ChildProcess;
  private ws?: WebSocket;
  private reader?: readline.Interface;
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (err: any) => void }>();
  private nextId = 1;
  private notificationHandlers: Array<(message: any) => void> = [];
  private exitHandlers: Array<() => void> = [];
  private cleanupCalled = false;

  private ipcClient: net.Socket | null = null;
  private ipcClientId: string | null = null;
  private pendingIpcRequests = new Map<string, {
    resolve: (turnId: string | null) => void;
    timeout: NodeJS.Timeout;
  }>();
  private ipcConnectionPromise: Promise<net.Socket | null> | null = null;
  private connectingIpcClient: net.Socket | null = null;
  private ipcReconnectTimeout: NodeJS.Timeout | null = null;
  private threadStates = new Map<string, any>();
  private currentPermissions: any = null;
  private lastAgentMessageTexts = new Map<string, string>();
  private lastCommandOutputs = new Map<string, string>();
  private pendingRequestNotifications = new Map<string, NodeJS.Timeout>();
  private processedRequests = new Set<string>();

  constructor(private options: { socketPath?: string } = {}) {}

  private queueApprovalRequest(requestVal: any, threadId: string) {
    if (!requestVal || !requestVal.id || !requestVal.method) return;
    if (requestVal.status === 'completed' || requestVal.decision !== undefined) return;
    const state = this.threadStates.get(threadId);
    if (state && Array.isArray(state.turns) && state.turns.length > 0) {
      const lastTurn = state.turns[state.turns.length - 1];
      const reviewer = lastTurn?.params?.approvalsReviewer;
      if (reviewer && reviewer !== 'user') {
        console.log(`[Adapter] approvalsReviewer is "${reviewer}" (not "user"), skipping Feishu card for request ${requestVal.id}.`);
        return;
      }
    }
    
    if (this.pendingRequestNotifications.has(requestVal.id)) return;
    if (this.processedRequests.has(requestVal.id)) return;

    const timeout = setTimeout(() => {
      this.pendingRequestNotifications.delete(requestVal.id);
      this.processedRequests.add(requestVal.id);
      this.emitNotification({
        id: requestVal.id,
        method: requestVal.method,
        params: {
          ...requestVal.params,
          threadId: threadId
        },
        isIpc: true
      });
    }, 1500);
    
    this.pendingRequestNotifications.set(requestVal.id, timeout);
  }

  private cancelPendingApprovalRequest(requestId: string) {
    if (!requestId) return;
    const timeout = this.pendingRequestNotifications.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingRequestNotifications.delete(requestId);
      this.processedRequests.add(requestId);
    }
  }

  async connect(): Promise<void> {
    this.cleanupCalled = false;
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

    let spawnErrorPromise: Promise<never> | null = null;

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
      let codexBin = process.env.CODEX_BIN || 'codex';
      if (codexBin === 'codex' && process.env.NODE_ENV !== 'test') {
        const commonPaths = [
          '/Applications/Codex.app/Contents/Resources/codex',
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
          path.join(os.homedir(), '.local', 'bin', 'codex')
        ];
        for (const p of commonPaths) {
          if (fs.existsSync(p)) {
            codexBin = p;
            break;
          }
        }
      }

      console.log(`Socket not found or dead at ${socketPath}. Launching standalone App Server via "${codexBin}"...`);
      this.childProcess = spawn(codexBin, ['app-server', '--listen', 'stdio://']);

      let onSpawnError: ((err: any) => void) | null = null;
      spawnErrorPromise = new Promise<never>((_, reject) => {
        onSpawnError = (err) => reject(err);
      });

      this.childProcess.on('error', (err: any) => {
        if (onSpawnError) {
          onSpawnError(err);
        }
        if (err.code === 'ENOENT') {
          console.error(`\n❌ [Error] 无法启动 Codex 命令行程序 (spawn "${codexBin}" ENOENT)。`);
          console.error(`- 请确保已全局安装 Codex 命令行程序并在 shell 中可执行。`);
          console.error(`- 如果 codex 已安装但没有在 PATH 中，可通过配置环境变量 CODEX_BIN 指定其路径，例如：`);
          console.error(`  export CODEX_BIN=/path/to/codex\n`);
        } else {
          console.error('Failed to start codex subprocess:', err);
        }
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
      const initPromise = this.request('initialize', {
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

      if (spawnErrorPromise) {
        await Promise.race([initPromise, spawnErrorPromise]);
      } else {
        await initPromise;
      }
      console.log('Codex App Server initialized.');
      this.startIpcConnectionLoop();
    } catch (e: any) {
      console.error('Failed to initialize Codex App Server:', e);
      this.cleanup();
      throw e;
    }
  }

  private startIpcConnectionLoop() {
    if (this.cleanupCalled) return;
    
    this.getIpcClient().then((client) => {
      if (!client && !this.cleanupCalled) {
        if (this.ipcReconnectTimeout) clearTimeout(this.ipcReconnectTimeout);
        this.ipcReconnectTimeout = setTimeout(() => this.startIpcConnectionLoop(), 5000);
      }
    }).catch((err: any) => {
      logToFile(`[IPC] Loop error: ${err?.message || err}`);
      if (!this.cleanupCalled) {
        if (this.ipcReconnectTimeout) clearTimeout(this.ipcReconnectTimeout);
        this.ipcReconnectTimeout = setTimeout(() => this.startIpcConnectionLoop(), 5000);
      }
    });
  }

  disconnect(): void {
    this.cleanup();
    this.exitHandlers = [];
    this.notificationHandlers = [];
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
    if (this.cleanupCalled) return;
    this.cleanupCalled = true;
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
    if (this.connectingIpcClient) {
      try {
        this.connectingIpcClient.destroy();
      } catch (e) {}
      this.connectingIpcClient = null;
    }
    this.ipcClientId = null;
    for (const [reqId, pending] of this.pendingIpcRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingIpcRequests.clear();
    this.ipcConnectionPromise = null;
    if (this.ipcReconnectTimeout) {
      clearTimeout(this.ipcReconnectTimeout);
      this.ipcReconnectTimeout = null;
    }

    // Trigger and clear exit handlers
    const handlers = this.exitHandlers;
    this.exitHandlers = [];
    handlers.forEach(h => {
      try { h(); } catch (e) { console.error('Error in exit handler:', e); }
    });
  }

  cleanupThreadState(threadId: string): void {
    this.threadStates.delete(threadId);
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
      this.connectingIpcClient = client;
      let chunks: Buffer[] = [];
      let chunksLen = 0;
      let expectedLen: number | null = null;

      let isResolved = false;
      const connectionTimeout = setTimeout(() => {
        if (isResolved) return;
        isResolved = true;
        this.connectingIpcClient = null;
        logToFile('[IPC] Connection to Desktop IPC socket timed out.');
        client.destroy();
        this.ipcConnectionPromise = null;
        resolve(null);
      }, 5000);

      const writeMessage = (obj: any) => this.writeIpcMessage(client, obj);

      client.on('connect', () => {
        if (isResolved) return;
        clearTimeout(connectionTimeout);
        logToFile('[IPC] Connected to Desktop IPC socket. Sending initialize...');
        writeMessage({
          type: 'request',
          requestId: crypto.randomUUID(),
          method: 'initialize',
          params: { clientType: 'vscode' }
        });
      });

      let dataCount = 0;
      client.on('data', (data) => {
        dataCount++;
        chunks.push(data);
        chunksLen += data.length;

        while (true) {
          if (expectedLen === null) {
            if (chunksLen < 4) break;
            const tempBuf = Buffer.concat(chunks, chunksLen);
            if (IS_LITTLE_ENDIAN) {
              expectedLen = tempBuf.readUInt32LE(0);
            } else {
              expectedLen = tempBuf.readUInt32BE(0);
            }
            const remaining = tempBuf.subarray(4);
            chunks = remaining.length > 0 ? [remaining] : [];
            chunksLen = remaining.length;
          }

          if (chunksLen < expectedLen) {
            break;
          }

          const tempBuf = Buffer.concat(chunks, chunksLen);
          const msgBytes = tempBuf.subarray(0, expectedLen);
          const remaining = tempBuf.subarray(expectedLen);
          chunks = remaining.length > 0 ? [remaining] : [];
          chunksLen = remaining.length;
          expectedLen = null;
          
          const msgStr = msgBytes.toString('utf8');
          try {
            const msg = JSON.parse(msgStr);
            if (msg.method !== 'thread-stream-state-changed') {
              logToFile(`[IPC Received]: ${msgStr}`);
            }
            
            if (msg.type === 'response' && msg.method === 'initialize') {
              if (isResolved) {
                client.destroy();
                return;
              }
              if (msg.resultType === 'success' && msg.result?.clientId) {
                isResolved = true;
                this.connectingIpcClient = null;
                this.ipcClientId = msg.result.clientId;
                this.ipcClient = client;
                this.ipcConnectionPromise = null;
                logToFile(`[IPC] Initialized successfully. clientId: ${this.ipcClientId}`);
                resolve(client);
              } else {
                isResolved = true;
                this.connectingIpcClient = null;
                logToFile(`[IPC] Initialize failed: ${JSON.stringify(msg)}`);
                this.ipcConnectionPromise = null;
                resolve(null);
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
        if (!isResolved) {
          isResolved = true;
          this.connectingIpcClient = null;
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
        this.ipcConnectionPromise = null;
        if (!isResolved) {
          isResolved = true;
          this.connectingIpcClient = null;
          resolve(null);
        }

        // Trigger reconnection loop
        if (!this.cleanupCalled) {
          if (this.ipcReconnectTimeout) clearTimeout(this.ipcReconnectTimeout);
          this.ipcReconnectTimeout = setTimeout(() => this.startIpcConnectionLoop(), 5000);
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
          const turnId = turn.turnId || turn.id;
          if (turn.status === 'inProgress') {
            // Emitting turn/started so the bridge recreates the Feishu card
            this.emitNotification({
              method: 'turn/started',
              params: { threadId, turnId, turn }
            });
            if (Array.isArray(turn.items)) {
              turn.items.forEach((item: any, itemIdx: number) => {
                if (item) {
                  if (item.type === 'agentMessage' && typeof item.text === 'string') {
                    const textKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastAgentMessageTexts.set(textKey, item.text);
                    this.emitNotification({
                      method: 'item/started',
                      params: { threadId, turnId, item: { type: 'agentMessage', text: item.text, phase: item.phase } }
                    });
                  } else if (item.type === 'reasoning') {
                    const rawReasoningText = this.extractReasoningText(item);
                    const textKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastAgentMessageTexts.set(textKey, rawReasoningText);
                    const timeStr = get24HourTimeStr();
                    const reasoningText = rawReasoningText.replace(/\n\[STEP_BOUNDARY\]\n/g, `\n\n---\n⏱️ *[${timeStr}] 阶段*\n`);
                    this.emitNotification({
                      method: 'item/started',
                      params: { threadId, turnId, item: { type: 'reasoning', text: reasoningText } }
                    });
                  } else if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
                    const outputKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastCommandOutputs.set(outputKey, item.aggregatedOutput);
                    this.emitNotification({
                      method: 'agent/stderr',
                      params: { threadId, turnId, chunk: item.aggregatedOutput }
                    });
                  }
                }
              });
            }
          } else {
            // Just populate tracking variables for completed turns
            if (turn && Array.isArray(turn.items)) {
              turn.items.forEach((item: any, itemIdx: number) => {
                if (item) {
                  if (item.type === 'agentMessage' && typeof item.text === 'string') {
                    const textKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastAgentMessageTexts.set(textKey, item.text);
                  } else if (item.type === 'reasoning') {
                    const textKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastAgentMessageTexts.set(textKey, this.extractReasoningText(item));
                  } else if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
                    const outputKey = `${threadId}-${turnId}-${itemIdx}`;
                    this.lastCommandOutputs.set(outputKey, item.aggregatedOutput);
                  }
                }
              });
            }
          }
        });
      }
      if (Array.isArray(conversationState.requests)) {
        conversationState.requests.forEach((requestVal: any) => {
          this.queueApprovalRequest(requestVal, threadId);
        });
      }
    } else if (change.type === 'patches' && Array.isArray(change.patches)) {
      for (const patch of change.patches) {
        if (!patch || !Array.isArray(patch.path)) continue;
        
        const path = patch.path;
        let beforeTurn = null;
        let turnIndex = -1;
        if (path[0] === 'turns' && typeof path[1] === 'number') {
          turnIndex = path[1];
          beforeTurn = state.turns[turnIndex] ? { ...state.turns[turnIndex] } : null;
        }

        this.applyJsonPatch(state, patch);

        // Process global requests
        if (Array.isArray(state.requests)) {
          state.requests.forEach((req: any) => {
             if (req && (req.status === 'completed' || req.decision !== undefined)) {
                this.cancelPendingApprovalRequest(req.id);
             } else {
                this.queueApprovalRequest(req, threadId);
             }
          });
        }
        
        if (turnIndex !== -1) {
          const afterTurn = state.turns[turnIndex];
          if (!afterTurn) continue;

          // Process turn-specific requests
          if (Array.isArray(afterTurn.requests)) {
             afterTurn.requests.forEach((req: any) => {
                if (req && (req.status === 'completed' || req.decision !== undefined)) {
                   this.cancelPendingApprovalRequest(req.id);
                } else {
                   this.queueApprovalRequest(req, threadId);
                }
             });
          }

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
                  if (key.startsWith(`${threadId}-${turnId}-`)) {
                    this.lastAgentMessageTexts.delete(key);
                  }
                }
                for (const key of this.lastCommandOutputs.keys()) {
                  if (key.startsWith(`${threadId}-${turnId}-`)) {
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

          if (path[2] === 'items' && typeof path[3] === 'number') {
            const itemIndex = path[3];
            const item = afterTurn.items[itemIndex];
            if (item) {
              if (item.type === 'agentMessage' && typeof item.text === 'string') {
                const textKey = `${threadId}-${turnId}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = item.text || '';
                
                if (oldText === '' && newText.length > 0) {
                  this.emitNotification({
                    method: 'item/started',
                    params: { threadId, turnId, item: { type: 'agentMessage', text: '', phase: item.phase } }
                  });
                }
                
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
                const textKey = `${threadId}-${turnId}-${itemIndex}`;
                const oldText = this.lastAgentMessageTexts.get(textKey) || '';
                const newText = this.extractReasoningText(item) || '';
                
                if (oldText === '' && newText.length > 0) {
                  this.emitNotification({
                    method: 'item/started',
                    params: { threadId, turnId, item: { type: 'reasoning', text: '' } }
                  });
                }
                
                if (newText.length > oldText.length) {
                  this.lastAgentMessageTexts.set(textKey, newText);
                  
                  const formatReasoning = (text: string) => {
                    const timeStr = get24HourTimeStr();
                    return text.replace(/\n\[STEP_BOUNDARY\]\n/g, `\n\n---\n⏱️ *[${timeStr}] 阶段*\n`);
                  };
                  
                  const oldFormatted = formatReasoning(oldText);
                  const newFormatted = formatReasoning(newText);
                  const delta = newFormatted.slice(oldFormatted.length);
                  
                  this.emitNotification({
                    method: 'item/reasoning/delta',
                    params: { threadId, turnId, delta }
                  });
                }
              } else if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
                const outputKey = `${threadId}-${turnId}-${itemIndex}`;
                const oldOutput = this.lastCommandOutputs.get(outputKey) || '';
                const newOutput = item.aggregatedOutput || '';
                if (newOutput.length > oldOutput.length) {
                  const delta = newOutput.slice(oldOutput.length);
                  this.lastCommandOutputs.set(outputKey, newOutput);
                  this.emitNotification({
                    method: 'agent/stderr',
                    params: { threadId, turnId, chunk: delta }
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
      if (!curr || typeof curr !== 'object') return;
      if (curr[key] === undefined) {
        const nextKey = path[i + 1];
        curr[key] = (typeof nextKey === 'number' || nextKey === '-') ? [] : {};
      }
      curr = curr[key];
    }
    
    if (!curr || typeof curr !== 'object') return;
    const lastKey = path[path.length - 1];
    if (patch.op === 'add') {
      if (Array.isArray(curr)) {
        if (lastKey === '-') {
          curr.push(patch.value);
        } else if (typeof lastKey === 'number') {
          curr.splice(lastKey, 0, patch.value);
        } else {
          curr[lastKey as any] = patch.value;
        }
      } else {
        curr[lastKey as any] = patch.value;
      }
    } else if (patch.op === 'replace') {
      curr[lastKey as any] = patch.value;
    } else if (patch.op === 'remove') {
      if (Array.isArray(curr) && typeof lastKey === 'number') {
        curr.splice(lastKey, 1);
      } else {
        delete curr[lastKey as any];
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
        resolve: (turnId: string | null) => {
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
  private extractSlateText(nodes: any[]): string {
    if (!Array.isArray(nodes)) return '';
    return nodes.map(node => {
      if (!node) return '';
      if (typeof node === 'string') return node;
      if (typeof node.text === 'string') return node.text;
      if (Array.isArray(node.children)) return this.extractSlateText(node.children);
      return '';
    }).join('');
  }

  private extractReasoningText(item: any): string {
    if (typeof item.text === 'string') return item.text;
    const parts: string[] = [];
    if (Array.isArray(item.summary)) {
      parts.push(...item.summary.map((s: any) => this.extractSlateText([s])));
    }
    if (Array.isArray(item.content)) {
      parts.push(...item.content.map((c: any) => this.extractSlateText([c])));
    }
    return parts.filter(p => p.trim().length > 0).join('\n[STEP_BOUNDARY]\n');
  }
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let clean = text;
  
  // 1. Patterns that need a prefix captured and kept (i.e. replacement is $1[REDACTED])
  const prefixPatterns = [
    /(authorization:\s*bearer\s+)[^\s'"]+/gi,
    /(token=)[^&\s]+/gi,
    /(api[_-]?key=)[^&\s]+/gi,
    /(secret=)[^&\s]+/gi,
    /(password=)[^&\s]+/gi,
    /(passwd=)[^&\s]+/gi,
    /(openai[_-]?api[_-]?key=)[^&\s]+/gi,
    /(\b(?:openai[_-]?)?api[_-]?key\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
    /(\bpassword\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
  ];
  for (const pattern of prefixPatterns) {
    clean = clean.replace(pattern, "$1[REDACTED]");
  }

  // 2. Patterns to replace entirely with [REDACTED]
  const fullPatterns = [
    /sk-[a-zA-Z0-9_-]{20,}/gi,
  ];
  for (const pattern of fullPatterns) {
    clean = clean.replace(pattern, "[REDACTED]");
  }
  return clean;
}

export function logToFile(msg: string) {
  try {
    const logPath = path.join(os.homedir(), '.codex', 'bridge_debug.log');
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    
    // Ensure parent directory exists with restrictive permissions (0o700)
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_SIZE) {
        fs.renameSync(logPath, logPath + '.old');
      }
    } catch (_) {}
    
    const redacted = redactSecrets(msg);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${redacted}\n`, { mode: 0o600 });
    
    // Explicitly enforce restrictive permission
    try {
      fs.chmodSync(logPath, 0o600);
    } catch (_) {}
  } catch (e) {}
}
