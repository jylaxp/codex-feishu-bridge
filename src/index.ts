import * as Lark from '@larksuiteoapi/node-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import * as crypto from 'crypto';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import { LocalAppServerAdapter, CodexThread, redactSecrets, get24HourTimeStr, formatDateTime24h } from './adapter';

// Ensure the config directory and .env file exist before loading
const configDir = path.join(os.homedir(), '.codex-feishu-bridge');
const envPath = path.join(configDir, '.env');

if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}
if (!fs.existsSync(path.join(configDir, 'logs'))) {
  fs.mkdirSync(path.join(configDir, 'logs'), { recursive: true });
}
if (!fs.existsSync(envPath)) {
  const defaultEnv = `LARK_APP_ID=YOUR_FEISHU_APP_ID
LARK_APP_SECRET=YOUR_FEISHU_APP_SECRET
ALLOWED_APPROVERS=

# Rate limits querying interval in milliseconds (default: 300000 ms / 5 minutes)
RATE_LIMIT_QUERY_INTERVAL_MS=300000

# Path to the Codex CLI binary on macOS (using Desktop App bundled resources version)
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex

# Switch to output logs to a file instead of stdout (true/false)
LOG_TO_FILE=false
LOG_FILE_PATH=bridge.log
`;
  fs.writeFileSync(envPath, defaultEnv, 'utf8');
  console.log(`Created default .env config file at: ${envPath}`);
}

// Load environmental variables from ~/.codex-feishu-bridge/.env
dotenv.config({ path: envPath });

// Configure file logging if enabled or silence logs if disabled
function setupLogging() {
  const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
  const originalError = console.error;

  const defaultLogPath = path.join(os.homedir(), '.codex-feishu-bridge', 'logs', 'bridge.log');
  const logFilePath = process.env.LOG_FILE_PATH
    ? (path.isAbsolute(process.env.LOG_FILE_PATH) ? process.env.LOG_FILE_PATH : path.join(os.homedir(), '.codex-feishu-bridge', 'logs', process.env.LOG_FILE_PATH))
    : defaultLogPath;
  
  // Ensure the directory exists
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const formatMessage = (args: any[]) => {
    return args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      } else if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  };

  const writeLog = (level: string, args: any[]) => {
    const timeStr = new Date().toISOString();
    logStream.write(`[${timeStr}] [${level}] ${formatMessage(args)}\n`);
  };

  // 1. INFO/WARN logs are controlled by LOG_TO_FILE switch
  if (LOG_TO_FILE) {
    console.log = (...args: any[]) => writeLog('INFO', args);
    console.info = (...args: any[]) => writeLog('INFO', args);
    console.warn = (...args: any[]) => writeLog('WARN', args);
    // Write a status line to stdout once so the user knows logs are redirected
    process.stdout.write(`[Bridge] Logging to file enabled. Log file: ${logFilePath}\n`);
  } else {
    // Switch is closed: Silence log/info/warn to keep standard output clean.
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }

  // 2. ERROR logs are NOT controlled by the switch: always write to log file AND print to terminal
  console.error = (...args: any[]) => {
    writeLog('ERROR', args);
    originalError(...args);
  };
}


// Credentials will be loaded dynamically in ensureCredentials()

// Session database path
const SESSIONS_FILE = path.join(configDir, 'sessions.json');
const APPROVALS_FILE = path.join(configDir, 'approvals.json');
const PUSHED_TURNS_FILE = path.join(configDir, 'pushed_turns.json');
const APPROVAL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RATE_LIMIT_QUERY_INTERVAL_MS = parseInt(process.env.RATE_LIMIT_QUERY_INTERVAL_MS || '300000', 10);

interface SessionDb {
  [feishuChatId: string]: {
    threadId: string;
    threadName: string;
    cwd?: string;
    lastPushedTurnId?: string; // Add this field
    personality?: 'friendly' | 'pragmatic' | 'none';
    planMode?: boolean;
    activeSkill?: { name: string; path: string } | null;
    lastSkillsCardMessageId?: string | null;
  };
}

function loadPushedTurns(): Set<string> {
  if (fs.existsSync(PUSHED_TURNS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(PUSHED_TURNS_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        return new Set(arr);
      }
    } catch (e) {
      console.error('Failed to parse pushed_turns.json:', e);
    }
  }
  return new Set();
}

function writeJsonFileSyncAtomic(filepath: string, data: any) {
  const tmpPath = filepath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filepath);
}

function savePushedTurns(set: Set<string>) {
  try {
    let arr = Array.from(set);
    if (arr.length > 1000) {
      arr = arr.slice(arr.length - 1000);
      set.clear();
      arr.forEach(item => set.add(item));
    }
    writeJsonFileSyncAtomic(PUSHED_TURNS_FILE, arr);
  } catch (e) {
    console.error('Failed to save pushed_turns.json:', e);
  }
}

function loadSessions(): SessionDb {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse sessions.json:', e);
    }
  }
  return {};
}

function saveSessions(db: SessionDb) {
  try {
    writeJsonFileSyncAtomic(SESSIONS_FILE, db);
  } catch (e) {
    console.error('Failed to save sessions.json:', e);
  }
}

function loadApprovals(): Map<string, ActiveApproval> {
  const map = new Map<string, ActiveApproval>();
  if (fs.existsSync(APPROVALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
      const now = Date.now();
      let hasExpired = false;
      for (const [key, value] of Object.entries(data)) {
        const approval = value as ActiveApproval;
        const createdAt = approval.createdAt || now;
        if (now - createdAt > APPROVAL_TTL_MS) {
          hasExpired = true;
          continue;
        }
        map.set(key, approval);
      }
      if (hasExpired) {
        saveApprovals(map);
      }
    } catch (e) {
      console.error('Failed to parse approvals.json:', e);
    }
  }
  return map;
}

function saveApprovals(map: Map<string, ActiveApproval>) {
  try {
    const obj = Object.fromEntries(map.entries());
    writeJsonFileSyncAtomic(APPROVALS_FILE, obj);
  } catch (e) {
    console.error('Failed to save approvals.json:', e);
  }
}

function getAllowedCommands(): string[] {
  let allowedCommands = ['ls', 'pwd', 'git', 'find', 'cd'];
  if (process.env.ALLOWED_SHELL_COMMANDS) {
    allowedCommands = process.env.ALLOWED_SHELL_COMMANDS.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return allowedCommands;
}

function parseCommandArgs(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map(arg => {
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.substring(1, arg.length - 1);
    }
    return arg;
  });
}

async function executeUserCommand(chatId: string, command: string) {
  command = command.trim();
  if (!command) {
    await sendSimpleStatusCard(chatId, "⚠️ 缺少指令内容", "orange", "请提供要执行的命令行指令。\n例如：`/cmd ls -la` 或 `/run git status`。");
    return;
  }

  const parsedArgs = parseCommandArgs(command);
  if (parsedArgs.length === 0) {
    await sendSimpleStatusCard(chatId, "⚠️ 缺少指令内容", "orange", "请提供要执行的命令行指令。\n例如：`/cmd ls -la` 或 `/run git status`。");
    return;
  }

  const firstWord = parsedArgs[0].toLowerCase();
  
  // Command Whitelist Check
  const allowedCommands = getAllowedCommands();

  if (!allowedCommands.includes(firstWord)) {
    await sendSimpleStatusCard(chatId, "⚠️ 安全警示", "orange", `根据系统安全策略，本地命令 \`${firstWord}\` 不在执行白名单中。\n\n如需执行，请联系网桥管理员在 \`.env\` 配置文件中通过 \`ALLOWED_SHELL_COMMANDS\` 加上该命令名。`);
    return;
  }

  const bound = sessionDb[chatId];
  let execCwd = exploreCwds.get(chatId);
  if (!execCwd) {
    execCwd = bound?.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();
    exploreCwds.set(chatId, execCwd);
  }

  // Native cd implementation
  if (firstWord === 'cd') {
    const targetPath = command.substring(2).trim();
    let newCwd = "";
    if (!targetPath) {
      newCwd = os.homedir();
    } else {
      if (path.isAbsolute(targetPath)) {
        newCwd = path.normalize(targetPath);
      } else {
        newCwd = path.resolve(execCwd, targetPath);
      }
    }

    try {
      const stats = fs.statSync(newCwd);
      if (!stats.isDirectory()) {
        await sendSimpleStatusCard(chatId, "🚫 切换目录失败", "red", `路径不是一个目录：\n\`${newCwd}\``);
        return;
      }
    } catch (statErr: any) {
      if (statErr.code === 'ENOENT') {
        await sendSimpleStatusCard(chatId, "🚫 切换目录失败", "red", `路径不存在：\n\`${newCwd}\``);
        return;
      }
      const errMsg = statErr?.message || "";
      if (errMsg.includes("Operation not permitted") || errMsg.includes("EACCES")) {
        await sendSimpleStatusCard(chatId, "⚠️ 系统权限不足 (Operation not permitted)", "orange", `网桥程序无权访问该目录：\n\`${newCwd}\`\n\n**建议解决办法**：\n1. 将项目移出 \`Documents\` / \`Desktop\` 等系统受限文件夹，移至例如 \`~/work/\` 下。\n2. 或者前往 macOS \`系统设置 -> 隐私与安全性 -> 完全磁盘访问权限\`，为您的终端应用或 node 启用读取权限。`);
      } else {
        await sendSimpleStatusCard(chatId, "🚫 无法访问该目录", "red", `${statErr.message || statErr}`);
      }
      return;
    }

    exploreCwds.set(chatId, newCwd);

    let replyText = `📂 探查目录已切换为：\n\`${newCwd}\``;
    if (bound) {
      replyText += `\n\n*(注意：当前绑定的会话工作目录未受影响。若要正式应用并保存此目录，请发送 \`/cwd\`)*`;
    }

    await sendSimpleStatusCard(chatId, "📂 探查目录已切换", "indigo", replyText);
    return;
  }

  console.log(`Executing terminal command: "${command}" in cwd: "${execCwd}"`);

  try {
    const cmdArgs = parsedArgs.slice(1);
    execFile(parsedArgs[0], cmdArgs, { cwd: execCwd, timeout: 15000 }, async (error: any, stdout: string, stderr: string) => {
      let isPermissionError = false;
      const stdErrStr = stderr || "";
      const errStr = error?.message || "";
      
      if (stdErrStr.includes("Operation not permitted") || stdErrStr.includes("Permission denied") ||
          errStr.includes("Operation not permitted") || errStr.includes("Permission denied")) {
        isPermissionError = true;
      }

      let output = "";
      if (isPermissionError) {
        output = `⚠️ **本地系统权限不足 (Operation not permitted)**\n\n原因：macOS 默认限制了网桥程序访问 \`Documents\`、\`Desktop\` 等受保护的文件夹。\n\n**建议解决办法**：\n1. 将您的项目移动到主目录下的普通文件夹中（例如 \`~/work/\`）。\n2. 或者前往 macOS \`系统设置 -> 隐私与安全性 -> 完全磁盘访问权限\`，为您的终端应用或 node 开启磁盘访问授权。`;
      } else {
        if (stdout) {
          output += stdout;
        }
        if (stderr) {
          output += `\n[Stderr]:\n${stderr}`;
        }
        if (error) {
          output += `\n[Error exit code: ${error.code}]:\n${error.message}`;
        }
        
        if (!output.trim()) {
          output = "(命令执行成功，但无任何控制台输出)";
        }

        const maxChars = 3000;
        if (output.length > maxChars) {
          output = output.substring(0, maxChars) + "\n\n... (由于长度超限已截断) ...";
        }
      }

      await sendSimpleStatusCard(
        chatId, 
        isPermissionError ? "⚠️ 系统权限不足" : "💻 终端命令执行结果", 
        isPermissionError ? "orange" : "blue", 
        `**工作目录 (CWD)**: \`${execCwd}\`\n\n\`\`\`text\n${output}\n\`\`\``
      );
    });
  } catch (err: any) {
    console.error('Failed to execute command:', err);
    await sendSimpleStatusCard(chatId, "💻 执行命令失败", "red", `${err.message || err}`);
  }
}

// Active turn interface
interface TurnStats {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  contextLength?: number;
  apiCalls?: number;
}

interface ActiveTurn {
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
  activeStream?: 'reasoning' | 'answer';
  startedAt?: number;
  completedAt?: number;
  stats: TurnStats;
  sequence: number;
  isHistory?: boolean;
  skillName?: string;
  collaborationMode?: string | null;
  personality?: string | null;
  streamingClosed?: boolean;
  rateLimitStr?: string;
  lastFullUpdateAt?: number;
  lastSentValues?: Record<string, string>;
  commandExecutionCount?: number;
  hasLoggedFoldMessage?: boolean;
  pendingReasoningHeader?: string;
  lastRateLimitQueryAt?: number;
}

interface ActiveApproval {
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

// Global states
const sessionDb = loadSessions();
const activeTurns = new Map<string, ActiveTurn>(); // turnId -> ActiveTurn
const threadToActiveTurnId = new Map<string, string>(); // threadId -> turnId
const recentTurns = new Map<string, ActiveTurn>(); // turnId or threadId -> ActiveTurn (for late stats delivery)
const activeApprovals = loadApprovals();
const pushedTurns = loadPushedTurns();
const exploreCwds = new Map<string, string>();



// Periodically clean up expired approvals (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, value] of activeApprovals.entries()) {
    const createdAt = value.createdAt || now;
    if (now - createdAt > APPROVAL_TTL_MS) {
      activeApprovals.delete(key);
      changed = true;
    }
  }
  if (changed) {
    saveApprovals(activeApprovals);
  }
}, 10 * 60 * 1000);

// Serialization Queue for Card Updates
const turnQueues = new Map<string, Promise<any>>();
const turnTaskCounts = new Map<string, number>();

function queueTurnTask(turnId: string, task: () => Promise<any>): Promise<any> {
  const previous = turnQueues.get(turnId) || Promise.resolve();
  turnTaskCounts.set(turnId, (turnTaskCounts.get(turnId) || 0) + 1);

  const next = previous.then(() => task()).catch((err) => {
    console.error(`Error executing task in queue for turn ${turnId}:`, err);
  }).finally(() => {
    const count = (turnTaskCounts.get(turnId) || 0) - 1;
    if (count <= 0) {
      turnTaskCounts.delete(turnId);
      turnQueues.delete(turnId);
    } else {
      turnTaskCounts.set(turnId, count);
    }
  });
  turnQueues.set(turnId, next);
  return next;
}

// --- Feishu Token Cache ---
let cachedToken = "";
let tokenExpiresAt = 0;
let tokenFetchPromise: Promise<string> | null = null;

async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  if (tokenFetchPromise) {
    return tokenFetchPromise;
  }

  tokenFetchPromise = (async () => {
    try {
      const appId = process.env.LARK_APP_ID || process.env.APP_ID;
      const appSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET;
      console.log(`[DEBUG] getTenantAccessToken using APP_ID: ${appId}`);
      if (!appId || !appSecret) {
        throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET");
      }

      const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
      });
      const data: any = await res.json();
      if (data.code !== 0) {
        throw new Error(`Failed to get Feishu token: ${data.msg}`);
      }
      cachedToken = data.tenant_access_token;
      tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
      return cachedToken;
    } finally {
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

// --- CardKit 2.0 Core APIs ---
async function createCardKitCard(cardContent: any): Promise<string> {
  const token = await getTenantAccessToken();
  const res = await fetch("https://open.feishu.cn/open-apis/cardkit/v1/cards", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      type: "card_json",
      data: JSON.stringify(cardContent)
    })
  });
  const data: any = await res.json();
  console.log(`[DEBUG] createCardKitCard response: ${JSON.stringify(data)}`);
  if (data.code !== 0) {
    throw new Error(`Failed to create CardKit card: ${data.msg}`);
  }
  return data.data.card_id;
}

