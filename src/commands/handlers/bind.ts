import { adapter } from '../../codex/connector';
import { sendSimpleStatusCard, createCardKitCard, sendCardKitMessage } from '../../feishu/card';
import { createBindingCard, createTableBindingCard } from '../../cards/turn-cards';

export async function handleList(chatId: string) {
  try {
    console.log(`Fetching Codex threads for /list...`);
    const threads = await adapter.listThreads();
    if (threads.length === 0) {
      await sendSimpleStatusCard(chatId, "⚠️ 未发现活跃会话", "orange", "No active Codex sessions found. Please open Codex Desktop client first.");
      return;
    }

    const bindingCard = await createBindingCard(threads);
    const cardId = await createCardKitCard(bindingCard);
    await sendCardKitMessage(chatId, cardId);
  } catch (e: any) {
    console.error('Failed to list threads or send card:', e);
    await sendSimpleStatusCard(chatId, "🚫 获取会话列表失败", "red", `Failed to bind Codex session: ${e.message || e}`);
  }
}

export async function handleTableList(chatId: string) {
  try {
    console.log(`Fetching Codex threads for /ll (Table View)...`);
    const threads = await adapter.listThreads();
    if (threads.length === 0) {
      await sendSimpleStatusCard(chatId, "⚠️ 未发现活跃会话", "orange", "No active Codex sessions found. Please open Codex Desktop client first.");
      return;
    }

    const bindingCard = await createTableBindingCard(threads);
    const cardId = await createCardKitCard(bindingCard);
    await sendCardKitMessage(chatId, cardId);
  } catch (e: any) {
    console.error('Failed to list threads in table view or send card:', e);
    await sendSimpleStatusCard(chatId, "🚫 获取会话列表失败", "red", `Failed to bind Codex session: ${e.message || e}`);
  }
}
