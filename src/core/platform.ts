import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, exec } from 'child_process';

export interface ShellCommandResult {
  error: any;
  stdout: string;
  stderr: string;
}

export interface PlatformConfig {
  getDefaultSocketPath(): string;
  getIpcSocketPath(): Promise<string | null>;
  getAppServerBinaryPaths(): string[];
  runShellCommand(
    command: string,
    parsedArgs: string[],
    cwd: string,
    timeout: number
  ): Promise<ShellCommandResult>;
}

class MacOSConfig implements PlatformConfig {
  getDefaultSocketPath(): string {
    return path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
  }

  async getIpcSocketPath(): Promise<string | null> {
    const systemTmpDir = os.tmpdir();

    // Check new ChatGPT macOS app IPC socket pattern: com.openai.codex.XXXXXX/SingletonSocket
    try {
      const folders = fs.readdirSync(systemTmpDir);
      let newestSocket: string | null = null;
      let newestMtime = 0;

      for (const folder of folders) {
        if (folder.startsWith('com.openai.codex.')) {
          const sockPath = path.join(systemTmpDir, folder, 'SingletonSocket');
          if (fs.existsSync(sockPath)) {
            const stats = fs.statSync(sockPath);
            if (stats.mtimeMs > newestMtime) {
              newestMtime = stats.mtimeMs;
              newestSocket = sockPath;
            }
          }
        }
      }
      if (newestSocket) {
        return newestSocket;
      }
    } catch (e) {
      console.warn('Error finding new IPC socket:', e);
    }

    // Fallback to old behavior
    const codexIpcDir = path.join(systemTmpDir, 'codex-ipc');
    if (!fs.existsSync(codexIpcDir)) {
      return null;
    }
    const files = fs.readdirSync(codexIpcDir);
    const sockFile = files.find(f => (f.startsWith('ipc-') && f.endsWith('.sock')) || f === 'ipc.sock');
    return sockFile ? path.join(codexIpcDir, sockFile) : null;
  }

  getAppServerBinaryPaths(): string[] {
    return [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
      path.join(os.homedir(), '.local', 'bin', 'codex')
    ];
  }

  runShellCommand(
    command: string,
    parsedArgs: string[],
    cwd: string,
    timeout: number
  ): Promise<ShellCommandResult> {
    return new Promise((resolve) => {
      const file = parsedArgs[0];
      const args = parsedArgs.slice(1);
      execFile(file, args, { cwd, timeout }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }
}

class WindowsConfig implements PlatformConfig {
  getDefaultSocketPath(): string {
    // Windows uses named pipe for app server control socket
    return '\\\\.\\pipe\\codex-app-server-control';
  }

  async getIpcSocketPath(): Promise<string | null> {
    // Windows uses named pipe for desktop app IPC
    // Typical path: \\.\pipe\codex-ipc-<UUID>
    // Note: Since Node.js can directly connect to named pipes, we'll try standard named pipes.
    // For now we return a common fallback or scan if possible. In standard Windows app setups,
    // a common fallback pattern is '\\\\.\\pipe\\codex-ipc'.
    // If scanning is required, Windows Named Pipes cannot be easily listed via standard fs.readdirSync,
    // but the app server registry or fixed patterns can be used. We default to the standard named pipe prefix.
    return '\\\\.\\pipe\\codex-ipc';
  }

  getAppServerBinaryPaths(): string[] {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe'),
      path.join(programFiles, 'Codex', 'resources', 'codex.exe'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd')
    ];
  }

  runShellCommand(
    command: string,
    parsedArgs: string[],
    cwd: string,
    timeout: number
  ): Promise<ShellCommandResult> {
    return new Promise((resolve) => {
      const isShellBuiltIn = ['dir', 'echo', 'copy', 'del', 'move', 'mkdir', 'rmdir', 'type'].includes(parsedArgs[0].toLowerCase());
      if (isShellBuiltIn) {
        exec(command, { cwd, timeout }, (error, stdout, stderr) => {
          resolve({ error, stdout, stderr });
        });
      } else {
        const file = parsedArgs[0];
        const args = parsedArgs.slice(1);
        execFile(file, args, { cwd, timeout }, (error, stdout, stderr) => {
          resolve({ error, stdout, stderr });
        });
      }
    });
  }
}

export const platform: PlatformConfig = os.platform() === 'win32' ? new WindowsConfig() : new MacOSConfig();