async function sendCardKitMessage(chatId: string, cardId: string): Promise<string> {
  let attempts = 0;
  const maxAttempts = 6;
  while (true) {
    try {
      const res = await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            type: "card",
            data: {
              card_id: cardId
            }
          })
        }
      });
      return res.data?.message_id || "";
    } catch (err: any) {
      attempts++;
      const errData = err.response?.data;
      const isCardInvalid = errData?.code === 230099 || 
                            (errData?.msg && errData.msg.includes("cardid is invalid")) ||
                            (err.message && err.message.includes("400")) ||
                            err.code === 'ERR_BAD_REQUEST';
      if (attempts >= maxAttempts || !isCardInvalid) {
        throw err;
      }
      const delay = attempts * 500;
      console.warn(`[DEBUG] sendCardKitMessage failed (card_id: ${cardId}), retrying in ${delay}ms (attempt ${attempts}/${maxAttempts}). Error: ${err.message || err}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function sendSimpleStatusCard(chatId: string, title: string, template: string, markdownContent: string): Promise<string> {
  try {
    const cardLayout = {
      schema: "2.0",
      config: {
        wide_screen_mode: true
      },
      header: {
        template: template,
        title: {
          tag: "plain_text",
          content: title
        }
      },
      body: {
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: markdownContent
            }
          }
        ]
      }
    };
    const cardId = await createCardKitCard(cardLayout);
    return await sendCardKitMessage(chatId, cardId);
  } catch (err: any) {
    console.error('Failed to send simple status card, falling back to text:', err);
    const res = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: `[${title}] ${markdownContent}` })
      }
    });
    return res.data?.message_id || "";
  }
}

async function streamCardKitElement(cardId: string, elementId: string, content: string, sequence: number, turn?: ActiveTurn) {
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        content: content || " ",
        sequence: sequence
      })
    });
    const data: any = await res.json();
    if (data.code !== 0) {
      if (data.msg && (data.msg.includes('streaming mode is closed') || data.msg.includes('streaming_mode is closed'))) {
        if (turn) turn.streamingClosed = true;
      }
      console.error(`Failed to stream CardKit element ${elementId}:`, data.msg);
    }
  } catch (e) {
    console.error(`Failed to stream element ${elementId} network request:`, e);
  }
}

async function finalizeCardKitCard(cardId: string, finalContent: any, turn: ActiveTurn) {
  try {
    const token = await getTenantAccessToken();
    
    // 1. Close streaming mode
    const settingsRes = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        settings: JSON.stringify({ streaming_mode: false }),
        sequence: turn.sequence++
      })
    });
    const settingsData: any = await settingsRes.json();
    if (settingsData.code !== 0) {
      console.error(`Failed to close streaming mode for card ${cardId}:`, settingsData.msg);
    }

    // 2. Put final full card json
    const updateRes = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        card: {
          type: "card_json",
          data: JSON.stringify(finalContent)
        },
        sequence: turn.sequence++
      })
    });
    const updateData: any = await updateRes.json();
    if (updateData.code !== 0) {
      console.error(`Failed to finalize CardKit card ${cardId}:`, updateData.msg);
    }
  } catch (e) {
    console.error(`Failed to finalize CardKit card network request:`, e);
  }
}

// --- Stats Parser and Formatting ---
function extractStatsFromParams(params: any): TurnStats {
  const stats: TurnStats = {};
  if (!params || typeof params !== 'object') {
    return stats;
  }

  // Explicit check for Codex tokenUsage notification format
  if (params.tokenUsage && typeof params.tokenUsage === 'object') {
    const tu = params.tokenUsage;
    if (tu.last && typeof tu.last === 'object') {
      if (typeof tu.last.inputTokens === 'number') stats.inputTokens = tu.last.inputTokens;
      if (typeof tu.last.outputTokens === 'number') stats.outputTokens = tu.last.outputTokens;
    }
    if (tu.last && typeof tu.last === 'object' && typeof tu.last.totalTokens === 'number') {
      stats.contextTokens = tu.last.totalTokens;
    } else if (tu.total && typeof tu.total === 'object' && typeof tu.total.totalTokens === 'number') {
      stats.contextTokens = tu.total.totalTokens;
    }
    if (typeof tu.modelContextWindow === 'number') {
      stats.contextLength = tu.modelContextWindow;
    }
    if (typeof params.model === 'string') {
      stats.model = params.model;
    }
  }
  
  function search(obj: any, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return;
    
    const modelKeys = ["model", "model_name", "modelName", "model_id", "modelId", "toModel"];
    for (const key of modelKeys) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        if (!stats.model) stats.model = obj[key].trim();
        break;
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        const nestedModel = obj[key].id || obj[key].name || obj[key].model;
        if (typeof nestedModel === 'string' && nestedModel.trim()) {
          if (!stats.model) stats.model = nestedModel.trim();
          break;
        }
      }
    }

    const inputTokenKeys = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "tokens_in", "tokensIn"];
    for (const key of inputTokenKeys) {
      if (typeof obj[key] === 'number') { if (stats.inputTokens === undefined) stats.inputTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { if (stats.inputTokens === undefined) stats.inputTokens = parseInt(obj[key], 10); break; }
    }
    const outputTokenKeys = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "tokens_out", "tokensOut"];
    for (const key of outputTokenKeys) {
      if (typeof obj[key] === 'number') { if (stats.outputTokens === undefined) stats.outputTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { if (stats.outputTokens === undefined) stats.outputTokens = parseInt(obj[key], 10); break; }
    }
    const contextTokenKeys = ["context_tokens", "contextTokens", "context_used_tokens", "contextUsedTokens", "total_tokens", "totalTokens"];
    for (const key of contextTokenKeys) {
      if (typeof obj[key] === 'number') { if (stats.contextTokens === undefined) stats.contextTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { if (stats.contextTokens === undefined) stats.contextTokens = parseInt(obj[key], 10); break; }
    }
    const contextLengthKeys = ["context_length", "contextLength", "context_window", "contextWindow", "modelContextWindow", "max_context_tokens", "maxContextTokens"];
    for (const key of contextLengthKeys) {
      if (typeof obj[key] === 'number') { if (stats.contextLength === undefined) stats.contextLength = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { if (stats.contextLength === undefined) stats.contextLength = parseInt(obj[key], 10); break; }
    }
    const apiCallKeys = ["api_calls", "apiCalls", "api_requests", "apiRequests", "request_count", "requestCount"];
    for (const key of apiCallKeys) {
      if (typeof obj[key] === 'number') { if (stats.apiCalls === undefined) stats.apiCalls = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { if (stats.apiCalls === undefined) stats.apiCalls = parseInt(obj[key], 10); break; }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        search(item, depth + 1);
      }
    } else {
      for (const k of Object.keys(obj)) {
        if (k === 'total' && depth > 0) {
          // Skip total usage fields to prevent cumulative stats from overwriting current turn stats
          continue;
        }
        if (typeof obj[k] === 'object') {
          search(obj[k], depth + 1);
        }
      }
    }
  }

  search(params);
  return stats;
}

function formatCount(value?: number): string {
  if (value === undefined || value === null) return "-";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m${remainder.toString().padStart(2, '0')}s`;
}

function getStatsFooterText(turn: ActiveTurn): string {
  const parts: string[] = [];
  
  if (turn.status === 'success') {
    parts.push("✅ 已完成");
  } else if (turn.status === 'failed') {
    parts.push("❌ 失败");
  } else if (turn.status === 'interrupted') {
    parts.push("🛑 已取消");
  } else {
    parts.push("⏳ 运行中");
  }

  if (turn.startedAt) {
    const elapsed = turn.completedAt 
      ? turn.completedAt - turn.startedAt
      : Date.now() - turn.startedAt;
    parts.push(`耗时 ${formatDuration(elapsed)}`);
  }

  if (turn.stats.model) {
    parts.push(turn.stats.model);
  }

  if (turn.stats.inputTokens !== undefined || turn.stats.outputTokens !== undefined) {
    const inT = formatCount(turn.stats.inputTokens);
    const outT = formatCount(turn.stats.outputTokens);
    parts.push(`↑ ${inT} ↓ ${outT}`);
  }

  if (turn.stats.contextTokens !== undefined && turn.stats.contextLength) {
    const percentage = Math.round((turn.stats.contextTokens / turn.stats.contextLength) * 100);
    const used = formatCount(turn.stats.contextTokens);
    const maxLen = formatCount(turn.stats.contextLength);
    parts.push(`上下文 ${used}/${maxLen} (${percentage}%)`);
  }

  if (turn.stats.apiCalls !== undefined) {
    parts.push(`API ${turn.stats.apiCalls}`);
  }

  const baseFooter = parts.join(" · ");
  if (turn.rateLimitStr) {
    return `${baseFooter}\n窗口用量: ${turn.rateLimitStr}`;
  }

  return baseFooter;
}


function formatResetTime(timestampSec?: number): string {
  if (!timestampSec) return '';
  const date = new Date(timestampSec * 1000);
  const now = new Date();
  
  const isToday = date.toDateString() === now.toDateString();
  
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  
  if (isToday) {
    return `${hh}:${mm}`;
  } else if (isTomorrow) {
    return `明天 ${hh}:${mm}`;
  } else {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}月${day}日`;
  }
}

async function fetchRateLimitsForTurn(turn: ActiveTurn): Promise<void> {
  try {
    const res = await adapter.request('account/rateLimits/read', {});
    const codexLimits = res?.rateLimitsByLimitId?.codex || res?.rateLimits;
    if (codexLimits) {
      let limitStrs = [];
      if (codexLimits.primary) {
        let str = `5h: ${codexLimits.primary.usedPercent ?? 0}%`;
        const resetStr = formatResetTime(codexLimits.primary.resetsAt);
        if (resetStr) {
          str += ` (${resetStr})`;
        }
        limitStrs.push(str);
      }
      if (codexLimits.secondary) {
        let str = `7d: ${codexLimits.secondary.usedPercent ?? 0}%`;
        const resetStr = formatResetTime(codexLimits.secondary.resetsAt);
        if (resetStr) {
          str += ` (${resetStr})`;
        }
        limitStrs.push(str);
      }
      if (codexLimits.credits && codexLimits.credits.hasCredits) {
        limitStrs.push(`点数: ${codexLimits.credits.balance}`);
      }
      if (limitStrs.length > 0) {
        const newStr = limitStrs.join(" | ");
        if (turn.rateLimitStr !== newStr) {
          turn.rateLimitStr = newStr;
          turn.dirty = true;
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch rate limits:', e);
  }
}

function getTurnMetadataContent(turn: ActiveTurn): string | null {
  const parts: string[] = [];
  if (turn.skillName) {
    parts.push(`✨ **调用的技能**: \`${turn.skillName}\``);
  }
  if (turn.collaborationMode === 'plan') {
    parts.push(`📝 **计划模式**: \`开启\``);
  }
  if (turn.personality && turn.personality !== 'none') {
    const persMap: Record<string, string> = { friendly: '亲和', pragmatic: '务实' };
    parts.push(`🎭 **回复风格**: \`${persMap[turn.personality] || turn.personality}\``);
  }
  
  if (parts.length === 0) return null;
  return parts.join(" ｜ ");
}

// --- CardKit Layout Constructors ---
function createCardKitInitialLayout(turn: ActiveTurn) {
  const footer = getStatsFooterText(turn);
  const metadataContent = getTurnMetadataContent(turn);
  
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: "Codex 执行进度" },
      streaming_config: {
        print_frequency_ms: { default: 30, android: 30, ios: 30, pc: 30 },
        print_step: { default: 3, android: 3, ios: 3, pc: 3 },
        print_strategy: "delay"
      }
    },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "🌌 Codex Remote Control" }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**📥 输入 Prompt**\n> ${turn.prompt}`,
          element_id: "codex_prompt"
        },
        ...(getTurnMetadataContent(turn) ? [{
          tag: "markdown",
          content: getTurnMetadataContent(turn)!,
          element_id: "codex_metadata"
        }] : []),
        { tag: "hr" },
        {
          tag: "markdown",
          content: `🧠 **模型推理过程**\n等待开始...`,
          element_id: "codex_reasoning"
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `✨ **最终结果输出**\n等待中...`,
          element_id: "codex_output"
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `📊 ${footer}`,
          element_id: "codex_footer"
        }
      ]
    }
  };
}

function createCardKitFinalLayout(turn: ActiveTurn) {
  const headerTemplate = turn.status === "failed" 
    ? "red" 
    : (turn.status === "interrupted" 
        ? "grey" 
        : (turn.status === "running" 
            ? "indigo" 
            : (turn.isHistory ? "indigo" : "green")));
  const footer = getStatsFooterText(turn);
  
  let logContent = turn.logs.join("\n");
  if (!logContent.trim()) {
    logContent = "Finished.";
  }
  const maxChars = 2000;
  if (logContent.length > maxChars) {
    logContent = "... (truncated) ...\n" + logContent.substring(logContent.length - maxChars);
  }

  const elements: any[] = [
    {
      tag: "markdown",
      content: `**📥 输入 Prompt**\n> ${turn.prompt}`
    }
  ];

  const metadata = getTurnMetadataContent(turn);
  if (metadata) {
    elements.push({
      tag: "markdown",
      content: metadata
    });
  }

  if (turn.reasoning) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: `🧠 **模型推理过程**\n${turn.reasoning}`
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `✨ **最终结果输出**\n${turn.answer || '无最终文本输出'}`
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `📊 ${footer}`
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: {
        tag: "plain_text",
        content: turn.isHistory
          ? (turn.status === "success" ? "📜 [历史] ✅ Codex 执行成功" : (turn.status === "interrupted" ? "📜 [历史] 🛑 Codex 执行已取消" : "📜 [历史] ❌ Codex 执行失败"))
          : (turn.status === "success" ? "✅ Codex 执行成功" : (turn.status === "interrupted" ? "🛑 Codex 执行已取消" : "❌ Codex 执行失败"))
      }
    },
    body: {
      elements
    }
  };
}

// redactSecrets is now imported from './adapter'

// --- Approval Card Templates ---
function createApprovalCard(approvalId: string, type: string, cwd: string, summary: string, reason?: string) {
  const cleanSummary = redactSecrets(summary);

  let riskLevel = "low";
  const text = `${type} ${summary}`.toLowerCase();
  if (/\b(rm|delete|curl|wget)\b|https?:\/\/|token|secret/i.test(text)) {
    riskLevel = "high";
  } else if (["exec", "command", "shell"].includes(type.toLowerCase())) {
    riskLevel = "medium";
  }

  const riskText = riskLevel === "high" 
    ? "<font color='red'><b>高风险 ⚠️ (包含敏感词或命令)</b></font>" 
    : (riskLevel === "medium" ? "<font color='orange'><b>中风险 ⚡️ (执行命令)</b></font>" : "低风险 ✅");

  const elements: any[] = [
    {
      tag: "markdown",
      content: "🚨 Codex 正在尝试在您的系统上执行以下敏感操作，需要您进行确认授权："
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `📌 **操作类型**: \`${type}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${riskText}`
    }
  ];

  if (reason && reason !== summary) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: `❓ **申请原因**:\n${reason}`
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `💻 **准备执行的操作指令**:\n\`\`\`text\n${cleanSummary}\n\`\`\``
    },
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "stretch",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🟢 批准 (Approve)" },
              type: "primary",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "accept"
              }
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🛡️ 总是批准 (Always)" },
              type: "primary",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "acceptForSession"
              }
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🔴 拒绝 (Deny)" },
              type: "danger",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "decline"
              }
            }
          ]
        }
      ]
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: riskLevel === "high" ? "carmine" : (riskLevel === "medium" ? "orange" : "violet"),
      title: {
        tag: "plain_text",
        content: "⚡️ Codex 安全审批申请"
      }
    },
    body: {
      elements
    }
  };
}

