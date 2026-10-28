import { describe, expect, test } from 'bun:test'
import { AUTO_BATCH_LIMIT, shouldPrefetchOlder } from './olderHistory'

const base = { viewport: 700, content: 5000, offset: 4300, following: true, batches: 0 }

describe('shouldPrefetchOlder', () => {
  test('starts loading before the reader reaches the top', () => {
    // 离顶部还有 1000（不到一屏半）就开始翻，不用等滑到顶、更不用点按钮。
    expect(shouldPrefetchOlder({ ...base, following: false, offset: 1000 })).toBe(true)
    expect(shouldPrefetchOlder({ ...base, following: false, offset: 1100 })).toBe(false)
  })

  test('keeps loading while still near the top after a batch added little height', () => {
    // 上一批都折进了已有行，位置几乎没动：同一次拖动里继续翻，直到上限。
    for (let batches = 0; batches < AUTO_BATCH_LIMIT; batches++)
      expect(shouldPrefetchOlder({ ...base, following: false, offset: 40, batches })).toBe(true)
    expect(
      shouldPrefetchOlder({ ...base, following: false, offset: 40, batches: AUTO_BATCH_LIMIT })
    ).toBe(false)
  })

  test('fills a conversation shorter than the screen even while following the bottom', () => {
    expect(shouldPrefetchOlder({ ...base, content: 600, offset: 0 })).toBe(true)
  })

  test('does not treat the first frame of a long conversation as reaching the top', () => {
    // 刚打开时列表还停在 0、马上会滚到底部：贴底跟随时不翻。
    expect(shouldPrefetchOlder({ ...base, offset: 0 })).toBe(false)
  })

  test('waits until the list has been measured', () => {
    expect(shouldPrefetchOlder({ ...base, viewport: 0, content: 0, offset: 0 })).toBe(false)
  })
})
