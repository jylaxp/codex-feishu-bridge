import { handleHelp, handleNew, handleFork, handleDelete, handleNewProject } from './handlers/session';
import { handleList, handleTableList } from './handlers/bind';
import { handleGoal, handlePlan, handleCompact, handleCancel, handleCwd, executeUserCommand } from './handlers/control';
import { handleUsage, handlePersonality, handleModel, handleStatus, handleSkills, handleMcp } from './handlers/info';

export function getAllowedCommands(): string[] {
  let allowedCommands = ['ls', 'pwd', 'git', 'find', 'cd'];
  if (process.env.ALLOWED_SHELL_COMMANDS) {
    allowedCommands = process.env.ALLOWED_SHELL_COMMANDS.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return allowedCommands;
}

export function parseCommandArgs(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

export async function routeCommand(chatId: string, text: string): Promise<boolean> {
  const trimmed = text.trim();
  
  // 0. Handle help command
  const isHelp = trimmed === '/help' || trimmed === '/h' || trimmed === 'help' || trimmed === 'h' || trimmed.startsWith('/help ') || trimmed.startsWith('/h ');
  if (isHelp) {
    await handleHelp(chatId);
    return true;
  }

  // 1. Handle list / ll commands
  if (trimmed.startsWith('/list')) {
    await handleList(chatId);
    return true;
  }
  if (trimmed.startsWith('/ll')) {
    await handleTableList(chatId);
    return true;
  }

  // 2. Handle goal command
  if (trimmed.startsWith('/goal')) {
    await handleGoal(chatId, trimmed);
    return true;
  }

  // 3. Handle mcp command
  if (trimmed.startsWith('/mcp')) {
    await handleMcp(chatId);
    return true;
  }

  // 4. Handle model command
  if (trimmed.startsWith('/model')) {
    await handleModel(chatId, trimmed);
    return true;
  }

  // 5. Handle personality command
  if (trimmed.startsWith('/personality') || trimmed.startsWith('/style')) {
    await handlePersonality(chatId, trimmed);
    return true;
  }

  // 6. Handle compact command
  if (trimmed.startsWith('/compact') || trimmed.startsWith('/compress')) {
    await handleCompact(chatId);
    return true;
  }

  // 7. Handle fork command
  if (trimmed.startsWith('/fork') || trimmed.startsWith('/branch')) {
    await handleFork(chatId, trimmed);
    return true;
  }

  // 8. Handle plan command
  if (trimmed.startsWith('/plan')) {
    await handlePlan(chatId, trimmed);
    return true;
  }

  // 9. Handle status command
  if (trimmed.startsWith('/status')) {
    await handleStatus(chatId);
    return true;
  }

  // 10. Handle usage command
  if (trimmed.startsWith('/usage') || trimmed.startsWith('/quota')) {
    await handleUsage(chatId);
    return true;
  }

  // 11. Handle skills command
  if (trimmed.startsWith('/skills')) {
    await handleSkills(chatId);
    return true;
  }

  // 12. Handle new command
  if (trimmed.startsWith('/new') || trimmed.startsWith('/create')) {
    await handleNew(chatId, trimmed);
    return true;
  }

  // 12.5 Handle np command
  if (trimmed.startsWith('/np')) {
    await handleNewProject(chatId);
    return true;
  }

  // 13. Handle cwd command
  if (trimmed.startsWith('/cwd') || trimmed.startsWith('/workspace')) {
    await handleCwd(chatId, trimmed);
    return true;
  }

  // 14. Handle cmd / run command
  if (trimmed.startsWith('/cmd') || trimmed.startsWith('/run') || trimmed.startsWith('/shell')) {
    const parts = trimmed.split(/\s+/);
    const command = trimmed.substring(parts[0].length).trim();
    await executeUserCommand(chatId, command);
    return true;
  }

  // 15. Handle delete / archive command
  if (trimmed.startsWith('/delete') || trimmed.startsWith('/archive')) {
    await handleDelete(chatId);
    return true;
  }

  // 16. Handle cancel / stop / s command
  if (trimmed === '/cancel' || trimmed === '/stop' || trimmed === '/s') {
    await handleCancel(chatId);
    return true;
  }

  // 17. Fallback: command starting with '/'
  if (trimmed.startsWith('/')) {
    const command = trimmed.substring(1).trim();
    await executeUserCommand(chatId, command);
    return true;
  }

  return false;
}
