import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { ChatGptAppVersion } from './protocol-version-config';

export interface ChatGptAppVersionDependencies {
  readonly executeFile?: typeof execFileSync;
  readonly platform?: NodeJS.Platform;
}

/** Reads the containing ChatGPT.app identity when the configured binary is bundled on macOS. */
export function inspectChatGptAppVersion(
  codexBinary: string,
  dependencies: ChatGptAppVersionDependencies = {},
): ChatGptAppVersion | null {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    return null;
  }
  const appPath = findContainingApp(codexBinary);
  if (appPath === null || basename(appPath) !== 'ChatGPT.app') {
    return null;
  }
  const infoPlist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(infoPlist)) {
    return null;
  }
  const executeFile = dependencies.executeFile ?? execFileSync;
  try {
    const version = executeFile(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', infoPlist],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    const build = executeFile(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleVersion', infoPlist],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    return version && build ? Object.freeze({ appPath, version, build }) : null;
  } catch {
    return null;
  }
}

function findContainingApp(filePath: string): string | null {
  let current = dirname(filePath);
  while (current !== dirname(current)) {
    if (current.endsWith('.app')) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}
