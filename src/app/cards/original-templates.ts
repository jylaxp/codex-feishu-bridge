import { formatDateTime24h } from './original-common';
import { getAllowedCommands } from '../commands/router';

export function createGoalCard(goal: any) {
  if (!goal) {
    return {
      schema: "2.0",
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "grey",
        title: {
          tag: "plain_text",
          content: "🎯 Codex 目标模式"
        }
      },
      body: {
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: "当前会话**未设置目标**。\\n\\n**如何使用目标模式：**\\n- 发送 \`/goal [您的目标内容]\` 来设置目标并启动任务。\\n  例如：\`/goal 修复项目中的所有编译警告\`\\n- 发送 \`/goal clear\` 或 \`/goal -c\` 随时清除当前的目标。"
            }
          }
        ]
      }
    };
  }

  let statusText = goal.status || "未知";
  let statusEmoji = "⚙️";
  let headerTemplate = "blue";
  
  if (goal.status === "active") {
    statusText = "活跃中 (Active) ⚙️";
    statusEmoji = "⚙️";
    headerTemplate = "indigo";
  } else if (goal.status === "complete") {
    statusText = "已完成 (Complete) ✅";
    statusEmoji = "✅";
    headerTemplate = "green";
  } else if (goal.status === "paused") {
    statusText = "已暂停 (Paused) ⏸️";
    statusEmoji = "⏸️";
    headerTemplate = "orange";
  } else if (goal.status === "blocked") {
    statusText = "受阻中 (Blocked) 🚫";
    statusEmoji = "🚫";
    headerTemplate = "red";
  }

  const createdTime = goal.createdAt ? formatDateTime24h(new Date(goal.createdAt * 1000)) : '未知';
  const updatedTime = goal.updatedAt ? formatDateTime24h(new Date(goal.updatedAt * 1000)) : '未知';

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: headerTemplate,
      title: {
        tag: "plain_text",
        content: `${statusEmoji} Codex 目标模式`
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `🎯 **当前目标 (Objective)**:\\n> **${goal.objective}**`
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `🚦 **目标状态**: ${statusText}\\n🪙 **已用 Token 数**: \`${goal.tokensUsed || 0}\`${goal.tokenBudget ? ` / \\\`${goal.tokenBudget}\\\`` : ''}\\n⏳ **执行时长**: \`${goal.timeUsedSeconds || 0} 秒\``
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `📅 **创建时间**: ${createdTime}\\n🔄 **更新时间**: ${updatedTime}`
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "💡 **提示**：\\n- 如需更改目标，请重新发送 \`/goal [新目标内容]\`\\n- 如需清除目标，请发送 \`/goal clear\` 或 \`/goal -c\`"
          }
        }
      ]
    }
  };
}

export function createMcpCard(mcpData: any) {
  const servers = mcpData?.data || [];
  const elements: any[] = [];

  if (servers.length === 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "⚠️ **当前未配置或加载任何 MCP 服务器。**\n如需使用 Model Context Protocol 工具，请在本地主机上的 `config.toml` 中配置 `mcp_servers`。"
      }
    });
  } else {
    let tableMarkdown = "| 服务名称 | 认证状态 | 启用状态 |\n| :--- | :--- | :--- |\n";
    
    servers.forEach((server: any) => {
      let authText = "未知";
      const auth = server.authStatus;
      if (auth === "bearerToken" || auth === "token") {
        authText = "已通过身份验证 (API 密钥)";
      } else if (auth === "unsupported") {
        authText = "不支持身份验证";
      } else if (auth === "oauth") {
        authText = "已通过身份验证 (OAuth)";
      } else if (auth === "unauthenticated") {
        authText = "⚠️ 未完成身份验证";
      } else if (auth === "none" || !auth) {
        authText = "无需身份验证";
      } else {
        authText = auth;
      }

      const enabledText = server.enabled === false ? "🔴 已禁用" : "🟢 已启用";
      tableMarkdown += `| \`${server.name}\` | ${authText} | ${enabledText} |\n`;
    });

    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: tableMarkdown
      }
    });

    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `💡 **共加载了 ${servers.length} 个 MCP 服务器。** 如需管理，请在本地配置文件中进行配置。`
      }
    });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: servers.length > 0 ? "indigo" : "grey",
      title: { tag: "plain_text", content: "🔌 MCP 插件管理" }
    },
    body: { elements }
  };
}

