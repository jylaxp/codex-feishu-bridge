import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec } from 'child_process';

import './config';
import { envPath } from './config';
import { setupLogging } from './core/logger';
import { stateManager } from './core/state';
import { saveSessions, saveApprovals, loadApprovals } from './core/storage';
import { initLarkClient, larkClient } from './feishu/client';
import { sendSimpleStatusCard, createCardKitCard, sendCardKitMessage, updateCardKitCard } from './feishu/card';
import { createBoundSuccessCard, createSkillsCard } from './cards/templates';
import { createApprovalDecidedCard, createCardKitInitialLayout } from './cards/turn-cards';
import { initCodex, adapter } from './codex/connector';
import { handleCodexNotification } from './codex/dispatcher';
import { routeCommand } from './commands/router';
import { checkAndPushHistory } from './codex/history';
import { ActiveTurn } from './types';
import { platform } from './core/platform';
import { registerThreadInGlobalState } from './core/global-state';

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

// Periodically clean up old message IDs (older than 10 minutes) every 5 minutes
setInterval(() => {
  stateManager.cleanOldMessageIds(10 * 60 * 1000);
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
      if (stateManager.isMessageProcessed(messageId)) {
        console.log(`[Duplicate Message Ignored] Msg: ${messageId}`);
        return;
      }
      stateManager.markMessageProcessed(messageId);
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

        // Try routing command
        const wasCommand = await routeCommand(chatId, text);
        if (wasCommand) {
          stateManager.pendingProjects.delete(chatId);
          return;
        }

        const pendingProject = stateManager.pendingProjects.get(chatId);
        if (pendingProject) {
          stateManager.pendingProjects.delete(chatId);
          try {
            console.log(`Creating new Codex thread for project "${pendingProject.name}" in CWD "${pendingProject.path}"`);
            
            // Launch Codex Desktop App with the project path to ensure it opens/switches to this project
            try {
              const codexBin = platform.getAppServerBinaryPaths().find((p: string) => fs.existsSync(p)) || 'codex';
              console.log(`Launching Codex Desktop for path: ${pendingProject.path} using binary: ${codexBin}`);
              exec(`"${codexBin}" app "${pendingProject.path}"`, (err: any) => {
                if (err) {
                  console.error('Failed to launch Codex Desktop App:', err);
                }
              });
              // Wait a brief moment for Codex Desktop to start opening the project
              await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (appErr) {
              console.warn('Failed to auto-launch Codex Desktop App:', appErr);
            }

            const params: any = {
              threadSource: 'user',
              cwd: pendingProject.path,
              workspacePath: pendingProject.path,
              workspace: pendingProject.path
            };
            const startRes = await adapter.request('thread/start', params);
            console.log('Codex thread/start response:', JSON.stringify(startRes));

            const thread = startRes?.thread || startRes;
            const threadId = thread?.id || startRes?.threadId;

            if (!threadId) {
              throw new Error('No thread ID returned from Codex App Server');
            }

            // Determine session name
            let sessionName = text.trim();
            if (sessionName.length > 20 || !sessionName) {
              const now = new Date();
              const pad = (n: number) => n.toString().padStart(2, '0');
              const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
              sessionName = `${pendingProject.name}_${timeStr}`;
            }

            // Set the thread name on Codex Server so it shows up named correctly
            try {
              await adapter.request('thread/name/set', {
                threadId: threadId,
                name: sessionName
              });
            } catch (nameErr) {
              console.warn('Failed to set thread name on Codex Server:', nameErr);
            }

            // Register the thread in global state so it is visible in the sidebar under the project
            await registerThreadInGlobalState(threadId, { projectPath: pendingProject.path });

            stateManager.sessionDb[chatId] = {
              threadId: threadId,
              threadName: sessionName,
              cwd: pendingProject.path
            };
            saveSessions(stateManager.sessionDb);

            checkAndPushHistory().catch(e => {
              console.error('Failed to run history check after creating project session:', e);
            });

            const successCard = createBoundSuccessCard(sessionName, threadId);
            const successCardId = await createCardKitCard(successCard);
            await sendCardKitMessage(chatId, successCardId);
          } catch (createErr: any) {
            console.error('Failed to create session for selected project:', createErr);
            await sendSimpleStatusCard(chatId, "🆕 创建会话失败", "red", `项目: ${pendingProject.name}\n错误: ${createErr.message || createErr}`);
            return;
          }
        }

        // Handle normal user message (forward to Codex)
        const bound = stateManager.sessionDb[chatId];
        if (!bound) {
          await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
          return;
        }

        const boundCwd = bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();

        // Check if any skill is mentioned in the text or preset in session
        let matchedSkill: any = null;
        let cleanText = text;
        let turnInput: any[] | undefined = undefined;

        if (bound.activeSkill) {
          matchedSkill = {
            name: bound.activeSkill.name,
            path: bound.activeSkill.path
          };
          const skillsCardMessageId = bound.lastSkillsCardMessageId;
          bound.activeSkill = null;
          bound.lastSkillsCardMessageId = null;
          saveSessions(stateManager.sessionDb);
          console.log(`Consuming locked session skill: "${matchedSkill.name}"`);

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

            allSkills.sort((a, b) => b.name.length - a.name.length);

            for (const skill of allSkills) {
              const escapedName = skill.name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
              const regex = new RegExp(`@${escapedName}\\b`, 'i');
              if (regex.test(text)) {
                matchedSkill = skill;
                cleanText = text.replace(regex, '').trim();
                break;
              }

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

          const initialLayout = await createCardKitInitialLayout(initialTurn);
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
          stateManager.activeTurns.set(tempTurnId, initialTurn);
          stateManager.threadToActiveTurnId.set(bound.threadId, tempTurnId);

          (async () => {
            try {
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
                model: bound.model || null,
                personality: bound.personality || null
              });

              stateManager.activeTurns.delete(tempTurnId);
              stateManager.activeTurns.set(turnId, initialTurn);
              stateManager.threadToActiveTurnId.set(bound.threadId, turnId);
              console.log(`Remote turn started and mapped with ID: ${turnId}`);
            } catch (e: any) {
              console.error('Asynchronous Codex turn trigger failed:', e);
              stateManager.activeTurns.delete(tempTurnId);
              const activeTurnId = stateManager.threadToActiveTurnId.get(bound.threadId);
              if (activeTurnId === tempTurnId) {
                stateManager.threadToActiveTurnId.delete(bound.threadId);
              }

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
            const bound = stateManager.sessionDb[chatId];
            if (bound) {
              bound.activeSkill = null;
              saveSessions(stateManager.sessionDb);
              console.log(`Cleared active skill lock for chat ${chatId}`);
            }
            const updatedCard = createSkillsCard(skillsRes, selectCwd);
            await larkClient.im.message.patch({
              path: { message_id: messageId },
              data: { content: JSON.stringify(updatedCard) }
            });
            return;
          }

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
            const bound = stateManager.sessionDb[chatId];
            if (bound) {
              bound.activeSkill = {
                name: targetSkill.name,
                path: targetSkill.path
              };
              bound.lastSkillsCardMessageId = messageId;
              saveSessions(stateManager.sessionDb);
              console.log(`Successfully locked skill "${targetSkill.name}" for the next turn in chat ${chatId}`);
            }
          }

          const updatedCard = createSkillsCard(skillsRes, selectCwd, selectedSkillName);
          await larkClient.im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(updatedCard) }
          });
        } catch (e: any) {
          console.error('Failed to update skills card with selected skill:', e);
        }
      }
      return;
    }

    // 1.5 Handle set_model
    if (action.action_id === 'set_model' || actionValue.action === 'set_model') {
      const selectedModel = action.option || actionValue.model;
      if (!selectedModel) return;

      const bound = stateManager.sessionDb[chatId];
      if (!bound) {
        await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前群聊未绑定 Codex 会话。");
        return;
      }
      bound.model = selectedModel;
      saveSessions(stateManager.sessionDb);

      await sendSimpleStatusCard(chatId, "🤖 模型设定", "green", `当前会话使用的模型已成功设定为：**${selectedModel}**。\n接下来发送给 Codex 的消息将应用该模型。`);
      return;
    }

    // 0.5 Handle np_select_project
    if (action.action_id === 'np_select_project' || actionValue.action === 'np_select_project') {
      const selectedProjectPath = action.option || actionValue.projectPath;
      if (!selectedProjectPath) return;

      const projectName = path.basename(selectedProjectPath);
      
      stateManager.pendingProjects.set(chatId, {
        path: selectedProjectPath,
        name: projectName
      });

      const updateCard = {
        schema: "2.0",
        config: { wide_screen_mode: true },
        header: {
          template: "green",
          title: { tag: "plain_text", content: "📁 项目选择成功" }
        },
        body: {
          elements: [
            {
              tag: "div",
              text: {
                tag: "lark_md",
                content: `已选择项目: **${projectName}**\n路径: \`${selectedProjectPath}\`\n\n💬 **请直接在当前聊天中输入信息（如第一条指令或新会话名称）**，系统将自动在项目下创建新会话并开始工作。`
              }
            }
          ]
        }
      };

      try {
        await larkClient.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(updateCard) }
        });
      } catch (patchErr: any) {
        console.error('Failed to patch project selection card:', patchErr);
      }

      return {
        toast: {
          type: "success",
          content: `Selected project: ${projectName}`,
          i18n: {
            zh_cn: `已选择项目: ${projectName}`,
            en_us: `Selected project: ${projectName}`
          }
        }
      };
    }

    // 1. Handle session binding
    if (action.action_id === 'bind_select_thread' || actionValue.action === 'bind_select_thread') {
      const selectedThreadId = action.option || actionValue.threadId;
      if (!selectedThreadId) return;

      try {
        console.log(`Binding Chat ${chatId} to Codex Thread ${selectedThreadId}...`);
        const threads = await adapter.listThreads();
        const selectedThread = threads.find(t => t.id === selectedThreadId);
        const threadName = selectedThread ? selectedThread.name : `Session (${selectedThreadId})`;

        stateManager.sessionDb[chatId] = {
          threadId: selectedThreadId,
          threadName: threadName,
          cwd: selectedThread ? selectedThread.cwd : ""
        };
        saveSessions(stateManager.sessionDb);

        checkAndPushHistory().catch(e => {
          console.error('Failed to run history check after binding:', e);
        });

        const successCard = createBoundSuccessCard(threadName, selectedThreadId);
        await larkClient.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(successCard) }
        });

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
      let approval = stateManager.activeApprovals.get(approvalId);
      if (!approval) {
        try {
          const reloaded = loadApprovals();
          approval = reloaded.get(approvalId);
          if (approval) {
            stateManager.activeApprovals.set(approvalId, approval);
            console.log(`[Cache Sync] Successfully reloaded approval ${approvalId} from disk.`);
          }
        } catch (reloadErr) {
          console.error('Failed to reload approvals from approvals.json:', reloadErr);
        }
      }

      if (!approval) {
        const expiredCard = {
          schema: "2.0",
          config: { wide_screen_mode: true },
          header: {
            template: "grey",
            title: { tag: "plain_text", content: "⚠️ Codex 审批已过期" }
          },
          body: {
            elements: [
              {
                tag: "markdown",
                content: "⏳ **该审批请求已过期或不存在。**\n此审批可能已在其他设备处理，或超出了 30 分钟的安全有效期。"
              }
            ]
          }
        };

        if (messageId) {
          larkClient.im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(expiredCard) }
          }).catch(err => {
            console.error('Failed to patch expired approval card:', err);
          });
        }

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

      // Check if this approval was already processed to prevent duplicate clicks
      if (approval.status === 'approved' || approval.status === 'declined') {
        const decidedCard = createApprovalDecidedCard(
          approval.approvalType,
          approval.cwd,
          approval.summary,
          approval.reason,
          approval.decision || 'accept'
        );
        if (messageId) {
          larkClient.im.message.delete({
            path: { message_id: messageId }
          }).catch(err => {
            console.error('Failed to recall already processed approval card message:', err);
            if (approval.cardId) {
              const nextSeq = (approval.sequence || 1) + 1;
              approval.sequence = nextSeq;
              saveApprovals(stateManager.activeApprovals);
              updateCardKitCard(approval.cardId, decidedCard, nextSeq).catch(console.error);
            }
          });
        }
        return {
          toast: {
            type: "info",
            content: "This approval has already been processed",
            i18n: {
              zh_cn: `该审批已于之前被处理：${approval.status === 'approved' ? '批准' : '拒绝'}`,
              en_us: `This approval has already been processed: ${approval.status}`
            }
          }
        };
      }

      let allowedApproversStr = process.env.ALLOWED_APPROVERS;
      let isSingleChat = context.chat_type === 'p2p' || context.chat_type === 'direct';

      if (!isSingleChat) {
        try {
          const chatInfo = await larkClient.im.chat.get({
            path: { chat_id: chatId }
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

      // Mark as processed instead of deleting, so we can support repeat click checks
      approval.status = decision === 'decline' ? 'declined' : 'approved';
      approval.decision = decision;
      saveApprovals(stateManager.activeApprovals);

      try {
        const ipcId = approval.ipcRequestId || (approval.isIpc ? approval.requestId : undefined);
        const wsId = approval.wsRequestId || (!approval.isIpc ? approval.requestId : undefined);

        console.log(`Responding to Codex Approval (IPC ID: ${ipcId || 'none'}, WS ID: ${wsId || 'none'}) with decision ${decision}...`);

        // 1. Respond to IPC channel if present
        if (ipcId && (adapter as any).respondIpcApproval) {
          try {
            const success = await (adapter as any).respondIpcApproval({
              threadId: approval.threadId,
              requestId: ipcId,
              method: approval.approvalMethod || 'command',
              decision: decision
            });
            console.log(`IPC approval response returned: ${success}`);
          } catch (ipcErr) {
            console.error('Failed to respond to IPC approval:', ipcErr);
          }
        }

        // 2. Respond to WebSocket JSON-RPC channel if present
        if (wsId) {
          try {
            adapter.respond(wsId, { decision });
            console.log(`WebSocket approval response returned for request ID: ${wsId}`);
          } catch (wsErr) {
            console.error('Failed to respond to WebSocket approval:', wsErr);
          }
        }

        // 3. Fallback to default respond logic if neither was explicitly mapped
        if (!ipcId && !wsId) {
          if (approval.isIpc && (adapter as any).respondIpcApproval) {
            await (adapter as any).respondIpcApproval({
              threadId: approval.threadId,
              requestId: approval.requestId,
              method: approval.approvalMethod || 'command',
              decision: decision
            });
          } else {
            adapter.respond(approval.requestId, { decision });
          }
        }

        const decidedCard = createApprovalDecidedCard(
          approval.approvalType,
          approval.cwd,
          approval.summary,
          approval.reason,
          decision
        );

        if (messageId) {
          larkClient.im.message.delete({
            path: { message_id: messageId }
          }).catch(err => {
            console.error('Failed to recall/delete approval card message, updating card content instead:', err);
            if (approval.cardId) {
              const nextSeq = (approval.sequence || 1) + 1;
              approval.sequence = nextSeq;
              saveApprovals(stateManager.activeApprovals);
              updateCardKitCard(approval.cardId, decidedCard, nextSeq).catch(console.error);
            }
          });
        }

        return {
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

// Start everything
async function main() {
  const creds = await initLarkClient();

  setupLogging();

  await initCodex(handleCodexNotification);

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
