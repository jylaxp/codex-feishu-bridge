import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Creates a one-time 256-bit opaque action token. */
export function createOpaqueActionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hashes action tokens before durable persistence or lookup. */
export function hashActionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Reconstructs a task-scoped opaque cancel token for complete-card redraws.
 * The token is never persisted; the database stores only its SHA-256 hash.
 */
export function deriveTaskCancelToken(appSecret: string, taskId: string): string {
  if (!appSecret || !taskId) {
    throw new TypeError('App secret and task id are required for a cancellation token');
  }
  return createHmac('sha256', appSecret)
    .update('codex-feishu-bridge\0task-cancel\0')
    .update(taskId)
    .digest('base64url');
}
