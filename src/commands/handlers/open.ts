import { sendSimpleStatusCard } from '../../feishu/card';
import { stateManager } from '../../core/state';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export async function handleOpen(chatId: string) {
  const bound = stateManager.sessionDb[chatId];
  if (!bound || !bound.threadId) {
    await sendSimpleStatusCard(chatId, "⚠️ 无法唤起", "red", "当前飞书群聊未绑定任何 Codex 会话。请先使用 `/list` 或 `/new` 绑定会话。");
    return;
  }

  try {
    console.log(`Attempting to open Codex Desktop for thread ${bound.threadId}...`);
    // 使用 codex:// URL Scheme 唤起桌面端并强制跳转到该会话
    await execAsync(`open "codex://chat/${bound.threadId}"`);
    await sendSimpleStatusCard(chatId, "✅ 唤起成功", "green", `已向系统发送唤起指令！\n\nCodex 桌面端应该已经自动弹出并跳转到了当前会话：**${bound.threadName}**\n*(如果不成功，请确保 Codex 桌面端正在运行并且支持 codex:// 协议)*`);
  } catch (e: any) {
    console.error('Failed to open Codex Desktop:', e);
    await sendSimpleStatusCard(chatId, "❌ 唤起失败", "red", `执行唤起指令时出错：\n${e.message || e}`);
  }
}
