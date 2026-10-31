import { expect, test } from 'bun:test'
import { randomRequestId } from './requestId'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('uses randomUUID where the platform provides it', () => {
  expect(randomRequestId({ randomUUID: () => 'from-platform', getRandomValues: (a) => a })).toBe('from-platform')
})

test('builds a v4 UUID from random bytes on a plain-http page without randomUUID', () => {
  // A LAN H5 page is not a secure context: browsers leave crypto.randomUUID undefined there.
  const ids = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const id = randomRequestId({ getRandomValues: (array) => crypto.getRandomValues(array) })
    expect(id).toMatch(UUID_V4)
    ids.add(id)
  }
  expect(ids.size).toBe(50)
  // Version and variant bits are forced even when every random byte is 0xff.
  expect(randomRequestId({ getRandomValues: (array) => array.fill(0xff) })).toBe(
    'ffffffff-ffff-4fff-bfff-ffffffffffff'
  )
})
