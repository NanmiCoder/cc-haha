import { expect, test } from 'bun:test'
import { BoundedCache, sessionKey } from './resultsCache'

test('bounded cache evicts the least recently written entry', () => {
  const cache = new BoundedCache<number>(2)
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('a', 3)
  cache.set('c', 4)
  expect(cache.has('b')).toBe(false)
  expect(cache.get('a')).toBe(3)
  expect(cache.get('c')).toBe(4)
  expect(cache.size).toBe(2)
})

test('session keys keep hosts apart', () => {
  expect(sessionKey('host-a', 's1')).not.toBe(sessionKey('host-b', 's1'))
  expect(sessionKey('ab', 'c')).not.toBe(sessionKey('a', 'bc'))
})
