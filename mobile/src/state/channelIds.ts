/**
 * Android 通知渠道 id。电脑推送按事件类型选渠道：登记时带 `delivery.channels = 'split'`
 * 的新版本手机用下面三个，旧版本仍用单一的 legacy 渠道。
 */
export const LEGACY_CHANNEL_ID = 'cc-haha'
export const CHANNEL_IDS = {
  decisions: 'cc-haha-decisions',
  completed: 'cc-haha-completed',
  errors: 'cc-haha-errors',
} as const
export type ChannelKind = keyof typeof CHANNEL_IDS

/**
 * App 自己发的本机通知（电脑推送没通时的兜底）也要落在对应渠道里，
 * 否则设置页「声音和震动」改了也管不到它们。只有安卓有渠道，iOS 返回 null。
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