function createApprovalDecidedCard(
  type: string,
  cwd: string,
  summary: string,
  reason: string | undefined,
  decision: string
) {
  const isAccepted = decision === "accept";
  const isAlways = decision === "acceptForSession";
  const isDeclined = decision === "decline";
  
  let cleanSummary = redactSecrets(summary);

  let riskLevel = "low";
  const text = `${type} ${summary}`.toLowerCase();
  if (/\b(rm|delete|curl|wget)\b|https?:\/\/|token|secret/i.test(text)) {
    riskLevel = "high";
  } else if (["exec", "command", "shell"].includes(type.toLowerCase())) {
    riskLevel = "medium";
  }

  const riskText = riskLevel === "high" 
    ? "<font color='red'><b>高风险 ⚠️ (包含敏感词或命令)</b></font>" 
    : (riskLevel === "medium" ? "<font color='orange'><b>中风险 ⚡️ (执行命令)</b></font>" : "低风险 ✅");

  let statusContent = "";
  if (isAccepted) {
    statusContent = `✅ **审批已批准** (已于 **${formatDateTime24h(new Date())}** 被批准执行一次)`;
  } else if (isAlways) {
    statusContent = `🛡️ **已总是批准该操作** (已于 **${formatDateTime24h(new Date())}** 批准在本次会话中不再询问)`;
  } else {
    statusContent = `❌ **审批已拒绝** (已于 **${formatDateTime24h(new Date())}** 被拒绝执行。Codex 将停止该步骤的执行。)`;
  }

  const elements: any[] = [
    {
      tag: "markdown",
      content: statusContent
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `📌 **操作类型**: \`${type}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${riskText}`
    }
  ];

  if (reason && reason !== summary) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: `❓ **申请原因**:\n${reason}`
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `💻 **执行的操作指令**:\n\`\`\`text\n${cleanSummary}\n\`\`\``
    },
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "stretch",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isAccepted ? "🟢 已批准 (Approved)" : "批准 (Approve)" },
              type: isAccepted ? "primary" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isAlways ? "🛡️ 已总是批准" : "总是批准 (Always)" },
              type: isAlways ? "primary" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isDeclined ? "🔴 已拒绝 (Denied)" : "拒绝 (Deny)" },
              type: isDeclined ? "danger" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        }
      ]
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: (isAccepted || isAlways) ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: isAccepted ? "✅ 审批已批准" : (isAlways ? "🛡️ 审批已总是批准" : "❌ 审批已拒绝")
      }
    },
    body: {
      elements
    }
  };
}

