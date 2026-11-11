import { expect, test } from 'bun:test'
import { RESUME_STALE_ATTEMPT_MS, resumeAction } from './resume'

const base = { socketOpen: true, backoffPending: false, now: 600_000 }

test('a connection that still looks open is probed, however long the app was away', () => {
  expect(resumeAction({ ...base, connection: 'ready', hiddenAt: 0 })).toBe('probe')
  expect(resumeAction({ ...base, connection: 'ready', hiddenAt: 599_000 })).toBe('probe')
  expect(resumeAction({ ...base, connection: 'ready' })).toBe('probe')
})

test('a ready state whose socket already closed is rebuilt', () => {
  expect(resumeAction({ ...base, connection: 'ready', socketOpen: false, hiddenAt: 0 })).toBe('reconnect')
})

test('an attempt still in flight is left alone instead of being restarted', () => {
  for (const connection of ['connecting', 'syncing', 'reconnecting'] as const)
    expect(
      resumeAction({ ...base, connection, socketOpen: false, attemptStartedAt: 599_500, hiddenAt: 599_000 })
    ).toBe('none')
})

test('an attempt that spanned a long background stay is restarted', () => {
  expect(
    resumeAction({
      ...base,
      connection: 'syncing',
      attemptStartedAt: 100,
      hiddenAt: 200,
      now: 200 + RESUME_STALE_ATTEMPT_MS,
    })
  ).toBe('reconnect')
  // A short trip away does not make the attempt stale.
  expect(
    resumeAction({
      ...base,
      connection: 'syncing',
      attemptStartedAt: 100,
      hiddenAt: 200,
      now: 199 + RESUME_STALE_ATTEMPT_MS,
    })
  ).toBe('none')
})

test('waiting on backoff retries at once; an offline transport reconnects', () => {
  expect(resumeAction({ ...base, connection: 'reconnecting', backoffPending: true })).toBe('expedite')
  expect(resumeAction({ ...base, connection: 'offline', socketOpen: false })).toBe('reconnect')
})

test('a revoked pairing is never retried automatically', () => {
  expect(resumeAction({ ...base, connection: 'pairing_required', backoffPending: true, hiddenAt: 0 })).toBe('none')
})
