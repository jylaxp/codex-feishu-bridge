import type { AppServerProtocolAdapter } from './app-server-protocol-adapter';
import type { AppServerProtocolProfile } from './app-server-protocol-registry';
import { APP_SERVER_PROTOCOL_V144 } from './app-server-protocol-v144';
import { APP_SERVER_PROTOCOL_V145 } from './app-server-protocol-v145';

/** Minimal request capability implemented by AppServerClient and test fakes. */
export interface AppServerRequestClient {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
}

export type AppServerControlPlaneErrorCode =
  | 'UNSUPPORTED_METHOD'
  | 'INVALID_REQUEST'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE';

/** Stable error that never embeds raw server payloads or downstream messages. */
export class AppServerControlPlaneError extends Error {
  readonly code: AppServerControlPlaneErrorCode;

  constructor(code: AppServerControlPlaneErrorCode) {
    super(messageForCode(code));
    this.name = 'AppServerControlPlaneError';
    this.code = code;
  }
}

/**
 * Whitelisted App Server control surface exposed to bridge business services.
 *
 * Its generic request signature intentionally remains compatible with the
 * current catalog interfaces while every runtime response crosses the selected
 * version adapter before reaching a consumer.
 */
export class AppServerControlPlane implements AppServerRequestClient {
  constructor(
    private readonly client: AppServerRequestClient,
    private readonly adapter: AppServerProtocolAdapter,
  ) {}

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    if (!this.adapter.supports(method)) {
      throw new AppServerControlPlaneError('UNSUPPORTED_METHOD');
    }

    let mappedParams: unknown;
    try {
      mappedParams = this.adapter.mapRequest(method, params);
    } catch {
      throw new AppServerControlPlaneError('INVALID_REQUEST');
    }

    let response: unknown;
    try {
      response = await this.client.request<unknown>(method, mappedParams);
    } catch {
      throw new AppServerControlPlaneError('REQUEST_FAILED');
    }

    try {
      return this.adapter.parseResponse(method, response) as TResult;
    } catch {
      // Adapter bugs and validation failures must both fail closed without
      // exposing the untrusted response or an implementation stack as data.
      throw new AppServerControlPlaneError('INVALID_RESPONSE');
    }
  }
}

/**
 * Returns the adapter implemented for the selected exact profile.
 *
 * Each profile has an explicit export even though the two reviewed versions
 * share validators for the response fields consumed by the Bridge.
 */
export function adapterForAppServerProfile(
  profile: AppServerProtocolProfile,
): AppServerProtocolAdapter {
  switch (profile.id) {
    case 'app-server-0.145.0-alpha.18':
      return APP_SERVER_PROTOCOL_V145;
    case 'app-server-0.144.3':
      return APP_SERVER_PROTOCOL_V144;
    default:
      return assertNever(profile.id);
  }
}

function messageForCode(code: AppServerControlPlaneErrorCode): string {
  switch (code) {
    case 'UNSUPPORTED_METHOD':
      return 'App Server control-plane method is not registered';
    case 'INVALID_REQUEST':
      return 'App Server control-plane request is invalid for the selected protocol';
    case 'REQUEST_FAILED':
      return 'App Server control-plane request failed';
    case 'INVALID_RESPONSE':
      return 'App Server returned an invalid control-plane response';
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported App Server protocol profile: ${String(value)}`);
}