// --- Granular CardKit Updater ---
async function streamUpdateCardKit(turn: ActiveTurn) {
  if (!turn.cardId || turn.status !== 'running') return;
  
  if (turn.streamingClosed) {
    const now = Date.now();
    if (turn.lastFullUpdateAt && now - turn.lastFullUpdateAt < 2000) {
      turn.dirty = true;
      return;
    }
    turn.lastFullUpdateAt = now;
    
    try {
      const fullLayout = createCardKitFinalLayout(turn);
      const token = await getTenantAccessToken();
      const updateRes = await fetch(`https://open.feishu.cn/open-apis/cardkit/v1/cards/${encodeURIComponent(turn.cardId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          card: {
            type: "card_json",
            data: JSON.stringify(fullLayout)
          },
          sequence: turn.sequence++,
          update_multi: true
        })
      });
      const data: any = await updateRes.json();
      if (data.code !== 0) {
        console.error(`Failed to full update card ${turn.cardId}:`, data.msg);
      }
    } catch (e) {
      console.error(`Failed full update card network request:`, e);
    }
    return;
  }

  try {
    if (!turn.lastSentValues) {
      turn.lastSentValues = {};
    }

    const shouldUpdate = (elementId: string, content: string): boolean => {
      if (turn.lastSentValues![elementId] === content) {
        return false;
      }
      turn.lastSentValues![elementId] = content;
      return true;
    };

    // 0. Update Prompt
    if (turn.prompt) {
      const promptMd = `**📥 输入 Prompt**\n> ${turn.prompt}`;
      if (shouldUpdate("codex_prompt", promptMd)) {
        await streamCardKitElement(turn.cardId, "codex_prompt", promptMd, turn.sequence++, turn);
      }
    }

    // 0.1 Update Metadata
    const metadataContent = getTurnMetadataContent(turn);
    if (metadataContent) {
      if (shouldUpdate("codex_metadata", metadataContent)) {
        await streamCardKitElement(turn.cardId, "codex_metadata", metadataContent, turn.sequence++, turn);
      }
    }

    // 1. Update Reasoning
    if (turn.reasoning) {
      let reasoningContent = turn.reasoning;
      const maxReasoningChars = 4000;
      if (reasoningContent.length > maxReasoningChars) {
        reasoningContent = `... (已省略前部 ${reasoningContent.length - maxReasoningChars} 字) ...\n` + reasoningContent.substring(reasoningContent.length - maxReasoningChars);
      }
      const reasoningMd = `🧠 **模型推理过程**:\n${reasoningContent}${turn.activeStream === 'reasoning' ? ' ▉' : ''}`;
      if (shouldUpdate("codex_reasoning", reasoningMd)) {
        await streamCardKitElement(turn.cardId, "codex_reasoning", reasoningMd, turn.sequence++, turn);
      }
    }



    // 3. Update Output
    if (turn.answer) {
      let answerContent = turn.answer;
      const maxAnswerChars = 4000;
      if (answerContent.length > maxAnswerChars) {
        answerContent = `... (已省略前部 ${answerContent.length - maxAnswerChars} 字) ...\n` + answerContent.substring(answerContent.length - maxAnswerChars);
      }
      const outputMd = `✨ **最终结果输出**:\n${answerContent}${turn.activeStream === 'answer' ? ' ▉' : ''}`;
      if (shouldUpdate("codex_output", outputMd)) {
        await streamCardKitElement(turn.cardId, "codex_output", outputMd, turn.sequence++, turn);
      }
    }

    // 4. Update Footer
    const footerText = `📊 ${getStatsFooterText(turn)}`;
    if (shouldUpdate("codex_footer", footerText)) {
      await streamCardKitElement(turn.cardId, "codex_footer", footerText, turn.sequence++, turn);
    }

  } catch (e) {
    console.error(`Failed to stream update CardKit card:`, e);
  }
}

// Initialize Lark client (initialized dynamically in main)
let larkClient: Lark.Client;

// Initialize Codex adapter
const adapter = new LocalAppServerAdapter({
  socketPath: process.env.CODEX_SOCKET_PATH
});

// Helper to extract text content
function extractTextMessage(contentStr: string): string {
  try {
    const parsed = JSON.parse(contentStr);
    let text = parsed.text || "";
    // Remove bot mentions
    text = text.replace(/@_user_\d+/g, "").trim();
    return text;
  } catch (e) {
    return contentStr;
  }
}

// Helper to clean up turn maps
function cleanupTurn(turnId: string, threadId: string) {
  const turn = activeTurns.get(turnId);
  if (turn) {
    recentTurns.set(turnId, turn);
    recentTurns.set(threadId, turn);
    // Keep in recentTurns for 30 seconds to handle late notifications, then purge
    setTimeout(() => {
      recentTurns.delete(turnId);
      recentTurns.delete(threadId);
    }, 30000);
  }

  activeTurns.delete(turnId);
  threadToActiveTurnId.delete(threadId);
  if (typeof adapter.cleanupThreadState === 'function') {
    adapter.cleanupThreadState(threadId);
  }
}


// Periodic tick (100ms throttling for real-time typewriter experience)
setInterval(() => {
  const now = Date.now();
  for (const [turnId, turn] of activeTurns.entries()) {
    if (turn.status === 'running') {
      // Query rate limits periodically for long-running turns
      if (!turn.lastRateLimitQueryAt || now - turn.lastRateLimitQueryAt > RATE_LIMIT_QUERY_INTERVAL_MS) {
        turn.lastRateLimitQueryAt = now;
        fetchRateLimitsForTurn(turn);
      }
    }

    if (turn.dirty && turn.status === 'running' && !turn.updating) {
      turn.dirty = false;
      turn.updating = true;
      queueTurnTask(turnId, async () => {
        try {
          await streamUpdateCardKit(turn);
        } finally {
          turn.updating = false;
        }
      });
    }
  }
}, 100);

// Keep track of recently processed message IDs to prevent duplicates
const processedMessageIds = new Map<string, number>();

// Periodically clean up old message IDs (older than 10 minutes) every 5 minutes
setInterval(() => {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (timestamp < tenMinutesAgo) {
      processedMessageIds.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Initialize Event Dispatcher
const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const message = data.message;
    const sender = data.sender;

    // Ignore messages not sent by standard users (e.g. apps/bots) to prevent loops
    if (sender?.sender_type !== 'user') {
      return;
    }

    const messageId = message.message_id;

    // Validate incoming message sender if AUTHORIZED_USERS is configured in environment
    const authorizedUsersStr = process.env.AUTHORIZED_USERS;
    const senderOpenId = sender?.sender_id?.open_id;
    if (authorizedUsersStr && senderOpenId) {
      const authList = authorizedUsersStr.split(',').map(id => id.trim()).filter(Boolean);
      if (authList.length > 0 && !authList.includes(senderOpenId)) {
        console.warn(`[Unauthorized Access Attempt] Sender: ${senderOpenId}, Msg: ${messageId || "unknown"}`);
        return;
      }
    }
    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log(`[Duplicate Message Ignored] Msg: ${messageId}`);
        return;
      }
      processedMessageIds.set(messageId, Date.now());
    }

    // Ignore old backlogged messages sent by Feishu on reconnect (older than 30s)
    const createTimeStr = message.create_time;
    if (createTimeStr) {
      let createTimeMs = parseInt(createTimeStr, 10);
      if (createTimeStr.length > 13) {
        createTimeMs = Math.floor(createTimeMs / 1000);
      }
      const nowMs = Date.now();
      const ageSec = (nowMs - createTimeMs) / 1000;
      if (ageSec > 30) {
        console.log(`[Ignore Old Message] Msg: ${message.message_id}, Content: "${extractTextMessage(message.content)}", Age: ${Math.round(ageSec)}s ago`);
        return;
      }
    }

    // Process the message asynchronously to return ACK immediately to Feishu
    (async () => {
      try {
        const chatId = message.chat_id;
        const text = extractTextMessage(message.content);

        console.log(`[Received Message] Chat: ${chatId}, Msg: ${messageId}, Text: "${text}"`);

    // Immediately react with 'ok' emoji to indicate receipt
    if (messageId) {
      (async () => {
        try {
          await larkClient.im.messageReaction.create({
            path: {
              message_id: messageId,
            },
            data: {
              reaction_type: {
                emoji_type: 'OK',
              },
            },
          });
        } catch (err: any) {
          console.warn(`[Reaction Error] Failed to react with OK to msg ${messageId}:`, err.message || err);
          // Fallback to text emoji reply if reaction fails
          try {
            await larkClient.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: '👌' })
              }
            });
          } catch (textErr) {
            console.error('Fallback text emoji reply failed:', textErr);
          }
        }
      })();
    }

    // 0. Handle /help or /h command
    const isHelp = text === '/help' || text === '/h' || text === 'help' || text === 'h' || text.startsWith('/help ') || text.startsWith('/h ');
    if (isHelp) {
      try {
        const helpCard = createHelpCard();
        const cardId = await createCardKitCard(helpCard);
        await sendCardKitMessage(chatId, cardId);
      } catch (e: any) {
        console.error('Failed to send help card:', e);
        const allowedCommands = getAllowedCommands();
        await sendSimpleStatusCard(chatId, "💡 Codex 飞书助手指令指南 (备用)", "blue", `支持的指令：\n- /list: 绑定/列出会话\n- /new [名称] 或 /create: 新建并绑定新会话\n- /cwd [工作目录] 或 /workspace: 查询或切换工作目录\n- /cmd [命令] 或 /run: 执行本地终端命令 (当前支持: ${allowedCommands.join(', ')})\n- /goal [目标内容]: 设置并启动目标模式\n- /goal: 查看当前目标状态\n- /goal clear: 清除当前目标\n- /mcp: 查看 MCP 服务及认证状态\n- /personality [friendly|pragmatic|none]: 设置或查询回复风格\n- /compact: 压缩当前会话上下文\n- /fork [新名称]: 派生并绑定新会话\n- /plan: 开启或关闭计划模式 (Plan Mode)\n- /status: 展示当前会话综合状态\n- /skills: 列出当前工作区可用技能\n- 在日常对话中通过 @技能名称 提及并调用特定技能 (例如: @Ce Debug 为什么编译报错)\n- /usage 或 /quota: 获取当前账户的短期/长期窗口用量及重置时间\n- /delete 或 /archive: 归档并解绑会话\n- /help 或 /h: 获取此帮助卡片`);
      }
      return;
    }

    // 1. Handle /list command
    if (text.startsWith('/list')) {
      try {
        console.log(`Fetching Codex threads for /list...`);
        const threads = await adapter.listThreads();
        if (threads.length === 0) {
          await sendSimpleStatusCard(chatId, "⚠️ 未发现活跃会话", "orange", "No active Codex sessions found. Please open Codex Desktop client first.");
          return;
        }

        const bindingCard = await createBindingCard(threads);
        const cardId = await createCardKitCard(bindingCard);
        await sendCardKitMessage(chatId, cardId);
      } catch (e: any) {
        console.error('Failed to list threads or send card:', e);
        await sendSimpleStatusCard(chatId, "🚫 获取会话列表失败", "red", `Failed to bind Codex session: ${e.message || e}`);
      }
      return;
    }

    // 1.4. Handle /goal command
    if (text.startsWith('/goal')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }

      try {
        const parts = text.split(/\s+/);
        const commandArg = parts.slice(1).join(" ").trim();

        if (!commandArg) {
          // 查询当前目标 (thread/goal/get)
          console.log(`Fetching goal status for thread: ${bound.threadId}`);
          const getRes = await adapter.request('thread/goal/get', { threadId: bound.threadId });
          console.log('Codex thread/goal/get response:', JSON.stringify(getRes));
          
          const goal = getRes?.goal;
          const goalCard = createGoalCard(goal);
          const cardId = await createCardKitCard(goalCard);
          await sendCardKitMessage(chatId, cardId);
        } else if (commandArg === 'clear' || commandArg === '-c' || commandArg === '--clear') {
          // 清除当前目标 (thread/goal/clear)
          console.log(`Clearing goal for thread: ${bound.threadId}`);
          const clearRes = await adapter.request('thread/goal/clear', { threadId: bound.threadId });
          console.log('Codex thread/goal/clear response:', JSON.stringify(clearRes));

          await sendSimpleStatusCard(chatId, "🎯 Codex 目标清除", "grey", `已成功清除会话 **${bound.threadName}** 的当前目标。`);
        } else {
          // 设置新目标 (thread/goal/set) 并自动启动 execution (startRemoteControlTurn)
          console.log(`Setting new goal for thread: ${bound.threadId}. Goal: "${commandArg}"`);
          const setRes = await adapter.request('thread/goal/set', {
            threadId: bound.threadId,
            objective: commandArg,
            status: "active"
          });
          console.log('Codex thread/goal/set response:', JSON.stringify(setRes));

          // 创建并初始化目标卡片和 ActiveTurn (类似于普通消息的处理方式)
          const promptText = `🎯 目标模式：${commandArg}`;
          const initialTurn: ActiveTurn = {
            chatId,
            messageId: "",
            cardId: "",
            threadId: bound.threadId,
            prompt: promptText,
            logs: ["正在初始化目标模式并启动..."],
            status: 'running',
            dirty: false,
            startedAt: Date.now(),
            stats: {},
            sequence: 1,
            skillName: undefined,
            collaborationMode: bound.planMode ? "plan" : null,
            personality: bound.personality || null
          };

          const initialLayout = createCardKitInitialLayout(initialTurn);
          const cardId = await createCardKitCard(initialLayout);
          initialTurn.cardId = cardId;

          const logCardMessageId = await sendCardKitMessage(chatId, cardId);
          if (!logCardMessageId) {
            throw new Error("Failed to retrieve Feishu log card message ID for goal turn");
          }
          initialTurn.messageId = logCardMessageId;

          const tempTurnId = 'temp-' + crypto.randomUUID();
          activeTurns.set(tempTurnId, initialTurn);
          threadToActiveTurnId.set(bound.threadId, tempTurnId);

          // 异步启动 Remote Control Turn
          (async () => {
            try {
              const turnId = await adapter.startRemoteControlTurn({
                threadId: bound.threadId,
                cwd: bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir(),
                prompt: `开始执行目标：${commandArg}`,
                collaborationMode: bound.planMode ? "plan" : null,
                personality: bound.personality || null
              });

              // Replace the temporary turn ID with the actual turn ID
              activeTurns.delete(tempTurnId);
              activeTurns.set(turnId, initialTurn);
              threadToActiveTurnId.set(bound.threadId, turnId);
              console.log(`Goal turn started and mapped with ID: ${turnId}`);
            } catch (e: any) {
              console.error('Asynchronous Codex goal turn trigger failed:', e);
              activeTurns.delete(tempTurnId);
              const activeTurnId = threadToActiveTurnId.get(bound.threadId);
              if (activeTurnId === tempTurnId) {
                threadToActiveTurnId.delete(bound.threadId);
              }
              
              // Update the card to show failure via CardKit
              initialTurn.status = 'failed';
              initialTurn.logs.push(`Failed to trigger goal turn: ${e.message || e}`);
              if (initialTurn.cardId) {
                const finalLayout = createCardKitFinalLayout(initialTurn);
                finalizeCardKitCard(initialTurn.cardId, finalLayout, initialTurn).catch(finalizeErr => {
                  console.error('Failed to finalize goal error card asynchronously:', finalizeErr);
                });
              }
            }
          })();
        }
      } catch (e: any) {
        console.error('Failed to execute goal command:', e);
        await sendSimpleStatusCard(chatId, "❌ 处理目标指令失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.1. Handle /mcp command
    if (text.startsWith('/mcp')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        console.log(`Fetching MCP server list for thread: ${bound.threadId}`);
        const mcpRes = await adapter.request('mcpServerStatus/list', { threadId: bound.threadId });
        console.log('Codex mcpServerStatus/list response:', JSON.stringify(mcpRes));
        
        const mcpCard = createMcpCard(mcpRes);
        const cardId = await createCardKitCard(mcpCard);
        await sendCardKitMessage(chatId, cardId);
      } catch (e: any) {
        console.error('Failed to execute mcp command:', e);
        await sendSimpleStatusCard(chatId, "🔌 获取 MCP 状态失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.2. Handle /personality or /style command
    if (text.startsWith('/personality') || text.startsWith('/style')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定 any Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      
      const parts = text.split(/\s+/);
      const style = parts.slice(1).join(" ").trim().toLowerCase();
      
      if (!style) {
        const currentPers = bound.personality || "none (默认)";
        await sendSimpleStatusCard(chatId, "🎭 回复风格状态", "indigo", `当前会话的回复风格（Personality）为：\n- **${currentPers}**\n\n如需更改，请使用指令：\n- \`/personality friendly\` (或 \`亲和\`)\n- \`/personality pragmatic\` (或 \`务实\`)\n- \`/personality none\` (或 \`默认\`)`);
      } else {
        let target: 'friendly' | 'pragmatic' | 'none' = 'none';
        if (style === 'friendly' || style === '亲和') target = 'friendly';
        else if (style === 'pragmatic' || style === '务实') target = 'pragmatic';
        
        bound.personality = target;
        saveSessions(sessionDb);
        
        await sendSimpleStatusCard(chatId, "🎭 回复风格设定", "green", `会话回复风格已成功设定为：**${target}**。\n接下来 Codex 的回复风格将应用此选项。`);
      }
      return;
    }

    // 1.4.3. Handle /compact or /compress command
    if (text.startsWith('/compact') || text.startsWith('/compress')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        console.log(`Starting compact for thread: ${bound.threadId}`);
        await adapter.request('thread/compact/start', { threadId: bound.threadId });
        await sendSimpleStatusCard(chatId, "⚡️ 上下文压缩", "blue", "已向 App Server 发起上下文压缩指令。Codex 正在压缩整理当前会话的上下文，这通常在几秒内完成。");
      } catch (e: any) {
        console.error('Failed to execute compact command:', e);
        await sendSimpleStatusCard(chatId, "⚡️ 压缩上下文失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.4. Handle /fork or /branch command
    if (text.startsWith('/fork') || text.startsWith('/branch')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        const parts = text.split(/\s+/);
        let forkName = parts.slice(1).join(" ").trim();
        if (!forkName) {
          forkName = bound.threadName + "_派生";
        }
        
        console.log(`Forking thread ${bound.threadId} as "${forkName}"`);
        const forkRes = await adapter.request('thread/fork', {
          threadId: bound.threadId,
          threadSource: 'user'
        });
        console.log('Codex thread/fork response:', JSON.stringify(forkRes));
        
        const thread = forkRes?.thread || forkRes;
        const newThreadId = thread?.id || forkRes?.threadId;
        if (!newThreadId) {
          throw new Error('No thread ID returned from fork RPC');
        }
        
        // 设置新会话的名称
        await adapter.request('thread/name/set', {
          threadId: newThreadId,
          name: forkName
        });
        
        // 绑定到新会话
        sessionDb[chatId] = {
          threadId: newThreadId,
          threadName: forkName,
          cwd: bound.cwd || "",
          personality: bound.personality,
          planMode: bound.planMode
        };
        saveSessions(sessionDb);
        
        await sendSimpleStatusCard(chatId, "🌱 会话派生成功", "green", `已成功以此前的历史派生出新会话！\n\n- 📂 新会话名称: **${forkName}**\n- 🆔 会话 ID: \`${newThreadId}\`\n\n当前飞书聊天已自动绑定到该新会话。`);
      } catch (e: any) {
        console.error('Failed to execute fork command:', e);
        await sendSimpleStatusCard(chatId, "🌱 派生会话失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.5. Handle /plan command
    if (text.startsWith('/plan')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      
      const parts = text.split(/\s+/);
      const arg = parts.slice(1).join(" ").trim().toLowerCase();
      
      let nextState = !bound.planMode;
      if (arg === 'on' || arg === 'true' || arg === '开启') nextState = true;
      else if (arg === 'off' || arg === 'false' || arg === '关闭') nextState = false;
      
      bound.planMode = nextState;
      saveSessions(sessionDb);
      
      await sendSimpleStatusCard(chatId, `📝 计划模式：${nextState ? '已开启 🟢' : '已关闭 🔴'}`, nextState ? "green" : "grey", nextState ? "接下来的开发指令将优先生成 implementation_plan 供您审批。" : "接下来将直接运行日常对话。");
      return;
    }

    // 1.4.6. Handle /status command
    if (text.startsWith('/status')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        console.log(`Fetching full status for thread: ${bound.threadId}`);
        let goal = null;
        try {
          const goalRes = await adapter.request('thread/goal/get', { threadId: bound.threadId });
          goal = goalRes?.goal || null;
        } catch (e) {
          console.warn('Failed to fetch goal in /status:', e);
        }
        
        const statusCard = createStatusCard({
          name: bound.threadName,
          threadId: bound.threadId,
          cwd: bound.cwd || "",
          personality: bound.personality || "none",
          planMode: !!bound.planMode,
          goal
        });
        
        const cardId = await createCardKitCard(statusCard);
        await sendCardKitMessage(chatId, cardId);
      } catch (e: any) {
        console.error('Failed to execute status command:', e);
        await sendSimpleStatusCard(chatId, "📊 获取状态面板失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.7. Handle /usage or /quota command
    if (text.startsWith('/usage') || text.startsWith('/quota')) {
      try {
        const res = await adapter.request('account/rateLimits/read', {});
        const codexLimits = res?.rateLimitsByLimitId?.codex || res?.rateLimits;
        
        if (!codexLimits) {
          await sendSimpleStatusCard(chatId, "📊 用量信息", "orange", "无法获取当前账户的使用量信息，请稍后再试。");
          return;
        }

        const planType = codexLimits.planType || '未知';
        
        let msg = `**账户类型**: ${planType.toUpperCase()}\n\n`;

        if (codexLimits.primary) {
          const used = codexLimits.primary.usedPercent ?? 0;
          const windowHours = Math.round(codexLimits.primary.windowDurationMins / 60);
          const resetTime = new Date(codexLimits.primary.resetsAt * 1000);
          msg += `**短期窗口 (${windowHours}h) 使用量**:\n• 已用: ${used}%\n• 重置时间: ${formatDateTime24h(resetTime)}\n\n`;
        }

        if (codexLimits.secondary) {
          const used = codexLimits.secondary.usedPercent ?? 0;
          const windowHours = Math.round(codexLimits.secondary.windowDurationMins / 60);
          const resetTime = new Date(codexLimits.secondary.resetsAt * 1000);
          msg += `**长期窗口 (${windowHours}h) 使用量**:\n• 已用: ${used}%\n• 重置时间: ${formatDateTime24h(resetTime)}\n\n`;
        }
        
        if (codexLimits.credits && codexLimits.credits.hasCredits) {
          msg += `**点数余额**: ${codexLimits.credits.balance}\n`;
        }

        await sendSimpleStatusCard(chatId, "📊 账户用量统计", "blue", msg.trim());
      } catch (e: any) {
        console.error('Failed to execute usage command:', e);
        await sendSimpleStatusCard(chatId, "📊 获取用量失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.4.8. Handle /skills command
    if (text.startsWith('/skills')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        const queryCwd = bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();
        console.log(`Listing skills for cwd: ${queryCwd}`);
        const skillsRes = await adapter.request('skills/list', { cwds: [queryCwd] });
        console.log('Codex skills/list response:', JSON.stringify(skillsRes));
        
        const skillsCard = createSkillsCard(skillsRes, queryCwd);
        const cardId = await createCardKitCard(skillsCard);
        const skillsMsgId = await sendCardKitMessage(chatId, cardId);
        if (skillsMsgId) {
          bound.lastSkillsCardMessageId = skillsMsgId;
          saveSessions(sessionDb);
        }
      } catch (e: any) {
        console.error('Failed to execute skills command:', e);
        await sendSimpleStatusCard(chatId, "✨ 获取可用技能失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.5. Handle /new or /create command
    if (text.startsWith('/new') || text.startsWith('/create')) {
      try {
        const parts = text.split(/\s+/);
        let sessionName = parts.slice(1).join(" ").trim();

        if (!sessionName) {
          const now = new Date();
          const pad = (n: number) => n.toString().padStart(2, '0');
          const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
          sessionName = `飞书会话_${timeStr}`;
        }

        console.log(`Creating new Codex thread: "${sessionName}"`);
        
        const params: any = { threadSource: 'user' };
        const startRes = await adapter.request('thread/start', params);
        console.log('Codex thread/start response:', JSON.stringify(startRes));

        const thread = startRes?.thread || startRes;
        const threadId = thread?.id || startRes?.threadId;

        if (!threadId) {
          throw new Error('No thread ID returned from Codex App Server');
        }

        sessionDb[chatId] = {
          threadId: threadId,
          threadName: sessionName,
          cwd: thread?.cwd || ""
        };
        saveSessions(sessionDb);

        checkAndPushHistory().catch(e => {
          console.error('Failed to run history check after creating session:', e);
        });

        const successCard = createBoundSuccessCard(sessionName, threadId);
        const cardId = await createCardKitCard(successCard);
        await sendCardKitMessage(chatId, cardId);

      } catch (e: any) {
        console.error('Failed to create or bind Codex session:', e);
        await sendSimpleStatusCard(chatId, "🆕 创建会话失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.6. Handle /cwd or /workspace command
    if (text.startsWith('/cwd') || text.startsWith('/workspace')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }

      try {
        const parts = text.split(/\s+/);
        let newCwd = parts.slice(1).join(" ").trim();

        if (!newCwd) {
          const exploreCwd = exploreCwds.get(chatId);
          if (exploreCwd && exploreCwd !== bound.cwd) {
            newCwd = exploreCwd;
          }
        }

        if (!newCwd) {
          const currentCwd = bound.cwd || "未配置 (默认工作区)";
          await sendSimpleStatusCard(chatId, "📁 当前工作目录", "indigo", `当前会话 **${bound.threadName}** 的工作目录 (CWD) 为：\n\`${currentCwd}\``);
        } else {
          let finalCwd = newCwd;
          if (!path.isAbsolute(newCwd)) {
            const baseCwd = bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();
            finalCwd = path.resolve(baseCwd, newCwd);
          }

          try {
            const stats = fs.statSync(finalCwd);
            if (!stats.isDirectory()) {
              await sendSimpleStatusCard(chatId, "🚫 路径绑定失败", "red", `路径不是一个目录：\n\`${finalCwd}\``);
              return;
            }
          } catch (statErr: any) {
            if (statErr.code === 'ENOENT') {
              await sendSimpleStatusCard(chatId, "🚫 路径绑定失败", "red", `路径不存在：\n\`${finalCwd}\``);
              return;
            }
            const errMsg = statErr?.message || "";
            if (errMsg.includes("Operation not permitted") || errMsg.includes("EACCES")) {
              await sendSimpleStatusCard(chatId, "⚠️ 系统权限不足 (Operation not permitted)", "orange", `网桥程序无权访问该目录：\n\`${finalCwd}\`\n\n**建议解决办法**：\n1. 将项目移出 \`Documents\` / \`Desktop\` 等系统受限文件夹，移至例如 \`~/work/\` 下。\n2. 或者前往 macOS \`系统设置 -> 隐私与安全性 -> 完全磁盘访问权限\`，为您的终端应用或 node 启用读取权限。`);
            } else {
              await sendSimpleStatusCard(chatId, "🚫 无法访问该目录", "red", `${statErr.message || statErr}`);
            }
            return;
          }

          bound.cwd = finalCwd;
          saveSessions(sessionDb);
          exploreCwds.set(chatId, finalCwd);

          await sendSimpleStatusCard(chatId, "📁 工作目录绑定成功", "green", `已将当前会话 **${bound.threadName}** 的工作目录（CWD）绑定并保存为：\n\`${finalCwd}\``);
        }
      } catch (e: any) {
        console.error('Failed to update or query session CWD:', e);
        await sendSimpleStatusCard(chatId, "📁 设置工作目录失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.7. Handle /cmd or /run command
    if (text.startsWith('/cmd') || text.startsWith('/run') || text.startsWith('/shell')) {
      const parts = text.split(/\s+/);
      const command = text.substring(parts[0].length).trim();
      await executeUserCommand(chatId, command);
      return;
    }

    // 1.8. Handle /delete or /archive command
    if (text.startsWith('/delete') || text.startsWith('/archive')) {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，无须解绑。");
        return;
      }

      try {
        console.log(`Archiving and unbinding Codex Thread ${bound.threadId} for Chat ${chatId}...`);
        
        try {
          const archiveRes = await adapter.request('thread/archive', { threadId: bound.threadId });
          console.log('Codex thread/archive response:', JSON.stringify(archiveRes));
        } catch (archiveErr: any) {
          console.warn(`[Archive Warning] Failed to archive thread ${bound.threadId} on App Server:`, archiveErr.message || archiveErr);
        }

        const threadName = bound.threadName;
        delete sessionDb[chatId];
        saveSessions(sessionDb);

        await sendSimpleStatusCard(chatId, "🗑️ 会话归档解绑成功", "green", `已成功将当前聊天与 Codex 会话 **${threadName}** 解绑，并在本地完成归档。`);

      } catch (e: any) {
        console.error('Failed to unbind or archive session:', e);
        await sendSimpleStatusCard(chatId, "🗑️ 解绑失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.8.8. Handle /cancel or /stop command to abort the active turn
    const normalizedText = text.trim();
    if (normalizedText === '/cancel' || normalizedText === '/stop') {
      const bound = sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
        return;
      }
      try {
        console.log(`Attempting to cancel active turn for thread: ${bound.threadId}`);
        const activeTurnId = threadToActiveTurnId.get(bound.threadId);
        if (!activeTurnId) {
          await sendSimpleStatusCard(chatId, "🛑 无活跃任务", "grey", "当前会话没有正在运行的任务，无需取消。");
          return;
        }

        if (activeTurnId.startsWith('temp-')) {
          await sendSimpleStatusCard(chatId, "🛑 任务正在启动中", "orange", "任务正在启动，请在几秒后任务开始运行后再输入 `/cancel` 取消。");
          return;
        }

        // Send turn/interrupt request to App Server
        console.log(`Sending turn/interrupt for thread: ${bound.threadId}, turnId: ${activeTurnId}`);
        await adapter.request('turn/interrupt', { threadId: bound.threadId, turnId: activeTurnId });

        await sendSimpleStatusCard(chatId, "🛑 任务取消指令已发送", "grey", "已向 Codex 发送取消任务指令，任务正在中断中...");
      } catch (e: any) {
        console.error('Failed to cancel active turn:', e);
        await sendSimpleStatusCard(chatId, "🛑 取消任务失败", "red", `${e.message || e}`);
      }
      return;
    }

    // 1.9. Fallback: Any other command starting with '/' is executed directly as a shell command
    if (text.startsWith('/')) {
      const command = text.substring(1).trim();
      await executeUserCommand(chatId, command);
      return;
    }

    // 2. Handle normal user message (forward to Codex)
    const bound = sessionDb[chatId];
    if (!bound) {
      // Reply to user to prompt bind first
      await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
      return;
    }

    const boundCwd = bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();

    // Check if any skill is mentioned in the text or preset in session
    let matchedSkill: any = null;
    let cleanText = text;
    let turnInput: any[] | undefined = undefined;

    // First check if there is a preset active skill from dropdown selection
    if (bound.activeSkill) {
      matchedSkill = {
        name: bound.activeSkill.name,
        path: bound.activeSkill.path
      };
      const skillsCardMessageId = bound.lastSkillsCardMessageId;
      // Consume/clear it from database
      bound.activeSkill = null;
      bound.lastSkillsCardMessageId = null;
      saveSessions(sessionDb);
      console.log(`Consuming locked session skill: "${matchedSkill.name}"`);

      // Asynchronously patch the skills card to reset its visual state to cleared
      if (skillsCardMessageId) {
        (async () => {
          try {
            console.log(`Resetting visual state of skills card ${skillsCardMessageId} to cleared`);
            const skillsRes = await adapter.request('skills/list', { cwds: [boundCwd] });
            const clearedCard = createSkillsCard(skillsRes, boundCwd);
            await larkClient.im.message.patch({
              path: { message_id: skillsCardMessageId },
              data: { content: JSON.stringify(clearedCard) }
            });
          } catch (patchErr: any) {
            console.warn(`Failed to patch skills card to cleared state:`, patchErr.message || patchErr);
          }
        })();
      }
    }

    if (!matchedSkill) {
      try {
      console.log(`Checking skills list for inline @mention in cwd: ${boundCwd}`);
      const skillsRes = await adapter.request('skills/list', { cwds: [boundCwd] });
      const entries = skillsRes?.data || [];
      const allSkills: any[] = [];
      entries.forEach((entry: any) => {
        if (Array.isArray(entry.skills)) {
          entry.skills.forEach((skill: any) => {
            allSkills.push(skill);
          });
        }
      });

      // Sort skills by name length descending to ensure longer names match first
      allSkills.sort((a, b) => b.name.length - a.name.length);

      for (const skill of allSkills) {
        const escapedName = skill.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const regex = new RegExp(`@${escapedName}\\b`, 'i');
        if (regex.test(text)) {
          matchedSkill = skill;
          cleanText = text.replace(regex, '').trim();
          break;
        }

        // Alternative match without word boundary for non-english/unicode skill names
        const mentionStr = `@${skill.name.toLowerCase()}`;
        const lowerText = text.toLowerCase();
        const mentionIdx = lowerText.indexOf(mentionStr);
        if (mentionIdx !== -1) {
          const beforeChar = mentionIdx > 0 ? lowerText[mentionIdx - 1] : ' ';
          const afterChar = mentionIdx + mentionStr.length < lowerText.length ? lowerText[mentionIdx + mentionStr.length] : ' ';
          const isWordBoundary = (char: string) => /[\s\p{P}]/u.test(char);
          if (isWordBoundary(beforeChar) && isWordBoundary(afterChar)) {
            matchedSkill = skill;
            cleanText = text.substring(0, mentionIdx) + text.substring(mentionIdx + mentionStr.length);
            cleanText = cleanText.replace(/\s+/g, ' ').trim();
            break;
          }
        }
      }

      if (matchedSkill) {
        console.log(`Matched skill mention: "${matchedSkill.name}" (path: ${matchedSkill.path})`);
        turnInput = [
          { type: "skill", name: matchedSkill.name, path: matchedSkill.path },
          { type: "text", text: cleanText, text_elements: [] }
        ];
      }
    } catch (skillsErr) {
      console.warn('Failed to query or parse skills list for @mention:', skillsErr);
    }
  }

    // Send initial running log card
    let logCardMessageId = "";
    try {
      const initialTurn: ActiveTurn = {
        chatId,
        messageId: "",
        cardId: "",
        threadId: bound.threadId,
        prompt: text,
        logs: [matchedSkill ? `⚡️ 正在调用技能 [${matchedSkill.name}] 启动 Remote Control...` : "Starting remote control turn..."],
        status: 'running',
        dirty: false,
        startedAt: Date.now(),
        stats: {},
        sequence: 1,
        skillName: matchedSkill ? matchedSkill.name : undefined,
        collaborationMode: bound.planMode ? "plan" : null,
        personality: bound.personality || null
      };
      
      const initialLayout = createCardKitInitialLayout(initialTurn);
      const cardId = await createCardKitCard(initialLayout);
      initialTurn.cardId = cardId;

      const resMessageId = await sendCardKitMessage(chatId, cardId);
      logCardMessageId = resMessageId;
      if (!logCardMessageId) {
        throw new Error("Failed to retrieve Feishu log card message ID");
      }
      
      initialTurn.messageId = logCardMessageId;

      console.log(`Starting Remote Control Turn for Thread: ${bound.threadId}, Prompt: "${text}"`);
      
      const tempTurnId = 'temp-' + crypto.randomUUID();
      activeTurns.set(tempTurnId, initialTurn);
      threadToActiveTurnId.set(bound.threadId, tempTurnId);

      // Asynchronously trigger Codex remote control to avoid blocking Feishu events (which triggers retries)
      (async () => {
        try {
          // Determine workspaceKind from Codex global state
          const homeDir = os.homedir();
          const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
          let isProjectless = false;
          if (fs.existsSync(globalStatePath)) {
            try {
              const globalState = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
              const projectlessThreadIds = globalState['projectless-thread-ids'] || [];
              isProjectless = !!(bound.threadId && projectlessThreadIds.includes(bound.threadId));
            } catch (e) {}
          }

          const turnId = await adapter.startRemoteControlTurn({
            threadId: bound.threadId,
            cwd: boundCwd,
            prompt: text,
            workspaceKind: isProjectless ? 'projectless' : 'project',
            input: turnInput,
            collaborationMode: bound.planMode ? "plan" : null,
            personality: bound.personality || null
          });

          // Replace the temporary turn ID with the actual turn ID
          activeTurns.delete(tempTurnId);
          activeTurns.set(turnId, initialTurn);
          threadToActiveTurnId.set(bound.threadId, turnId);
          console.log(`Remote turn started and mapped with ID: ${turnId}`);
        } catch (e: any) {
          console.error('Asynchronous Codex turn trigger failed:', e);
          activeTurns.delete(tempTurnId);
          const activeTurnId = threadToActiveTurnId.get(bound.threadId);
          if (activeTurnId === tempTurnId) {
            threadToActiveTurnId.delete(bound.threadId);
          }
          
          // Update the card to show failure
          if (logCardMessageId) {
            try {
              await larkClient.im.message.patch({
                path: { message_id: logCardMessageId },
                data: {
                  content: JSON.stringify({
                    schema: "2.0",
                    config: { wide_screen_mode: true },
                    header: { template: "red", title: { tag: "plain_text", content: "Codex Error" } },
                    body: {
                      elements: [
                        { tag: "markdown", content: `**Prompt**: ${text}` },
                        { tag: "markdown", content: `**Failed to trigger turn**: ${e.message || e}` }
                      ]
                    }
                  })
                }
              });
            } catch (patchErr) {
              console.error('Failed to patch error message card asynchronously:', patchErr);
            }
          }
        }
      })();

    } catch (e: any) {
      console.error('Failed to trigger Codex turn:', e);
      if (logCardMessageId) {
        // Update the card to show failure
        try {
          await larkClient.im.message.patch({
            path: { message_id: logCardMessageId },
            data: {
              content: JSON.stringify({
                schema: "2.0",
                config: { wide_screen_mode: true },
                header: { template: "red", title: { tag: "plain_text", content: "Codex Error" } },
                body: {
                  elements: [
                    { tag: "markdown", content: `**Prompt**: ${text}` },
                    { tag: "markdown", content: `**Failed to trigger turn**: ${e.message || e}` }
                  ]
                }
              })
            }
          });
        } catch (patchErr) {
          console.error('Failed to patch error message card:', patchErr);
        }
      } else {
        await sendSimpleStatusCard(chatId, "❌ 启动 turn 失败", "red", `无法启动 Codex 会话执行。请确保 Codex 桌面客户端已经启动。\n\n**详细错误**:\n${e.message || e}`);
      }
    }
  } catch (err: any) {
      console.error('Asynchronous message handler failed:', err);
    }
  })();
  },

  'card.action.trigger': async (data: any) => {
    console.log('Received card interaction callback:', JSON.stringify(data, null, 2));

    const context = data.context || {};
    const action = data.action || {};

    const messageId = context.open_message_id;
    const chatId = context.open_chat_id;

    const actionValue = action.value || {};
    
    // 0. Handle skills select view
    if (actionValue.action === 'skills_select_view') {
      const selectedSkillName = action.option;
      const selectCwd = actionValue.cwd;
      if (selectedSkillName) {
        try {
          console.log(`User selected skill: ${selectedSkillName} in CWD: ${selectCwd}`);
          const skillsRes = await adapter.request('skills/list', { cwds: [selectCwd] });

          if (selectedSkillName === "__CLEAR_SKILL__") {
            const bound = sessionDb[chatId];
            if (bound) {
              bound.activeSkill = null;
              saveSessions(sessionDb);
              console.log(`Cleared active skill lock for chat ${chatId}`);
            }
            const updatedCard = createSkillsCard(skillsRes, selectCwd);
            await larkClient.im.message.patch({
              path: {
                message_id: messageId
              },
              data: {
                content: JSON.stringify(updatedCard)
              }
            });
            return;
          }

          // Find the skill object to get its path
          const entries = skillsRes?.data || [];
          let targetSkill: any = null;
          entries.forEach((entry: any) => {
            if (Array.isArray(entry.skills)) {
              entry.skills.forEach((skill: any) => {
                if (skill.name === selectedSkillName) {
                  targetSkill = skill;
                }
              });
            }
          });

          if (targetSkill) {
            const bound = sessionDb[chatId];
            if (bound) {
              bound.activeSkill = {
                name: targetSkill.name,
                path: targetSkill.path
              };
              bound.lastSkillsCardMessageId = messageId;
              saveSessions(sessionDb);
              console.log(`Successfully locked skill "${targetSkill.name}" for the next turn in chat ${chatId}`);
            }
          }

          const updatedCard = createSkillsCard(skillsRes, selectCwd, selectedSkillName);
          await larkClient.im.message.patch({
            path: {
              message_id: messageId
            },
            data: {
              content: JSON.stringify(updatedCard)
            }
          });
        } catch (e: any) {
          console.error('Failed to update skills card with selected skill:', e);
        }
      }
      return;
    }
    
    // 1. Handle session binding
    if (action.action_id === 'bind_select_thread' || actionValue.action === 'bind_select_thread') {
      const selectedThreadId = action.option || actionValue.threadId;
      if (!selectedThreadId) return;

      try {
        console.log(`Binding Chat ${chatId} to Codex Thread ${selectedThreadId}...`);
        
        // Fetch thread list to get the name of the thread
        const threads = await adapter.listThreads();
        const selectedThread = threads.find(t => t.id === selectedThreadId);
        const threadName = selectedThread ? selectedThread.name : `Session (${selectedThreadId})`;

        // Save mapping
        sessionDb[chatId] = {
          threadId: selectedThreadId,
          threadName: threadName,
          cwd: selectedThread ? selectedThread.cwd : ""
        };
        saveSessions(sessionDb);

        // Run history check immediately for this new session
        checkAndPushHistory().catch(e => {
          console.error('Failed to run history check after binding:', e);
        });

        // Update card to Success State
        const successCard = createBoundSuccessCard(threadName, selectedThreadId);
        await larkClient.im.message.patch({
          path: {
            message_id: messageId
          },
          data: {
            content: JSON.stringify(successCard)
          }
        });

        // Return a toast
        return {
          toast: {
            type: "success",
            content: "Bound successfully",
            i18n: {
              zh_cn: "成功绑定到 Codex 会话",
              en_us: "Successfully bound to Codex Session"
            }
          }
        };

      } catch (e: any) {
        console.error('Failed to update bind mapping:', e);
        return {
          toast: {
            type: "error",
            content: `Binding failed: ${e.message || e}`,
            i18n: {
              zh_cn: `绑定失败: ${e.message || e}`,
              en_us: `Binding failed: ${e.message || e}`
            }
          }
        };
      }
    }

    // 2. Handle approval decision callback
    if (actionValue.action === 'approval_decision') {
      const { approvalId, decision } = actionValue;
      let approval = activeApprovals.get(approvalId);
      if (!approval) {
        // Try reloading approvals from approvals.json to handle multi-instance or daemon restarts
        try {
          const reloaded = loadApprovals();
          approval = reloaded.get(approvalId);
          if (approval) {
            activeApprovals.set(approvalId, approval);
            console.log(`[Cache Sync] Successfully reloaded approval ${approvalId} from disk.`);
          }
        } catch (reloadErr) {
          console.error('Failed to reload approvals from approvals.json:', reloadErr);
        }
      }

      if (!approval) {
        return {
          toast: {
            type: "error",
            content: "Approval request not found or expired",
            i18n: {
              zh_cn: "未找到该审批请求或已过期",
              en_us: "Approval request not found or expired"
            }
          }
        };
      }

      // Validate allowed approver if configured in environment and not a single/p2p chat
      let allowedApproversStr = process.env.ALLOWED_APPROVERS;
      let isSingleChat = context.chat_type === 'p2p' || context.chat_type === 'direct';
      
      if (!isSingleChat) {
        try {
          const chatInfo = await larkClient.im.chat.get({
            path: {
              chat_id: chatId
            }
          });
          const chatMode = chatInfo?.data?.chat_mode;
          if (chatMode === 'p2p') {
            isSingleChat = true;
          }
        } catch (err) {
          console.error(`Failed to fetch chat mode for chat ${chatId}:`, err);
        }
      }

      const clickerOpenId = data.operator?.open_id;

      if (allowedApproversStr) {
        const allowedList = allowedApproversStr.split(',').map(id => id.trim()).filter(Boolean);
        if (allowedList.length > 0 && (!clickerOpenId || !allowedList.includes(clickerOpenId))) {
          console.warn(`Unauthorized approval attempt: user ${clickerOpenId} tried to make decision on ${approvalId} (chatType: ${context.chat_type})`);
          return {
            toast: {
              type: "error",
              content: "You are not authorized to make decisions on this approval",
              i18n: {
                zh_cn: "您无权对该审批做出决策",
                en_us: "You are not authorized to make decisions on this approval"
              }
            }
          };
        }
      }

      // Atomically delete from map and persist before any async operations to prevent double-triggering
      activeApprovals.delete(approvalId);
      saveApprovals(activeApprovals);

      try {
        console.log(`Responding to Codex Approval ${approval.requestId} with decision ${decision}...`);
        
        // Respond to Codex via adapter
        let success = true;
        if (approval.isIpc && (adapter as any).respondIpcApproval) {
          success = await (adapter as any).respondIpcApproval({
            threadId: approval.threadId,
            requestId: approval.requestId,
            method: approval.approvalMethod || 'command',
            decision: decision
          });
          console.log(`IPC approval response returned: ${success}`);
        } else {
          adapter.respond(approval.requestId, { decision });
        }

        // Update card to finished state
        const decidedCard = createApprovalDecidedCard(
          approval.approvalType,
          approval.cwd,
          approval.summary,
          approval.reason,
          decision
        );
        await larkClient.im.message.patch({
          path: {
            message_id: messageId
          },
          data: {
            content: JSON.stringify(decidedCard)
          }
        });

        return {
          card: {
            type: "card_json",
            data: decidedCard
          },
          toast: {
            type: "success",
            content: `Decision: ${decision} submitted`,
            i18n: {
              zh_cn: `已提交决策: ${decision === 'accept' ? '批准' : (decision === 'acceptForSession' ? '总是批准' : '拒绝')}`,
              en_us: `Decision: ${decision} submitted`
            }
          }
        };
      } catch (e: any) {
        console.error('Failed to submit approval decision:', e);
        return {
          toast: {
            type: "error",
            content: `Failed: ${e.message || e}`,
            i18n: {
              zh_cn: `提交决策失败: ${e.message || e}`,
              en_us: `Failed to submit decision: ${e.message || e}`
            }
          }
        };
      }
    }
  }
});

// Helper to resolve active turn from notification
function getActiveTurnForNotification(msg: any): ActiveTurn | undefined {
  const params = msg.params || {};
  
  // Try mapping by turnId first
  const turnId = params.turnId || (params.turn && params.turn.id);
  if (turnId) {
    if (activeTurns.has(turnId)) {
      return activeTurns.get(turnId);
    }
    if (recentTurns.has(turnId)) {
      return recentTurns.get(turnId);
    }
  }

  // Fallback to threadId mapping
  const threadId = params.threadId;
  if (threadId) {
    const activeTurnId = threadToActiveTurnId.get(threadId);
    if (activeTurnId) {
      const turn = activeTurns.get(activeTurnId);
      if (turn && turnId && activeTurnId !== turnId && activeTurnId.startsWith('temp-')) {
        console.log(`[Turn Transition in resolver] Migrating active turn mapping for thread ${threadId} from ${activeTurnId} to ${turnId}`);
        activeTurns.set(turnId, turn);
        threadToActiveTurnId.set(threadId, turnId);
        activeTurns.delete(activeTurnId);
      }
      return turn;
    }
    if (recentTurns.has(threadId)) {
      return recentTurns.get(threadId);
    }
  }

  return undefined;
}

function getChatIdForThread(threadId: string): string | undefined {
  for (const chatId in sessionDb) {
    if (sessionDb[chatId].threadId === threadId) {
      return chatId;
    }
  }
  return undefined;
}

function parseCodexTurnToActiveTurn(chatId: string, threadId: string, turn: any): ActiveTurn {
  let prompt = "";
  let reasoning = "";
  let answer = "";
  const logs: string[] = [];
  let skillName = "";
  let commandExecutionCount = 0;

  if (Array.isArray(turn.input)) {
    const textItem = turn.input.find((inp: any) => inp && inp.type === 'text');
    if (textItem && textItem.text) {
      prompt = textItem.text;
    }
    const skillItem = turn.input.find((inp: any) => inp && inp.type === 'skill');
    if (skillItem && skillItem.name) {
      skillName = skillItem.name;
    }
  }

  const items = turn.items || [];
  for (const item of items) {
    if (item.type === 'userMessage') {
      const text = (item.content && item.content[0] && item.content[0].text) || "";
      if (text && !prompt) prompt = text.trim();
    } else if (item.type === 'agentMessage') {
      if (item.phase === 'commentary') {
        reasoning += (item.text || "");
      } else {
        answer += (item.text || "");
      }
    } else if (item.type === 'reasoning') {
      reasoning += (item.text || "");
    } else if (item.type === 'commandExecution') {
      commandExecutionCount++;
      if (commandExecutionCount === 1) {
        const cmd = item.command || "";
        const exitCode = item.exitCode;
        const exitStatus = exitCode === 0 ? "成功" : (exitCode !== undefined ? `失败 (Exit Code: ${exitCode})` : "完成");
        
        const separator = reasoning ? `\n\n---\n` : ``;
        let cmdDisplay = cmd;
        if (cmdDisplay.length > 120) {
          cmdDisplay = cmdDisplay.substring(0, 120) + '...';
        }
        
        let outputLog = "";
        if (item.aggregatedOutput && typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
          let out = item.aggregatedOutput.trim();
          const limit = 800;
          if (out.length > limit) {
            out = out.substring(0, limit / 2) + '\n... (truncated) ...\n' + out.substring(out.length - limit / 2);
          }
          outputLog = `\n\`\`\`text\n${out}\n\`\`\``;
        }
        
        reasoning += `${separator}🛠️ 运行命令: \`${cmdDisplay}\`\n📌 命令执行结束: ${exitStatus}${outputLog}`;
      } else if (commandExecutionCount === 2) {
        reasoning += `\n\n---\n📎 *后续执行指令已自动折叠*`;
      }
    }
  }

  const status = turn.status === 'completed' ? 'success' : (turn.status === 'failed' ? 'failed' : 'running');

  return {
    chatId,
    messageId: "",
    threadId,
    prompt: prompt || "Empty Prompt",
    answer: answer || undefined,
    reasoning: reasoning || undefined,
    logs,
    status,
    dirty: false,
    startedAt: turn.startedAt ? turn.startedAt * 1000 : undefined,
    completedAt: turn.completedAt ? turn.completedAt * 1000 : undefined,
    stats: extractStatsFromParams(turn),
    sequence: 1,
    isHistory: true,
    skillName: skillName || undefined,
    collaborationMode: turn.collaborationMode || null,
    personality: turn.personality || null
  };
}

async function checkAndPushHistory() {
  console.log('Checking for history turns to push to Feishu...');
  let sessionsChanged = false;
  let pushedTurnsChanged = false;

  const promises = Object.entries(sessionDb).map(async ([chatId, session]) => {
    console.log(`Checking history for Feishu Chat ${chatId} / Codex Thread ${session.threadId}...`);
    try {
      // Fetch thread history
      const result = await adapter.request('thread/resume', { threadId: session.threadId });
      const turns = result?.thread?.turns || [];
      
      // Find the most recent completed or failed turn
      let latestCompletedTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (turn.status === 'completed' || turn.status === 'failed') {
          latestCompletedTurn = turn;
          break;
        }
      }

      if (latestCompletedTurn) {
        // If we've already pushed this turn or it matches the last pushed turn, skip
        if (session.lastPushedTurnId === latestCompletedTurn.id || pushedTurns.has(latestCompletedTurn.id)) {
          console.log(`History turn ${latestCompletedTurn.id} for thread ${session.threadId} is already pushed. Skipping.`);
          if (session.lastPushedTurnId !== latestCompletedTurn.id) {
            session.lastPushedTurnId = latestCompletedTurn.id;
            sessionsChanged = true;
          }
          return;
        }

        console.log(`Found latest completed turn ${latestCompletedTurn.id} for thread ${session.threadId}. Pushing to Feishu...`);
        
        const activeTurn = parseCodexTurnToActiveTurn(chatId, session.threadId, latestCompletedTurn);
        if (result?.model) {
          activeTurn.stats.model = result.model;
        }
        await fetchRateLimitsForTurn(activeTurn);
        const finalLayout = createCardKitFinalLayout(activeTurn);
        
        // Send to Feishu
        const cardId = await createCardKitCard(finalLayout);
        const messageId = await sendCardKitMessage(chatId, cardId);
        
        if (messageId) {
          console.log(`Successfully pushed history turn ${latestCompletedTurn.id} to Feishu Message ${messageId}`);
          // Save state
          session.lastPushedTurnId = latestCompletedTurn.id;
          sessionsChanged = true;
          // Save globally
          pushedTurns.add(latestCompletedTurn.id);
          pushedTurnsChanged = true;
        }
      } else {
        console.log(`No completed/failed turns found in history for thread ${session.threadId}`);
        if (session.lastPushedTurnId !== null && session.lastPushedTurnId !== undefined) {
          session.lastPushedTurnId = undefined;
          sessionsChanged = true;
        }
      }
    } catch (e) {
      console.error(`Failed to push history for thread ${session.threadId}:`, e);
    }
  });

  await Promise.all(promises);

  if (sessionsChanged) {
    saveSessions(sessionDb);
  }
  if (pushedTurnsChanged) {
    savePushedTurns(pushedTurns);
  }
}

let isReconnecting = false;
let reconnectAttempts = 0;

async function connectWithRetry() {
  if (isReconnecting) return;
  isReconnecting = true;

  while (true) {
    try {
      console.log(`Connecting to Codex App Server (attempt ${reconnectAttempts + 1})...`);
      await adapter.connect();
      console.log('Codex App Server connection established.');
      reconnectAttempts = 0;
      isReconnecting = false;
      
      // Run history check asynchronously
      checkAndPushHistory().catch(e => {
        console.error('Failed to run startup history check:', e);
      });
      break;
    } catch (err: any) {
      reconnectAttempts++;
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
      console.error(`Connection to Codex failed: ${err.message || err}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Connect to Codex App Server
async function initCodex() {
  adapter.onExit(() => {
    console.warn('Codex App Server disconnected.');
    const snapshot = Array.from(activeTurns.entries());
    activeTurns.clear();
    threadToActiveTurnId.clear();
    for (const [turnId, turn] of snapshot) {
      turn.status = 'failed';
      const errorMsg = `\n⚠️ *[System]*: Codex App Server disconnected unexpectedly.`;
      turn.reasoning = (turn.reasoning || "") + errorMsg;
      if (turn.cardId) {
        const finalLayout = createCardKitFinalLayout(turn);
        finalizeCardKitCard(turn.cardId, finalLayout, turn).catch(e =>
          console.error('Failed to finalize card on exit:', e)
        );
      }
    }

    // Automatically trigger reconnect loop on exit
    connectWithRetry().catch(e => {
      console.error('Reconnection loop encountered a fatal error:', e);
    });
  });

  // Start the initial connection flow
  await connectWithRetry();

  adapter.onNotification(async (msg) => {
    // Log the notification (skip high-frequency deltas to keep console I/O fast)
    if (msg.method !== 'item/reasoning/delta' && msg.method !== 'item/agentMessage/delta') {
      console.log(`[Codex Notification]:`, redactSecrets(JSON.stringify(msg)));
    }

    const params = msg.params || {};

    // 1. Intercept Codex approval request
    if (msg.id !== undefined && msg.method && msg.method.toLowerCase().includes("approval")) {
      const approvalId = 'apr-' + crypto.randomUUID();
      const type = params.approvalType || params.type || "操作审批";
      
      const summaryKeys = ["cmd", "command", "path", "file", "summary", "reason"];
      let summary = "";
      for (const key of summaryKeys) {
        if (params[key]) {
          summary = String(params[key]);
          break;
        }
      }
      if (!summary) {
        summary = JSON.stringify(params);
      }
      
      const cwd = params.cwd || "";
      const threadId = params.threadId || (params.turn && params.turn.threadId);
      const turnId = params.turnId || (params.turn && params.turn.id);
      
      const chatId = threadId ? getChatIdForThread(threadId) : undefined;
      if (chatId) {
        (async () => {
          try {
            // Check approvalsReviewer first
            if (threadId) {
              const resumeRes = await adapter.request('thread/resume', { threadId });
              let reviewer = resumeRes?.approvalsReviewer || 'user';
              if (resumeRes?.thread?.turns && Array.isArray(resumeRes.thread.turns) && resumeRes.thread.turns.length > 0) {
                const lastTurn = resumeRes.thread.turns[resumeRes.thread.turns.length - 1];
                if (lastTurn?.params?.approvalsReviewer) {
                  reviewer = lastTurn.params.approvalsReviewer;
                }
              }
              if (reviewer !== 'user') {
                console.log(`[Approval Request] approvalsReviewer is "${reviewer}" (not "user"), skipping Feishu card for request ${msg.id}.`);
                return;
              }
            }

            console.log(`[Approval Request] Intercepted approval request ${msg.id} for thread ${threadId} (isIpc: ${!!msg.isIpc}). Sending Feishu card...`);
            
            activeApprovals.set(approvalId, {
              requestId: msg.id,
              chatId,
              threadId: threadId || "",
              turnId: turnId || "",
              approvalType: type,
              summary,
              cwd,
              reason: params.reason || "",
              isIpc: !!msg.isIpc,
              approvalMethod: msg.method,
              createdAt: Date.now()
            });
            saveApprovals(activeApprovals);

            const appCard = createApprovalCard(approvalId, type, cwd, summary, params.reason);
            const cardId = await createCardKitCard(appCard);
            await sendCardKitMessage(chatId, cardId);
          } catch (e) {
            console.error('Failed to process approval request:', e);
            activeApprovals.delete(approvalId);
            saveApprovals(activeApprovals);
            try {
              if (msg.isIpc && (adapter as any).respondIpcApproval) {
                await (adapter as any).respondIpcApproval({
                  threadId: threadId || "",
                  requestId: msg.id,
                  method: msg.method,
                  decision: 'reject'
                });
              } else {
                adapter.respond(msg.id, { decision: 'reject' });
              }
            } catch (respondErr) {
              console.error('Failed to reject failed approval request:', respondErr);
            }
          }
        })();
      }
      return;
    }

    let turn = getActiveTurnForNotification(msg);

    if (!turn) {
      // Check if this event belongs to an active turn on a bound thread
      const threadId = params.threadId || (params.turn && params.turn.threadId);
      const turnId = params.turnId || (params.turn && params.turn.id);
      
      const isTurnEvent = msg.method === 'turn/started' || 
                          msg.method === 'turn/completed' || 
                          (msg.method && msg.method.startsWith('item/')) || 
                          (msg.method && msg.method.startsWith('agent/'));

      if (isTurnEvent && threadId && turnId) {
        const chatId = getChatIdForThread(threadId);
        
        if (chatId) {
          // Check if there is already an active running turn on this thread (e.g. triggered by Feishu)
          const activeTurnId = threadToActiveTurnId.get(threadId);
          const existingTurn = activeTurnId ? activeTurns.get(activeTurnId) : undefined;
          
          if (existingTurn && existingTurn.status === 'running' && activeTurnId && activeTurnId.startsWith('temp-')) {
            console.log(`[Turn Transition] Adopting new turnId ${turnId} for existing active turn (old: ${activeTurnId})`);
            activeTurns.set(turnId, existingTurn);
            threadToActiveTurnId.set(threadId, turnId);
            
            // Clean up old ID mapping if different
            if (activeTurnId && activeTurnId !== turnId) {
              activeTurns.delete(activeTurnId);
            }
            
            // Link the local turn variable so subsequent parsing in this notification step runs normally
            turn = existingTurn;
          } else {
            // This is a true reverse push from Codex Desktop UI, create a new card
            console.log(`[Reverse Push] Detected turn ${turnId} activity on bound thread ${threadId}. Creating Feishu message card...`);
            
            let desktopPrompt = msg.method === 'turn/started' ? "Desktop Input 💻" : "Resumed from Desktop 💻";
            let desktopSkillName = "";
            const turnData = params.turn || {};
            if (Array.isArray(turnData.input)) {
              const textItem = turnData.input.find((inp: any) => inp && inp.type === 'text');
              if (textItem && textItem.text) {
                desktopPrompt = textItem.text;
              }
              const skillItem = turnData.input.find((inp: any) => inp && inp.type === 'skill');
              if (skillItem && skillItem.name) {
                desktopSkillName = skillItem.name;
              }
            }
            const desktopCollaborationMode = turnData.collaborationMode || null;
            const desktopPersonality = turnData.personality || null;

            const reverseTurn: ActiveTurn = {
              chatId,
              messageId: "",
              cardId: "",
              threadId: threadId,
              prompt: desktopPrompt,
              logs: ["Synchronizing execution state from Codex..."],
              status: 'running',
              dirty: false,
              startedAt: Date.now(),
              stats: {},
              sequence: 1,
              skillName: desktopSkillName || undefined,
              collaborationMode: desktopCollaborationMode,
              personality: desktopPersonality
            };

            activeTurns.set(turnId, reverseTurn);
            threadToActiveTurnId.set(threadId, turnId);

            // Trigger asynchronous Feishu message creation
            (async () => {
              try {
                // Proactively subscribe to thread events on WebSocket connection and sync model info
                try {
                  const result = await adapter.request('thread/resume', { threadId });
                  if (result && result.model && !reverseTurn.stats.model) {
                    reverseTurn.stats.model = result.model;
                    reverseTurn.dirty = true;
                  }
                } catch (wsErr) {
                  console.warn(`[Reverse Push] WS subscription fallback failed for thread ${threadId}:`, wsErr);
                }

                const initialLayout = createCardKitInitialLayout(reverseTurn);
                const cardId = await createCardKitCard(initialLayout);
                reverseTurn.cardId = cardId;
                
                const newMsgId = await sendCardKitMessage(chatId, cardId);
                if (newMsgId) {
                  reverseTurn.messageId = newMsgId;
                  // Immediate update in case we already have logs
                  queueTurnTask(turnId, async () => {
                    await streamUpdateCardKit(reverseTurn);
                  });
                } else {
                  cleanupTurn(turnId, threadId);
                }
              } catch (e) {
                console.error('[Reverse Push] Failed to create reverse card:', e);
                cleanupTurn(turnId, threadId);
              }
            })();
            
            turn = reverseTurn;
          }
        }
      }
    }

    if (!turn) return;

    // Sync metadata from turn parameter if present
    if (params.turn) {
      const turnData = params.turn;
      if (Array.isArray(turnData.input)) {
        const skillItem = turnData.input.find((inp: any) => inp && inp.type === 'skill');
        if (skillItem && skillItem.name) {
          turn.skillName = skillItem.name;
        }
      }
      if (turnData.collaborationMode !== undefined) {
        turn.collaborationMode = turnData.collaborationMode;
      }
      if (turnData.personality !== undefined) {
        turn.personality = turnData.personality;
      }
    }

    // Extract stats dynamically if present in parameters
    const stats = extractStatsFromParams(params);
    const jsonStr = JSON.stringify(params);
    if (jsonStr.match(/token/i)) {
      try {
        const fs = require('fs');
        fs.writeFileSync('/Users/jiang/work/ai/codex/bridge/params_debug_stats.json', JSON.stringify({ method: msg.method, params, extractedStats: stats }, null, 2));
      } catch (e) {}
    }
    for (const key of Object.keys(stats)) {
      if ((stats as any)[key] !== undefined) {
        (turn.stats as any)[key] = (stats as any)[key];
      }
    }

    if (msg.method === 'turn/completed') {
      try {
        const fs = require('fs');
        fs.writeFileSync('/Users/jiang/work/ai/codex/bridge/params_debug.json', JSON.stringify(params, null, 2));
      } catch (e) {
        // ignore
      }
      console.log(`Turn completed for thread ${turn.threadId}`);
      let finalStatus: 'success' | 'failed' | 'interrupted' = 'success';
      if (params.turn && params.turn.status === 'interrupted') {
        finalStatus = 'interrupted';
      } else if (params.error) {
        finalStatus = 'failed';
      }

      if (finalStatus === 'interrupted') {
        const errorMsg = `\n⚠️ *[System]*: Turn was manually interrupted/canceled by the user.`;
        turn.reasoning = (turn.reasoning || "") + errorMsg;
      } else if (params.error) {
        const errorMsg = `\n❌ *[Error]*: ${params.error.message || JSON.stringify(params.error)}`;
        turn.reasoning = (turn.reasoning || "") + errorMsg;
      }
      turn.dirty = true;
      turn.completedAt = Date.now();
      
      // Set status synchronously to avoid race condition in async finalize
      turn.status = finalStatus;
      
      // Finalize CardKit Card
      const rawTurnId = params.turnId || (params.turn && params.turn.id);
      let targetTurnId: string | undefined;
      if (rawTurnId && activeTurns.has(rawTurnId)) {
        targetTurnId = rawTurnId;
      } else {
        targetTurnId = threadToActiveTurnId.get(turn.threadId);
      }

      if (!targetTurnId) {
        console.warn(`[turn/completed] Cannot resolve targetTurnId for thread ${turn.threadId}, skipping queue`);
        turn.status = finalStatus;
      } else {
        const finalTargetTurnId = targetTurnId;
        if (turn.cardId) {
          const cId = turn.cardId;
          queueTurnTask(finalTargetTurnId, async () => {
            try {
              // Fetch rate limits to append to the footer
              await fetchRateLimitsForTurn(turn);

              // Perform one last stream update to flush any remaining dirty changes
              await streamUpdateCardKit(turn);
            } finally {
              // Set final status and remove from active turns mapping immediately to unlock the thread
              turn.status = finalStatus;
              cleanupTurn(finalTargetTurnId, turn.threadId);
            }
          });

          // Perform the finalization asynchronously outside the queue to avoid blocking
          (async () => {
            try {
              const totalLength = (turn.reasoning || "").length + (turn.answer || "").length;
              const delayMs = Math.min(8000, Math.max(1000, (totalLength * 10) + 500));
              console.log(`[Async Finalize] Waiting ${delayMs}ms for typewriter animation to catch up (total chars: ${totalLength})...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
              const finalLayout = createCardKitFinalLayout(turn);
              await finalizeCardKitCard(cId, finalLayout, turn);
              console.log(`[Async Finalize] Card ${cId} finalized successfully.`);
            } catch (finalizeErr) {
              console.error('Asynchronous card finalization failed:', finalizeErr);
            }
          })();
        } else {
          turn.status = finalStatus;
          cleanupTurn(finalTargetTurnId, turn.threadId);
          
          // P1-13: If cardId is empty, send a fallback text message notification
          try {
            const statusText = finalStatus === 'success' ? '✅ 执行成功' : (finalStatus === 'interrupted' ? '🛑 已中断' : '❌ 执行失败');
            const summary = turn.prompt ? `"${turn.prompt.substring(0, 50)}${turn.prompt.length > 50 ? '...' : ''}"` : '本地任务';
            const statusMsg = `Codex 任务执行完成 (${statusText})：\n输入: ${summary}`;
            await larkClient.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: turn.chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: statusMsg })
              }
            });
          } catch (sendErr) {
            console.error('Failed to send fallback text notification for turn completion:', sendErr);
          }
        }
      }
      
      // Retrieve the turnId
      const turnId = rawTurnId;
      if (turnId) {
        // Add to global pushed turns
        pushedTurns.add(turnId);
        savePushedTurns(pushedTurns);

        // Update lastPushedTurnId in sessions
        for (const [chatId, session] of Object.entries(sessionDb)) {
          if (session.threadId === turn.threadId) {
            session.lastPushedTurnId = turnId;
            saveSessions(sessionDb);
            break;
          }
        }
      }
    } else if (msg.method === 'turn/started') {
      turn.dirty = true;
      turn.lastRateLimitQueryAt = Date.now();
      fetchRateLimitsForTurn(turn);
      // Proactively subscribe to thread events and sync model info
      (async () => {
        try {
          const result = await adapter.request('thread/resume', { threadId: turn.threadId });
          if (result && result.model && !turn.stats.model) {
            turn.stats.model = result.model;
            turn.dirty = true;
          }
        } catch (err) {
          console.warn(`Failed to subscribe to thread ${turn.threadId} on WS in turn/started:`, err);
        }
      })();
    } else if (msg.method === 'item/agentMessage/delta') {
      const delta = params.delta;
      if (delta) {
        if (turn.activeStream === 'reasoning') {
          if (turn.pendingReasoningHeader) {
            turn.reasoning = (turn.reasoning || "") + turn.pendingReasoningHeader;
            turn.pendingReasoningHeader = undefined;
          }
          turn.reasoning = (turn.reasoning || "") + delta;
        } else {
          turn.answer = (turn.answer || "") + delta;
          turn.activeStream = 'answer';
        }
        turn.dirty = true;
      }
    } else if (msg.method === 'item/reasoning/delta') {
      const delta = params.delta;
      if (delta) {
        if (turn.pendingReasoningHeader) {
          turn.reasoning = (turn.reasoning || "") + turn.pendingReasoningHeader;
          turn.pendingReasoningHeader = undefined;
        }
        turn.reasoning = (turn.reasoning || "") + delta;
        turn.activeStream = 'reasoning';
        turn.dirty = true;
      }
    } else if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const item = params.item || {};
      
      if (msg.method === 'item/completed') {
        if (item.type === 'agentMessage' || item.type === 'reasoning') {
          turn.activeStream = undefined;
          turn.dirty = true;
        }
      }
      
      if (item.type === 'userMessage') {
        const contentStr = (item.content && item.content[0] && item.content[0].text) || "";
        if (contentStr) {
          turn.prompt = contentStr;
          turn.dirty = true;
        }
      } else if (item.type === 'agentMessage') {
        if (item.phase === 'commentary') {
          if (msg.method === 'item/started') {
            const timeStr = get24HourTimeStr();
            const separator = turn.reasoning ? `\n\n---\n⏱️ *[${timeStr}] 阶段推理*\n` : `⏱️ *[${timeStr}] 阶段推理*\n`;
            if (item.text) {
              turn.reasoning = (turn.reasoning || "") + separator + item.text;
              turn.pendingReasoningHeader = undefined;
            } else {
              turn.pendingReasoningHeader = separator;
            }
          }
          turn.activeStream = msg.method === 'item/started' ? 'reasoning' : undefined;
        } else {
          if (msg.method === 'item/started') {
            const timeStr = get24HourTimeStr();
            const separator = turn.answer ? `\n\n---\n⏱️ *[${timeStr}] 阶段输出*\n` : `⏱️ *[${timeStr}] 阶段输出*\n`;
            turn.answer = (turn.answer || "") + separator + (item.text || "");
          }
          turn.activeStream = msg.method === 'item/started' ? 'answer' : undefined;
        }
        turn.dirty = true;
      } else if (item.type === 'reasoning') {
        if (msg.method === 'item/started') {
          const timeStr = get24HourTimeStr();
          const separator = turn.reasoning ? `\n\n---\n⏱️ *[${timeStr}] 阶段推理*\n` : `⏱️ *[${timeStr}] 阶段推理*\n`;
          if (item.text) {
            turn.reasoning = (turn.reasoning || "") + separator + item.text;
            turn.pendingReasoningHeader = undefined;
          } else {
            turn.pendingReasoningHeader = separator;
          }
        }
        turn.activeStream = msg.method === 'item/started' ? 'reasoning' : undefined;
        turn.dirty = true;
      } else if (item.type === 'commandExecution') {
        const cmdCount = turn.commandExecutionCount || 0;
        if (msg.method === 'item/started') {
          turn.commandExecutionCount = cmdCount + 1;
          if (cmdCount === 0) {
            const timeStr = get24HourTimeStr();
            let cmdDisplay = item.command || '';
            if (cmdDisplay.length > 120) {
              cmdDisplay = cmdDisplay.substring(0, 120) + '...';
            }
            const separator = turn.reasoning ? `\n\n---\n` : ``;
            const cmdLog = `${separator}🛠️ *[${timeStr}] 运行命令*: \`${cmdDisplay}\``;
            turn.reasoning = (turn.reasoning || "") + cmdLog;
            turn.activeStream = 'reasoning';
          } else if (cmdCount === 1 && !turn.hasLoggedFoldMessage) {
            turn.hasLoggedFoldMessage = true;
            turn.reasoning = (turn.reasoning || "") + `\n\n---\n📎 *后续执行指令已自动折叠*`;
          }
        } else if (msg.method === 'item/completed') {
          if (turn.commandExecutionCount === 1) {
            const timeStr = get24HourTimeStr();
            const exitStatus = item.exitCode === 0 ? "成功" : `失败 (Exit Code: ${item.exitCode})`;
            let outputLog = "";
            if (item.aggregatedOutput && typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
              let out = item.aggregatedOutput.trim();
              const limit = 800;
              if (out.length > limit) {
                out = out.substring(0, limit / 2) + '\n... (truncated) ...\n' + out.substring(out.length - limit / 2);
              }
              outputLog = `\n\`\`\`text\n${out}\n\`\`\``;
            }
            const endLog = `\n📌 *[${timeStr}] 命令执行结束*: ${exitStatus}${outputLog}`;
            turn.reasoning = (turn.reasoning || "") + endLog;
            turn.activeStream = undefined;
          }
        }
        turn.dirty = true;
      }
    } else if (msg.method === 'agent/stderr' || msg.method === 'agent/stdout') {
      // Ignore raw stdout/stderr to keep the Feishu card logs clean and within size limits.
    } else if (msg.method === 'thread/tokenUsage/updated') {
      turn.dirty = true;
      if (turn.status !== 'running' && turn.cardId) {
        const cId = turn.cardId;
        const targetTurnId = params.turnId || (params.turn && params.turn.id) || turn.threadId;
        queueTurnTask(targetTurnId, async () => {
          try {
            const finalLayout = createCardKitFinalLayout(turn);
            await finalizeCardKitCard(cId, finalLayout, turn);
          } catch (e) {
            console.error('Failed to update finalized card with late stats:', e);
          }
        });
      }
    } else {
      if (msg.method && msg.method.startsWith('agent/') && msg.method !== 'agent/stdout' && msg.method !== 'agent/stderr') {
        const details = params.output || params.delta || JSON.stringify(params);
        const separator = turn.reasoning ? `\n` : ``;
        turn.reasoning = (turn.reasoning || "") + separator + `*[${msg.method}]*: ${details}`;
        turn.dirty = true;
      }
    }
  });
}

