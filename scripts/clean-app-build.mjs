import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const target = process.argv[2];
const relativePaths = target === 'test'
  ? ['dist-test']
  : ['dist/app', 'dist-test'];

for (const relativePath of relativePaths) {
  rmSync(resolve(projectRoot, relativePath), { force: true, recursive: true });
}
