import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(__dirname, '../..', '..');
const appRoot = resolve(projectRoot, 'src/app');

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const absolutePath = resolve(directory, entry);
      return statSync(absolutePath).isDirectory()
        ? listTypeScriptFiles(absolutePath)
        : [absolutePath];
    })
    .filter((filePath) => extname(filePath) === '.ts');
}

test('new production graph cannot import legacy bridge modules', () => {
  const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  const violations: string[] = [];

  for (const filePath of listTypeScriptFiles(appRoot)) {
    const source = readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) {
        continue;
      }

      const resolvedImport = resolve(dirname(filePath), specifier);
      if (resolvedImport !== appRoot && !resolvedImport.startsWith(`${appRoot}${sep}`)) {
        violations.push(`${filePath}: ${specifier}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('package entrypoints and published files expose only the new application graph', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
  ) as {
    readonly main?: string;
    readonly bin?: Readonly<Record<string, string>>;
    readonly files?: readonly string[];
  };

  assert.equal(packageJson.main, 'dist/app/main.js');
  assert.deepEqual(packageJson.bin, {
    'codex-feishu-bridge': './dist/app/cli.js',
  });
  assert.deepEqual(packageJson.files, ['dist/app', 'README.md', '.env.example']);
});
