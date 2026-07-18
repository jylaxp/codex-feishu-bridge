import type { AppServerProtocolProfileId } from './app-server-protocol-registry';

/** App Server methods whose response contracts are consumed by the bridge. */
export type AppServerControlPlaneMethod =
  | 'thread/list'
  | 'thread/read'
  | 'thread/resume'
  | 'thread/start'
  | 'thread/fork'
  | 'thread/name/set'
  | 'thread/archive'
  | 'thread/goal/get'
  | 'thread/goal/set'
  | 'thread/goal/clear'
  | 'thread/compact/start'
  | 'skills/list'
  | 'mcpServerStatus/list'
  | 'account/rateLimits/read'
  | 'turn/start';

/**
 * Version-specific response boundary.
 *
 * The adapter deliberately owns no transport lifecycle and is not selected by
 * version ranges. Startup passes the exact adapter matching its verified
 * protocol profile.
 */
export interface AppServerProtocolAdapter {
  readonly profileId: AppServerProtocolProfileId;
  supports(method: string): method is AppServerControlPlaneMethod;
  mapRequest(method: AppServerControlPlaneMethod, params: unknown): unknown;
  parseResponse(method: AppServerControlPlaneMethod, response: unknown): unknown;
}

/** Internal signal translated to a stable control-plane error at the boundary. */
export class AppServerProtocolValidationError extends Error {
  constructor() {
    super('App Server response does not match the selected protocol');
    this.name = 'AppServerProtocolValidationError';
  }
}
