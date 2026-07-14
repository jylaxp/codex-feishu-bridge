import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export class AppNavigationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppNavigationError';
  }
}

export interface ThreadNavigation {
  openThread(threadId: string): Promise<void>;
}

export interface UriLauncher {
  open(uri: string): Promise<void>;
}

export interface CodexAppNavigationOptions {
  readonly platform?: NodeJS.Platform;
  readonly launcher?: UriLauncher;
}

/**
 * Opens one known Codex task using the documented canonical deep-link form.
 * It never discovers or infers the active Desktop page.
 */
export class CodexAppNavigationAdapter implements ThreadNavigation {
  private readonly platform: NodeJS.Platform;
  private readonly launcher: UriLauncher;

  public constructor(options: CodexAppNavigationOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.launcher = options.launcher ?? new MacOsUriLauncher(this.platform);
  }

  public async openThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || normalizedThreadId.length > 512 || /[\u0000-\u001F\u007F]/.test(normalizedThreadId)) {
      throw new AppNavigationError('Codex thread id is invalid for navigation');
    }
    await this.launcher.open(`codex://threads/${encodeURIComponent(normalizedThreadId)}`);
  }
}

class MacOsUriLauncher implements UriLauncher {
  public constructor(private readonly platform: NodeJS.Platform) {}

  public async open(uri: string): Promise<void> {
    if (this.platform !== 'darwin') {
      throw new AppNavigationError('Automatic Codex task navigation is currently available on macOS only');
    }
    try {
      await execFile('open', [uri], { windowsHide: true });
    } catch (error) {
      throw new AppNavigationError('Could not open the selected Codex task in ChatGPT Desktop', {
        cause: error,
      });
    }
  }
}
