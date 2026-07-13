/**
 * Event dispatcher for Codex app-server notifications.
 * Handles turn lifecycle, item streaming, approvals, and reverse push.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodexClient } from './client';
import { ThreadItem, ItemType, Turn, ServerNotification } from './protocol';
import { stateManager } from '../core/state';
import { larkClient } from '../feishu/client';
import { ActiveTurn, TurnStats } from '../types';

// Forward declarations — these are circular dependencies resolved at runtime
let _createCardKitInitialLayout: any;
let _createCardKitFinalLayout: any;
let _streamUpdateCardKit: any;
let _createCardKitCard: any;
let _sendCardKitMessage: any;
let _finalizeCardKitCard: any;
let _sendSimpleStatusCard: any;
let _fetchRateLimitsForTurn: any;
let _queueTurnTask: any;
let _cleanupTurn: any;
let _saveSessions: any;
let _savePushedTurns: any;
let _getChatIdForThread: any;
let _routeCommand: any;
let _checkAndPushHistory: any;

export function registerDependencies(deps: {
  createCardKitInitialLayout: any;
  createCardKitFinalLayout: any;
  streamUpdateCardKit: any;
  createCardKitCard: any;
  sendCardKitMessage: any;
  finalizeCardKitCard: any;
  sendSimpleStatusCard: any;
  fetchRateLimitsForTurn: any;
  queueTurnTask: any;
  cleanupTurn: any;
  saveSessions: any;
  savePushedTurns: any;
  getChatIdForThread: any;
  routeCommand: any;
  checkAndPushHistory: any;
}) {
  Object.assign(arguments[0], deps);
  _createCardKitInitialLayout = deps.createCardKitInitialLayout;
  _createCardKitFinalLayout = deps.createCardKitFinalLayout;
  _streamUpdateCardKit = deps.streamUpdateCardKit;
  _createCardKitCard = deps.createCardKitCard;
  _sendCardKitMessage = deps.sendCardKitMessage;
  _finalizeCardKitCard = deps.finalizeCardKitCard;
  _sendSimpleStatusCard = deps.sendSimpleStatusCard;
  _fetchRateLimitsForTurn = deps.fetchRateLimitsForTurn;
  _queueTurnTask = deps.queueTurnTask;
  _cleanupTurn = deps.cleanupTurn;
  _saveSessions = deps.saveSessions;
  _savePushedTurns = deps.savePushedTurns;
  _getChatIdForThread = deps.getChatIdForThread;
  _routeCommand = deps.routeCommand;
  _checkAndPushHistory = deps.checkAndPushHistory;
}

/** Extract token/model stats from notification params (compatible with old extractStatsFromParams). */
function extractStats(params: any): Partial<TurnStats> {
  const stats: any = {};
  if (!params) return stats;
  const tu = params.tokenUsage;
  if (tu) {
    if (tu.last) {
      stats.inputTokens = tu.last.inputTokens;
      stats.outputTokens = tu.last.outputTokens;
      stats.contextTokens = tu.last.totalTokens;
    }
    stats.contextLength = tu.modelContextWindow;
  }
  if (params.model) stats.model = params.model;
  return stats;
}

/** Find active turn by notification params. */
function findTurn(params: any): ActiveTurn | undefined {
  const turnId = params.turnId || params.turn?.id;
  if (turnId) return stateManager.activeTurns.get(turnId) || stateManager.recentTurns.get(turnId);
  const threadId = params.threadId || params.turn?.threadId;
  if (threadId) {
    const activeId = stateManager.threadToActiveTurnId.get(threadId);
    if (activeId) return stateManager.activeTurns.get(activeId) || stateManager.recentTurns.get(activeId);
  }
  return undefined;
}

