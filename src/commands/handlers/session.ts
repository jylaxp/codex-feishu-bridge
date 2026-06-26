import { stateManager } from '../../core/state';
import { adapter } from '../../codex/connector';
import { sendSimpleStatusCard, createCardKitCard, sendCardKitMessage } from '../../feishu/card';
import { createHelpCard, createBoundSuccessCard } from '../../cards/templates';
import { saveSessions } from '../../core/storage';
import { checkAndPushHistory } from '../../codex/history';

export async function handleHelp(chatId: string) {
  try {
    const helpCard = createHelpCard();
    const cardId = await createCardKitCard(helpCard);
    await sendCardKitMessage(chatId, cardId);
  } catch (e: any) {
    console.error('Failed to send help card:', e);
    const { getAllowedCommands } = require('../router');
    const allowedCommands = getAllowedCommands();
    await sendSimpleStatusCard(chatId, "💡 Codex 飞书助手指令指南 (备用)", "blue", `支持的指令：\n- /list 或 /l: 绑定/列出会话\n- /ll: 绑定/列出会话 (表格 Table 视图)\n- /new [名称] 或 /create: 新建并绑定新会话\n- /cwd [工作目录] 或 /workspace: 查询或切换工作目录\n- /cmd [命令] 或 /run: 执行本地终端命令 (当前支持: ${allowedCommands.join(', ')})\n- /goal [目标内容]: 设置并启动目标模式\n- /goal: 查看当前目标状态\n- /goal clear: 清除当前目标\n- /mcp: 查看 MCP 服务及认证状态\n- /model [名称]: 设置或查询当前会话使用的大模型\n- /personality [friendly|pragmatic|none]: 设置或查询回复风格\n- /compact: 压缩当前会话上下文\n- /fork [新名称]: 派生并绑定新会话\n- /plan: 开启或关闭计划模式 (Plan Mode)\n- /status: 展示当前会话综合状态\n- /skills: 列出当前工作区可用技能\n- 在日常对话中通过 @技能名称 提及并调用特定技能 (例如: @Ce Debug 为什么编译报错)\n- /usage 或 /quota: 获取当前账户的短期/长期窗口用量及重置时间\n- /delete 或 /archive: 归档并解绑会话\n- /help 或 /h: 获取此帮助卡片`);
  }
}

export async function handleNew(chatId: string, text: string) {
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

    stateManager.sessionDb[chatId] = {
      threadId: threadId,
      threadName: sessionName,
      cwd: thread?.cwd || ""
    };
    saveSessions(stateManager.sessionDb);

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
}

export async function handleFork(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
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
    
    await adapter.request('thread/name/set', {
      threadId: newThreadId,
      name: forkName
    });
    
    stateManager.sessionDb[chatId] = {
      threadId: newThreadId,
      threadName: forkName,
      cwd: bound.cwd || "",
      personality: bound.personality,
      planMode: bound.planMode
    };
    saveSessions(stateManager.sessionDb);
    
    await sendSimpleStatusCard(chatId, "🌱 会话派生成功", "green", `已成功以此前的历史派生出新会话！\n\n- 📂 新会话名称: **${forkName}**\n- 🆔 会话 ID: \`${newThreadId}\`\n\n当前飞书聊天已自动绑定到该新会话。`);
  } catch (e: any) {
    console.error('Failed to execute fork command:', e);
    await sendSimpleStatusCard(chatId, "🌱 派生会话失败", "red", `${e.message || e}`);
  }
}

export async function handleDelete(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
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
    delete stateManager.sessionDb[chatId];
    saveSessions(stateManager.sessionDb);

    await sendSimpleStatusCard(chatId, "🗑️ 会话归档解绑成功", "green", `已成功将当前聊天与 Codex 会话 **${threadName}** 解绑，并在本地完成归档。`);

  } catch (e: any) {
    console.error('Failed to unbind or archive session:', e);
    await sendSimpleStatusCard(chatId, "🗑️ 解绑失败", "red", `${e.message || e}`);
  }
}
