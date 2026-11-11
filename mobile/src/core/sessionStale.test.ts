import { expect, test } from 'bun:test'
import { markSessionStale, takeSessionStale } from './sessionStale'

test('a rewound session is reloaded exactly once and only on its own host', () => {
  markSessionStale('host-a', 's1')
  expect(takeSessionStale('host-b', 's1')).toBe(false)
  expect(takeSessionStale('host-a', 's2')).toBe(false)
  expect(takeSessionStale('host-a', 's1')).toBe(true)
  expect(takeSessionStale('host-a', 's1')).toBe(false)
})