/** Create and register a new ActiveTurn, returning it. */
function createTurn(params: {
  chatId: string;
  threadId: string;
  prompt: string;
  turnId: string;
  cwd?: string;
  skillName?: string;
  collaborationMode?: string | null;
  personality?: string | null;
}): ActiveTurn {
  const turn: ActiveTurn = {
    chatId: params.chatId,
    messageId: '',
    cardId: '',
    threadId: params.threadId,
    prompt: params.prompt,
    logs: [],
    status: 'running',
    dirty: false,
    startedAt: Date.now(),
    stats: {},
    sequence: 1,
    skillName: params.skillName,
    collaborationMode: params.collaborationMode || null,
    personality: params.personality || null,
  };
  (turn as any).cwd = params.cwd;
  stateManager.activeTurns.set(params.turnId, turn);
  stateManager.threadToActiveTurnId.set(params.threadId, params.turnId);
  return turn;
}

/** Handle Codex app-server notifications. */
export async function handleNotification(client: CodexClient, msg: any): Promise<void> {
  const method = msg.method;
  const params = msg.params || {};
  const turn = findTurn(params) as ActiveTurn | undefined;

  switch (method) {
    // ── Turn lifecycle ──
    case 'turn/started': {
      const turnData = params.turn as Turn | undefined;
      const threadId = params.threadId as string;
      const turnId = turnData?.id || params.turnId;

      if (!threadId || !turnId) break;

      const chatId = _getChatIdForThread?.(threadId);
      if (!chatId) break;

      // If we already have a temp turn (from Feishu-initiated), adopt it
      const activeTurnId = stateManager.threadToActiveTurnId.get(threadId);
      if (activeTurnId?.startsWith('temp-') && turn) {
        stateManager.activeTurns.set(turnId, turn);
        stateManager.activeTurns.delete(activeTurnId);
        stateManager.threadToActiveTurnId.set(threadId, turnId);

        // Nudge desktop to load this thread (deep link triggers SQLite reload)
        try {
          const { execSync } = require('child_process');
          execSync(`open "codex://chat/${threadId}"`, { timeout: 3000 });
        } catch {}

        break;
      }

      // Reverse push: desktop-initiated turn → create card
      if (!turn) {
        let prompt = 'Desktop Input 💻';
        if (turnData?.items) {
          const um = turnData.items.find((i: any) => i?.type === 'userMessage');
          if (um?.content) {
            const ti = um.content.find((c: any) => c?.type === 'text') as any;
            if (ti?.text) prompt = ti.text;
          }
        }

        const rt = createTurn({ chatId, threadId, prompt, turnId });
        try {
          const layout = await _createCardKitInitialLayout(rt);
          rt.cardId = await _createCardKitCard(layout);
          rt.messageId = await _sendCardKitMessage(chatId, rt.cardId);
          _queueTurnTask?.(turnId, () => _streamUpdateCardKit(rt));
        } catch (e) {
          console.error('[Reverse Push] Failed:', e);
          _cleanupTurn?.(turnId, threadId);
        }
      }
      break;
    }

    case 'turn/completed': {
      if (!turn) break;
      let finalStatus: ActiveTurn['status'] = 'success';
      if (params.turn?.status === 'interrupted') finalStatus = 'interrupted';
      else if (params.error) finalStatus = 'failed';

      turn.status = finalStatus;
      turn.completedAt = Date.now();
      turn.dirty = true;

      if (turn.cardId) {
        _queueTurnTask?.(turn.threadId, async () => {
          await _fetchRateLimitsForTurn?.(turn);
          await _streamUpdateCardKit(turn);
          const finalLayout = await _createCardKitFinalLayout(turn);
          await _finalizeCardKitCard(turn.cardId!, finalLayout, turn);
          _cleanupTurn?.(turn.threadId, turn.threadId);
        });
      }

      const rawTurnId = params.turnId || params.turn?.id;
      if (rawTurnId) {
        stateManager.pushedTurns.add(rawTurnId);
        _savePushedTurns?.(stateManager.pushedTurns);
      }
      break;
    }

    // ── Item events ──
    case 'item/started': {
      if (!turn) break;
      const item = params.item as ThreadItem;
      if (!item) break;

      if (item.type === 'userMessage' && item.content) {
        const textItem = item.content.find((c: any) => c.type === 'text') as any;
        if (textItem?.text) {
          turn.prompt = textItem.text;
          turn.dirty = true;
        }
      } else if (item.type === 'agentMessage') {
        if (item.phase === 'commentary') {
          turn.activeStream = 'reasoning';
        } else {
          turn.activeStream = 'answer';
        }
        turn.dirty = true;
      } else if (item.type === 'reasoning') {
        turn.activeStream = 'reasoning';
        turn.dirty = true;
      } else if (item.type === 'imageGeneration') {
        turn.logs.push('🎨 正在生成图片...');
        turn.dirty = true;
      } else if (item.type === 'webSearch') {
        turn.logs.push('🔍 正在搜索网页...');
        turn.dirty = true;
      }
      break;
    }

    case 'item/completed': {
      if (!turn) break;
      const item = params.item as ThreadItem;
      if (!item) break;

      if (item.type === 'agentMessage' || item.type === 'reasoning') {
        turn.activeStream = undefined;
        turn.dirty = true;
      } else if (item.type === 'imageGeneration' && item.status === 'completed' && item.result) {
        // Upload generated image to Feishu
        _queueTurnTask?.(turn.threadId, async () => {
          try {
            const tmpDir = path.join(os.homedir(), '.codex-feishu-bridge', 'tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

            let ext = '.png';
            if (item.result!.startsWith('/9j/')) ext = '.jpg';
            else if (item.result!.startsWith('R0lGOD')) ext = '.gif';
            else if (item.result!.includes('xmlns')) ext = '.svg';

            const fp = path.join(tmpDir, `codex_gen_${item.id}${ext}`);
            fs.writeFileSync(fp, Buffer.from(item.result!, 'base64'));

            const res = await larkClient.im.v1.image.create({
              data: { image_type: 'message', image: fs.readFileSync(fp) },
            });
            if (res?.image_key) {
              turn.answer = (turn.answer || '') + `\n\n![${item.revisedPrompt || '生成图片'}](${res.image_key})`;
              turn.dirty = true;
            }
          } catch (e: any) { console.error('[Image Gen]', e.message); }
        });
      }
      break;
    }

    // ── Deltas (streaming) ──
    case 'item/agentMessage/delta': {
      if (!turn) break;
      const delta = params.delta as string;
      if (delta) {
        turn.answer = (turn.answer || '') + delta;
        turn.activeStream = 'answer';
        turn.dirty = true;
      }
      break;
    }

    case 'item/reasoning/delta':
    case 'item/reasoning/textDelta': {
      if (!turn) break;
      const delta = params.delta as string;
      if (delta) {
        turn.reasoning = (turn.reasoning || '') + delta;
        turn.activeStream = 'reasoning';
        turn.dirty = true;
      }
      break;
    }

    case 'agent/stdout':
    case 'agent/stderr':
    case 'process/outputDelta':
    case 'command/exec/outputDelta': {
      if (!turn) break;
      const chunk = params.chunk || params.delta;
      if (chunk && turn.activeStream?.startsWith('cmd_')) {
        turn.commandOutputTail = ((turn.commandOutputTail || '') + chunk).slice(-1000);
        turn.dirty = true;
      }
      break;
    }

    // ── Token / rate limit updates ──
    case 'thread/tokenUsage/updated': {
      if (turn) {
        Object.assign(turn.stats, extractStats(params));
        turn.dirty = true;
      }
      break;
    }

    case 'account/rateLimits/updated': {
      // Update rate limit state for all active turns
      for (const [, t] of stateManager.activeTurns) {
        _fetchRateLimitsForTurn?.(t);
      }
      break;
    }

    default:
      // Silently ignore unknown notifications
      break;
  }
}
