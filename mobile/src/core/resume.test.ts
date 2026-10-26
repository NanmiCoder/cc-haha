import { expect, test } from 'bun:test'
import { RESUME_RECONNECT_AFTER_MS, shouldReconnectOnResume } from './resume'

test('a healthy connection survives a short trip to the background', () => {
  expect(shouldReconnectOnResume({ connection: 'ready', hiddenAt: 1_000, now: 4_000 })).toBe(false)
  expect(shouldReconnectOnResume({ connection: 'ready', now: 4_000 })).toBe(false)
})

test('a long background stay or a broken connection reconnects on resume', () => {
  expect(
    shouldReconnectOnResume({
      connection: 'ready',
      hiddenAt: 0,
      now: RESUME_RECONNECT_AFTER_MS,
    })
  ).toBe(true)
  for (const connection of ['offline', 'reconnecting', 'connecting', 'syncing'] as const)
    expect(shouldReconnectOnResume({ connection, hiddenAt: 0, now: 1 })).toBe(true)
})

test('a revoked pairing is never retried automatically', () => {
  expect(shouldReconnectOnResume({ connection: 'pairing_required', hiddenAt: 0, now: 60_000 })).toBe(false)
})
