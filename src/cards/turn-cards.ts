import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ActiveTurn, ActiveApproval } from '../types';
import { formatDateTime24h } from './common';
import { processMarkdownImages } from '../feishu/media';
import { redactSecrets } from '../core/logger';
import { getStatsFooterText, getTurnMetadataContent } from '../codex/stats';
import { CodexThread } from '../adapter';

export function truncateText(text: string, limit = 10000, suffix = '\n\n... (内容过长，已被截断) ...'): string {
  if (!text) return text;
  if (text.length <= limit) return text;
  return text.substring(0, limit) + suffix;
}

export async function createCardKitInitialLayout(turn: ActiveTurn) {
  const footer = getStatsFooterText(turn);
  const metadataContent = getTurnMetadataContent(turn);
  
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      summary: { content: "Codex 执行进度" },
      streaming_config: {
        print_frequency_ms: { default: 30, android: 30, ios: 30, PC: 30 },
        print_step: { default: 3, android: 3, ios: 3, PC: 3 },
        print_strategy: "delay"
      }
    },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "🌌 Codex Remote Control" }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: await processMarkdownImages(`**📥 输入 Prompt**\n> ${turn.prompt}`),
          element_id: "codex_prompt"
        },
        ...(metadataContent ? [{
          tag: "markdown",
          content: await processMarkdownImages(metadataContent),
          element_id: "codex_metadata"
        }] : []),
        { tag: "hr" },
        {
          tag: "markdown",
          content: await processMarkdownImages(`🧠 **模型推理过程**\n等待开始...`),
          element_id: "codex_reasoning"
        },
        { tag: "hr", element_id: "codex_output_hr" },
        {
          tag: "markdown",
          content: await processMarkdownImages(`✨ **最终结果输出**\n等待中...`),
          element_id: "codex_output"
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: await processMarkdownImages(`📊 ${footer}`),
          element_id: "codex_footer"
        }
      ]
    }
  };
}

export async function createCardKitFinalLayout(turn: ActiveTurn) {
  const headerTemplate = turn.status === "failed" 
    ? "red" 
    : (turn.status === "interrupted" 
        ? "grey" 
        : (turn.status === "running" 
            ? "indigo" 
            : (turn.isHistory ? "indigo" : "green")));
  const footer = getStatsFooterText(turn);
  
  let logContent = turn.logs.join("\n");
  if (!logContent.trim()) {
    logContent = "Finished.";
  }
  const maxChars = 2000;
  if (logContent.length > maxChars) {
    logContent = "... (truncated) ...\n" + logContent.substring(logContent.length - maxChars);
  }

  const elements: any[] = [
    {
      tag: "markdown",
      content: await processMarkdownImages(`**📥 输入 Prompt**\n> ${turn.prompt}`)
    }
  ];

  const metadata = getTurnMetadataContent(turn);
  if (metadata) {
    elements.push({
      tag: "markdown",
      content: await processMarkdownImages(metadata)
    });
  }

  if (turn.reasoning) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: await processMarkdownImages(`🧠 **模型推理过程**\n${truncateText(turn.reasoning, 10000, '\n\n... (由于长度限制，后续推理过程已被截断) ...')}`)
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: await processMarkdownImages(`✨ **最终结果输出**\n${truncateText(turn.answer || '无最终文本输出', 10000, '\n\n... (由于长度限制，后续输出已被截断，请在 IDE 中查看完整内容) ...')}`)
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: await processMarkdownImages(`📊 ${footer}`)
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: {
        tag: "plain_text",
        content: turn.isHistory
          ? (turn.status === "success" ? "📜 [历史] ✅ Codex 执行成功" : (turn.status === "interrupted" ? "📜 [历史] 🛑 Codex 执行已取消" : (turn.status === "running" ? "📜 [历史] 🌌 Codex 执行中..." : "📜 [历史] ❌ Codex 执行失败")))
          : (turn.status === "success" ? "✅ Codex 执行成功" : (turn.status === "interrupted" ? "🛑 Codex 执行已取消" : (turn.status === "running" ? "🌌 Codex 执行中..." : "❌ Codex 执行失败")))
      }
    },
    body: {
      elements
    }
  };
}

