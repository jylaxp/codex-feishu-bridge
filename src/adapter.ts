import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import WebSocket from 'ws';
import * as crypto from 'crypto';

export interface CodexThread {
  id: string;
  name: string;
  preview: string;
  cwd?: string;
}

export interface CodexThreadAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  request(method: string, params: Record<string, unknown>): Promise<any>;
  onNotification(handler: (message: any) => void): void;
  onExit(handler: () => void): void;
  listThreads(limit?: number): Promise<CodexThread[]>;
  startRemoteControlTurn(options: {
    threadId: string;
    cwd: string;
    prompt: string;
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

    // Trigger and clear exit handlers
    const handlers = this.exitHandlers;
    this.exitHandlers = [];
    handlers.forEach(h => {
      try { h(); } catch (e) { console.error('Error in exit handler:', e); }
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const reqObj = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      if (this.ws) {
        this.ws.send(JSON.stringify(reqObj));
      } else if (this.childProcess && this.childProcess.stdin) {
        this.childProcess.stdin.write(JSON.stringify(reqObj) + '\n');
      } else {
        this.pendingRequests.delete(id);
        reject(new Error("Transport disconnected"));
      }
    });
  }

  onNotification(handler: (message: any) => void): void {
    this.notificationHandlers.push(handler);
  }

  async listThreads(limit: number = 50): Promise<CodexThread[]> {
    const result = await this.request('thread/list', { limit, archived: false });
    if (!result || !Array.isArray(result.data)) {
      return [];
    }
    return result.data.map((t: any) => ({
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

  private async tryDesktopIpcStartTurn(options: { threadId: string; cwd: string; prompt: string }): Promise<string | null> {
    if (process.env.NODE_ENV === 'test') {
      console.log('Skipping Desktop IPC start turn in test environment.');
      return null;
    }
    const tmpDir = os.tmpdir();
    const codexIpcDir = path.join(tmpDir, 'codex-ipc');
    let socketPath = '';
    
    if (fs.existsSync(codexIpcDir)) {
      const files = fs.readdirSync(codexIpcDir);
      const sockFile = files.find(f => (f.startsWith('ipc-') && f.endsWith('.sock')) || f === 'ipc.sock');
      if (sockFile) {
        socketPath = path.join(codexIpcDir, sockFile);
      }
    }
    
    if (!socketPath) {
      console.log('No desktop IPC socket found.');
      return null;
    }

    console.log(`Attempting connection to Desktop IPC socket: ${socketPath}`);
    
    return new Promise<string | null>((resolve) => {
      const client = net.createConnection(socketPath);
      let rxBuffer = Buffer.alloc(0);
      let expectedLen: number | null = null;
      let clientId: string | null = null;
      let turnId: string | null = null;
      
      // Helper to write length-prefixed message
      function writeMessage(obj: any) {
        const jsonStr = JSON.stringify(obj);
        const msgBuffer = Buffer.from(jsonStr, 'utf8');
        const lenBuffer = Buffer.alloc(4);
        
        if (os.endianness() === 'LE') {
          lenBuffer.writeUInt32LE(msgBuffer.length, 0);
        } else {
          lenBuffer.writeUInt32BE(msgBuffer.length, 0);
        }
        
        client.write(Buffer.concat([lenBuffer, msgBuffer]));
      }
      
      const timeout = setTimeout(() => {
        console.log('[IPC] Desktop IPC request timed out (30s).');
        client.destroy();
        resolve(null);
      }, 30000);

      client.on('connect', () => {
        console.log('[IPC] Connected to Desktop IPC socket.');
        const req = {
          type: 'request',
          requestId: crypto.randomUUID(),
          method: 'initialize',
          params: {
            clientType: 'vscode'
          }
        };
        writeMessage(req);
      });

      client.on('data', (data) => {
        rxBuffer = Buffer.concat([rxBuffer, data]);
        
        while (true) {
          if (expectedLen === null) {
            if (rxBuffer.length < 4) {
              break;
            }
            if (os.endianness() === 'LE') {
              expectedLen = rxBuffer.readUInt32LE(0);
            } else {
              expectedLen = rxBuffer.readUInt32BE(0);
            }
            rxBuffer = rxBuffer.subarray(4);
          }
          
          if (rxBuffer.length < expectedLen) {
            break;
          }
          
          const msgBytes = rxBuffer.subarray(0, expectedLen);
          rxBuffer = rxBuffer.subarray(expectedLen);
          expectedLen = null;
          
          const msgStr = msgBytes.toString('utf8');
          try {
            const msg = JSON.parse(msgStr);
            if (msg.type === 'response' && msg.method === 'initialize') {
              if (msg.resultType === 'success' && msg.result?.clientId) {
                clientId = msg.result.clientId;
                console.log(`[IPC] Initialized successfully. clientId: ${clientId}`);
                
                const turnParams = {
                  threadId: options.threadId,
                  clientUserMessageId: 'bridge-' + crypto.randomUUID(),
                  input: [{ type: 'text', text: options.prompt, text_elements: [] }],
                  cwd: options.cwd,
                  sandboxPolicy: {
                    type: 'workspaceWrite',
                    writableRoots: [],
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
                  personality: null,
                  responsesapiClientMetadata: { workspace_kind: 'project' },
                  attachments: [],
                  commentAttachments: []
                };

                console.log(`[IPC] Sending thread-follower-start-turn for thread: ${options.threadId}`);
                writeMessage({
                  type: 'request',
                  requestId: crypto.randomUUID(),
                  sourceClientId: clientId,
                  version: 1,
                  method: 'thread-follower-start-turn',
                  params: {
                    conversationId: options.threadId,
                    turnStartParams: turnParams
                  },
                  timeoutMs: 30000
                });
              } else {
                console.warn('[IPC] Initialize IPC failed:', msg.error || 'unknown error');
                client.destroy();
                resolve(null);
              }
            } else if (msg.type === 'response' && msg.method === 'thread-follower-start-turn') {
              if (msg.resultType === 'success' && msg.result?.turnId) {
                turnId = msg.result.turnId;
                console.log(`[IPC] Start turn successfully finished. turnId: ${turnId}`);
                client.destroy();
                clearTimeout(timeout);
                resolve(turnId);
              } else {
                console.warn('[IPC] thread-follower-start-turn failed:', msg.error || 'unknown error');
                client.destroy();
                resolve(null);
              }
            }
          } catch (e) {
            console.error('[IPC] Failed to parse IPC message:', e);
          }
        }
      });

      client.on('error', (err) => {
        console.warn('[IPC] Desktop IPC connection error:', err.message);
        clearTimeout(timeout);
        resolve(null);
      });

      client.on('close', () => {
        console.log('[IPC] Connection to Desktop IPC socket closed.');
        clearTimeout(timeout);
        resolve(turnId);
      });
    });
  }

  async startRemoteControlTurn(options: { threadId: string; cwd: string; prompt: string }): Promise<string> {
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
    // Proactively resume/load the thread first to prevent "thread not found" error
    try {
      console.log(`Pre-loading thread ${options.threadId} via thread/resume...`);
      await this.request('thread/resume', { threadId: options.threadId });
    } catch (e) {
      console.warn(`Failed to preload thread ${options.threadId} via thread/resume:`, e);
    }

    const result = await this.request('turn/start', {
      threadId: options.threadId,
      cwd: options.cwd,
      collaborationMode: null,
      input: [{ type: "text", text: options.prompt, text_elements: [] }]
    });
    if (!result || !result.turn || !result.turn.id) {
      throw new Error(`Invalid turn/start response: ${JSON.stringify(result)}`);
    }
    return result.turn.id;
  }
}
