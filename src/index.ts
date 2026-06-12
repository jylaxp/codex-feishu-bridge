import * as Lark from '@larksuiteoapi/node-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import * as crypto from 'crypto';
import * as os from 'os';
import { LocalAppServerAdapter, CodexThread } from './adapter';

// Load environmental variables
dotenv.config();

// Credentials will be loaded dynamically in ensureCredentials()

// Session database path
const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');

interface SessionDb {
  [feishuChatId: string]: {
    threadId: string;
    threadName: string;
  };
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
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save sessions.json:', e);
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
  logs: string[];
  status: 'running' | 'success' | 'failed';
  dirty: boolean;
  startedAt?: number;
  completedAt?: number;
  stats: TurnStats;
  sequence: number;
}

interface ActiveApproval {
  requestId: number | string;
  chatId: string;
  threadId: string;
  turnId: string;
  approvalType: string;
  summary: string;
  cwd: string;
}

// Global states
const sessionDb = loadSessions();
const activeTurns = new Map<string, ActiveTurn>(); // turnId -> ActiveTurn
const threadToActiveTurnId = new Map<string, string>(); // threadId -> turnId
const activeApprovals = new Map<string, ActiveApproval>(); // approvalId -> ActiveApproval

// --- Feishu Token Cache ---
let cachedToken = "";
let tokenExpiresAt = 0;

async function getTenantAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }
  const appId = process.env.LARK_APP_ID || process.env.APP_ID;
  const appSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET;
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
  tokenExpiresAt = now + (data.expire || 7200) * 1000;
  return cachedToken;
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
  if (data.code !== 0) {
    throw new Error(`Failed to create CardKit card: ${data.msg}`);
  }
  return data.data.card_id;
}

async function sendCardKitMessage(chatId: string, cardId: string): Promise<string> {
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
}

async function streamCardKitElement(cardId: string, elementId: string, content: string, sequence: number) {
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
      console.error(`Failed to stream CardKit element ${elementId}:`, data.msg);
    }
  } catch (e) {
    console.error(`Failed to stream element ${elementId} network request:`, e);
  }
}

async function finalizeCardKitCard(cardId: string, finalContent: any, sequence: number) {
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
        sequence: sequence
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
        sequence: sequence + 1
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
  
  function search(obj: any, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return;
    
    const modelKeys = ["model", "model_name", "modelName", "model_id", "modelId", "toModel"];
    for (const key of modelKeys) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        stats.model = obj[key].trim();
        break;
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        const nestedModel = obj[key].id || obj[key].name || obj[key].model;
        if (typeof nestedModel === 'string' && nestedModel.trim()) {
          stats.model = nestedModel.trim();
          break;
        }
      }
    }

    const inputTokenKeys = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "tokens_in", "tokensIn"];
    for (const key of inputTokenKeys) {
      if (typeof obj[key] === 'number') { stats.inputTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { stats.inputTokens = parseInt(obj[key], 10); break; }
    }
    const outputTokenKeys = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "tokens_out", "tokensOut"];
    for (const key of outputTokenKeys) {
      if (typeof obj[key] === 'number') { stats.outputTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { stats.outputTokens = parseInt(obj[key], 10); break; }
    }
    const contextTokenKeys = ["context_tokens", "contextTokens", "context_used_tokens", "contextUsedTokens", "total_tokens", "totalTokens"];
    for (const key of contextTokenKeys) {
      if (typeof obj[key] === 'number') { stats.contextTokens = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { stats.contextTokens = parseInt(obj[key], 10); break; }
    }
    const contextLengthKeys = ["context_length", "contextLength", "context_window", "contextWindow", "modelContextWindow", "max_context_tokens", "maxContextTokens"];
    for (const key of contextLengthKeys) {
      if (typeof obj[key] === 'number') { stats.contextLength = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { stats.contextLength = parseInt(obj[key], 10); break; }
    }
    const apiCallKeys = ["api_calls", "apiCalls", "api_requests", "apiRequests", "request_count", "requestCount"];
    for (const key of apiCallKeys) {
      if (typeof obj[key] === 'number') { stats.apiCalls = obj[key]; break; }
      if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) { stats.apiCalls = parseInt(obj[key], 10); break; }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        search(item, depth + 1);
      }
    } else {
      for (const k in obj) {
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

  return parts.join(" · ");
}

// --- CardKit Layout Constructors ---
function createCardKitInitialLayout(turn: ActiveTurn) {
  const footer = getStatsFooterText(turn);
  
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: "Codex 执行进度" }
    },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "🌌 Codex Remote Control" }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**📥 输入 Prompt**\n> ${turn.prompt}`
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `🧠 **推理过程与日志**\nInitializing execution...`,
          element_id: "codex_process"
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
  const headerTemplate = turn.status === "failed" ? "red" : "green";
  const footer = getStatsFooterText(turn);
  
  let logContent = turn.logs.join("\n");
  if (!logContent.trim()) {
    logContent = "Finished.";
  }
  const maxChars = 2000;
  if (logContent.length > maxChars) {
    logContent = "... (truncated) ...\n" + logContent.substring(logContent.length - maxChars);
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: { tag: "plain_text", content: turn.status === "success" ? "✅ Codex 执行成功" : "❌ Codex 执行失败" }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `**📥 输入 Prompt**\n> ${turn.prompt}`
        },
        { tag: "hr" },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `🧠 **执行日志**:\n\`\`\`text\n${logContent}\n\`\`\``
          }
        },
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
      ]
    }
  };
}

