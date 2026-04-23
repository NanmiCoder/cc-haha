/**
 * FlushController 单元测试
 *
 * 覆盖:
 * - 基础: cardMessageReady gate, complete() 锁死
 * - 节流窗口: 立即 flush / 延迟 flush
 * - Mutex: 进行中的 flush 重复调用标记 needsReflush
 * - Conflict reflush: API 结束后自动补一次
 * - 长间隔批量: elapsed > 2000ms 后延迟 300ms 再 flush
 * - waitForFlush: 等当前 flush 结束
 */

import { describe, it, expect } from 'bun:test'
import { FlushController, THROTTLE } from '../flush-controller.js'

// 创建一个可控的 doFlush —— 返回一个 Promise 可以手动 resolve
function makeControllableFlush() {
  const calls: string[] = []
  let resolveCurrent: (() => void) | null = null
  let latch: Promise<void> | null = null

  const doFlush = async () => {
    calls.push('flush-start')
    if (latch) {
      await latch
      latch = null
    }
    calls.push('flush-end')
  }

  const blockNext = () => {
    latch = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })
  }

  const unblock = () => {
    if (resolveCurrent) {
      const r = resolveCurrent
      resolveCurrent = null
      r()
    }
  }

  return { doFlush, calls, blockNext, unblock }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Basic gating
// ---------------------------------------------------------------------------

describe('FlushController: cardMessageReady gate', () => {
  it('在 cardMessageReady=false 时不 flush', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    await fc.flush()
    await fc.throttledUpdate(50)
    expect(count).toBe(0)
  })

  it('setCardMessageReady(true) 后 flush 可执行', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    await fc.flush()
    expect(count).toBe(1)
  })

  it('setCardMessageReady(true) 同步初始化 lastUpdateTime —— 刚 ready 时 throttledUpdate 被节流窗口阻挡', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    // 立即调用 throttledUpdate 500ms 窗口，首次 elapsed≈0 → 进入延迟分支
    await fc.throttledUpdate(500)
    // 同步阶段还没到 500ms，不应触发 flush
    expect(count).toBe(0)
    // 500+ms 后延迟 timer 触发
    await sleep(600)
    expect(count).toBe(1)
  })
})

