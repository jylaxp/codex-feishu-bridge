import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const relativePaths = ['dist/app'];

for (const relativePath of relativePaths) {
  rmSync(resolve(projectRoot, relativePath), { force: true, recursive: true });
}
