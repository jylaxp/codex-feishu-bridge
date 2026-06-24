import * as fs from 'fs';
import { SESSIONS_FILE, APPROVALS_FILE, PUSHED_TURNS_FILE, APPROVAL_TTL_MS } from '../config';
import { SessionDb, ActiveApproval } from '../types';

export function writeJsonFileSyncAtomic(filepath: string, data: any) {
  const tmpPath = filepath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filepath);
}

export function loadPushedTurns(): Set<string> {
  if (fs.existsSync(PUSHED_TURNS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(PUSHED_TURNS_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        return new Set(arr);
      }
    } catch (e) {
      console.error('Failed to parse pushed_turns.json:', e);
    }
  }
  return new Set();
}

export function savePushedTurns(set: Set<string>) {
  try {
    let arr = Array.from(set);
    if (arr.length > 1000) {
      arr = arr.slice(arr.length - 1000);
      set.clear();
      arr.forEach(item => set.add(item));
    }
    writeJsonFileSyncAtomic(PUSHED_TURNS_FILE, arr);
  } catch (e) {
    console.error('Failed to save pushed_turns.json:', e);
  }
}

export function loadSessions(): SessionDb {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse sessions.json:', e);
    }
  }
  return {};
}

export function saveSessions(db: SessionDb) {
  try {
    writeJsonFileSyncAtomic(SESSIONS_FILE, db);
  } catch (e) {
    console.error('Failed to save sessions.json:', e);
  }
}

export function loadApprovals(): Map<string, ActiveApproval> {
  const map = new Map<string, ActiveApproval>();
  if (fs.existsSync(APPROVALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8'));
      const now = Date.now();
      let hasExpired = false;
      for (const [key, value] of Object.entries(data)) {
        const approval = value as ActiveApproval;
        const createdAt = approval.createdAt || now;
        if (now - createdAt > APPROVAL_TTL_MS) {
          hasExpired = true;
          continue;
        }
        map.set(key, approval);
      }
      if (hasExpired) {
        saveApprovals(map);
      }
    } catch (e) {
      console.error('Failed to parse approvals.json:', e);
    }
  }
  return map;
}

export function saveApprovals(map: Map<string, ActiveApproval>) {
  try {
    const obj = Object.fromEntries(map.entries());
    writeJsonFileSyncAtomic(APPROVALS_FILE, obj);
  } catch (e) {
    console.error('Failed to save approvals.json:', e);
  }
}