// Message Card Builders
async function createBindingCard(threads: CodexThread[]) {
  const homeDir = os.homedir();

  // Read Codex global state to get active projects and projectless threads
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  let savedWorkspaces: string[] = [];
  let workspaceLabels: Record<string, string> = {};
  let projectlessThreadIds: string[] = [];

  try {
    const stats = await fs.promises.stat(globalStatePath);
    if (stats.isFile()) {
      const globalStateStr = await fs.promises.readFile(globalStatePath, 'utf8');
      const globalState = JSON.parse(globalStateStr);
      savedWorkspaces = globalState['electron-saved-workspace-roots'] || globalState['project-order'] || [];
      workspaceLabels = globalState['electron-workspace-root-labels'] || {};
      projectlessThreadIds = globalState['projectless-thread-ids'] || [];
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.error('Failed to parse .codex-global-state.json:', e);
    }
  }

  // 1. Filter out threads belonging to deleted projects or deleted global threads (like 'q')
  const filteredThreads = threads.filter(t => {
    // A thread is a valid global/projectless thread only if its ID is explicitly active in projectless-thread-ids
    const isValidProjectless = t.id && projectlessThreadIds.includes(t.id);
    if (isValidProjectless) {
      return true;
    }
    
    // Check if the thread belongs to an active workspace
    const isSavedWorkspace = t.cwd && savedWorkspaces.some(w => {
      const normW = path.normalize(w).toLowerCase();
      const normC = path.normalize(t.cwd || "").toLowerCase();
      return normC === normW || normC.startsWith(normW + path.sep);
    });

    return isSavedWorkspace; // Only keep it if it belongs to a saved (active) workspace
  });

  // 2. Sort threads so global/no-project threads are at the top, followed by projects grouped by cwd
  const sortedThreads = [...filteredThreads].sort((a, b) => {
    const isGlobalA = a.id && projectlessThreadIds.includes(a.id);
    const isGlobalB = b.id && projectlessThreadIds.includes(b.id);
    
    if (isGlobalA && !isGlobalB) return -1;
    if (!isGlobalA && isGlobalB) return 1;
    
    const cwdA = a.cwd || "";
    const cwdB = b.cwd || "";
    return cwdA.localeCompare(cwdB);
  });

  // 3. Map to dropdown options
  const options = sortedThreads.map(t => {
    const isGlobal = t.id && projectlessThreadIds.includes(t.id);
    
    let prefix = "🌐 全局会话 ➜ ";
    if (!isGlobal && t.cwd) {
      // Find the matched workspace to get the proper label/basename
      const matchedWorkspace = savedWorkspaces.find(w => {
        const normW = path.normalize(w).toLowerCase();
        const normC = path.normalize(t.cwd || "").toLowerCase();
        return normC === normW || normC.startsWith(normW + path.sep);
      });

      let dirName = "";
      if (matchedWorkspace) {
        dirName = workspaceLabels[matchedWorkspace] || path.basename(matchedWorkspace);
      } else {
        dirName = path.basename(t.cwd);
      }
      prefix = dirName ? `📁 ${dirName} ➜ ` : "";
    }
    
    const content = `${prefix}${t.name}`;
    const cleanContent = content.length > 50 ? content.substring(0, 47) + "..." : content;
    
    return {
      text: {
        tag: "plain_text",
        content: cleanContent
      },
      value: t.id
    };
  });

  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "请从下方下拉菜单中选择一个 Codex 活跃会话绑定至当前聊天。选项已按本地项目分组："
      }
    },
    {
      tag: "select_static",
      element_id: "bind_select_dropdown",
      placeholder: {
        tag: "plain_text",
        content: "选择 Codex 会话..."
      },
      value: {
        action: "bind_select_thread"
      },
      options: options.slice(0, 99)
    }
  ];

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "indigo",
      title: {
        tag: "plain_text",
        content: "📂 Codex 绑定会话"
      }
    },
    body: {
      elements: elements
    }
  };
}

