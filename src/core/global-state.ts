import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export async function registerThreadInGlobalState(
  threadId: string,
  options: { projectPath?: string; isProjectless?: boolean }
): Promise<void> {
  const homeDir = os.homedir();
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  try {
    let globalState: any = {};
    if (fs.existsSync(globalStatePath)) {
      const globalStateStr = await fs.promises.readFile(globalStatePath, 'utf8');
      globalState = JSON.parse(globalStateStr);
    }

    if (options.isProjectless) {
      if (!globalState['projectless-thread-ids']) {
        globalState['projectless-thread-ids'] = [];
      }
      if (!globalState['projectless-thread-ids'].includes(threadId)) {
        globalState['projectless-thread-ids'].push(threadId);
      }
    } else if (options.projectPath) {
      const projectPath = options.projectPath;
      
      // 1. Register under thread-writable-roots
      if (!globalState['thread-writable-roots']) {
        globalState['thread-writable-roots'] = {};
      }
      const existingRoots = globalState['thread-writable-roots'][threadId] || [];
      if (!existingRoots.includes(projectPath)) {
        globalState['thread-writable-roots'][threadId] = [...existingRoots, projectPath];
      }

      // 2. Register under thread-workspace-root-hints
      if (!globalState['thread-workspace-root-hints']) {
        globalState['thread-workspace-root-hints'] = {};
      }
      globalState['thread-workspace-root-hints'][threadId] = projectPath;

      // 3. Set as active workspace root
      globalState['active-workspace-roots'] = [projectPath];
    }

    await fs.promises.writeFile(globalStatePath, JSON.stringify(globalState, null, 2), 'utf8');
    console.log(`[Global State] Successfully registered thread ${threadId} in Codex global state:`, options);
  } catch (err) {
    console.error(`[Global State] Failed to register thread ${threadId} in Codex global state:`, err);
  }
}
