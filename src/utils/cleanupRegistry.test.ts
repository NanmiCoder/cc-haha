import { expect, test } from 'bun:test'
import { getCleanupTimeoutMs, registerCleanup } from './cleanupRegistry.js'

test('the default shutdown budget stays two seconds without a longer cleanup', () => {
  const unregister = registerCleanup(async () => {})
  try { expect(getCleanupTimeoutMs()).toBe(2_000) } finally { unregister() }
})

test('native teardown can reserve a bounded budget that is removed with its registration', () => {
  const unregister = registerCleanup(async () => {}, { timeoutMs: 10_000 })
  try { expect(getCleanupTimeoutMs()).toBe(4_500) } finally { unregister() }
  expect(getCleanupTimeoutMs()).toBe(2_000)
})
