import { adapter } from './connector';
import { ActiveTurn, TurnStats } from '../types';

export function extractStatsFromParams(params: any): TurnStats {
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

export function formatCount(value?: number): string {
  if (value === undefined || value === null) return "-";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m${remainder.toString().padStart(2, '0')}s`;
}

export function getStatsFooterText(turn: ActiveTurn): string {
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

export function formatResetTime(timestampSec?: number): string {
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

export async function fetchRateLimitsForTurn(turn: ActiveTurn): Promise<void> {
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

export function getTurnMetadataContent(turn: ActiveTurn): string | null {
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

export function parseCodexTurnToActiveTurn(chatId: string, threadId: string, turn: any): ActiveTurn {
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

