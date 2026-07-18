import type { AppServerControlPlaneMethod } from './app-server-protocol-adapter';
import { createAppServerProtocolValidator } from './app-server-protocol-validator';

/** Narrow response adapter for the exact 0.144.3 protocol profile. */
export const APP_SERVER_PROTOCOL_V144 = createAppServerProtocolValidator(
  'app-server-0.144.3',
  mapRequest,
);

function mapRequest(method: AppServerControlPlaneMethod, params: unknown): unknown {
  if (!isRecord(params)) {
    return params;
  }
  if (method !== 'thread/start' && method !== 'thread/fork' && method !== 'turn/start') {
    return params;
  }
  const supportedParams: Record<string, unknown> = { ...params };
  if (method === 'thread/start' || method === 'turn/start') {
    delete supportedParams.runtimeWorkspaceRoots;
  }
  if (method === 'thread/fork') {
    delete supportedParams.beforeTurnId;
    delete supportedParams.deferGoalContinuation;
  }
  return supportedParams;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