describe('FlushController: complete()', () => {
  it('complete() 后拒绝新 flush', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    fc.complete()
    await fc.flush()
    await fc.throttledUpdate(50)
    expect(count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Throttle window
// ---------------------------------------------------------------------------

describe('FlushController: 节流窗口', () => {
  it('超过窗口立即 flush', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    // 手动把 lastUpdateTime 挪远（等同于已过了节流窗口）
    await sleep(150)
    await fc.throttledUpdate(100)
    expect(count).toBe(1)
  })

  it('在窗口内首次调用安排延迟 flush', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true) // lastUpdateTime = now

    await fc.throttledUpdate(200)
    expect(count).toBe(0) // 延迟中，还没触发

    await sleep(300)
    expect(count).toBe(1) // 200ms 后延迟 timer 触发
  })

  it('窗口内多次调用复用同一个延迟 timer（不重复 flush）', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)

    await fc.throttledUpdate(200)
    await fc.throttledUpdate(200)
    await fc.throttledUpdate(200)
    await fc.throttledUpdate(200)

    await sleep(300)
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Mutex + conflict reflush
// ---------------------------------------------------------------------------

describe('FlushController: mutex + 冲突重刷', () => {
  it('flush 进行中的重复调用不并发执行', async () => {
    const { doFlush, calls, blockNext, unblock } = makeControllableFlush()
    const fc = new FlushController(doFlush)
    fc.setCardMessageReady(true)

    blockNext()
    const p1 = fc.flush() // flush-start 后被 latch 卡住
    // 让事件循环走一轮，确保第一次 flush 进入 body
    await sleep(10)
    // 第二次调用时第一次还没结束 —— 应被 mutex 挡住
    const p2 = fc.flush()

    // 两次 Promise 都已登记，但都还没 end
    expect(calls).toEqual(['flush-start'])

    unblock()
    await p1
    await p2
    // 第一次跑完后，由于 needsReflush 被标记，会触发一次补刷
    // （conflict reflush 是通过 setTimeout 0 调度的，需要让它跑完）
    await sleep(20)

    // 第一次 flush-start + flush-end，然后冲突补刷再一次 start + end
    expect(calls).toEqual([
      'flush-start', 'flush-end',
      'flush-start', 'flush-end',
    ])
  })

  it('flush 进行中的 throttledUpdate 也会触发补刷', async () => {
    const { doFlush, calls, blockNext, unblock } = makeControllableFlush()
    const fc = new FlushController(doFlush)
    fc.setCardMessageReady(true)

    blockNext()
    const p1 = fc.flush()
    await sleep(10)

    // API 进行中收到新的 update 请求
    await fc.throttledUpdate(10)

    unblock()
    await p1
    await sleep(30)

    // 第一次 flush + 冲突补刷
    expect(calls.filter((c) => c === 'flush-end').length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Long gap batching
// ---------------------------------------------------------------------------

describe('FlushController: 长间隔批量', () => {
  it('elapsed > LONG_GAP_THRESHOLD_MS 时延迟 BATCH_AFTER_GAP_MS 再 flush', async () => {
    let count = 0
    let flushAtMs = 0
    const start = Date.now()
    const fc = new FlushController(async () => {
      count += 1
      flushAtMs = Date.now() - start
    })
    fc.setCardMessageReady(true)

    // 等到 elapsed > 2000ms
    await sleep(THROTTLE.LONG_GAP_THRESHOLD_MS + 50)
    const callAt = Date.now() - start

    await fc.throttledUpdate(THROTTLE.CARDKIT_MS)
    // throttledUpdate 同步阶段不应立即 flush（因为走批量分支）
    expect(count).toBe(0)

    // 等 BATCH_AFTER_GAP_MS + 余量
    await sleep(THROTTLE.BATCH_AFTER_GAP_MS + 50)
    expect(count).toBe(1)
    // 实际 flush 时刻至少比 throttledUpdate 调用晚 300ms
    expect(flushAtMs - callAt).toBeGreaterThanOrEqual(THROTTLE.BATCH_AFTER_GAP_MS - 20)
  })
})

// ---------------------------------------------------------------------------
// waitForFlush
// ---------------------------------------------------------------------------

describe('FlushController: waitForFlush', () => {
  it('没在 flush 时立即返回', async () => {
    const fc = new FlushController(async () => {})
    fc.setCardMessageReady(true)
    const start = Date.now()
    await fc.waitForFlush()
    expect(Date.now() - start).toBeLessThan(10)
  })

  it('有 flush 在跑时等它结束', async () => {
    const { doFlush, blockNext, unblock } = makeControllableFlush()
    const fc = new FlushController(doFlush)
    fc.setCardMessageReady(true)

    blockNext()
    const p1 = fc.flush()
    await sleep(10)

    let resolved = false
    const waiter = fc.waitForFlush().then(() => {
      resolved = true
    })
    await sleep(20)
    expect(resolved).toBe(false)

    unblock()
    await p1
    await waiter
    expect(resolved).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 常量合理性
// ---------------------------------------------------------------------------

describe('FlushController: THROTTLE 常量', () => {
  it('CARDKIT_MS=100, PATCH_MS=1500', () => {
    expect(THROTTLE.CARDKIT_MS).toBe(100)
    expect(THROTTLE.PATCH_MS).toBe(1500)
  })
  it('LONG_GAP_THRESHOLD_MS=2000, BATCH_AFTER_GAP_MS=300', () => {
    expect(THROTTLE.LONG_GAP_THRESHOLD_MS).toBe(2000)
    expect(THROTTLE.BATCH_AFTER_GAP_MS).toBe(300)
  })
})
