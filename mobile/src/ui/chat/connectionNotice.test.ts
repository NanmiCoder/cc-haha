import { expect, test } from 'bun:test'
import {
  CONNECTION_BANNER_AFTER_MS,
  CONNECTION_LABEL_AFTER_MS,
  connectionNotice,
  showsReconnectBanner,
} from './connectionNotice'

test('a short disconnect after being connected shows nothing', () => {
  for (const connection of ['reconnecting', 'syncing', 'connecting', 'offline'] as const) {
    const notice = connectionNotice({ connection, since: 1000, now: 1000 + CONNECTION_LABEL_AFTER_MS - 1, everReady: true })
    expect(notice.label).toBe(false)
    expect(notice.banner).toBe(false)
    expect(notice.recheckIn).toBe(1)
  }
})

test('the subtitle says so after a few seconds and the banner after ten', () => {
  const label = connectionNotice({ connection: 'reconnecting', since: 0, now: CONNECTION_LABEL_AFTER_MS, everReady: true })
  expect(label).toEqual({ label: true, banner: false, recheckIn: CONNECTION_BANNER_AFTER_MS - CONNECTION_LABEL_AFTER_MS })
  const banner = connectionNotice({ connection: 'reconnecting', since: 0, now: CONNECTION_BANNER_AFTER_MS, everReady: true })
  expect(banner).toEqual({ label: true, banner: true })
})

test('opening a conversation shows "connecting" at once, but still delays the banner', () => {
  const notice = connectionNotice({ connection: 'connecting', since: 0, now: 0, everReady: false })
  expect(notice.label).toBe(true)
  expect(notice.banner).toBe(false)
})

test('two failed attempts in a row bring up the banner without waiting ten seconds', () => {
  const once = connectionNotice({ connection: 'reconnecting', since: 0, now: 1500, everReady: true, failures: 1 })
  expect(once.banner).toBe(false)
  const twice = connectionNotice({ connection: 'reconnecting', since: 0, now: 1500, everReady: true, failures: 2 })
  expect(twice).toMatchObject({ label: true, banner: true })
  expect(connectionNotice({ connection: 'ready', since: 0, now: 1500, everReady: true, failures: 2 }).banner).toBe(false)
})

test('a resume that drags on shows the same reconnect banner as a reconnect', () => {
  for (const connection of ['resuming', 'reconnecting', 'offline'] as const)
    expect(showsReconnectBanner(connection)).toBe(true)
  for (const connection of ['connecting', 'syncing', 'ready', 'pairing_required'] as const)
    expect(showsReconnectBanner(connection)).toBe(false)
  const notice = connectionNotice({ connection: 'resuming', since: 0, now: CONNECTION_BANNER_AFTER_MS, everReady: true })
  expect(notice.banner && showsReconnectBanner('resuming')).toBe(true)
})

test('a revoked pairing is shown immediately and a ready connection shows nothing', () => {
  expect(connectionNotice({ connection: 'pairing_required', since: 0, now: 0, everReady: true })).toEqual({ label: true, banner: true })
  expect(connectionNotice({ connection: 'ready', since: 0, now: 99_999, everReady: true })).toEqual({ label: false, banner: false })
})
