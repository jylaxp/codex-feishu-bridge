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
  const envPath = path.join(configDir, '.env');
  if (!fs.existsSync(envPath)) {
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
    console.log(`✅ 成功在目录 ${configDir} 下创建默认 .env 配置文件。`);
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
  init       在全局配置目录 (~/.codex-feishu-bridge) 初始化默认 .env 配置文件
  run        在前台启动网桥服务 (控制台流输出，适合调试)
  start      在后台启动网桥服务 (Detached 守护进程模式)
  restart    重启后台网桥服务
  stop       停止后台运行的网桥服务
  update     从 GitHub 远程自动拉取最新代码更新并重启网桥服务
  status     查看网桥服务当前运行状态
  rebind     重置飞书应用凭证以重新扫码绑定新机器人
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
    }
    break;
  }

  case 'run': {
    ensureLogDir();
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

  case 'restart': {
    console.log('🔄 正在重启网桥服务...');
    // 1. Stop if running
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid && isPidRunning(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          let killed = false;
          for (let i = 0; i < 10; i++) {
            if (!isPidRunning(pid)) { killed = true; break; }
            const start = Date.now(); while (Date.now() - start < 100) {}
          }
          if (!killed) process.kill(pid, 'SIGKILL');
          fs.unlinkSync(pidFile);
        } catch (e) {}
      }
    }
    
    // 2. Start
    const indexPath = path.resolve(__dirname, 'index.js');
    if (!fs.existsSync(indexPath)) {
      console.error(`❌ 错误：找不到网桥主程序 "${indexPath}"，请确认项目是否已运行 npm run build 进行编译。`);
      process.exit(1);
    }

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
    console.log(`✅ 成功在后台重启网桥服务 (PID: ${child.pid})。`);
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

  case 'update': {
    console.log('🔄 正在检查 GitHub 上的最新版本...');
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      
      let localCommit = 'unknown';
      try {
        // When running globally, __dirname is .../codex-feishu-bridge/dist
        localCommit = fs.readFileSync(path.join(__dirname, '../build-commit.txt'), 'utf8').trim();
      } catch (e) {}

      // Get remote commit hash for main branch
      const remoteCommitOutput = execSync('git ls-remote https://github.com/jylaxp/codex-feishu-bridge.git HEAD', { stdio: 'pipe' }).toString();
      const remoteCommit = remoteCommitOutput.split('\t')[0].trim();

      const force = process.argv.includes('--force') || process.argv.includes('-f');

      if (localCommit === remoteCommit && remoteCommit !== 'unknown' && !force) {
        console.log('✅ 当前已是最新版本，无需更新！');
        console.log('（如果你想强制重新拉取编译，请添加 --force 参数：codex-feishu-bridge update --force）');
        process.exit(0);
      }

      console.log('🔄 发现新版本（或强制更新），正在从 GitHub 远程仓库拉取并编译...');
      // Execute npm install from github repo
      execSync('npm install -g git+https://github.com/jylaxp/codex-feishu-bridge.git', { stdio: 'inherit' });
      
      console.log('✅ 源码拉取与编译安装完成！正在重启服务...');
      // Restart the daemon to apply changes
      execSync('codex-feishu-bridge restart', { stdio: 'inherit' });
    } catch (e: any) {
      console.error('❌ 更新失败:', e.message || e);
      process.exit(1);
    }
    break;
  }

  case 'rebind': {
    const envPath = path.join(configDir, '.env');
    if (!fs.existsSync(envPath)) {
      console.log(`⚠️ .env 配置文件不存在，无需重置。您可以直接运行 codex-feishu-bridge run 启动绑定。`);
      break;
    }

    try {
      let content = fs.readFileSync(envPath, 'utf8');
      
      const resetEnvVar = (envStr: string, key: string, placeholder: string) => {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envStr)) {
          return envStr.replace(regex, `${key}=${placeholder}`);
        }
        return envStr + `\n${key}=${placeholder}`;
      };

      content = resetEnvVar(content, 'LARK_APP_ID', 'YOUR_FEISHU_APP_ID');
      content = resetEnvVar(content, 'LARK_APP_SECRET', 'YOUR_FEISHU_APP_SECRET');

      fs.writeFileSync(envPath, content, 'utf8');
      console.log(`✅ 成功重置飞书应用凭证！已保留其他自定义配置。`);
      console.log(`👉 现在您可以运行 codex-feishu-bridge run 重新扫码绑定新机器人。`);
    } catch (e: any) {
      console.error(`❌ 重置飞书应用凭证失败:`, e.message || e);
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
