import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const npmCli = process.env.npm_execpath;
if (!npmCli || !isAbsolute(npmCli)) {
  throw new Error('Package check must run through npm with an absolute npm_execpath');
}

const cacheDirectory = join(tmpdir(), 'codex-feishu-bridge-npm-cache');
mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });

const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run'], {
  env: {
    ...process.env,
    npm_config_cache: cacheDirectory,
  },
  shell: false,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