export function createApprovalCard(approvalId: string, type: string, cwd: string, summary: string, reason?: string) {
  const cleanSummary = redactSecrets(summary);

  let riskLevel = "low";
  const text = `${type} ${summary}`.toLowerCase();
  if (/\b(rm|delete|curl|wget)\b|https?:\/\/|token|secret/i.test(text)) {
    riskLevel = "high";
  } else if (["exec", "command", "shell"].includes(type.toLowerCase())) {
    riskLevel = "medium";
  }

  const riskText = riskLevel === "high" 
    ? "<font color='red'><b>高风险 ⚠️ (包含敏感词或命令)</b></font>" 
    : (riskLevel === "medium" ? "<font color='orange'><b>中风险 ⚡️ (执行命令)</b></font>" : "低风险 ✅");

  const elements: any[] = [
    {
      tag: "markdown",
      content: "🚨 Codex 正在尝试在您的系统上执行以下敏感操作，需要您进行确认授权："
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `📌 **操作类型**: \`${type}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${riskText}`
    }
  ];

  if (reason && reason !== summary) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: `❓ **申请原因**:\n${reason}`
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `💻 **准备执行的操作指令**:\n\`\`\`text\n${cleanSummary}\n\`\`\``
    },
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "stretch",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🟢 批准 (Approve)" },
              type: "primary",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "accept"
              }
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🛡️ 总是批准 (Always)" },
              type: "primary",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "acceptForSession"
              }
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "🔴 拒绝 (Deny)" },
              type: "danger",
              width: "fill",
              value: {
                action: "approval_decision",
                approvalId: approvalId,
                decision: "decline"
              }
            }
          ]
        }
      ]
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: riskLevel === "high" ? "carmine" : (riskLevel === "medium" ? "orange" : "violet"),
      title: {
        tag: "plain_text",
        content: "⚡️ Codex 安全审批申请"
      }
    },
    body: {
      elements
    }
  };
}

export function createApprovalDecidedCard(
  type: string,
  cwd: string,
  summary: string,
  reason: string | undefined,
  decision: string
) {
  const isAccepted = decision === "accept";
  const isAlways = decision === "acceptForSession";
  const isDeclined = decision === "decline";
  
  let cleanSummary = redactSecrets(summary);

  let riskLevel = "low";
  const text = `${type} ${summary}`.toLowerCase();
  if (/\b(rm|delete|curl|wget)\b|https?:\/\/|token|secret/i.test(text)) {
    riskLevel = "high";
  } else if (["exec", "command", "shell"].includes(type.toLowerCase())) {
    riskLevel = "medium";
  }

  const riskText = riskLevel === "high" 
    ? "<font color='red'><b>高风险 ⚠️ (包含敏感词或命令)</b></font>" 
    : (riskLevel === "medium" ? "<font color='orange'><b>中风险 ⚡️ (执行命令)</b></font>" : "低风险 ✅");

  let statusContent = "";
  if (isAccepted) {
    statusContent = `✅ **审批已批准** (已于 **${formatDateTime24h(new Date())}** 被批准执行一次)`;
  } else if (isAlways) {
    statusContent = `🛡️ **已总是批准该操作** (已于 **${formatDateTime24h(new Date())}** 批准在本次会话中不再询问)`;
  } else {
    statusContent = `❌ **审批已拒绝** (已于 **${formatDateTime24h(new Date())}** 被拒绝执行。Codex 将停止该步骤的执行。)`;
  }

  const elements: any[] = [
    {
      tag: "markdown",
      content: statusContent
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `📌 **操作类型**: \`${type}\`\n📂 **工作目录**: \`${cwd || 'Unknown'}\`\n🛡️ **风险评估**: ${riskText}`
    }
  ];

  if (reason && reason !== summary) {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content: `❓ **申请原因**:\n${reason}`
      }
    );
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `💻 **执行的操作指令**:\n\`\`\`text\n${cleanSummary}\n\`\`\``
    },
    { tag: "hr" },
    {
      tag: "column_set",
      flex_mode: "stretch",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isAccepted ? "🟢 已批准 (Approved)" : "批准 (Approve)" },
              type: isAccepted ? "primary" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isAlways ? "🛡️ 已总是批准" : "总是批准 (Always)" },
              type: isAlways ? "primary" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        },
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: isDeclined ? "🔴 已拒绝 (Denied)" : "拒绝 (Deny)" },
              type: isDeclined ? "danger" : "default",
              width: "fill",
              disabled: true,
              value: {}
            }
          ]
        }
      ]
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: (isAccepted || isAlways) ? "green" : "grey",
      title: {
        tag: "plain_text",
        content: isAccepted ? "✅ 审批已批准" : (isAlways ? "🛡️ 审批已总是批准" : "❌ 审批已拒绝")
      }
    },
    body: {
      elements
    }
  };
}