// --- Approval Card Templates ---
function createApprovalCard(approvalId: string, type: string, cwd: string, summary: string) {
  let cleanSummary = summary;
  const secretPatterns = [
    /(authorization:\s*bearer\s+)[^\s'"]+/gi,
    /(token=)[^&\s]+/gi,
    /(api[_-]?key=)[^&\s]+/gi,
    /(secret=)[^&\s]+/gi
  ];
  for (const pattern of secretPatterns) {
    cleanSummary = cleanSummary.replace(pattern, "$1[REDACTED]");
  }

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
      elements: [
        {
          tag: "markdown",
          content: "🚨 Codex 正在尝试在您的系统上执行以下敏感操作，需要您进行确认授权："
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `📌 **操作类型**: \`${type}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${riskText}`
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `💻 **准备执行的操作指令**:\n\`\`\`text\n${cleanSummary}\n\`\`\``
        },
        { tag: "hr" },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "批准 (Approve)" },
              type: "primary",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "accept"
              }
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "拒绝 (Deny)" },
              type: "danger",
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
  };
}

function createApprovalDecidedCard(type: string, decision: string) {
  const isAccepted = decision === "accept";
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: isAccepted ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: isAccepted ? "✅ 审批已批准" : "❌ 审批已拒绝"
      }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: isAccepted 
            ? `该操作（类型：\`${type}\`）已于 **${new Date().toLocaleString()}** 被批准执行。` 
            : `该操作已被拒绝。Codex 将停止该步骤 of 执行。`
        }
      ]
    }
  };
}

