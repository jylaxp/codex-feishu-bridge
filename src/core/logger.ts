import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function redactSecrets(text: string): string {
  if (!text) return text;
  let clean = text;
  
  // 1. Patterns that need a prefix captured and kept (i.e. replacement is $1[REDACTED])
  const prefixPatterns = [
    /(authorization:\s*bearer\s+)[^\s'"]+/gi,
    /(token=)[^&\s]+/gi,
    /(api[_-]?key=)[^&\s]+/gi,
    /(secret=)[^&\s]+/gi,
    /(password=)[^&\s]+/gi,
    /(passwd=)[^&\s]+/gi,
    /(openai[_-]?api[_-]?key=)[^&\s]+/gi,
    /(\b(?:openai[_-]?)?api[_-]?key\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
    /(\bpassword\b\s*[:=]\s*['"]?)[a-zA-Z0-9_-]+/gi,
  ];
  for (const pattern of prefixPatterns) {
    clean = clean.replace(pattern, "$1[REDACTED]");
  }

  // 2. Patterns to replace entirely with [REDACTED]
  const fullPatterns = [
    /sk-[a-zA-Z0-9_-]{20,}/gi,
  ];
  for (const pattern of fullPatterns) {
    clean = clean.replace(pattern, "[REDACTED]");
  }
  return clean;
}

export function setupLogging() {
  const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true';
  const originalError = console.error;

  const defaultLogPath = path.join(os.homedir(), '.codex-feishu-bridge', 'logs', 'bridge.log');
  const logFilePath = process.env.LOG_FILE_PATH
    ? (path.isAbsolute(process.env.LOG_FILE_PATH) ? process.env.LOG_FILE_PATH : path.join(os.homedir(), '.codex-feishu-bridge', 'logs', process.env.LOG_FILE_PATH))
    : defaultLogPath;
  
  // Ensure the directory exists
  const logDir = path.dirname(logFilePath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  const formatMessage = (args: any[]) => {
    return args.map(arg => {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      } else if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');
  };

  const writeLog = (level: string, args: any[]) => {
    const timeStr = new Date().toISOString();
    logStream.write(`[${timeStr}] [${level}] ${formatMessage(args)}\n`);
  };

  // 1. INFO/WARN logs are controlled by LOG_TO_FILE switch
  if (LOG_TO_FILE) {
    console.log = (...args: any[]) => writeLog('INFO', args);
    console.info = (...args: any[]) => writeLog('INFO', args);
    console.warn = (...args: any[]) => writeLog('WARN', args);
    // Write a status line to stdout once so the user knows logs are redirected
    process.stdout.write(`[Bridge] Logging to file enabled. Log file: ${logFilePath}\n`);
  } else {
    // Switch is closed: Silence log/info/warn to keep standard output clean.
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
  }

  // 2. ERROR logs are NOT controlled by the switch: always write to log file AND print to terminal
  console.error = (...args: any[]) => {
    writeLog('ERROR', args);
    originalError(...args);
  };
}
