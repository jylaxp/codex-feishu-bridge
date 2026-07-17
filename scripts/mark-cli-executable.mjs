import { chmodSync } from 'node:fs';

// npm exposes Unix binaries as symlinks. Keep the compiled CLI executable so
// `npm install -g` works without requiring callers to invoke `node` directly.
chmodSync(new URL('../dist/app/cli.js', import.meta.url), 0o755);
