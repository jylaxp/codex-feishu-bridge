import * as crypto from 'crypto';
import { stateManager } from '../core/state';
import { adapter } from './connector';
import { larkClient } from '../feishu/client';
import {
  createCardKitCard,
  sendCardKitMessage,
  streamCardKitElement,
  batchUpdateCardKitElements,
  finalizeCardKitCard,
  sendSimpleStatusCard
} from '../feishu/card';
import {
  createApprovalCard,
  createCardKitInitialLayout,
  createCardKitFinalLayout,
  truncateText
} from '../cards/turn-cards';
import {
  saveSessions,
  saveApprovals,
  savePushedTurns,
  loadApprovals
} from '../core/storage';
import {
  fetchRateLimitsForTurn,
  extractStatsFromParams
} from './stats';
import { get24HourTimeStr } from '../adapter';
import { queueTurnTask } from './queue';
import { redactSecrets } from '../core/logger';
import { ActiveTurn } from '../types';

export function cleanupTurn(turnId: string, threadId: string) {
  const turn = stateManager.activeTurns.get(turnId);
  if (turn) {
    stateManager.recentTurns.set(turnId, turn);
    stateManager.recentTurns.set(threadId, turn);
    setTimeout(() => {
      stateManager.recentTurns.delete(turnId);
      stateManager.recentTurns.delete(threadId);
    }, 30000);
  }

  stateManager.activeTurns.delete(turnId);
  stateManager.threadToActiveTurnId.delete(threadId);
  if (typeof adapter.cleanupThreadState === 'function') {
    adapter.cleanupThreadState(threadId);
  }
}

