import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stateManager } from '../../core/state';
import { adapter } from '../../codex/connector';
import { sendSimpleStatusCard, createCardKitCard, sendCardKitMessage } from '../../feishu/card';
import { saveSessions } from '../../core/storage';
import { createMcpCard, createStatusCard, createSkillsCard } from '../../cards/templates';
import { formatDateTime24h } from '../../cards/common';
import { larkClient } from '../../feishu/client';

export async function handleMcp(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
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
}

export async function handleModel(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
  if (!bound) {
    await sendSimpleStatusCard(chatId, "⚠️ 未绑定会话", "orange", "当前飞书群聊未绑定 any Codex 会话，请先使用 `/list` 选择一个会话，或者使用 `/new` 指令创建一个会话。");
    return;
  }

  const parts = text.split(/\s+/);
  const modelName = parts.slice(1).join(" ").trim();

  if (!modelName) {
    // Show interactive list of models
    const modelsCachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
    if (fs.existsSync(modelsCachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(modelsCachePath, 'utf8'));
        if (cache.models && Array.isArray(cache.models)) {
          const elements: any[] = [];
          elements.push({
            tag: "markdown",
            content: "请从以下列表中选择一个模型，该模型将应用于当前会话："
          });
          
          const options = cache.models.map((m: any) => ({
            text: { tag: "plain_text", content: m.slug },
            value: m.slug
          }));

          elements.push({
            tag: "select_static",
            placeholder: {
              tag: "plain_text",
              content: "点击下拉选择模型..."
            },
            options: options,
            value: {
              action: "set_model"
            }
          });

          const card = {
            schema: "2.0",
            config: { wide_screen_mode: true },
            header: {
              template: "blue",
              title: { tag: "plain_text", content: "🤖 选择大模型" }
            },
            body: { elements }
          };
          await larkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }
          });
        } else {
          await sendSimpleStatusCard(chatId, "⚠️ 读取失败", "orange", "本地 models_cache.json 格式不符合预期，请手动使用 `/model <名称>` 指定。");
        }
      } catch (e: any) {
        await sendSimpleStatusCard(chatId, "⚠️ 读取失败", "orange", `解析 models_cache.json 失败: ${e.message}\n请手动使用 \`/model <名称>\` 指定。`);
      }
    } else {
      await sendSimpleStatusCard(chatId, "⚠️ 缓存未找到", "orange", "未找到 Codex 的模型缓存文件。请手动使用 `/model <名称>` 指定。");
    }
  } else {
    bound.model = modelName;
    saveSessions(stateManager.sessionDb);
    await sendSimpleStatusCard(chatId, "🤖 模型设定", "green", `当前会话使用的模型已成功设定为：**${modelName}**。\n接下来发送给 Codex 的消息将应用该模型。`);
  }
}

export async function handlePersonality(chatId: string, text: string) {
  const bound = stateManager.sessionDb[chatId];
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
    saveSessions(stateManager.sessionDb);
    
    await sendSimpleStatusCard(chatId, "🎭 回复风格设定", "green", `会话回复风格已成功设定为：**${target}**。\n接下来 Codex 的回复风格将应用此选项。`);
  }
}

export async function handleStatus(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
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
}

export async function handleUsage(chatId: string) {
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
}

export async function handleSkills(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
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
      saveSessions(stateManager.sessionDb);
    }
  } catch (e: any) {
    console.error('Failed to execute skills command:', e);
    await sendSimpleStatusCard(chatId, "✨ 获取可用技能失败", "red", `${e.message || e}`);
  }
}
