import { describe, expect, test } from 'bun:test'
import { AUTO_BATCH_LIMIT, shouldPrefetchOlder } from './olderHistory'

const base = { viewport: 700, content: 5000, toOldest: 4300, batches: 0 }

describe('shouldPrefetchOlder', () => {
  test('starts loading before the reader reaches the oldest loaded content', () => {
    // Start paging when 1000 (less than a screen and a half) from the earliest content, without waiting to reach the top, let alone tapping a button.
    expect(shouldPrefetchOlder({ ...base, toOldest: 1000 })).toBe(true)
    expect(shouldPrefetchOlder({ ...base, toOldest: 1100 })).toBe(false)
  })

  test('does not load while the reader is far from the top', () => {
    // Staying at the newest with several screens of loaded content above.
    expect(shouldPrefetchOlder(base)).toBe(false)
  })

  test('keeps loading while still near the top after a batch added little height', () => {
    // The previous batch all folded into existing rows and the distance to the top barely changed: keep paging in the same drag, up to the cap.
    for (let batches = 0; batches < AUTO_BATCH_LIMIT; batches++)
      expect(shouldPrefetchOlder({ ...base, toOldest: 40, batches })).toBe(true)
    expect(shouldPrefetchOlder({ ...base, toOldest: 40, batches: AUTO_BATCH_LIMIT })).toBe(false)
  })

  test('fills a conversation shorter than the screen', () => {
    expect(shouldPrefetchOlder({ ...base, content: 600, toOldest: 0 })).toBe(true)
  })

  test('waits until the list has been measured', () => {
    expect(shouldPrefetchOlder({ ...base, viewport: 0 })).toBe(false)
    expect(shouldPrefetchOlder({ ...base, content: 0, toOldest: 0 })).toBe(false)
  })
})
