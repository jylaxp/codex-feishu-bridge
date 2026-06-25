import { ActiveTurn, ActiveApproval, SessionDb } from '../types';
import { loadSessions, loadPushedTurns } from './storage';

export class BridgeStateManager {
  public sessionDb: SessionDb = loadSessions();
  public pushedTurns: Set<string> = loadPushedTurns();
  public activeTurns = new Map<string, ActiveTurn>();
  public threadToActiveTurnId = new Map<string, string>();
  public recentTurns = new Map<string, ActiveTurn>();
  public activeApprovals = new Map<string, ActiveApproval>();
  public processedMessageIds = new Map<string, number>();
  public exploreCwds = new Map<string, string>();

  public isMessageProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  public markMessageProcessed(messageId: string) {
    this.processedMessageIds.set(messageId, Date.now());
  }

  public cleanOldMessageIds(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    for (const [id, timestamp] of this.processedMessageIds.entries()) {
      if (timestamp < cutoff) {
        this.processedMessageIds.delete(id);
      }
    }
  }
}

export const stateManager = new BridgeStateManager();
