import { createAppServerProtocolValidator } from './app-server-protocol-validator';

/** Narrow response adapter for the exact 0.145.0-alpha.18 protocol profile. */
export const APP_SERVER_PROTOCOL_V145 = createAppServerProtocolValidator(
  'app-server-0.145.0-alpha.18',
);
