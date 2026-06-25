import { stateManager } from '../core/state';
import { adapter } from './connector';
import { saveSessions, savePushedTurns } from '../core/storage';
import { parseCodexTurnToActiveTurn, fetchRateLimitsForTurn } from './stats';
import { createCardKitFinalLayout } from '../cards/turn-cards';
import { createCardKitCard, sendCardKitMessage } from '../feishu/card';

export async function checkAndPushHistory() {
  console.log('Checking for history turns to push to Feishu...');
  let sessionsChanged = false;
  let pushedTurnsChanged = false;

  const promises = Object.entries(stateManager.sessionDb).map(async ([chatId, session]) => {
    console.log(`Checking history for Feishu Chat ${chatId} / Codex Thread ${session.threadId}...`);
    try {
      const result = await adapter.request('thread/resume', { threadId: session.threadId });
      const turns = result?.thread?.turns || [];
      
      let latestCompletedTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (turn.status === 'completed' || turn.status === 'failed') {
          latestCompletedTurn = turn;
          break;
        }
      }

      if (latestCompletedTurn) {
        if (session.lastPushedTurnId === latestCompletedTurn.id || stateManager.pushedTurns.has(latestCompletedTurn.id)) {
          console.log(`History turn ${latestCompletedTurn.id} for thread ${session.threadId} is already pushed. Skipping.`);
          if (session.lastPushedTurnId !== latestCompletedTurn.id) {
            session.lastPushedTurnId = latestCompletedTurn.id;
            sessionsChanged = true;
          }
          return;
        }

        console.log(`Found latest completed turn ${latestCompletedTurn.id} for thread ${session.threadId}. Pushing to Feishu...`);
        
        const activeTurn = parseCodexTurnToActiveTurn(chatId, session.threadId, latestCompletedTurn);
        if (result?.model) {
          activeTurn.stats.model = result.model;
        }
        await fetchRateLimitsForTurn(activeTurn);
        const finalLayout = await createCardKitFinalLayout(activeTurn);
        
        const cardId = await createCardKitCard(finalLayout);
        const messageId = await sendCardKitMessage(chatId, cardId);
        
        if (messageId) {
          console.log(`Successfully pushed history turn ${latestCompletedTurn.id} to Feishu Message ${messageId}`);
          session.lastPushedTurnId = latestCompletedTurn.id;
          sessionsChanged = true;
          stateManager.pushedTurns.add(latestCompletedTurn.id);
          pushedTurnsChanged = true;
        }
      } else {
        console.log(`No completed/failed turns found in history for thread ${session.threadId}`);
        if (session.lastPushedTurnId !== null && session.lastPushedTurnId !== undefined) {
          session.lastPushedTurnId = undefined;
          sessionsChanged = true;
        }
      }
    } catch (e) {
      console.error(`Failed to push history for thread ${session.threadId}:`, e);
    }
  });

  await Promise.all(promises);

  if (sessionsChanged) {
    saveSessions(stateManager.sessionDb);
  }
  if (pushedTurnsChanged) {
    savePushedTurns(stateManager.pushedTurns);
  }
}
