import type { ChatThreadBinding } from './binding-store';
import type { LarkBotConfig } from './bot-config-store';
import type { InboundMessage } from './lark/intake';

export function shouldSuppressExternalGroupUserMention(
  message: InboundMessage,
  binding: ChatThreadBinding,
): boolean {
  return (message.chatType ?? 'p2p') === 'group'
    && message.senderType === 'user'
    && message.externalGroupUser === true
    && binding.allowExternalGroupUserMentions === false;
}

export type GroupBotSenderMentionDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason:
        | 'not_group_bot_sender'
        | 'bot_sender_command'
        | 'receiver_disabled'
        | 'sender_disabled';
    };

export function evaluateGroupBotSenderMention(
  message: InboundMessage,
  _binding: ChatThreadBinding,
  sourceBot: LarkBotConfig | undefined,
  receiverAllowsBotMentions = true,
): GroupBotSenderMentionDecision {
  if ((message.chatType ?? 'p2p') !== 'group' || message.senderType !== 'bot') {
    return { accepted: false, reason: 'not_group_bot_sender' };
  }
  if (message.text.trim().startsWith('/')) {
    return { accepted: false, reason: 'bot_sender_command' };
  }
  if (!receiverAllowsBotMentions) {
    return { accepted: false, reason: 'receiver_disabled' };
  }
  if (sourceBot && !sourceBot.enabled) {
    return { accepted: false, reason: 'sender_disabled' };
  }
  return { accepted: true };
}
