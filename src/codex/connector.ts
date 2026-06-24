import { LocalAppServerAdapter } from '../adapter';
import { stateManager } from '../core/state';
import { checkAndPushHistory } from './history';
import { finalizeCardKitCard } from '../feishu/card';
import { createCardKitFinalLayout } from '../cards/turn-cards';

export const adapter = new LocalAppServerAdapter({
  socketPath: process.env.CODEX_SOCKET_PATH
});

export let isReconnecting = false;
export let reconnectAttempts = 0;

export async function connectWithRetry() {
  if (isReconnecting) return;
  isReconnecting = true;

  while (true) {
    try {
      console.log(`Connecting to Codex App Server (attempt ${reconnectAttempts + 1})...`);
      await adapter.connect();
      console.log('Codex App Server connection established.');
      reconnectAttempts = 0;
      isReconnecting = false;
      
      // Run history check asynchronously
      checkAndPushHistory().catch(e => {
        console.error('Failed to run startup history check:', e);
      });
      break;
    } catch (err: any) {
      reconnectAttempts++;
      const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
      console.error(`Connection to Codex failed: ${err.message || err}. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function initCodex(notificationHandler: (msg: any) => Promise<void>) {
  adapter.onExit(async () => {
    console.warn('Codex App Server disconnected.');
    const snapshot = Array.from(stateManager.activeTurns.entries());
    stateManager.activeTurns.clear();
    stateManager.threadToActiveTurnId.clear();
    for (const [turnId, turn] of snapshot) {
      turn.status = 'failed';
      const errorMsg = `\n⚠️ *[System]*: Codex App Server disconnected unexpectedly.`;
      turn.reasoning = (turn.reasoning || "") + errorMsg;
      if (turn.cardId) {
        const finalLayout = await createCardKitFinalLayout(turn);
        finalizeCardKitCard(turn.cardId, finalLayout, turn).catch(e =>
          console.error('Failed to finalize card on exit:', e)
        );
      }
    }

    // Automatically trigger reconnect loop on exit
    connectWithRetry().catch(e => {
      console.error('Reconnection loop encountered a fatal error:', e);
    });
  });

  // Start the initial connection flow
  await connectWithRetry();

  adapter.onNotification(notificationHandler);
}
