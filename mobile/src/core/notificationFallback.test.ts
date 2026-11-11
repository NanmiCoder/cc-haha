import { expect, test } from 'bun:test'
import { NotificationFallback } from './notificationFallback'
import type { NotificationEvent } from './notifications'
import { migratePreferences } from '../state/preferences'

const preferences = migratePreferences(null)
const waiting = (requestId = 'request-1', hostId = 'host-a') => ({
  hostId,
  activity: [{ id: 'session', activityState: 'waiting' as const, requestId, toolName: 'Bash' }],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function delivery() {
  const scheduled: NotificationEvent[] = []
  let permissionReads = 0
  return {
    scheduled,
    get permissionReads() { return permissionReads },
    permitted: async () => { permissionReads++; return true },
    schedule: async (event: NotificationEvent) => { scheduled.push(event) },
  }
}

test('relaunch does not schedule local fallback before server configuration is known', async () => {
  for (const status of [undefined, 'loading', 'error', 'permissionRequired', 'unsupported']) {
    const fallback = new NotificationFallback()
    const native = delivery()
    await fallback.observe(waiting(), status, preferences, native)
    expect(native.scheduled).toEqual([])
    expect(native.permissionReads).toBe(0)
  }
})

test('loading to notConfigured keeps the initial pending request and delivers it once', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  await fallback.observe(waiting(), undefined, preferences, native)
  await fallback.observe(waiting(), 'loading', preferences, native)
  expect(native.scheduled).toEqual([])
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['request-1'])
})

test('configuration resolution uses the latest pending request instead of replaying a stale one', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  await fallback.observe(waiting('old'), 'loading', preferences, native)
  await fallback.observe(waiting('current'), 'error', preferences, native)
  await fallback.observe(waiting('current'), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['current'])
})

test('registered push baselines remote-owned requests before a later fallback', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  await fallback.observe(waiting(), 'loading', preferences, native)
  await fallback.observe(waiting(), 'registered', preferences, native)
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  expect(native.scheduled).toEqual([])
  await fallback.observe(waiting('request-2'), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['request-2'])
})

test('registration completing during the native permission lookup cancels local scheduling', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  const permission = deferred<boolean>()
  const pending = fallback.observe(waiting(), 'notConfigured', preferences, { ...native, permitted: () => permission.promise })
  await fallback.observe(waiting(), 'registered', preferences, native)
  permission.resolve(true)
  await pending
  expect(native.scheduled).toEqual([])
})

test('a permission lookup superseded by loading does not consume the pending request', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  const permission = deferred<boolean>()
  const pending = fallback.observe(waiting(), 'notConfigured', preferences, { ...native, permitted: () => permission.promise })
  await fallback.observe(waiting(), 'loading', preferences, native)
  permission.resolve(true)
  await pending
  expect(native.scheduled).toEqual([])
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['request-1'])
})

test('host baselines are isolated and returning to a remote-owned request stays quiet', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  await fallback.observe(waiting('same-id', 'host-a'), 'registered', preferences, native)
  await fallback.observe(waiting('same-id', 'host-b'), 'notConfigured', preferences, native)
  await fallback.observe(waiting('same-id', 'host-a'), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['same-id'])
})

test('host switch invalidates a permission lookup from the previous host', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  const permission = deferred<boolean>()
  const pending = fallback.observe(waiting('a', 'host-a'), 'notConfigured', preferences, { ...native, permitted: () => permission.promise })
  await fallback.observe(waiting('b', 'host-b'), 'notConfigured', preferences, native)
  permission.resolve(true)
  await pending
  expect(native.scheduled.map(event => event.requestId)).toEqual(['b'])
})

test('unmount or stale dashboard cleanup cancels pending native work without consuming it', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  const permission = deferred<boolean>()
  const pending = fallback.observe(waiting(), 'notConfigured', preferences, { ...native, permitted: () => permission.promise })
  fallback.cancel()
  permission.resolve(true)
  await pending
  expect(native.scheduled).toEqual([])
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['request-1'])
})

test('denied or failed permission lookup can be retried once the native state is ready', async () => {
  const fallback = new NotificationFallback()
  const native = delivery()
  await fallback.observe(waiting(), 'notConfigured', preferences, { ...native, permitted: async () => false })
  await expect(fallback.observe(waiting(), 'notConfigured', preferences, { ...native, permitted: async () => { throw new Error('native unavailable') } })).rejects.toThrow('native unavailable')
  expect(native.scheduled).toEqual([])
  await fallback.observe(waiting(), 'notConfigured', preferences, native)
  expect(native.scheduled.map(event => event.requestId)).toEqual(['request-1'])
})