// --- Granular CardKit Updater ---
async function streamUpdateCardKit(turn: ActiveTurn) {
  if (!turn.cardId || turn.status !== 'running') return;
  try {
    const seq = turn.sequence++;
    
    // 1. Update Inference / logs
    let logContent = turn.logs.join("\n");
    if (logContent.trim()) {
      const maxChars = 2000;
      if (logContent.length > maxChars) {
        logContent = "... (truncated) ...\n" + logContent.substring(logContent.length - maxChars);
      }
      const logMd = `🧠 **推理过程与日志**:\n\`\`\`text\n${logContent}\n\`\`\``;
      await streamCardKitElement(turn.cardId, "codex_process", logMd, seq);
    }

    // 2. Update Output
    if (turn.answer) {
      const outputMd = `✨ **最终结果输出**:\n${turn.answer}`;
      await streamCardKitElement(turn.cardId, "codex_output", outputMd, seq);
    }

    // 3. Update Footer
    const footerText = `📊 ${getStatsFooterText(turn)}`;
    await streamCardKitElement(turn.cardId, "codex_footer", footerText, seq);

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
  activeTurns.delete(turnId);
  threadToActiveTurnId.delete(threadId);
}

// Update log card via Patch API
async function updateLogCard(turn: ActiveTurn) {
  try {
    const cardContent = createLogCard(turn);
    await larkClient.im.message.patch({
      path: {
        message_id: turn.messageId
      },
      data: {
        content: JSON.stringify(cardContent)
      }
    });
  } catch (e) {
    console.error(`Failed to update log card for message ${turn.messageId}:`, e);
  }
}

// Periodic tick (1-second throttling)
setInterval(async () => {
  for (const [turnId, turn] of activeTurns.entries()) {
    if (turn.dirty && turn.status === 'running') {
      turn.dirty = false;
      await streamUpdateCardKit(turn);
    }
  }
}, 1000);

// Initialize Event Dispatcher
const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const message = data.message;
    const sender = data.sender;

    // Ignore messages not sent by standard users (e.g. apps/bots) to prevent loops
    if (sender?.sender_type !== 'user') {
      return;
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

    const chatId = message.chat_id;
    const messageId = message.message_id;
    const text = extractTextMessage(message.content);

    console.log(`[Received Message] Chat: ${chatId}, Msg: ${messageId}, Text: "${text}"`);

    // 1. Handle /bind or /list command
    if (text.startsWith('/bind') || text.startsWith('/list')) {
      try {
        console.log(`Fetching Codex threads for ${text.startsWith('/bind') ? '/bind' : '/list'}...`);
        const threads = await adapter.listThreads();
        if (threads.length === 0) {
          await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text: 'No active Codex sessions found. Please open Codex Desktop client first.' })
            }
          });
          return;
        }

        const bindingCard = createBindingCard(threads);
        const cardId = await createCardKitCard(bindingCard);
        await sendCardKitMessage(chatId, cardId);
      } catch (e: any) {
        console.error('Failed to list threads or send card:', e);
        await larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: `Failed to bind Codex session: ${e.message || e}` })
          }
        });
      }
      return;
    }

    // 2. Handle normal user message (forward to Codex)
    const bound = sessionDb[chatId];
    if (!bound) {
      // Reply to user to prompt bind first
      await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: 'This Feishu chat is not bound to any Codex session. Please send `/bind` or `/list` to select a session first.' })
        }
      });
      return;
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
        logs: ["Starting remote control turn..."],
        status: 'running',
        dirty: false,
        startedAt: Date.now(),
        stats: {},
        sequence: 1
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
          const turnId = await adapter.startRemoteControlTurn({
            threadId: bound.threadId,
            cwd: process.env.CODEX_CWD || process.cwd(),
            prompt: text
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
        await larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: `Error: Failed to launch Codex turn. Make sure Codex Desktop is running. Detail: ${e.message || e}` })
          }
        });
      }
    }
  },

  'card.action.trigger': async (data: any) => {
    console.log('Received card interaction callback:', JSON.stringify(data, null, 2));

    const context = data.context || {};
    const action = data.action || {};

    const messageId = context.open_message_id;
    const chatId = context.open_chat_id;

    const actionValue = action.value || {};
    
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
          threadName: threadName
        };
        saveSessions(sessionDb);

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
      const approval = activeApprovals.get(approvalId);
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

      try {
        console.log(`Responding to Codex Approval ${approval.requestId} with decision ${decision}...`);
        
        // Respond to Codex via adapter
        adapter.respond(approval.requestId, { decision });

        // Update card to finished state
        const decidedCard = createApprovalDecidedCard(approval.approvalType, decision);
        await larkClient.im.message.patch({
          path: {
            message_id: messageId
          },
          data: {
            content: JSON.stringify(decidedCard)
          }
        });

        activeApprovals.delete(approvalId);

        return {
          toast: {
            type: "success",
            content: `Decision: ${decision} submitted`,
            i18n: {
              zh_cn: `已提交决策: ${decision === 'accept' ? '批准' : '拒绝'}`,
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
  if (turnId && activeTurns.has(turnId)) {
    return activeTurns.get(turnId);
  }

  // Fallback to threadId mapping
  const threadId = params.threadId;
  if (threadId) {
    const activeTurnId = threadToActiveTurnId.get(threadId);
    if (activeTurnId) {
      return activeTurns.get(activeTurnId);
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

// Connect to Codex App Server
async function initCodex() {
  console.log('Connecting to Codex App Server...');
  await adapter.connect();
  console.log('Codex App Server connection established.');

  adapter.onExit(() => {
    console.warn('Codex App Server disconnected.');
    // Fail all active turns
    for (const [turnId, turn] of activeTurns.entries()) {
      turn.status = 'failed';
      turn.logs.push('Codex App Server disconnected unexpectedly.');
      updateLogCard(turn);
      cleanupTurn(turnId, turn.threadId);
    }
  });

  adapter.onNotification((msg) => {
    // Log the notification
    console.log(`[Codex Notification]:`, JSON.stringify(msg));

    const params = msg.params || {};

    // 1. Intercept Codex approval request
    if (msg.id !== undefined && msg.method && msg.method.toLowerCase().includes("approval")) {
      const approvalId = 'apr-' + crypto.randomUUID();
      const type = params.approvalType || params.type || "操作审批";
      
      const summaryKeys = ["cmd", "command", "path", "file", "summary"];
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
        console.log(`[Approval Request] Intercepted approval request ${msg.id} for thread ${threadId}. Sending Feishu card...`);
        
        activeApprovals.set(approvalId, {
          requestId: msg.id,
          chatId,
          threadId: threadId || "",
          turnId: turnId || "",
          approvalType: type,
          summary,
          cwd
        });

        (async () => {
          try {
            const appCard = createApprovalCard(approvalId, type, cwd, summary);
            const cardId = await createCardKitCard(appCard);
            await sendCardKitMessage(chatId, cardId);
          } catch (e) {
            console.error('Failed to send approval card:', e);
          }
        })();
      }
      return;
    }

    let turn = getActiveTurnForNotification(msg);

    if (!turn) {
      // Check if this is a turn/started event on a bound thread (reverse push)
      if (msg.method === 'turn/started' && params.threadId) {
        const chatId = getChatIdForThread(params.threadId);
        const turnId = params.turn && params.turn.id;
        
        if (chatId && turnId) {
          console.log(`[Reverse Push] Detected new turn ${turnId} started on bound thread ${params.threadId}. Creating Feishu message card...`);
          
          const reverseTurn: ActiveTurn = {
            chatId,
            messageId: "",
            cardId: "",
            threadId: params.threadId,
            prompt: "Desktop Input 💻",
            logs: ["Starting execution from Codex Desktop..."],
            status: 'running',
            dirty: false,
            startedAt: Date.now(),
            stats: {},
            sequence: 1
          };

          activeTurns.set(turnId, reverseTurn);
          threadToActiveTurnId.set(params.threadId, turnId);

          // Trigger asynchronous Feishu message creation
          (async () => {
            try {
              const initialLayout = createCardKitInitialLayout(reverseTurn);
              const cardId = await createCardKitCard(initialLayout);
              reverseTurn.cardId = cardId;
              
              const newMsgId = await sendCardKitMessage(chatId, cardId);
              if (newMsgId) {
                reverseTurn.messageId = newMsgId;
                // Immediate update in case we already have logs
                await streamUpdateCardKit(reverseTurn);
              }
            } catch (e) {
              console.error('[Reverse Push] Failed to create reverse card:', e);
            }
          })();

          turn = reverseTurn;
        }
      }
    }

    if (!turn) return;

    // Extract stats dynamically if present in parameters
    const stats = extractStatsFromParams(params);
    turn.stats = { ...turn.stats, ...stats };

    if (msg.method === 'turn/completed') {
      console.log(`Turn completed for thread ${turn.threadId}`);
      turn.status = params.error ? 'failed' : 'success';
      if (params.error) {
        turn.logs.push(`[Error]: ${params.error.message || JSON.stringify(params.error)}`);
      } else {
        turn.logs.push('Turn execution finished.');
      }
      turn.dirty = true;
      turn.completedAt = Date.now();
      
      // Finalize CardKit Card
      if (turn.cardId) {
        const cId = turn.cardId;
        (async () => {
          const finalLayout = createCardKitFinalLayout(turn);
          await finalizeCardKitCard(cId, finalLayout, turn.sequence++);
        })();
      }
      
      // Retrieve the turnId
      const turnId = params.turnId || (params.turn && params.turn.id);
      if (turnId) {
        cleanupTurn(turnId, turn.threadId);
      } else {
        // Fallback cleanup using threadId
        const activeTurnId = threadToActiveTurnId.get(turn.threadId);
        if (activeTurnId) {
          cleanupTurn(activeTurnId, turn.threadId);
        }
      }
    } else if (msg.method === 'turn/started') {
      turn.logs.push('Execution started...');
      turn.dirty = true;
    } else if (msg.method === 'item/agentMessage/delta') {
      const delta = params.delta;
      if (delta) {
        turn.answer = (turn.answer || "") + delta;
        turn.dirty = true;
      }
    } else if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'userMessage') {
        const contentStr = (item.content && item.content[0] && item.content[0].text) || "";
        if (contentStr) {
          turn.prompt = contentStr;
          turn.dirty = true;
        }
      } else if (item.type === 'agentMessage' && item.text) {
        turn.answer = item.text;
        turn.dirty = true;
      }
    } else if (msg.method === 'agent/stderr') {
      const chunk = params.chunk;
      if (chunk) {
        turn.logs.push(chunk.toString());
        turn.dirty = true;
      }
    } else {
      // General output capture
      const chunk = params.chunk || params.text || params.output || params.message || (msg.result && msg.result.chunk);
      if (chunk) {
        turn.logs.push(chunk.toString());
        turn.dirty = true;
      } else if (msg.method && msg.method.startsWith('agent/')) {
        const details = params.output || params.delta || JSON.stringify(params);
        turn.logs.push(`[${msg.method}]: ${details}`);
        turn.dirty = true;
      }
    }
  });
}

// Message Card Builders
function createBindingCard(threads: CodexThread[]) {
  const homeDir = os.homedir();

  // Read Codex global state to get active projects and projectless threads
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  let savedWorkspaces: string[] = [];
  let workspaceLabels: Record<string, string> = {};
  let projectlessThreadIds: string[] = [];

  if (fs.existsSync(globalStatePath)) {
    try {
      const globalState = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
      savedWorkspaces = globalState['electron-saved-workspace-roots'] || globalState['project-order'] || [];
      workspaceLabels = globalState['electron-workspace-root-labels'] || {};
      projectlessThreadIds = globalState['projectless-thread-ids'] || [];
    } catch (e) {
      console.error('Failed to parse .codex-global-state.json:', e);
    }
  }

  // 1. Filter out threads belonging to deleted projects
  const filteredThreads = threads.filter(t => {
    const isProjectless = !t.cwd || t.cwd === homeDir || t.cwd === "/" || t.cwd === "." || (t.id && projectlessThreadIds.includes(t.id));
    if (isProjectless) {
      return true; // Keep global/projectless threads
    }
    
    // Check if the thread's cwd is in the saved workspaces list
    const isSavedWorkspace = savedWorkspaces.some(w => {
      const normW = path.normalize(w).toLowerCase();
      const normC = path.normalize(t.cwd || "").toLowerCase();
      return normC === normW || normC.startsWith(normW + path.sep);
    });

    return isSavedWorkspace; // Only keep it if it belongs to a saved (active) workspace
  });

  // 2. Sort threads so global/no-project threads are at the top, followed by projects grouped by cwd
  const sortedThreads = [...filteredThreads].sort((a, b) => {
    const isGlobalA = !a.cwd || a.cwd === homeDir || a.cwd === "/" || a.cwd === "." || (a.id && projectlessThreadIds.includes(a.id));
    const isGlobalB = !b.cwd || b.cwd === homeDir || b.cwd === "/" || b.cwd === "." || (b.id && projectlessThreadIds.includes(b.id));
    
    if (isGlobalA && !isGlobalB) return -1;
    if (!isGlobalA && isGlobalB) return 1;
    
    const cwdA = a.cwd || "";
    const cwdB = b.cwd || "";
    return cwdA.localeCompare(cwdB);
  });

  // 3. Map to dropdown options
  const options = sortedThreads.map(t => {
    const isGlobal = !t.cwd || t.cwd === homeDir || t.cwd === "/" || t.cwd === "." || (t.id && projectlessThreadIds.includes(t.id));
    
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

function createLogCard(turn: ActiveTurn) {
  let statusText = "Running ⏳";
  let headerTemplate = "orange";
  if (turn.status === "success") {
    statusText = "Completed Successfully ✅";
    headerTemplate = "green";
  } else if (turn.status === "failed") {
    statusText = "Failed ❌";
    headerTemplate = "red";
  }

  // Format log content
  let logContent = turn.logs.join("\n");
  if (!logContent.trim()) {
    logContent = "Initializing execution...";
  }

  // Truncate logs if they are too long for Feishu card limits
  const maxChars = 3000;
  if (logContent.length > maxChars) {
    logContent = "... (truncated) ...\n" + logContent.substring(logContent.length - maxChars);
  }

  const elements: any[] = [
    {
      tag: "markdown",
      content: `**Prompt**: ${turn.prompt}`
    },
    {
      tag: "markdown",
      content: `**Status**: ${statusText}`
    }
  ];

  if (turn.answer) {
    elements.push({
      tag: "markdown",
      content: `**Answer**:\n${turn.answer}`
    });
  }

  elements.push(
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**Execution Logs**:\n\`\`\`text\n${logContent}\n\`\`\``
      }
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
        content: `Codex Remote Control`
      }
    },
    body: {
      elements: elements
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
  const curAppId = process.env.LARK_APP_ID || process.env.APP_ID;
  const curAppSecret = process.env.LARK_APP_SECRET || process.env.APP_SECRET;

  if (curAppId && curAppSecret) {
    return { appId: curAppId, appSecret: curAppSecret };
  }

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
