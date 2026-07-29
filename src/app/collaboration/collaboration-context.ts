import type { ChatThreadBinding } from '../binding-store';
import type { LarkBotConfig } from '../bot-config-store';

const MAX_CONTEXT_LENGTH = 4_000;

export interface CollaborationContextInput {
  readonly binding: ChatThreadBinding;
  readonly currentBot: LarkBotConfig | undefined;
  readonly bots: readonly LarkBotConfig[];
  readonly targetBindings: readonly ChatThreadBinding[];
}

export function buildCollaborationContext(input: CollaborationContextInput): string | null {
  const sourceBotKey = input.binding.botKey ?? input.currentBot?.botKey ?? 'default';
  const boundTargetKeys = new Set(input.targetBindings
    .filter((binding) => (
      binding.tenantKey === input.binding.tenantKey
        && binding.chatId === input.binding.chatId
        && (binding.botKey ?? 'default') !== sourceBotKey
    ))
    .map((binding) => binding.botKey ?? 'default'));
  if (boundTargetKeys.size === 0) {
    return null;
  }
  const availableTargets = input.bots.filter((bot) => {
    if (bot.botKey === sourceBotKey || !bot.enabled || !bot.allowGroupBotMentions) {
      return false;
    }
    return boundTargetKeys.has(bot.botKey);
  });
  if (availableTargets.length === 0) {
    return null;
  }
  const lines = [
    'Bridge collaboration context:',
    `Current bot: ${botRoleLine(input.currentBot, sourceBotKey)}`,
    'You may request exactly one visible Feishu bot handoff when another configured bot should continue the work.',
    'Do not include secrets, private reasoning, raw logs, or long task history in the handoff.',
    'Available target bots:',
    ...availableTargets.map((bot) => `- ${botRoleLine(bot, bot.botKey)}`),
    'To request a handoff, append one fenced block to the final answer:',
    '```cfb-handoff',
    'target: <botKey or bot display name>',
    'task: <bounded task for the target bot>',
    'reason: <why this target is needed>',
    'context: <short summary only>',
    'evidence: <trace ids or compact facts>',
    'expected: <what the target bot should return>',
    '```',
  ];
  const text = lines.join('\n');
  return text.length <= MAX_CONTEXT_LENGTH ? text : `${text.slice(0, MAX_CONTEXT_LENGTH - 1)}…`;
}

function botRoleLine(bot: LarkBotConfig | undefined, fallbackKey: string): string {
  if (!bot) {
    return fallbackKey;
  }
  const profile = bot.roleProfile;
  const parts = [
    bot.displayName ?? profile?.roleName ?? bot.botKey,
    `botKey=${bot.botKey}`,
    profile?.ownerLabel ? `owner=${profile.ownerLabel}` : '',
    profile?.domainDescription ? `domain=${profile.domainDescription}` : '',
    profile?.collaborationInstructions ? `instructions=${profile.collaborationInstructions}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}
