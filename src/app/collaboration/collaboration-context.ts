import type { ChatThreadBinding } from '../binding-store';
import type { LarkBotConfig } from '../bot-config-store';
import type { ExternalBotDirectoryEntry } from '../external-bot-directory';

const MAX_CONTEXT_LENGTH = 4_000;

export interface CollaborationContextInput {
  readonly binding: ChatThreadBinding;
  readonly currentBot: LarkBotConfig | undefined;
  readonly bots: readonly LarkBotConfig[];
  readonly targetBindings: readonly ChatThreadBinding[];
  readonly externalTargets?: readonly ExternalBotDirectoryEntry[];
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
  const availableTargets = input.bots.filter((bot) => {
    if (bot.botKey === sourceBotKey || !bot.enabled || !bot.allowGroupBotMentions) {
      return false;
    }
    return boundTargetKeys.has(bot.botKey);
  });
  const localOpenIds = new Set(input.bots
    .map((bot) => bot.botOpenId)
    .filter((value): value is string => Boolean(value)));
  const externalTargets = (input.externalTargets ?? []).filter((bot) => !localOpenIds.has(bot.botOpenId));
  if (availableTargets.length === 0 && externalTargets.length === 0) {
    return null;
  }
  const lines = [
    'Bridge collaboration context:',
    `Current bot: ${botRoleLine(input.currentBot, sourceBotKey)}`,
    'You may request exactly one visible Feishu bot handoff when another listed bot should continue the work.',
    'Do not include secrets, private reasoning, raw logs, or long task history in the handoff.',
    'Available target bots:',
    ...availableTargets.map((bot) => `- ${botRoleLine(bot, bot.botKey)}`),
    ...externalTargets.map((bot) => `- ${externalBotRoleLine(bot)}`),
    'To request a handoff, append one fenced block to the final answer:',
    '```cfb-handoff',
    'target: <appId, bot display name, or external bot open_id>',
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
    `appId=${bot.botKey}`,
    profile?.ownerLabel ? `owner=${profile.ownerLabel}` : '',
    profile?.domainDescription ? `domain=${profile.domainDescription}` : '',
    profile?.collaborationInstructions ? `instructions=${profile.collaborationInstructions}` : '',
  ].filter(Boolean);
  return parts.join(' | ');
}

function externalBotRoleLine(bot: ExternalBotDirectoryEntry): string {
  return [
    bot.displayName,
    `externalBotOpenId=${bot.botOpenId}`,
    'external=true',
  ].join(' | ');
}