function getThreadTimestamp(t: CodexThread): number {
  if (typeof t.createdAt === 'number') return t.createdAt * 1000;
  if (t.id) {
    const hex = t.id.replace(/-/g, '').substring(0, 12);
    if (/^[0-9a-fA-F]{12}$/.test(hex)) {
      return parseInt(hex, 16);
    }
  }
  return 0;
}

export async function createBindingCard(threads: CodexThread[]) {
  const homeDir = os.homedir();
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  let savedWorkspaces: string[] = [];
  let workspaceLabels: Record<string, string> = {};
  let projectlessThreadIds: string[] = [];

  try {
    const stats = await fs.promises.stat(globalStatePath);
    if (stats.isFile()) {
      const globalStateStr = await fs.promises.readFile(globalStatePath, 'utf8');
      const globalState = JSON.parse(globalStateStr);
      savedWorkspaces = globalState['electron-saved-workspace-roots'] || globalState['project-order'] || [];
      workspaceLabels = globalState['electron-workspace-root-labels'] || {};
      projectlessThreadIds = globalState['projectless-thread-ids'] || [];
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.error('Failed to parse .codex-global-state.json:', e);
    }
  }

  const filteredThreads = threads.filter(t => {
    // Show all active sessions (either global/projectless or project-based).
    // We no longer restrict project-based sessions to saved electron workspaces.
    return true;
  });

  const getDirName = (t: any) => {
    if (!t.cwd) return "";
    const matchedWorkspace = savedWorkspaces.find(w => {
      const normW = path.normalize(w).toLowerCase();
      const normC = path.normalize(t.cwd || "").toLowerCase();
      return normC === normW || normC.startsWith(normW + path.sep);
    });
    if (matchedWorkspace) {
      return workspaceLabels[matchedWorkspace] || path.basename(matchedWorkspace);
    }
    return path.basename(t.cwd);
  };

  const sortedThreads = [...filteredThreads].sort((a, b) => {
    return getThreadTimestamp(b) - getThreadTimestamp(a);
  });

  const options = sortedThreads.map(t => {
    const isGlobal = (t.id && projectlessThreadIds.includes(t.id)) || !t.cwd;
    let content = "";
    if (isGlobal) {
      content = `🌐 ${t.name} (全局)`;
    } else {
      let dirName = "";
      if (t.cwd) {
        const matchedWorkspace = savedWorkspaces.find(w => {
          const normW = path.normalize(w).toLowerCase();
          const normC = path.normalize(t.cwd || "").toLowerCase();
          return normC === normW || normC.startsWith(normW + path.sep);
        });
        if (matchedWorkspace) {
          dirName = workspaceLabels[matchedWorkspace] || path.basename(matchedWorkspace);
        } else {
          dirName = path.basename(t.cwd);
        }
      }
      content = dirName ? `💬 ${t.name} (📁 ${dirName})` : `💬 ${t.name}`;
    }
    const cleanContent = content.length > 100 ? content.substring(0, 97) + "..." : content;
    return {
      text: { tag: "plain_text", content: cleanContent },
      value: t.id
    };
  });

  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "请从下方下拉菜单中选择一个 Codex 活跃会话绑定至当前聊天。选项已按本地项目分组："
      }
    },
    {
      tag: "select_static",
      element_id: "bind_select_dropdown",
      placeholder: { tag: "plain_text", content: "选择 Codex 会话..." },
      value: { action: "bind_select_thread" },
      options: options.slice(0, 99)
    }
  ];

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "📂 Codex 绑定会话" }
    },
    body: { elements }
  };
}

