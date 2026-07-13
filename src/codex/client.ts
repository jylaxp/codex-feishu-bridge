/**
 * Codex App Server Client — connects to the daemon-managed app-server
 * via WebSocket over Unix domain socket.
 *
 * Architecture:
 *   Bridge ←→ daemon control socket (JSON-RPC 2.0 / WebSocket)
 *
 * The daemon is started via `codex app-server daemon start` on first connect.
 * All RPC requests and event notifications flow through this single connection.
 */
import * as net from 'net';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import WebSocket from 'ws';
import { platform } from '../core/platform';

export interface CodexClientOptions {
  /** Override the control socket path */
  socketPath?: string;
  /** Override the codex binary path */
  codexBin?: string;
}

export class CodexClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (err: any) => void;
    timer: NodeJS.Timeout;
  }>();
  private notificationHandlers: Array<(msg: any) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private socketPath: string;
  private codexBin: string;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: CodexClientOptions = {}) {
    this.socketPath = options.socketPath || platform.getDefaultSocketPath();
    this.codexBin = options.codexBin || process.env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex';
  }

  /** Ensure the daemon is running, then connect to its control socket. */
  async connect(): Promise<void> {
    // 1. Ensure daemon is running
    await this.ensureDaemon();

    // 2. Connect to the control socket via WebSocket
    await this.connectSocket();
  }

  private async ensureDaemon(): Promise<void> {
    // Check if socket already exists and is alive
    if (fs.existsSync(this.socketPath)) {
      const alive = await this.probeSocket();
      if (alive) return;
      // Dead socket — clean up
      try { fs.unlinkSync(this.socketPath); } catch {}
    }

    // Start the daemon
    console.log(`Starting app-server daemon via ${this.codexBin}...`);
    const result = spawnSync(this.codexBin, ['app-server', 'daemon', 'start'], {
      encoding: 'utf8',
      timeout: 15000,
    });

    if (result.error) {
      throw new Error(`Failed to start daemon: ${result.error.message}`);
    }

    // Wait for the socket to appear (up to 5 seconds)
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(this.socketPath)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (!fs.existsSync(this.socketPath)) {
      throw new Error(`Daemon started but socket missing: ${this.socketPath}`);
    }
    console.log(`Daemon ready, socket: ${this.socketPath}`);
  }

  private probeSocket(): Promise<boolean> {
    return new Promise(resolve => {
      const sock = net.createConnection(this.socketPath);
      sock.on('connect', () => { sock.end(); resolve(true); });
      sock.on('error', () => resolve(false));
    });
  }

  private async connectSocket(): Promise<void> {
    console.log(`Connecting to daemon socket: ${this.socketPath}`);
    this.ws = new WebSocket('ws://codex-app-server/', {
      perMessageDeflate: false,
      createConnection: () => net.createConnection(this.socketPath),
    });

    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => resolve());
      this.ws!.on('error', (err) => reject(err));
    });

    this.ws.on('message', (data) => {
      const line = data.toString().trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          // RPC response
          const p = this.pending.get(msg.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            msg.error ? p.reject(msg.error) : p.resolve(msg.result);
          }
        } else {
          // Notification
          for (const h of this.notificationHandlers) {
            try { h(msg); } catch (e) { console.error('Notification handler error:', e); }
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`WebSocket closed: ${code} ${reason}`);
      this.rejectAllPending(new Error('Connection closed'));
      for (const h of this.closeHandlers) {
        try { h(); } catch {}
      }
      // Auto-reconnect after 2 seconds
      this.scheduleReconnect();
    });

    // Send initialize
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'feishu-bridge',
        title: 'Feishu Bot Bridge',
        version: '2.0.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    console.log(`App-server initialized: ${result.userAgent}`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log('Reconnected to app-server');
      } catch (e) {
        console.error('Reconnect failed:', e);
        this.scheduleReconnect();
      }
    }, 2000);
  }

  /** Send a JSON-RPC request and return the result. */
  request(method: string, params: any = {}, timeoutMs = 30000): Promise<any> {
    if (!this.ws) throw new Error('Not connected');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.ws.send(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** Send a JSON-RPC response (for server→client requests like approvals). */
  respond(id: number | string, result: any): void {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  /** Register a notification handler. */
  onNotification(handler: (msg: any) => void): void {
    this.notificationHandlers.push(handler);
  }

  /** Register a close handler. */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** Connect to a WebSocket URL (ws://host:port). */
  async connectToUrl(url: string): Promise<void> {
    console.log(`Connecting to ${url}...`);
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      this.ws!.on('open', () => resolve());
      this.ws!.on('error', (err) => reject(err));
    });

    this.ws.on('message', (data) => {
      const line = data.toString().trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
        } else {
          for (const h of this.notificationHandlers) { try { h(msg); } catch (e) { console.error('Notification handler error:', e); } }
        }
      } catch {}
    });

    this.ws.on('error', (err) => console.error('WebSocket error:', err.message));
    this.ws.on('close', (code, reason) => {
      console.log(`WebSocket closed: ${code} ${reason}`);
      this.rejectAllPending(new Error('Connection closed'));
      for (const h of this.closeHandlers) { try { h(); } catch {} }
      this.scheduleReconnect();
    });

    // Send initialize
    const result = await this.request('initialize', {
      clientInfo: { name: 'feishu-bridge', title: 'Feishu Bot Bridge', version: '2.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
    });
    console.log(`App-server initialized: ${result.userAgent}`);
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('Disconnected'));
    this.notificationHandlers = [];
    this.closeHandlers = [];
    try { this.ws?.close(); } catch {}
    this.ws = undefined;
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ── Convenience methods ──

  /** List non-archived threads. */
  async listThreads(limit = 50): Promise<Array<{ id: string; name: string; preview: string; cwd: string }>> {
    const result = await this.request('thread/list', { limit, archived: false });
    if (!result?.data || !Array.isArray(result.data)) return [];
    return result.data
      .filter((t: any) => !t.archived && !t.deleted && !t.isDeleted && !t.is_deleted)
      .map((t: any) => ({
        id: t.id,
        name: t.name || t.preview || '未命名会话',
        preview: t.preview || '',
        cwd: t.cwd || t.workspacePath || '',
      }));
  }

  /** Start a turn on a thread and return the turn ID. */
  async startTurn(options: {
    threadId: string;
    cwd: string;
    prompt: string;
    input?: any[];
    collaborationMode?: string | null;
    model?: string | null;
    personality?: string | null;
  }): Promise<string> {
    // Pre-load the thread to subscribe to events
    try {
      await this.request('thread/resume', { threadId: options.threadId });
    } catch (e) {
      console.warn(`Pre-load thread ${options.threadId} failed:`, e);
    }

    const result = await this.request('turn/start', {
      threadId: options.threadId,
      cwd: options.cwd,
      collaborationMode: options.collaborationMode || null,
      personality: options.personality || null,
      input: options.input || [{ type: 'text', text: options.prompt, text_elements: [] }],
    });

    if (!result?.turn?.id) throw new Error(`Invalid turn/start response: ${JSON.stringify(result)}`);
    return result.turn.id;
  }

  /** Patch SQLite to make a thread visible in the desktop sidebar. */
  async patchThreadVisibility(threadId: string): Promise<void> {
    const { execSync } = require('child_process');
    const path = require('path');
    const fs = require('fs');
    const dbPath = path.join(process.env.HOME || '', '.codex', 'state_5.sqlite');
    const devDbPath = path.join(process.env.HOME || '', '.codex', 'sqlite', 'codex-dev.db');

    for (let i = 0; i < 5; i++) {
      try {
        const count = execSync(`sqlite3 "${dbPath}" "SELECT count(*) FROM threads WHERE id = '${threadId}';"`).toString().trim();
        if (count === '1') {
          execSync(`sqlite3 "${dbPath}" "UPDATE threads SET preview = 'New Session (via Feishu)' WHERE id = '${threadId}' AND preview = '';"`);
          execSync(`sqlite3 "${dbPath}" "UPDATE threads SET has_user_event = 1 WHERE id = '${threadId}';"`);
          if (fs.existsSync(devDbPath)) {
            const cwd = execSync(`sqlite3 "${dbPath}" "SELECT cwd FROM threads WHERE id = '${threadId}';"`).toString().trim();
            const now = Math.floor(Date.now() / 1000);
            let nextSeq = 100;
            try {
              const maxSeq = execSync(`sqlite3 "${devDbPath}" "SELECT COALESCE(MAX(observation_sequence), 0) FROM local_thread_catalog;"`).toString().trim();
              const parsed = parseInt(maxSeq, 10);
              if (!isNaN(parsed)) nextSeq = parsed + 1;
            } catch {}
            execSync(`sqlite3 "${devDbPath}" "INSERT OR IGNORE INTO local_thread_catalog (host_id, thread_id, display_title, source_created_at, source_updated_at, cwd, source_kind, source_detail, model_provider, git_branch, observation_sequence, missing_candidate) VALUES ('local', '${threadId}', 'New Session (via Feishu)', ${now}, ${now}, '${cwd.replace(/'/g, "''")}', 'vscode', '', 'openai', '', ${nextSeq}, 0);"`);
          }
          console.log(`Patched visibility for thread ${threadId}`);
          return;
        }
      } catch { /* SQLite busy — retry */ }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