function createGoalCard(goal: any) {
  if (!goal) {
    return {
      schema: "2.0",
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "grey",
        title: {
          tag: "plain_text",
          content: "🎯 Codex 目标模式"
        }
      },
      body: {
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: "当前会话**未设置目标**。\\n\\n**如何使用目标模式：**\\n- 发送 \`/goal [您的目标内容]\` 来设置目标并启动任务。\\n  例如：\`/goal 修复项目中的所有编译警告\`\\n- 发送 \`/goal clear\` 或 \`/goal -c\` 随时清除当前的目标。"
            }
          }
        ]
      }
    };
  }

  let statusText = goal.status || "未知";
  let statusEmoji = "⚙️";
  let headerTemplate = "blue";
  
  if (goal.status === "active") {
    statusText = "活跃中 (Active) ⚙️";
    statusEmoji = "⚙️";
    headerTemplate = "indigo";
  } else if (goal.status === "complete") {
    statusText = "已完成 (Complete) ✅";
    statusEmoji = "✅";
    headerTemplate = "green";
  } else if (goal.status === "paused") {
    statusText = "已暂停 (Paused) ⏸️";
    statusEmoji = "⏸️";
    headerTemplate = "orange";
  } else if (goal.status === "blocked") {
    statusText = "受阻中 (Blocked) 🚫";
    statusEmoji = "🚫";
    headerTemplate = "red";
  }

  const createdTime = goal.createdAt ? formatDateTime24h(new Date(goal.createdAt * 1000)) : '未知';
  const updatedTime = goal.updatedAt ? formatDateTime24h(new Date(goal.updatedAt * 1000)) : '未知';

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: {
        tag: "plain_text",
        content: `${statusEmoji} Codex 目标模式`
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `🎯 **当前目标 (Objective)**:\\n> **${goal.objective}**`
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `🚦 **目标状态**: ${statusText}\\n🪙 **已用 Token 数**: \`${goal.tokensUsed || 0}\`${goal.tokenBudget ? ` / \\\`${goal.tokenBudget}\\\`` : ''}\\n⏳ **执行时长**: \`${goal.timeUsedSeconds || 0} 秒\``
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `📅 **创建时间**: ${createdTime}\\n🔄 **更新时间**: ${updatedTime}`
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "💡 **提示**：\\n- 如需更改目标，请重新发送 \`/goal [新目标内容]\`\\n- 如需清除目标，请发送 \`/goal clear\` 或 \`/goal -c\`"
          }
        }
      ]
    }
  };
}