export async function createTableBindingCard(threads: CodexThread[]) {
  const homeDir = os.homedir();
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  let savedWorkspaces: string[] = [];
  let workspaceLabels: Record<string, string> = {};
  let projectlessThreadIds: string[] = [];

  try {
    const stats = await fs.promises.stat(globalStatePath);
    if (stats.isFile()) {
      const globalStateStr = await fs.promises.readFile(globalStatePath, 'utf8');
      const globalState = JSON.parse(globalStateStr);
      savedWorkspaces = globalState['electron-saved-workspace-roots'] || globalState['project-order'] || [];
      workspaceLabels = globalState['electron-workspace-root-labels'] || {};
      projectlessThreadIds = globalState['projectless-thread-ids'] || [];
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.error('Failed to parse .codex-global-state.json:', e);
    }
  }

  const filteredThreads = threads.filter(t => {
    // Show all active sessions (either global/projectless or project-based).
    // We no longer restrict project-based sessions to saved electron workspaces.
    return true;
  });

  const getDirName = (t: any) => {
    if (!t.cwd) return "";
    const matchedWorkspace = savedWorkspaces.find(w => {
      const normW = path.normalize(w).toLowerCase();
      const normC = path.normalize(t.cwd || "").toLowerCase();
      return normC === normW || normC.startsWith(normW + path.sep);
    });
    if (matchedWorkspace) {
      return workspaceLabels[matchedWorkspace] || path.basename(matchedWorkspace);
    }
    return path.basename(t.cwd);
  };

  const sortedThreads = [...filteredThreads].sort((a, b) => {
    return getThreadTimestamp(b) - getThreadTimestamp(a);
  });

  const columns = [
    { name: "col_name", display_name: "会话名称", data_type: "text" },
    { name: "col_project", display_name: "所属项目", data_type: "text" }
  ];

  const rows = sortedThreads.map((t, index) => {
    const isGlobal = (t.id && projectlessThreadIds.includes(t.id)) || !t.cwd;
    let dirName = "🌐 全局会话";
    if (!isGlobal && t.cwd) {
      const matchedWorkspace = savedWorkspaces.find(w => {
        const normW = path.normalize(w).toLowerCase();
        const normC = path.normalize(t.cwd || "").toLowerCase();
        return normC === normW || normC.startsWith(normW + path.sep);
      });
      if (matchedWorkspace) {
        dirName = workspaceLabels[matchedWorkspace] || path.basename(matchedWorkspace);
      } else {
        dirName = path.basename(t.cwd);
      }
    }
    return {
      col_name: `[${index + 1}] ${t.name || ""}`,
      col_project: dirName
    };
  });

  const selectOptions = sortedThreads.map((t, index) => {
    const content = `#${index + 1} ➜ ${t.name}`;
    const cleanContent = content.length > 100 ? content.substring(0, 97) + "..." : content;
    return {
      text: { tag: "plain_text", content: cleanContent },
      value: t.id
    };
  });

  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "请查看下方的活跃会话列表，并在底部的下拉菜单中选择对应序号以绑定至当前聊天。"
      }
    },
    {
      tag: "table",
      page_size: 10,
      row_height: "low",
      header_style: { bold: true, text_align: "left" },
      columns: columns,
      rows: rows
    },
    {
      tag: "select_static",
      element_id: "bind_select_dropdown",
      placeholder: { tag: "plain_text", content: "选择要绑定的会话序号..." },
      value: { action: "bind_select_thread" },
      options: selectOptions.slice(0, 99)
    }
  ];

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "📂 Codex 绑定会话 (Table 视图)" }
    },
    body: { elements }
  };
}

export async function createProjectSelectCard() {
  const homeDir = os.homedir();
  const globalStatePath = path.join(homeDir, '.codex', '.codex-global-state.json');
  let savedWorkspaces: string[] = [];
  let workspaceLabels: Record<string, string> = {};

  try {
    const stats = await fs.promises.stat(globalStatePath);
    if (stats.isFile()) {
      const globalStateStr = await fs.promises.readFile(globalStatePath, 'utf8');
      const globalState = JSON.parse(globalStateStr);
      savedWorkspaces = globalState['electron-saved-workspace-roots'] || globalState['project-order'] || [];
      workspaceLabels = globalState['electron-workspace-root-labels'] || {};
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      console.error('Failed to parse .codex-global-state.json:', e);
    }
  }

  if (savedWorkspaces.length === 0) {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: {
        template: "orange",
        title: { tag: "plain_text", content: "📁 Codex 新建项目会话" }
      },
      body: {
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: "⚠️ **未发现任何已保存的项目/工作区。**\n请先在 Codex Desktop 客户端中打开一个项目以保存工作区。"
            }
          }
        ]
      }
    };
  }

  const options = savedWorkspaces.map(w => {
    const name = workspaceLabels[w] || path.basename(w);
    const content = `📁 ${name} (${w})`;
    const cleanContent = content.length > 100 ? content.substring(0, 97) + "..." : content;
    return {
      text: { tag: "plain_text", content: cleanContent },
      value: w
    };
  });

  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "请从下方选择您要工作的项目。选择后，输入任何信息（如会话名称或指令），系统将自动在该项目下创建新会话并开始工作："
      }
    },
    {
      tag: "select_static",
      element_id: "np_select_dropdown",
      placeholder: { tag: "plain_text", content: "选择项目..." },
      value: { action: "np_select_project" },
      options: options.slice(0, 99)
    }
  ];

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "indigo",
      title: { tag: "plain_text", content: "📁 Codex 新建项目会话" }
    },
    body: { elements }
  };
}

