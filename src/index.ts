import * as Lark from '@larksuiteoapi/node-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import * as crypto from 'crypto';
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
interface ActiveTurn {
  chatId: string;
  messageId: string;
  threadId: string;
  prompt: string;
  logs: string[];
  status: 'running' | 'success' | 'failed';
  dirty: boolean;
}

// Global states
const sessionDb = loadSessions();
const activeTurns = new Map<string, ActiveTurn>(); // turnId -> ActiveTurn
const threadToActiveTurnId = new Map<string, string>(); // threadId -> turnId

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
      await updateLogCard(turn);
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
        await larkClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(bindingCard)
          }
        });
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
        threadId: bound.threadId,
        prompt: text,
        logs: ["Starting remote control turn..."],
        status: 'running',
        dirty: false
      };
      
      const res = await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(createLogCard(initialTurn))
        }
      });
      
      logCardMessageId = res.data?.message_id || "";
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
    if (action.action_id === 'bind_select_thread' || actionValue.action === 'bind_select_thread') {
      const selectedThreadId = action.option;
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

    const turn = getActiveTurnForNotification(msg);
    if (!turn) return;

    const params = msg.params || {};

    if (msg.method === 'turn/completed') {
      console.log(`Turn completed for thread ${turn.threadId}`);
      turn.status = params.error ? 'failed' : 'success';
      if (params.error) {
        turn.logs.push(`[Error]: ${params.error.message || JSON.stringify(params.error)}`);
      } else {
        turn.logs.push('Turn execution finished.');
      }
      turn.dirty = true;
      
      // Immediate final patch
      updateLogCard(turn);
      
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
  const options = threads.map(t => ({
    text: {
      tag: "plain_text",
      content: t.name.length > 50 ? t.name.substring(0, 47) + "..." : t.name
    },
    value: t.id
  }));

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Bind Codex Session"
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "Please select a Codex thread from the list below to bind with this Feishu chat."
          }
        },
        {
          tag: "select_static",
          element_id: "bind_select_dropdown",
          placeholder: {
            tag: "plain_text",
            content: "Select Codex Session..."
          },
          value: {
            action: "bind_select_thread"
          },
          options: options.slice(0, 99)
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
      elements: [
        {
          tag: "markdown",
          content: `**Prompt**: ${turn.prompt}`
        },
        {
          tag: "markdown",
          content: `**Status**: ${statusText}`
        },
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
