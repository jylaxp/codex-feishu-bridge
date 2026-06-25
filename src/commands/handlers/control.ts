import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { platform } from '../../core/platform';
import { stateManager } from '../../core/state';
import { adapter } from '../../codex/connector';
import {
  sendSimpleStatusCard,
  createCardKitCard,
  sendCardKitMessage,
  finalizeCardKitCard
} from '../../feishu/card';
import { createGoalCard } from '../../cards/templates';
import { createCardKitInitialLayout, createCardKitFinalLayout } from '../../cards/turn-cards';
import { saveSessions } from '../../core/storage';
import { getAllowedCommands, parseCommandArgs } from '../router';
import { ActiveTurn } from '../../types';

export async function handleGoal(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
  if (!bound) {
    await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
    return;
  }

  try {
    const parts = text.split(/\s+/);
    const commandArg = parts.slice(1).join(" ").trim();

    if (!commandArg) {
      console.log(`Fetching goal status for thread: ${bound.threadId}`);
      const getRes = await adapter.request('thread/goal/get', { threadId: bound.threadId });
      console.log('Codex thread/goal/get response:', JSON.stringify(getRes));
      
      const goal = getRes?.goal;
      const goalCard = createGoalCard(goal);
      const cardId = await createCardKitCard(goalCard);
      await sendCardKitMessage(chatId, cardId);
    } else if (commandArg === 'clear' || commandArg === '-c' || commandArg === '--clear') {
      console.log(`Clearing goal for thread: ${bound.threadId}`);
      const clearRes = await adapter.request('thread/goal/clear', { threadId: bound.threadId });
      console.log('Codex thread/goal/clear response:', JSON.stringify(clearRes));

      await sendSimpleStatusCard(chatId, "🎯 Codex 目标清除", "grey", `已成功清除会话 **${bound.threadName}** 的当前目标。`);
    } else {
      console.log(`Setting new goal for thread: ${bound.threadId}. Goal: "${commandArg}"`);
      const setRes = await adapter.request('thread/goal/set', {
        threadId: bound.threadId,
        objective: commandArg,
        status: "active"
      });
      console.log('Codex thread/goal/set response:', JSON.stringify(setRes));

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

      const initialLayout = await createCardKitInitialLayout(initialTurn);
      const cardId = await createCardKitCard(initialLayout);
      initialTurn.cardId = cardId;

      const logCardMessageId = await sendCardKitMessage(chatId, cardId);
      if (!logCardMessageId) {
        throw new Error("Failed to retrieve Feishu log card message ID for goal turn");
      }
      initialTurn.messageId = logCardMessageId;

      const tempTurnId = 'temp-' + crypto.randomUUID();
      stateManager.activeTurns.set(tempTurnId, initialTurn);
      stateManager.threadToActiveTurnId.set(bound.threadId, tempTurnId);

      (async () => {
        try {
          const turnId = await adapter.startRemoteControlTurn({
            threadId: bound.threadId,
            cwd: bound.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir(),
            prompt: `开始执行目标：${commandArg}`,
            collaborationMode: bound.planMode ? "plan" : null,
            model: bound.model || null,
            personality: bound.personality || null
          });

          stateManager.activeTurns.delete(tempTurnId);
          stateManager.activeTurns.set(turnId, initialTurn);
          stateManager.threadToActiveTurnId.set(bound.threadId, turnId);
          console.log(`Goal turn started and mapped with ID: ${turnId}`);
        } catch (e: any) {
          console.error('Asynchronous Codex goal turn trigger failed:', e);
          stateManager.activeTurns.delete(tempTurnId);
          const activeTurnId = stateManager.threadToActiveTurnId.get(bound.threadId);
          if (activeTurnId === tempTurnId) {
            stateManager.threadToActiveTurnId.delete(bound.threadId);
          }
          
          initialTurn.status = 'failed';
          initialTurn.logs.push(`Failed to trigger goal turn: ${e.message || e}`);
          if (initialTurn.cardId) {
            const finalLayout = await createCardKitFinalLayout(initialTurn);
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
}

export async function handlePlan(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
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
  saveSessions(stateManager.sessionDb);
  
  await sendSimpleStatusCard(chatId, `📝 计划模式：${nextState ? '已开启 🟢' : '已关闭 🔴'}`, nextState ? "green" : "grey", nextState ? "接下来的开发指令将优先生成 implementation_plan 供您审批。" : "接下来将直接运行日常对话。");
}

export async function handleCompact(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
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
}

export async function handleCancel(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
  if (!bound) {
    await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
    return;
  }
  try {
    console.log(`Attempting to cancel active turn for thread: ${bound.threadId}`);
    const activeTurnId = stateManager.threadToActiveTurnId.get(bound.threadId);
    if (!activeTurnId) {
      await sendSimpleStatusCard(chatId, "🛑 无活跃任务", "grey", "当前会话没有正在运行的任务，无需取消。");
      return;
    }

    if (activeTurnId.startsWith('temp-')) {
      await sendSimpleStatusCard(chatId, "🛑 任务正在启动中", "orange", "任务正在启动，请在几秒后任务开始运行后再输入 `/cancel` 取消。");
      return;
    }

    console.log(`Sending turn/interrupt for thread: ${bound.threadId}, turnId: ${activeTurnId}`);
    await adapter.request('turn/interrupt', { threadId: bound.threadId, turnId: activeTurnId });

    await sendSimpleStatusCard(chatId, "🛑 任务取消指令已发送", "grey", "已向 Codex 发送取消任务指令，任务正在中断中...");
  } catch (e: any) {
    console.error('Failed to cancel active turn:', e);
    await sendSimpleStatusCard(chatId, "🛑 取消任务失败", "red", `${e.message || e}`);
  }
}

export async function handleCwd(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
  if (!bound) {
    await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定任何 Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
    return;
  }

  try {
    const parts = text.split(/\s+/);
    let newCwd = parts.slice(1).join(" ").trim();

    if (!newCwd) {
      const exploreCwd = stateManager.exploreCwds.get(chatId);
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
          await sendSimpleStatusCard(chatId, "🚫 路径绑定失败", "red", `路径存在：\n\`${finalCwd}\``);
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
      saveSessions(stateManager.sessionDb);
      stateManager.exploreCwds.set(chatId, finalCwd);

      await sendSimpleStatusCard(chatId, "📁 工作目录绑定成功", "green", `已将当前会话 **${bound.threadName}** 的工作目录（CWD）绑定并保存为：\n\`${finalCwd}\``);
    }
  } catch (e: any) {
    console.error('Failed to update or query session CWD:', e);
    await sendSimpleStatusCard(chatId, "📁 设置工作目录失败", "red", `${e.message || e}`);
  }
}

export async function executeUserCommand(chatId: string, command: string) {
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
  const allowedCommands = getAllowedCommands();

  if (!allowedCommands.includes(firstWord)) {
    await sendSimpleStatusCard(chatId, "⚠️ 安全警示", "orange", `根据系统安全策略，本地命令 \`${firstWord}\` 不在执行白名单中。\n\n如需执行，请联系网桥管理员在 \`.env\` 配置文件中通过 \`ALLOWED_SHELL_COMMANDS\` 加上该命令名。`);
    return;
  }

  const bound = stateManager.sessionDb[chatId];
  let execCwd = stateManager.exploreCwds.get(chatId);
  if (!execCwd) {
    execCwd = bound?.cwd || process.env.CODEX_CWD || process.cwd() || os.homedir();
    stateManager.exploreCwds.set(chatId, execCwd);
  }

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
        await sendSimpleStatusCard(chatId, "🚫 切换目录失败", "red", `路径存在：\n\`${newCwd}\``);
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

    stateManager.exploreCwds.set(chatId, newCwd);

    let replyText = `📂 探查目录已切换为：\n\`${newCwd}\``;
    if (bound) {
      replyText += `\n\n*(注意：当前绑定的会话工作目录未受影响。若要正式应用并保存此目录，请发送 \`/cwd\`)*`;
    }

    await sendSimpleStatusCard(chatId, "📂 探查目录已切换", "indigo", replyText);
    return;
  }

  console.log(`Executing terminal command: "${command}" in cwd: "${execCwd}"`);

  try {
    platform.runShellCommand(command, parsedArgs, execCwd, 15000).then(async ({ error, stdout, stderr }) => {
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
