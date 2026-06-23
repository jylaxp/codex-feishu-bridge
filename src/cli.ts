#!/usr/bin/env node
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const configDir = path.join(os.homedir(), '.codex-feishu-bridge');
const logDir = path.join(configDir, 'logs');
const pidFile = path.join(configDir, 'bridge.pid');
const outLogFile = path.join(logDir, 'bridge_stdout.log');
const errLogFile = path.join(logDir, 'bridge_stderr.log');

function ensureLogDir() {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function showHelp() {
  console.log(`
🚀 Codex-Feishu Bridge CLI
用法:
  codex-feishu-bridge <命令>

命令:
  init       在当前工作目录初始化默认 .env 配置文件
  run        在前台启动网桥服务 (控制台流输出，适合调试)
  start      在后台启动网桥服务 (Detached 守护进程模式)
  stop       停止后台运行的网桥服务
  status     查看网桥服务当前运行状态
  help       展示此帮助指南
  `);
}

const command = process.argv[2];

switch (command) {
  case 'init': {
    const envPath = path.join(configDir, '.env');
    if (fs.existsSync(envPath)) {
      console.log(`⚠️ .env 配置文件在 ${configDir} 已存在，跳过初始化。`);
    } else {
      ensureLogDir();
      const defaultEnv = `LARK_APP_ID=YOUR_FEISHU_APP_ID
LARK_APP_SECRET=YOUR_FEISHU_APP_SECRET
ALLOWED_APPROVERS=

# Rate limits querying interval in milliseconds (default: 300000 ms / 5 minutes)
RATE_LIMIT_QUERY_INTERVAL_MS=300000

# Path to the Codex CLI binary on macOS (using Desktop App bundled resources version)
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex

# Switch to output logs to a file instead of stdout (true/false)
LOG_TO_FILE=false
LOG_FILE_PATH=bridge.log
`;
      fs.writeFileSync(envPath, defaultEnv, 'utf8');
      console.log(`✅ 成功在目录 ${configDir} 下创建默认 .env 配置文件。请编辑该文件填入您的飞书 APP_ID 与 APP_SECRET。`);
    }
    break;
  }

  case 'run': {
    console.log('Starting bridge in the foreground...');
    // Load the main index compiled code directly
    require('./index');
    break;
  }

  case 'start': {
    ensureLogDir();
    if (fs.existsSync(pidFile)) {
      const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (existingPid && isPidRunning(existingPid)) {
        console.log(`⚠️ 网桥已在后台运行中，PID 为: ${existingPid}。如果您需要更新，请先运行: codex-feishu-bridge stop`);
        process.exit(1);
      }
    }

    const indexPath = path.resolve(__dirname, 'index.js');
    if (!fs.existsSync(indexPath)) {
      console.error(`❌ 错误：找不到网桥主程序 "${indexPath}"，请确认项目是否已运行 npm run build 进行编译。`);
      process.exit(1);
    }

    console.log('正在后台启动飞书网桥服务...');
    const out = fs.openSync(outLogFile, 'a');
    const err = fs.openSync(errLogFile, 'a');

    const child = spawn(process.execPath, [indexPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', out, err]
    });

    if (!child.pid) {
      console.error('❌ 启动后台网桥进程失败：无法获取进程 PID。');
      process.exit(1);
    }

    child.unref();

    fs.writeFileSync(pidFile, child.pid.toString(), 'utf8');
    console.log(`✅ 成功在后台启动网桥服务。`);
    console.log(`- PID: ${child.pid}`);
    console.log(`- 运行日志: tail -f ~/.codex-feishu-bridge/logs/bridge_stdout.log`);
    console.log(`- 错误日志: tail -f ~/.codex-feishu-bridge/logs/bridge_stderr.log`);
    break;
  }

  case 'stop': {
    if (!fs.existsSync(pidFile)) {
      console.log('ℹ️ 未检测到运行中的后台网桥进程 PID。');
      process.exit(0);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid || !isPidRunning(pid)) {
      console.log('ℹ️ 未检测到活跃的网桥守护进程，清理失效的 PID 文件。');
      try {
        fs.unlinkSync(pidFile);
      } catch (e) {}
      process.exit(0);
    }

    console.log(`正在停止网桥进程 (PID: ${pid})...`);
    try {
      process.kill(pid, 'SIGTERM');
      // Wait slightly for cleanup
      let killed = false;
      for (let i = 0; i < 10; i++) {
        if (!isPidRunning(pid)) {
          killed = true;
          break;
        }
        // sleep 100ms
        const start = Date.now();
        while (Date.now() - start < 100) {}
      }
      if (!killed) {
        process.kill(pid, 'SIGKILL');
      }
      fs.unlinkSync(pidFile);
      console.log('✅ 后台网桥服务已停止。');
    } catch (e: any) {
      console.error(`❌ 停止服务失败: ${e.message || e}`);
    }
    break;
  }

  case 'status': {
    if (!fs.existsSync(pidFile)) {
      console.log('🔴 网桥服务当前未运行 (未检测到 PID)。');
      process.exit(0);
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid && isPidRunning(pid)) {
      console.log(`🟢 网桥服务正在运行中。`);
      console.log(`- PID: ${pid}`);
      console.log(`- 运行日志: ~/.codex-feishu-bridge/logs/bridge_stdout.log`);
      console.log(`- 错误日志: ~/.codex-feishu-bridge/logs/bridge_stderr.log`);
    } else {
      console.log('🔴 网桥服务当前未运行 (PID 对应的进程已退出)。');
    }
    break;
  }

  case 'help':
  case '-h':
  case '--help':
  default:
    showHelp();
    break;
}
