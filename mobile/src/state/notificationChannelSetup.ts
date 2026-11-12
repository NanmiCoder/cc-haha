import { CHANNEL_IDS, LEGACY_CHANNEL_ID } from './channelIds'

/**
 * Android Channel creation list. Pure data + injected API, no native module dependency, easy to unit test.
 * importance Values match AndroidImportance in expo-notifications (DEFAULT=5, HIGH=6; 
 * note 3 is MIN and 4 is LOW, which make silent channels without banners — the test checks against the enum definition file).
 * Once a channel is created the system fixes its importance and sound, and later calls can only rename it — so these values
 * must not be changed casually; to change behavior add a new channel id.
 */
export const IMPORTANCE_DEFAULT = 5
export const IMPORTANCE_HIGH = 6

export type ChannelSpec = {
  id: string
  name: string
  importance: number
  sound?: 'default' | null
  vibrationPattern?: number[]
}

/** Fixed order: the three split channels first, the legacy channel for older desktop versions last. */
export const CHANNEL_SPECS: ChannelSpec[] = [
  {
    id: CHANNEL_IDS.decisions,
    name: 'Needs my decision',
    importance: IMPORTANCE_HIGH,
    vibrationPattern: [0, 250, 250, 250],
  },
  {
    id: CHANNEL_IDS.completed,
    name: 'Task finished',
    importance: IMPORTANCE_DEFAULT,
  },
  {
    id: CHANNEL_IDS.errors,
    name: 'Error or stuck',
    importance: IMPORTANCE_HIGH,
    vibrationPattern: [0, 250, 250, 250],
  },
  // Older desktop versions still push to this channel; registrations without channels: 'split' use it.
  {
    id: LEGACY_CHANNEL_ID,
    name: 'Tasks and approvals',
    importance: IMPORTANCE_HIGH,
  },
]

export type ChannelApi = {
  setNotificationChannelAsync(
    id: string,
    config: Omit<ChannelSpec, 'id'>
  ): Promise<unknown>
}

/** created one by one; any failure is thrown up so the caller decides whether it can declare channels: 'split'. */
export async function createNotificationChannels(
  platform: string,
  api: ChannelApi
) {
  if (platform !== 'android') return
  for (const { id, ...config } of CHANNEL_SPECS)
    await api.setNotificationChannelAsync(id, config)
}
