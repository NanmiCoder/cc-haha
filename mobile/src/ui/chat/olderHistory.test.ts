import { describe, expect, test } from 'bun:test'
import { AUTO_BATCH_LIMIT, shouldPrefetchOlder } from './olderHistory'

const base = { viewport: 700, content: 5000, toOldest: 4300, batches: 0 }

describe('shouldPrefetchOlder', () => {
  test('starts loading before the reader reaches the oldest loaded content', () => {
    // 离最早内容还有 1000（不到一屏半）就开始翻，不用等滑到顶、更不用点按钮。
    expect(shouldPrefetchOlder({ ...base, toOldest: 1000 })).toBe(true)
    expect(shouldPrefetchOlder({ ...base, toOldest: 1100 })).toBe(false)
  })

  test('does not load while the reader is far from the top', () => {
    // 停在最新处、上面还有好几屏已加载的内容。
    expect(shouldPrefetchOlder(base)).toBe(false)
  })

  test('keeps loading while still near the top after a batch added little height', () => {
    // 上一批都折进了已有行，离顶部几乎没变：同一次拖动里继续翻，直到上限。
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
