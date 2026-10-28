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
  // 3 / 4 是 MIN / LOW：渠道会变成无横幅的静默，曾经写错过。
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
    name: '要我做决定',
    importance: IMPORTANCE_HIGH,
  })
  // 不能传 sound: 'default'：expo-notifications 会当成自定义声音文件去找，
  // 在真机上报 "Custom sound 'default' not found"（2026-10-28 在 OnePlus 9 上撞到）。
  for (const call of calls) expect(call.config).not.toHaveProperty('sound')
  expect(byId[CHANNEL_IDS.decisions]!.vibrationPattern).toBeDefined()
  expect(byId[CHANNEL_IDS.completed]).toMatchObject({
    name: '任务完成',
    importance: IMPORTANCE_DEFAULT,
  })
  expect(byId[CHANNEL_IDS.errors]).toMatchObject({
    name: '出错或卡住',
    importance: IMPORTANCE_HIGH,
  })
  expect(byId[LEGACY_CHANNEL_ID]).toMatchObject({
    name: '任务与审批',
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