function createMcpCard(mcpData: any) {
  const servers = mcpData?.data || [];
  const elements: any[] = [];

  if (servers.length === 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "⚠️ **当前未配置或加载任何 MCP 服务器。**\n如需使用 Model Context Protocol 工具，请在本地主机上的 `config.toml` 中配置 `mcp_servers`。"
      }
    });
  } else {
    let tableMarkdown = "| 服务名称 | 认证状态 | 启用状态 |\n| :--- | :--- | :--- |\n";
    
    servers.forEach((server: any) => {
      let authText = "未知";
      const auth = server.authStatus;
      if (auth === "bearerToken" || auth === "token") {
        authText = "已通过身份验证 (API 密钥)";
      } else if (auth === "unsupported") {
        authText = "不支持身份验证";
      } else if (auth === "oauth") {
        authText = "已通过身份验证 (OAuth)";
      } else if (auth === "unauthenticated") {
        authText = "⚠️ 未完成身份验证";
      } else if (auth === "none" || !auth) {
        authText = "无需身份验证";
      } else {
        authText = auth;
      }

      const enabledText = server.enabled === false ? "🔴 已禁用" : "🟢 已启用";
      tableMarkdown += `| \`${server.name}\` | ${authText} | ${enabledText} |\n`;
    });

    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: tableMarkdown
      }
    });

    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `💡 **共加载了 ${servers.length} 个 MCP 服务器。** 如需管理，请在本地配置文件中进行配置。`
      }
    });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: servers.length > 0 ? "indigo" : "grey",
      title: { tag: "plain_text", content: "🔌 MCP 插件管理" }
    },
    body: { elements }
  };
}

