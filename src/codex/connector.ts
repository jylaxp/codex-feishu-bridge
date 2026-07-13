/**
 * Bridge entry point for Codex integration.
 *
 * Architecture (same as VSCode extension):
 *   1. Spawn codex -c features.code_mode_host=true app-server --listen stdio://
 *   2. All JSON-RPC via stdio (turn/start, thread/list, skills/list, etc.)
 *   3. code_mode_host connects this app-server to the desktop IPC network
 *   4. Desktop detects SQLite changes → shows bridge-initiated turns in its UI
 *   5. All streaming events (deltas, completions) come through stdio JSON-RPC
 *
 * This is how VSCode extension works — no Desktop IPC, no thread-follower-start-turn.
 * Just a code_mode_host app-server + standard turn/start RPC.
 */
import { LocalAppServerAdapter } from '../adapter';
import { stateManager } from '../core/state';
import { checkAndPushHistory } from './history';
import { handleNotification, registerDependencies } from './events';

// Single app-server with code_mode_host, same as VSCode
export const adapter = new LocalAppServerAdapter({
  socketPath: '/tmp/bridge-direct.sock', // force spawn, never connect to daemon
});

export const client = adapter; // backward compat

export async function initCodex() {
  const { createCardKitInitialLayout, createCardKitFinalLayout } = require('../cards/turn-cards');
  const { streamUpdateCardKit, cleanupTurn } = require('./dispatcher');
  const { createCardKitCard, sendCardKitMessage, finalizeCardKitCard, sendSimpleStatusCard } = require('../feishu/card');
  const { fetchRateLimitsForTurn } = require('./stats');
  const { queueTurnTask } = require('./queue');
  const { saveSessions, savePushedTurns } = require('../core/storage');
  const { getChatIdForThread } = require('./dispatcher');

  registerDependencies({
    createCardKitInitialLayout, createCardKitFinalLayout,
    streamUpdateCardKit, createCardKitCard, sendCardKitMessage,
    finalizeCardKitCard, sendSimpleStatusCard,
    fetchRateLimitsForTurn, queueTurnTask, cleanupTurn,
    saveSessions, savePushedTurns, getChatIdForThread,
    routeCommand: (require('../commands/router') as any).routeCommand,
    checkAndPushHistory,
  });

  // Connect adapter (spawns app-server with code_mode_host)
  adapter.onNotification((msg) => {
    handleNotification(adapter as any, msg).catch(e => console.error('Event error:', e));
  });
  adapter.onExit(() => console.warn('App-server disconnected'));

  await adapter.connect();
  console.log('App-server connected (code_mode_host)');

  checkAndPushHistory().catch(e => console.error('History check failed:', e));
}