export function createSkillsCard(skillsData: any, cwd: string, selectedSkillName?: string) {
  const entries = skillsData?.data || [];
  const elements: any[] = [];
  
  let allSkills: any[] = [];
  entries.forEach((entry: any) => {
    if (Array.isArray(entry.skills)) {
      entry.skills.forEach((skill: any) => {
        allSkills.push({
          ...skill,
          cwd: entry.cwd
        });
      });
    }
  });

  if (allSkills.length === 0) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `⚠️ **当前工作目录下未发现可用技能。**\n工作目录: \`${cwd || '未配置'}\`\n\n您可以在项目中创建 \`skills/\` 目录并放置 \`SKILL.md\` 来声明自定义技能。`
      }
    });
  } else {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🎯 **当前工作区支持的技能列表 (${allSkills.length} 个)：**\n💡 *您可以在群聊对话中通过 \`@技能名称\` 提及并调用对应技能能力。*`
      }
    });

    allSkills.sort((a, b) => a.name.localeCompare(b.name));
    
    const dropdownOptions = allSkills.map(s => {
      const scopeText = s.scope === "local" ? "📁 本地" : "⚙️ 内置";
      return {
        text: {
          tag: "plain_text",
          content: `[${scopeText}] ${s.name}`
        },
        value: s.name
      };
    });

    dropdownOptions.unshift({
      text: {
        tag: "plain_text",
        content: "❌ 清除选中skill"
      },
      value: "__CLEAR_SKILL__"
    });

    const isCleared = !selectedSkillName || selectedSkillName === "__CLEAR_SKILL__";

    elements.push({
      tag: "select_static",
      element_id: "skills_select",
      placeholder: {
        tag: "plain_text",
        content: isCleared ? "选择一个技能查看详情并锁定..." : `已选择: ${selectedSkillName}`
      },
      value: {
        action: "skills_select_view",
        cwd: cwd
      },
      options: dropdownOptions.slice(0, 99)
    });

    if (selectedSkillName && selectedSkillName !== "__CLEAR_SKILL__") {
      const selectedSkill = allSkills.find(s => s.name === selectedSkillName);
      if (selectedSkill) {
        const desc = selectedSkill.shortDescription || selectedSkill.description || "暂无描述说明";
        const scopeText = selectedSkill.scope === "local" ? "📁 本地项目专属技能" : "⚙️ 全局内置技能";
        elements.push({ tag: "hr" });
        elements.push({
          tag: "div",
          text: {
            tag: "lark_md",
            content: `✨ **${selectedSkill.name}** (${scopeText})\n\n📌 **已锁定**：下一条指令将默认调用此技能运行，无需再次 @。\n\n**🔍 技能描述**：\n${desc}\n\n**📂 文件路径**：\n\`${selectedSkill.path || ''}\``
          }
        });
      }
    }
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: allSkills.length > 0 ? "blue" : "grey",
      title: { tag: "plain_text", content: "🎯 Codex 可用技能清单" }
    },
    body: { elements }
  };
}

export function createStatusCard(statusData: any) {
  const { name, threadId, cwd, personality, planMode, goal } = statusData;
  const personalityText = personality === "friendly" ? "亲和 (Friendly) 😊" : (personality === "pragmatic" ? "务实 (Pragmatic) 🎯" : "默认 ⚙️");
  const planModeText = planMode ? "开启 🟢 (优先编写实施计划)" : "关闭 🔴 (常规极速对话模式)";

  const elements: any[] = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `💬 **当前绑定会话**: **${name || '未命名会话'}**\n- 🆔 **会话 ID**: \`${threadId}\`\n- 📂 **工作目录 (CWD)**: \`${cwd || '默认工作区'}\``
      }
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🚦 **配置选项**:\n- 🎭 **回复风格 (Personality)**: ${personalityText}\n- 📝 **计划模式 (Plan Mode)**: ${planModeText}`
      }
    }
  ];

  if (goal) {
    let goalStatus = goal.status || "未知";
    if (goal.status === "active") goalStatus = "活跃 ⚙️";
    else if (goal.status === "complete") goalStatus = "完成 ✅";
    
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `🎯 **当前长期目标 (Goal)**:\n> **${goal.objective}**\n- 🪙 **消耗 Token**: \`${goal.tokensUsed || 0}\` | ⏳ **时长**: \`${goal.timeUsedSeconds || 0} 秒\` | 🚦 **状态**: ${goalStatus}`
      }
    });
  } else {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "🎯 **当前长期目标**: *暂未设定目标* (发送 `/goal [内容]` 可设定目标)"
      }
    });
  }

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "📊 Codex 会话综合状态" }
    },
    body: { elements }
  };
}