// Throttling stream interval handler for real-time typewriter experience
setInterval(() => {
  const now = Date.now();
  const RATE_LIMIT_QUERY_INTERVAL_MS = parseInt(process.env.RATE_LIMIT_QUERY_INTERVAL_MS || '300000', 10);
  for (const [turnId, turn] of stateManager.activeTurns.entries()) {
    if (turn.status === 'running') {
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

export async function streamUpdateCardKit(turn: ActiveTurn) {
  try {
    if (!turn.cardId) return;

    const shouldUpdate = (elementId: string, value: string) => {
      if (!turn.lastSentValues) turn.lastSentValues = {};
      if (turn.lastSentValues[elementId] === value) return false;
      turn.lastSentValues[elementId] = value;
      return true;
    };

    if (turn.prompt && shouldUpdate("codex_prompt", turn.prompt)) {
      await streamCardKitElement(turn.cardId, "codex_prompt", `**Prompt:** ${turn.prompt}`, turn.sequence++, turn);
    }

    if (turn.reasoning) {
      const truncatedReasoning = truncateText(turn.reasoning, 10000, '\n\n... (由于长度限制，后续推理过程已被截断) ...');
      const displayVal = truncatedReasoning + (turn.activeStream === 'reasoning' ? " ▍" : "");
      if (shouldUpdate("codex_reasoning", displayVal)) {
        await streamCardKitElement(turn.cardId, "codex_reasoning", displayVal, turn.sequence++, turn);
      }
    }

    if (turn.activeStream && turn.activeStream.startsWith('cmd_') && turn.activeToolPanels) {
      const mdId = turn.activeToolPanels[turn.activeStream];
      if (mdId && turn.commandOutputTail !== undefined) {
        const tailDisplay = `\`\`\`text\n${turn.commandOutputTail || "等待输出..."}\n\`\`\`` + " ▍";
        if (shouldUpdate(mdId, tailDisplay)) {
          const success = await streamCardKitElement(turn.cardId, mdId, tailDisplay, turn.sequence++, turn);
          if (success === false && turn.lastSentValues) {
            delete turn.lastSentValues[mdId];
          }
        }
      }
    }

    if (turn.answer) {
      const truncatedAnswer = truncateText(turn.answer, 10000, '\n\n... (由于长度限制，后续输出已被截断，请在 IDE 中查看完整内容) ...');
      const displayVal = truncatedAnswer + (turn.activeStream === 'answer' ? " ▍" : "");
      if (shouldUpdate("codex_output", displayVal)) {
        await streamCardKitElement(turn.cardId, "codex_output", displayVal, turn.sequence++, turn);
      }
    }

    const { getStatsFooterText } = require('./stats');
    const footerText = getStatsFooterText(turn);
    if (shouldUpdate("codex_footer", footerText)) {
      await streamCardKitElement(turn.cardId, "codex_footer", footerText, turn.sequence++, turn);
    }

  } catch (e) {
    console.error(`Failed to stream update CardKit card:`, e);
  }
}

export function getActiveTurnForNotification(msg: any): ActiveTurn | undefined {
  const params = msg.params || {};
  const turnId = params.turnId || (params.turn && params.turn.id);
  if (turnId) {
    if (stateManager.activeTurns.has(turnId)) {
      return stateManager.activeTurns.get(turnId);
    }
    if (stateManager.recentTurns.has(turnId)) {
      return stateManager.recentTurns.get(turnId);
    }
  }
  const threadId = params.threadId || (params.turn && params.turn.threadId);
  if (threadId) {
    const activeId = stateManager.threadToActiveTurnId.get(threadId);
    if (activeId && stateManager.activeTurns.has(activeId)) {
      return stateManager.activeTurns.get(activeId);
    }
    if (stateManager.recentTurns.has(threadId)) {
      return stateManager.recentTurns.get(threadId);
    }
  }
  return undefined;
}

export function getChatIdForThread(threadId: string): string | undefined {
  for (const [chatId, session] of Object.entries(stateManager.sessionDb)) {
    if (session.threadId === threadId) {
      return chatId;
    }
  }
  return undefined;
}

export type ActionCategory = 'READ' | 'EDIT' | 'SEARCH' | 'SKILL' | 'RUN';

export function categorizeAction(item: any): { category: ActionCategory; name: string; count: number } {
  if (item.type === 'fileChange') {
    return { category: 'EDIT', name: 'fileChange', count: item.changes?.length || 1 };
  } else if (item.type === 'mcpToolCall') {
    return { category: 'SKILL', name: `${item.server}.${item.tool}`, count: 1 };
  } else if (item.type === 'toolCall') {
    return { category: 'SKILL', name: item.toolName || item.tool || 'unknown_tool', count: 1 };
  } else if (item.type === 'commandExecution') {
    const cmd = (item.command || '').trim();
    if (cmd.startsWith('rg ') || cmd.startsWith('grep ') || cmd.startsWith('find ')) {
      return { category: 'SEARCH', name: cmd, count: 1 };
    } else if (cmd.startsWith('cat ') || cmd.startsWith('head ') || cmd.startsWith('less ') || cmd.startsWith('tail ')) {
      return { category: 'READ', name: cmd, count: 1 };
    } else if (cmd.startsWith('sed ') || cmd.startsWith('awk ') || cmd.startsWith('echo ')) {
      return { category: 'EDIT', name: cmd, count: 1 };
    } else {
      return { category: 'RUN', name: cmd, count: 1 };
    }
  }
  return { category: 'RUN', name: 'unknown', count: 1 };
}

export function generateClusterTitle(counts: any, latestRunName?: string): { title: string; icon: string } {
  const parts: string[] = [];
  if (counts.edits > 0) parts.push(`编辑了 ${counts.edits} 个文件`);
  if (counts.reads > 0) parts.push(`读取了 ${counts.reads} 个文件`);
  if (counts.searches > 0) parts.push(`已搜索代码`);
  
  if (counts.runs > 0) {
    if (latestRunName) {
      let shortCmd = latestRunName;
      if (shortCmd.length > 20) shortCmd = shortCmd.substring(0, 20) + '...';
      return { title: `🚀 执行命令: ${shortCmd} ${parts.length > 0 ? '(' + parts.join('和') + ')' : ''}`, icon: 'code-block_outlined' };
    }
    return { title: `🚀 执行了 ${counts.runs} 条命令 ${parts.length > 0 ? '(' + parts.join('和') + ')' : ''}`, icon: 'code-block_outlined' };
  } else if (counts.skills > 0) {
    return { title: `🔧 调用了 ${counts.skills} 个技能 ${parts.length > 0 ? '(' + parts.join('和') + ')' : ''}`, icon: 'api-app_outlined' };
  } else {
    // Only READ, EDIT, SEARCH
    if (parts.length > 0) {
      return { title: parts.join(''), icon: counts.edits > 0 ? 'file-word_outlined' : 'search_outlined' };
    }
  }
  return { title: `工具执行中...`, icon: 'api-app_outlined' };
}

export async function handleCodexNotification(msg: any) {
  if (msg.method !== 'item/reasoning/delta' && msg.method !== 'item/agentMessage/delta') {
    console.log(`[Codex Notification]:`, redactSecrets(JSON.stringify(msg)));
  }

  const params = msg.params || {};

  // Helper to check if the request is still pending in the resumed thread
  function isRequestPending(resumeRes: any, requestId: any): boolean {
    if (!resumeRes) return true; // If we can't get state, assume still pending (conservative)
    
    let foundRequest = false;
    
    // Check global requests
    if (Array.isArray(resumeRes.requests)) {
      const req = resumeRes.requests.find((r: any) => r && (r.id === requestId || r.requestId === requestId));
      if (req) {
        foundRequest = true;
        if (req.status !== 'completed' && req.decision === undefined) {
          return true;
        }
        return false; // Found and completed/decided
      }
    }
    
    // Check requests in turns
    const turns = resumeRes.thread?.turns || resumeRes.turns || [];
    if (Array.isArray(turns)) {
      for (const turn of turns) {
        if (Array.isArray(turn.requests)) {
          const req = turn.requests.find((r: any) => r && (r.id === requestId || r.requestId === requestId));
          if (req) {
            foundRequest = true;
            if (req.status !== 'completed' && req.decision === undefined) {
              return true;
            }
            return false; // Found and completed/decided
          }
        }
      }
    }
    
    // If the request was not found in the thread state at all, assume it's still pending.
    // This handles IPC approval requests where msg.id (numeric sequence like 12, 13) 
    // doesn't match the request IDs in the thread state (which use itemId/UUID format).
    if (!foundRequest) {
      console.log(`[Approval Request] Request ${requestId} not found in thread state, assuming still pending.`);
      return true;
    }
    
    return false;
  }


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
          // Delay by 1.5 seconds to see if the request is automatically approved
          await new Promise(resolve => setTimeout(resolve, 1500));

          if (threadId) {
            const resumeRes = await adapter.request('thread/resume', { threadId });
            
            // Check if the request is still active and pending
            if (!isRequestPending(resumeRes, msg.id)) {
              console.log(`[Approval Request] Request ${msg.id} is no longer pending (likely auto-approved or cancelled). Skipping Feishu card.`);
              return;
            }

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
          
          stateManager.activeApprovals.set(approvalId, {
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
          saveApprovals(stateManager.activeApprovals);

          const appCard = createApprovalCard(approvalId, type, cwd, summary, params.reason);
          const cardId = await createCardKitCard(appCard);
          await sendCardKitMessage(chatId, cardId);
        } catch (e) {
          console.error('Failed to process approval request:', e);
          stateManager.activeApprovals.delete(approvalId);
          saveApprovals(stateManager.activeApprovals);
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
    const threadId = params.threadId || (params.turn && params.turn.threadId);
    const turnId = params.turnId || (params.turn && params.turn.id);
    
    const isTurnEvent = msg.method === 'turn/started' || 
                        msg.method === 'turn/completed' || 
                        (msg.method && msg.method.startsWith('item/')) || 
                        (msg.method && msg.method.startsWith('agent/'));

    if (isTurnEvent && threadId && turnId) {
      const chatId = getChatIdForThread(threadId);
      
      if (chatId) {
        const activeTurnId = stateManager.threadToActiveTurnId.get(threadId);
        const existingTurn = activeTurnId ? stateManager.activeTurns.get(activeTurnId) : undefined;
        
        if (existingTurn && existingTurn.status === 'running' && activeTurnId && activeTurnId.startsWith('temp-')) {
          console.log(`[Turn Transition] Adopting new turnId ${turnId} for existing active turn (old: ${activeTurnId})`);
          stateManager.activeTurns.set(turnId, existingTurn);
          stateManager.threadToActiveTurnId.set(threadId, turnId);
          
          if (activeTurnId && activeTurnId !== turnId) {
            stateManager.activeTurns.delete(activeTurnId);
          }
          turn = existingTurn;
        } else {
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

          stateManager.activeTurns.set(turnId, reverseTurn);
          stateManager.threadToActiveTurnId.set(threadId, turnId);

          (async () => {
            try {
              try {
                const result = await adapter.request('thread/resume', { threadId });
                if (result && result.model && !reverseTurn.stats.model) {
                  reverseTurn.stats.model = result.model;
                  reverseTurn.dirty = true;
                }
              } catch (wsErr) {
                console.warn(`[Reverse Push] WS subscription fallback failed for thread ${threadId}:`, wsErr);
              }

              const initialLayout = await createCardKitInitialLayout(reverseTurn);
              const cardId = await createCardKitCard(initialLayout);
              reverseTurn.cardId = cardId;
              
              const newMsgId = await sendCardKitMessage(chatId, cardId);
              if (newMsgId) {
                reverseTurn.messageId = newMsgId;
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
    } catch (e) {}
    
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
    turn.status = finalStatus;
    
    const rawTurnId = params.turnId || (params.turn && params.turn.id);
    let targetTurnId: string | undefined;
    if (rawTurnId && stateManager.activeTurns.has(rawTurnId)) {
      targetTurnId = rawTurnId;
    } else {
      targetTurnId = stateManager.threadToActiveTurnId.get(turn.threadId);
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
            await fetchRateLimitsForTurn(turn);
            await streamUpdateCardKit(turn);
            
            const totalLength = (turn.reasoning || "").length + (turn.answer || "").length;
            const delayMs = Math.min(8000, Math.max(1000, (totalLength * 10) + 500));
            console.log(`[Async Finalize] Waiting ${delayMs}ms for typewriter animation to catch up (total chars: ${totalLength})...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            const finalLayout = await createCardKitFinalLayout(turn);
            await finalizeCardKitCard(cId, finalLayout, turn);
            console.log(`[Async Finalize] Card ${cId} finalized successfully.`);
          } catch (err) {
            console.error('Asynchronous card finalization or update failed:', err);
          } finally {
            turn.status = finalStatus;
            cleanupTurn(finalTargetTurnId, turn.threadId);
          }
        });
      } else {
        turn.status = finalStatus;
        cleanupTurn(finalTargetTurnId, turn.threadId);
        
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
    
    const turnId = rawTurnId;
    if (turnId) {
      stateManager.pushedTurns.add(turnId);
      savePushedTurns(stateManager.pushedTurns);

      for (const [chatId, session] of Object.entries(stateManager.sessionDb)) {
        if (session.threadId === turn.threadId) {
          session.lastPushedTurnId = turnId;
          saveSessions(stateManager.sessionDb);
          break;
        }
      }
    }
  } else if (msg.method === 'turn/started') {
    turn.dirty = true;
    turn.lastRateLimitQueryAt = Date.now();
    fetchRateLimitsForTurn(turn);
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
        if (turn.currentActionCluster) {
          turn.currentActionCluster.completed = true;
          const targetTurnIdForQueue = turn.threadId;
          const clusterToClose = turn.currentActionCluster;
          if (turn.cardId) {
            queueTurnTask(targetTurnIdForQueue, async () => {
              const updateAction = {
                action: "partial_update_element",
                partial_element: {
                  element_id: clusterToClose.panelId,
                  expanded: false
                }
              };
              await batchUpdateCardKitElements(turn.cardId!, [updateAction], turn.sequence++);
            });
          }
          turn.currentActionCluster = undefined;
        }
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
      if (turn.currentActionCluster) {
        turn.currentActionCluster.completed = true;
        const targetTurnIdForQueue = turn.threadId;
        const clusterToClose = turn.currentActionCluster;
        if (turn.cardId) {
          queueTurnTask(targetTurnIdForQueue, async () => {
            const updateAction = {
              action: "partial_update_element",
              partial_element: {
                element_id: clusterToClose.panelId,
                expanded: false
              }
            };
            await batchUpdateCardKitElements(turn.cardId!, [updateAction], turn.sequence++);
          });
        }
        turn.currentActionCluster = undefined;
      }
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
    } else if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'fileChange' || item.type === 'toolCall') {
      const targetTurnIdForQueue = turn.threadId;

      if (msg.method === 'item/started') {
        const actionInfo = categorizeAction(item);
        
        let isNewCluster = false;
        if (!turn.currentActionCluster || turn.currentActionCluster.completed) {
          isNewCluster = true;
          const clusterCount = (turn.clusterCount || 0) + 1;
          turn.clusterCount = clusterCount;
          
            const shortId = Date.now().toString(36).slice(-5);
            turn.currentActionCluster = {
            id: `cluster_${clusterCount}`,
            panelId: `p_${clusterCount}_${shortId}`,
            markdownId: `m_${clusterCount}_${shortId}`,
            startedAt: Date.now(),
            lastUpdatedAt: Date.now(),
            completed: false,
            counts: { searches: 0, reads: 0, edits: 0, skills: 0, runs: 0 },
            details: []
          };
        }
        
        const cluster = turn.currentActionCluster;
        if (actionInfo.category === 'SEARCH') cluster.counts.searches += actionInfo.count;
        if (actionInfo.category === 'READ') cluster.counts.reads += actionInfo.count;
        if (actionInfo.category === 'EDIT') cluster.counts.edits += actionInfo.count;
        if (actionInfo.category === 'SKILL') cluster.counts.skills += actionInfo.count;
        if (actionInfo.category === 'RUN') cluster.counts.runs += actionInfo.count;
        
        const cmdCount = turn.commandExecutionCount || 0;
        turn.commandExecutionCount = cmdCount + 1;
        
        cluster.details.push(`- \`${actionInfo.name}\``);
        const mdId = cluster.markdownId;
        
        turn.activeToolPanels = turn.activeToolPanels || {};
        turn.activeToolPanels[`cmd_${cmdCount + 1}`] = mdId;
        turn.activeStream = `cmd_${cmdCount + 1}`;
        turn.commandOutputTail = "";
        
        const summary = generateClusterTitle(cluster.counts, actionInfo.category === 'RUN' ? actionInfo.name : undefined);
        
        if (turn.cardId) {
          queueTurnTask(targetTurnIdForQueue, async () => {
            if (isNewCluster) {
              const addAction = {
                action: "add_elements",
                target_element_id: "codex_output_hr",
                insert_location: "before",
                elements: [
                  {
                    tag: "collapsible_panel",
                    element_id: cluster.panelId,
                    expanded: true,
                    header: {
                      title: { tag: "plain_text", content: summary.title },
                      vertical_align: "center",
                      icon: { tag: "standard_icon", token: summary.icon, color: "grey", size: "16px 16px" },
                      icon_position: "left"
                    },
                    border: { color: "grey", corner_radius: "5px" },
                    vertical_spacing: "4px",
                    padding: "4px 8px 4px 8px",
                    elements: [
                      { tag: "markdown", element_id: cluster.markdownId, content: cluster.details.join('\n') }
                    ]
                  }
                ]
              };
              await batchUpdateCardKitElements(turn.cardId!, [addAction], turn.sequence++);
            } else {
              const updateAction = {
                action: "partial_update_element",
                partial_element: {
                  element_id: cluster.panelId,
                  header: {
                    title: { tag: "plain_text", content: summary.title },
                    vertical_align: "center",
                    icon: { tag: "standard_icon", token: summary.icon, size: "16px 16px" },
                    icon_position: "left"
                  }
                }
              };
              await batchUpdateCardKitElements(turn.cardId!, [updateAction], turn.sequence++);
              await streamCardKitElement(turn.cardId!, cluster.markdownId, cluster.details.join('\n'), turn.sequence++, turn);
            }
          });
        }
      } else if (msg.method === 'item/completed') {
        const exitStatus = (item.exitCode === 0 || item.status === 'completed') ? "Succeeded" : `Failed`;
        const targetTurnIdForQueue = turn.threadId;
        
        const cluster = turn.currentActionCluster;
        if (cluster && exitStatus === 'Failed') {
          if (turn.cardId) {
            queueTurnTask(targetTurnIdForQueue, async () => {
              const updateAction = {
                action: "partial_update_element",
                partial_element: {
                  element_id: cluster.panelId,
                  border: { color: "red", corner_radius: "5px" }
                }
              };
              await batchUpdateCardKitElements(turn.cardId!, [updateAction], turn.sequence++);
            });
          }
        }

        turn.commandOutputTail = undefined;
        turn.activeStream = undefined;
      }
      turn.dirty = true;
    }
  } else if (msg.method === 'agent/stderr' || msg.method === 'agent/stdout') {
    const targetTurnId = params.turnId || (params.turn && params.turn.id);
    let targetTurn = turn;
    if (targetTurnId) {
      targetTurn = stateManager.activeTurns.get(targetTurnId) || stateManager.recentTurns.get(targetTurnId) || turn;
    }
    if (targetTurn && targetTurn.activeStream?.startsWith('cmd_') && typeof params.chunk === 'string') {
      if (targetTurn.commandOutputTail !== undefined) {
         let tail = targetTurn.commandOutputTail + params.chunk;
         if (tail.length > 1000) {
            tail = tail.substring(tail.length - 1000);
         }
         targetTurn.commandOutputTail = tail;
         targetTurn.dirty = true;
      }
    }
  } else if (msg.method === 'thread/tokenUsage/updated') {
    turn.dirty = true;
    if (turn.status !== 'running' && turn.cardId) {
      const cId = turn.cardId;
      const targetTurnId = turn.threadId;
      queueTurnTask(targetTurnId, async () => {
        try {
          const finalLayout = await createCardKitFinalLayout(turn);
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
}
