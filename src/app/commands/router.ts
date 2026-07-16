export function getAllowedCommands(): string[] {
  let allowedCommands = ['ls', 'pwd', 'git', 'find', 'cd'];
  if (process.env.ALLOWED_SHELL_COMMANDS) {
    allowedCommands = process.env.ALLOWED_SHELL_COMMANDS.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return allowedCommands;
}