function createSkillsCard(skillsData: any, cwd: string, selectedSkillName?: string) {
  const entries = skillsData?.data || [];
  const elements: any[] = [];
  
  let allSkills: any[] = [];
  entries.forEach((entry: any) => {
    if (Array.isArray(entry.skills)) {
      entry.skills.forEach((skill: any) => {
        allSkills.push({
          ...skill,
          cwd: entry.cwd
        });
      });
    }
  });

  if (allSkills.length === 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `⚠️ **当前工作目录下未发现可用技能。**\n工作目录: \`${cwd || '未配置'}\`\n\n您可以在项目中创建 \`skills/\` 目录并放置 \`SKILL.md\` 来声明自定义技能。`
      }
    });
  } else {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🎯 **当前工作区支持的技能列表 (${allSkills.length} 个)：**\n💡 *您可以在群聊对话中通过 \`@技能名称\` 提及并调用对应技能能力。*`
      }
    });

    // Create dropdown options sorted alphabetically
    allSkills.sort((a, b) => a.name.localeCompare(b.name));
    
    const dropdownOptions = allSkills.map(s => {
      const scopeText = s.scope === "local" ? "📁 本地" : "⚙️ 内置";
      return {
        text: {
          tag: "plain_text",
          content: `[${scopeText}] ${s.name}`
        },
        value: s.name
      };
    });

    // Prepend clear option
    dropdownOptions.unshift({
      text: {
        tag: "plain_text",
        content: "❌ 清除选中skill"
      },
      value: "__CLEAR_SKILL__"
    });

    const isCleared = !selectedSkillName || selectedSkillName === "__CLEAR_SKILL__";

    elements.push({
      tag: "select_static",
      element_id: "skills_select",
      placeholder: {
        tag: "plain_text",
        content: isCleared ? "选择一个技能查看详情并锁定..." : `已选择: ${selectedSkillName}`
      },
      value: {
        action: "skills_select_view",
        cwd: cwd
      },
      options: dropdownOptions.slice(0, 99)
    });

    // If a skill is selected and not cleared, show its detailed description and lock notice
    if (selectedSkillName && selectedSkillName !== "__CLEAR_SKILL__") {
      const selectedSkill = allSkills.find(s => s.name === selectedSkillName);
      if (selectedSkill) {
        const desc = selectedSkill.shortDescription || selectedSkill.description || "暂无描述说明";
        const scopeText = selectedSkill.scope === "local" ? "📁 本地项目专属技能" : "⚙️ 全局内置技能";
        elements.push({ tag: "hr" });
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `✨ **${selectedSkill.name}** (${scopeText})\n\n📌 **已锁定**：下一条指令将默认调用此技能运行，无需再次 @。\n\n**🔍 技能描述**：\n${desc}\n\n**📂 文件路径**：\n\`${selectedSkill.path || ''}\``
          }
        });
      }
    }
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: allSkills.length > 0 ? "blue" : "grey",
      title: { tag: "plain_text", content: "🎯 Codex 可用技能清单" }
    },
    body: { elements }
  };
}

function createStatusCard(statusData: any) {
  const { name, threadId, cwd, personality, planMode, goal } = statusData;
  const personalityText = personality === "friendly" ? "亲和 (Friendly) 😊" : (personality === "pragmatic" ? "务实 (Pragmatic) 🎯" : "默认 ⚙️");
  const planModeText = planMode ? "开启 🟢 (优先编写实施计划)" : "关闭 🔴 (常规极速对话模式)";

  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `💬 **当前绑定会话**: **${name || '未命名会话'}**\n- 🆔 **会话 ID**: \`${threadId}\`\n- 📂 **工作目录 (CWD)**: \`${cwd || '默认工作区'}\``
      }
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🚦 **配置选项**:\n- 🎭 **回复风格 (Personality)**: ${personalityText}\n- 📝 **计划模式 (Plan Mode)**: ${planModeText}`
      }
    }
  ];

  if (goal) {
    let goalStatus = goal.status || "未知";
    if (goal.status === "active") goalStatus = "活跃 ⚙️";
    else if (goal.status === "complete") goalStatus = "完成 ✅";
    
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🎯 **当前长期目标 (Goal)**:\n> **${goal.objective}**\n- 🪙 **消耗 Token**: \`${goal.tokensUsed || 0}\` | ⏳ **时长**: \`${goal.timeUsedSeconds || 0} 秒\` | 🚦 **状态**: ${goalStatus}`
      }
    });
  } else {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "🎯 **当前长期目标**: *暂未设定目标* (发送 `/goal [内容]` 可设定目标)"
      }
    });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "📊 Codex 会话综合状态" }
    },
    body: { elements }
  };
}

function createHelpCard() {
  const allowedCommands = getAllowedCommands();
  const allowedCommandsStr = allowedCommands.map(cmd => `\`${cmd}\``).join('、');
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "💡 Codex 飞书助手指令指南"
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "**欢迎使用 Codex 飞书助手！您可以发送以下指令来控制本地会话：**"
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🔍 **会话绑定**\n- `'/list'`\n  拉取本地 Codex 活跃会话列表，提供下拉菜单供当前聊天选择并绑定。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🆕 **新建会话**\n- `'/new [名称]'` 或 `'/create [名称]'\n  快速在本地 Codex Desktop 启动一个新会话并自动与当前聊天绑定。可指定会话名字。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📁 **切换工作目录**\n- `'/cwd [路径]'` 或 `'/workspace [路径]'\n  查询或动态修改当前已绑定会话的工作目录 (CWD)。这会直接决定接下来 Codex 在哪执行命令或修改文件。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `💻 **终端命令执行**\n- \`'/cmd [命令]'\` 或 \`'/run [命令]'\`\n  在本地 macOS 的当前工作目录下执行命令，辅助您在不知道具体绝对路径时进行查找定位。\n  **当前支持的本地命令**：${getAllowedCommands().map(cmd => `\`${cmd}\``).join('、')}`
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🎯 **目标模式 (Goal Mode)**\n- `'/goal [目标内容]'\n  为当前会话设置一个长期任务目标并立即自动启动执行。Codex 将在后台自主规划和调用工具，直到目标达成。\n- `'/goal'\n  查询当前会话的目标内容、执行进度（状态、消耗 Token、时长等）。\n- `'/goal clear' 或 '/goal -c'\n  清除当前会话的目标。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🔌 **MCP 插件管理**\n- `'/mcp'`\n  展示本地所有 MCP 服务及认证连接状态。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🎭 **回复风格设定**\n- `'/personality [friendly|pragmatic|none]'`\n  设置或查询回复风格（friendly: 亲和, pragmatic: 务实, none: 默认）。状态记录于 sessions.json，在执行 Turn 时自动应用。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "⚡️ **压缩上下文**\n- `'/compact'` 或 `'/compress'`\n  压缩当前会话的上下文窗口（释放 Token）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🍴 **会话派生**\n- `'/fork [新名称]'`\n  派生复制当前会话并将群聊自动绑定至新派生的会话。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📝 **计划模式 (Plan Mode)**\n- `'/plan [on|off]'`\n  开启或关闭“计划模式”。开启后，下发的日常指令会强制 Codex 优先提供实施计划供您审批。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📋 **会话综合状态**\n- `'/status'`\n  综合展示面板（包含会话名称、ID、当前 CWD、个性设定、计划模式及目标详情）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "✨ **可用技能列表与调用**\n- `'/skills'`\n  列出当前工作区下可用的所有技能（Skills）。\n- **技能 @ 提及**：在日常对话中通过 `@技能名称 [输入内容]` 来调用特定技能（例如 `@Ce Debug 为什么我的项目有类型报错？`）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🗑️ **归档解绑**\n- `'/delete'` 或 `'/archive'`\n  将当前聊天与 Codex 会话解绑，同时在本地归档该会话。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📊 **用量查询**\n- `'/usage'` 或 `'/quota'`\n  获取当前账户的短期 (5h) / 长期 (7d) 窗口用量统计及下次重置刷新时间。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "❓ **获取帮助**\n- `'/help'` 或 `'/h'`\n  获取所有支持的快捷指令和使用帮助。"
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "💡 *提示: 绑定会话后，直接发送日常对话即可与本地 Codex 交互推理。*"
          }
        }
      ]
    }
  };
}

function createBoundSuccessCard(threadName: string, threadId: string) {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: "Codex Session Bound Successfully"
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `This Feishu chat is now bound to Codex Session: **${threadName}**\n\n- **Thread ID**: \`${threadId}\`\n\nAny messages sent in this chat will now run on Codex Desktop.`
          }
        }
      ]
    }
  };
}


function updateEnvFile(appId: string, appSecret: string) {
  const envPath = path.join(process.cwd(), '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  // Helper to replace or append env vars
  const setEnvVar = (content: string, key: string, value: string): string => {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      return content.replace(regex, `${key}=${value}`);
    } else {
      return content + (content.endsWith('\n') || content === '' ? '' : '\n') + `${key}=${value}\n`;
    }
  };

  envContent = setEnvVar(envContent, 'LARK_APP_ID', appId);
  envContent = setEnvVar(envContent, 'LARK_APP_SECRET', appSecret);

  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log(`💾 Saved credentials to ${envPath}`);
}

async function ensureCredentials(): Promise<{ appId: string; appSecret: string }> {
  const rawAppId = process.env.LARK_APP_ID || process.env.APP_ID || '';
  const rawAppSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET || '';

  const curAppId = rawAppId.trim();
  const curAppSecret = rawAppSecret.trim();

  if (
    curAppId && 
    curAppSecret && 
    curAppId !== 'YOUR_FEISHU_APP_ID' && 
    curAppSecret !== 'YOUR_FEISHU_APP_SECRET'
  ) {
    return { appId: curAppId, appSecret: curAppSecret };
  }

  // Clear placeholders/empty values from process.env to prevent conflicts in Lark.registerApp
  delete process.env.LARK_APP_ID;
  delete process.env.APP_ID;
  delete process.env.LARK_APP_SECRET;
  delete process.env.APP_SECRET;

  console.log('\n==================================================================');
  console.log('⚠️  LARK_APP_ID and LARK_APP_SECRET are not configured.');
  console.log('Starting automatic Feishu Bot creation and registration flow...');
  console.log('==================================================================\n');

  try {
    const result = await Lark.registerApp({
      onQRCodeReady(info) {
        console.log('👉 Please open the following URL in your browser to authorize:');
        console.log(`🔗 URL: ${info.url}`);
        console.log('\n👉 Or scan the QR code below with your Feishu app:');
        qrcode.generate(info.url, { small: true });
        console.log(`(This QR code expires in ${info.expireIn} seconds)\n`);
      },
      onStatusChange(info) {
        console.log(`[Status Update] Registration status: ${info.status}`);
      },
      appPreset: {
        name: 'Codex Control Bot ({user})',
        desc: 'Codex Desktop remote control bot for {user}.',
      }
    });

    const newAppId = result.client_id;
    const newAppSecret = result.client_secret;

    console.log('\n==================================================================');
    console.log('🎉 Feishu Bot created and registered successfully!');
    console.log(`App ID: ${newAppId}`);
    console.log('==================================================================\n');

    updateEnvFile(newAppId, newAppSecret);

    process.env.LARK_APP_ID = newAppId;
    process.env.LARK_APP_SECRET = newAppSecret;

    return { appId: newAppId, appSecret: newAppSecret };
  } catch (e: any) {
    console.error('❌ Failed to automatically register Feishu Bot:', e.description || e.message || e);
    process.exit(1);
  }
}

// Start everything
async function main() {
  const creds = await ensureCredentials();

  setupLogging();

  larkClient = new Lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
  });

  await initCodex();
  
  console.log('Connecting Feishu WebSocket Event Stream...');
  const wsClient = new Lark.WSClient({
    appId: creds.appId,
    appSecret: creds.appSecret,
  });
  
  wsClient.start({ eventDispatcher });
  console.log('Feishu WebSocket Client started. Listening for events.');
}

main().catch((err) => {
  console.error('Failed to start bridge daemon:', err);
  process.exit(1);
});
