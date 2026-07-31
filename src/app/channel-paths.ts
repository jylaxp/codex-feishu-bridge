import { join } from 'node:path';

export const FEISHU_CHANNEL_ID = 'feishu';
export const CHANNELS_DIRECTORY_NAME = 'channels';

export type ChannelId = typeof FEISHU_CHANNEL_ID;

export function channelConfigDirectory(configHome: string, channel: ChannelId): string {
  return join(configHome, CHANNELS_DIRECTORY_NAME, channel);
}

export function feishuChannelConfigDirectory(configHome: string): string {
  return channelConfigDirectory(configHome, FEISHU_CHANNEL_ID);
}
