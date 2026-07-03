import { spawn } from 'child_process';
const bin = '/Applications/Codex.app/Contents/Resources/codex';
console.log('Testing codex app-server --analytics-default-enabled ...');
const p = spawn(bin, ['app-server', '--analytics-default-enabled']);
setTimeout(() => {
  p.kill();
  process.exit(0);
}, 3000);
