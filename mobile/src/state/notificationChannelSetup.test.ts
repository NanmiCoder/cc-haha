import { expect, test } from 'bun:test'
import { CHANNEL_IDS, LEGACY_CHANNEL_ID } from './channelIds'
import {
  CHANNEL_SPECS,
  createNotificationChannels,
  IMPORTANCE_DEFAULT,
  IMPORTANCE_HIGH,
  type ChannelApi,
} from './notificationChannelSetup'

test('importance numbers match the installed expo-notifications AndroidImportance enum', async () => {
  const text = await Bun.file(
    new URL(
      '../../node_modules/expo-notifications/build/NotificationChannelManager.types.d.ts',
      import.meta.url
    ).pathname
  ).text()
  const value = (name: string) =>
    Number(new RegExp(`\\b${name} = (\\d+)`).exec(text)?.[1])
  expect(IMPORTANCE_DEFAULT).toBe(value('DEFAULT'))
  expect(IMPORTANCE_HIGH).toBe(value('HIGH'))
  // 3 / 4 is MIN / LOW: the channel becomes a silent one without banners; this was gotten wrong once.
  expect(value('MIN')).toBe(3)
  expect(value('LOW')).toBe(4)
})

function recorder() {
  const calls: { id: string; config: Record<string, unknown> }[] = []
  const api: ChannelApi = {
    setNotificationChannelAsync: async (id, config) => {
      calls.push({ id, config })
    },
  }
  return { calls, api }
}

test('Android creates the three split channels with fixed names and importance, then the legacy channel', async () => {
  const { calls, api } = recorder()
  await createNotificationChannels('android', api)
  expect(calls.map((call) => call.id)).toEqual([
    CHANNEL_IDS.decisions,
    CHANNEL_IDS.completed,
    CHANNEL_IDS.errors,
    LEGACY_CHANNEL_ID,
  ])
  const byId = Object.fromEntries(calls.map((call) => [call.id, call.config]))
  expect(byId[CHANNEL_IDS.decisions]).toMatchObject({
    name: 'Needs my decision',
    importance: IMPORTANCE_HIGH,
  })
  // Do not pass sound: 'default': expo-notifications treats it as a custom sound file to look up, 
  // and real devices report "Custom sound 'default' not found" (hit on a OnePlus 9 on 2026-10-28).
  for (const call of calls) expect(call.config).not.toHaveProperty('sound')
  expect(byId[CHANNEL_IDS.decisions]!.vibrationPattern).toBeDefined()
  expect(byId[CHANNEL_IDS.completed]).toMatchObject({
    name: 'Task finished',
    importance: IMPORTANCE_DEFAULT,
  })
  expect(byId[CHANNEL_IDS.errors]).toMatchObject({
    name: 'Error or stuck',
    importance: IMPORTANCE_HIGH,
  })
  expect(byId[LEGACY_CHANNEL_ID]).toMatchObject({
    name: 'Tasks and approvals',
    importance: IMPORTANCE_HIGH,
  })
})

test('creation is idempotent: repeated runs send identical values, never changing importance after the first', async () => {
  const { calls, api } = recorder()
  await createNotificationChannels('android', api)
  await createNotificationChannels('android', api)
  expect(calls).toHaveLength(CHANNEL_SPECS.length * 2)
  const half = CHANNEL_SPECS.length
  expect(calls.slice(half)).toEqual(calls.slice(0, half))
  expect(new Set(CHANNEL_SPECS.map((spec) => spec.id)).size).toBe(half)
})

test('iOS and web never touch the channel API', async () => {
  for (const platform of ['ios', 'web']) {
    const { calls, api } = recorder()
    await createNotificationChannels(platform, api)
    expect(calls).toHaveLength(0)
  }
})

test('a failing channel stops creation and surfaces the error so split is not declared', async () => {
  const seen: string[] = []
  const api: ChannelApi = {
    setNotificationChannelAsync: async (id) => {
      seen.push(id)
      if (id === CHANNEL_IDS.completed) throw new Error('channel failed')
    },
  }
  await expect(createNotificationChannels('android', api)).rejects.toThrow(
    'channel failed'
  )
  expect(seen).toEqual([CHANNEL_IDS.decisions, CHANNEL_IDS.completed])
})
