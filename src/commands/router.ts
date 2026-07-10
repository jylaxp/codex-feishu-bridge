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
  const parts = trimmed.split(/\s+/);
  const commandName = parts[0];
  
  // 0. Handle help command
  const isHelp = trimmed === '/help' || trimmed === '/h' || trimmed === 'help' || trimmed === 'h' || trimmed.startsWith('/help ') || trimmed.startsWith('/h ');
  if (isHelp) {
    await handleHelp(chatId);
    return true;
  }

  // 1. Handle list / ll commands
  if (commandName === '/list') {
    await handleList(chatId);
    return true;
  }
  if (commandName === '/ll') {
    await handleTableList(chatId);
    return true;
  }

  // 2. Handle goal command
  if (commandName === '/goal') {
    await handleGoal(chatId, trimmed);
    return true;
  }

  // 3. Handle mcp command
  if (commandName === '/mcp') {
    await handleMcp(chatId);
    return true;
  }

  // 4. Handle model command
  if (commandName === '/model') {
    await handleModel(chatId, trimmed);
    return true;
  }

  // 5. Handle personality command
  if (commandName === '/personality' || commandName === '/style') {
    await handlePersonality(chatId, trimmed);
    return true;
  }

  // 6. Handle compact command
  if (commandName === '/compact' || commandName === '/compress') {
    await handleCompact(chatId);
    return true;
  }

  // 7. Handle fork command
  if (commandName === '/fork' || commandName === '/branch') {
    await handleFork(chatId, trimmed);
    return true;
  }

  // 8. Handle plan command
  if (commandName === '/plan') {
    await handlePlan(chatId, trimmed);
    return true;
  }

  // 9. Handle status command
  if (commandName === '/status') {
    await handleStatus(chatId);
    return true;
  }

  // 10. Handle usage command
  if (commandName === '/usage' || commandName === '/quota') {
    await handleUsage(chatId);
    return true;
  }

  // 11. Handle skills command
  if (commandName === '/skills') {
    await handleSkills(chatId);
    return true;
  }

  // 12. Handle new command
  if (commandName === '/new' || commandName === '/create') {
    await handleNew(chatId, trimmed);
    return true;
  }

  // 12.5 Handle np command
  if (commandName === '/np') {
    await handleNewProject(chatId);
    return true;
  }

  // 13. Handle cwd command
  if (commandName === '/cwd' || commandName === '/workspace') {
    await handleCwd(chatId, trimmed);
    return true;
  }

  // 14. Handle cmd / run command
  if (commandName === '/cmd' || commandName === '/run' || commandName === '/shell') {
    const command = trimmed.substring(commandName.length).trim();
    await executeUserCommand(chatId, command);
    return true;
  }

  // 15. Handle delete / archive command
  if (commandName === '/delete' || commandName === '/archive') {
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
