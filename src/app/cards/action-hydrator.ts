import { deriveTaskCancelToken } from '../action-tokens';
import { CardKitJson } from './layouts';

export const TASK_CANCEL_TOKEN_PLACEHOLDER = '__CODEX_BRIDGE_TASK_CANCEL_TOKEN__';

/** Replaces only the internal cancel-token placeholder immediately before delivery. */
export function hydrateTaskCardActions(
  card: CardKitJson,
  appSecret: string,
  taskId: string,
): CardKitJson {
  return replaceCancelAction(card, deriveTaskCancelToken(appSecret, taskId)) as CardKitJson;
}

function replaceCancelAction(value: unknown, cancelToken: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceCancelAction(entry, cancelToken));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.action === 'cancel'
    && record.token === TASK_CANCEL_TOKEN_PLACEHOLDER
  ) {
    return { ...record, token: cancelToken };
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = replaceCancelAction(entry, cancelToken);
  }
  return result;
}
