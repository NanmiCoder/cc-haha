import { expect, test } from 'bun:test'
import { settlePending } from './usePendingSwitches'

test('a pending switch survives a stale poll and clears once the computer agrees', () => {
  const pending = { a: false, b: true }
  // Stale poll: computer still reports the old values.
  const stale = settlePending(pending, new Map([['a', true], ['b', false]]))
  expect(stale).toBe(pending)
  // Computer accepted "a"; "b" still pending.
  expect(settlePending(pending, new Map([['a', false], ['b', false]]))).toEqual({ b: true })
  // A task that disappeared drops its pending value.
  expect(settlePending(pending, new Map([['b', true]]))).toEqual({})
})