export function createHelpCard() {
  const allowedCommands = getAllowedCommands();
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "💡 Codex 飞书助手指令指南"
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "**欢迎使用 Codex 飞书助手！您可以发送以下指令来控制本地会话：**"
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🔍 **会话绑定**\n- `'/list'` 或 `'/l'`\n  拉取本地 Codex 活跃会话列表，提供下拉菜单选择绑定。\n- `'/ll'`\n  拉取本地 Codex 活跃会话列表（Table 表格视图，完美防止会话名在客户端被截断）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🆕 **新建会话**\n- `'/new [名称]'` 或 `'/create [名称]'\n  快速在本地 Codex Desktop 启动一个新会话并自动与当前聊天绑定。可指定会话名字。\n\n🖥️ **唤起桌面端**\n- `'/open'`\n  强制通过 URL Scheme 唤起 Codex 桌面端，并自动跳转至当前绑定的会话，解决新建会话未实时显示的问题。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📁 **切换与管理**\n- `'/cwd [路径]'` 或 `'/workspace [路径]'\n  查询或动态修改当前会话绑定的工作目录。\n- `'/fork [新名称]'`\n  派生复制当前会话并将群聊自动绑定至新派生的会话。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `💻 **终端命令执行**\n- \`'/cmd [命令]'\` 或 \`'/run [命令]'\`\n  在本地 macOS 的当前工作目录下执行命令，辅助您在不知道具体绝对路径时进行查找定位。\n  **当前支持的本地命令**：${allowedCommands.map((cmd: string) => `\`${cmd}\``).join('、')}`
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🎯 **目标模式 (Goal Mode)**\n- `'/goal [目标内容]'\n  为当前会话设置一个长期任务目标并立即自动启动执行。Codex 将在后台自主规划和调用工具，直到目标达成。\n- `'/goal'\n  查询当前会话的目标内容、执行进度（状态、消耗 Token、时长等）。\n- `'/goal clear' 或 '/goal -c'\n  清除当前会话的目标。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🔌 **MCP 插件管理**\n- `'/mcp'`\n  展示本地所有 MCP 服务及认证连接状态。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🤖 **大模型选择**\n- `'/model'` 或 `'/model [模型名称]'`\n  提供下拉菜单或直接指定当前会话所使用的大模型（如 o3-mini 等）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🎭 **回复风格设定**\n- `'/personality [friendly|pragmatic|none]'`\n  设置或查询回复风格（friendly: 亲和, pragmatic: 务实, none: 默认）。状态记录于 sessions.json，在执行 Turn 时自动应用。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "⚡️ **压缩上下文**\n- `'/compact'` 或 `'/compress'`\n  压缩当前会话的上下文窗口（释放 Token）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🍴 **会话派生**\n- `'/fork [新名称]'`\n  派生复制当前会话并将群聊自动绑定至新派生的会话。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📝 **计划模式 (Plan Mode)**\n- `'/plan [on|off]'`\n  开启或关闭“计划模式”。开启后，下发的日常指令会强制 Codex 优先提供实施计划供您审批。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📋 **会话综合状态**\n- `'/status'`\n  综合展示面板（包含会话名称、ID、当前 CWD、个性设定、计划模式及目标详情）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "✨ **可用技能列表与调用**\n- `'/skills'`\n  列出当前工作区下可用的所有技能（Skills）。\n- **技能 @ 提及**：在日常对话中通过 `@技能名称 [输入内容]` 来调用特定技能（例如 `@Ce Debug 为什么我的项目有类型报错？`）。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "🗑️ **归档解绑**\n- `'/delete'` 或 `'/archive'`\n  将当前聊天与 Codex 会话解绑，同时在本地归档该会话。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "📊 **用量查询**\n- `'/usage'` 或 `'/quota'`\n  获取当前账户的长期 (7d) 窗口用量统计及下次重置刷新时间。"
          }
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "❓ **获取帮助**\n- `'/help'` 或 `'/h'`\n  获取所有支持的快捷指令和使用帮助。"
          }
        },
        {
          tag: "hr"
        },
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "💡 *提示: 绑定会话后，直接发送日常对话即可与本地 Codex 交互推理。*"
          }
        }
      ]
    }
  };
}

export function createBoundSuccessCard(threadName: string, threadId: string, cwd?: string) {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: "Codex Session Bound Successfully"
      }
    },
    body: {
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `This Feishu chat is now bound to Codex Session: **${threadName}**\n- **Project (CWD)**: \`${cwd || 'None (Global)'}\`\n- **Thread ID**: \`${threadId}\`\n\nAny messages sent in this chat will now run on Codex Desktop.`
          }
        }
      ]
    }
  };
}
