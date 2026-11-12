/**
 * Android Notification channel ids. Computer push picks the channel by event type: newer phones registering with `delivery.channels = 'split'`
 * use the three below, while older versions still use the single legacy channel.
 */
export const LEGACY_CHANNEL_ID = 'cc-haha'
export const CHANNEL_IDS = {
  decisions: 'cc-haha-decisions',
  completed: 'cc-haha-completed',
  errors: 'cc-haha-errors',
} as const
export type ChannelKind = keyof typeof CHANNEL_IDS

/**
 * App Local notifications we send ourselves (fallback when computer push fails) must also land in the right channel, 
 * otherwise changes in Settings "Sounds & vibration" cannot affect them. Only Android has channels; iOS returns null.
 */
export function channelTriggerFor(
  platform: string,
  kind: 'decision' | 'completed' | 'error'
): { channelId: string } | null {
  if (platform !== 'android') return null
  const channel: ChannelKind =
    kind === 'decision' ? 'decisions' : kind === 'completed' ? 'completed' : 'errors'
  return { channelId: CHANNEL_IDS[channel] }
}
