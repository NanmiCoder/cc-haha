/**
 * FlushController unit tests
 *
 * Covers:
 * - Basics: cardMessageReady gate, complete() lock
 * - Throttle window: immediate flush / delayed flush
 * - Mutex: repeated calls during a flush mark needsReflush
 * - Conflict reflush: automatic follow-up after the API call ends
 * - Long-gap batching: after elapsed > 2000ms, delay 300ms before flushing
 * - waitForFlush: wait for the current flush to finish
 */

import { describe, it, expect } from 'bun:test'
import { FlushController, THROTTLE } from '../flush-controller.js'

// Create a controllable doFlush —— returns a Promise that can be resolved manually
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
  it('does not flush when cardMessageReady=false', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    await fc.flush()
    await fc.throttledUpdate(50)
    expect(count).toBe(0)
  })

  it('flush can run after setCardMessageReady(true)', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    await fc.flush()
    expect(count).toBe(1)
  })

  it('setCardMessageReady(true) initializes lastUpdateTime synchronously —— throttledUpdate right after ready is held by the throttle window', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    // Immediately call throttledUpdate with a 500ms window; first elapsed≈0 → enters delayed branch
    await fc.throttledUpdate(500)
    // Synchronous phase hasn't reached 500ms, should not flush
    expect(count).toBe(0)
    // After 500+ms the delay timer fires
    await sleep(600)
    expect(count).toBe(1)
  })
})

describe('FlushController: complete()', () => {
  it('rejects new flushes after complete()', async () => {
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

describe('FlushController: throttle window', () => {
  it('flushes immediately past the window', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true)
    // Manually move lastUpdateTime far back (equivalent to the throttle window having passed)
    await sleep(150)
    await fc.throttledUpdate(100)
    expect(count).toBe(1)
  })

  it('schedules a delayed flush on the first call within the window', async () => {
    let count = 0
    const fc = new FlushController(async () => {
      count += 1
    })
    fc.setCardMessageReady(true) // lastUpdateTime = now

    await fc.throttledUpdate(200)
    expect(count).toBe(0) // delayed, not fired yet

    await sleep(300)
    expect(count).toBe(1) // delay timer fires after 200ms
  })

  it('multiple calls within the window reuse the same delay timer (no duplicate flush)', async () => {
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

describe('FlushController: mutex + conflict reflush', () => {
  it('repeated calls during a flush do not run concurrently', async () => {
    const { doFlush, calls, blockNext, unblock } = makeControllableFlush()
    const fc = new FlushController(doFlush)
    fc.setCardMessageReady(true)

    blockNext()
    const p1 = fc.flush() // held by the latch after flush-start
    // Let the event loop turn once so the first flush enters its body
    await sleep(10)
    // The first one hasn't finished on the second call —— should be blocked by the mutex
    const p2 = fc.flush()

    // Both Promises are registered but neither has ended
    expect(calls).toEqual(['flush-start'])

    unblock()
    await p1
    await p2
    // After the first finishes, needsReflush was set so one follow-up flush runs
    // (conflict reflush is scheduled via setTimeout 0; let it finish)
    await sleep(20)

    // First flush-start + flush-end, then the conflict reflush start + end once more
    expect(calls).toEqual([
      'flush-start', 'flush-end',
      'flush-start', 'flush-end',
    ])
  })

  it('throttledUpdate during a flush also triggers a reflush', async () => {
    const { doFlush, calls, blockNext, unblock } = makeControllableFlush()
    const fc = new FlushController(doFlush)
    fc.setCardMessageReady(true)

    blockNext()
    const p1 = fc.flush()
    await sleep(10)

    // New update request received while the API call is in progress
    await fc.throttledUpdate(10)

    unblock()
    await p1
    await sleep(30)

    // First flush + conflict reflush
    expect(calls.filter((c) => c === 'flush-end').length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Long gap batching
// ---------------------------------------------------------------------------

describe('FlushController: long-gap batching', () => {
  it('delays by BATCH_AFTER_GAP_MS before flushing when elapsed > LONG_GAP_THRESHOLD_MS', async () => {
    let count = 0
    let flushAtMs = 0
    const start = Date.now()
    const fc = new FlushController(async () => {
      count += 1
      flushAtMs = Date.now() - start
    })
    fc.setCardMessageReady(true)

    // Wait until elapsed > 2000ms
    await sleep(THROTTLE.LONG_GAP_THRESHOLD_MS + 50)
    const callAt = Date.now() - start

    await fc.throttledUpdate(THROTTLE.CARDKIT_MS)
    // throttledUpdate's synchronous phase should not flush immediately (takes the batch branch)
    expect(count).toBe(0)

    // Wait BATCH_AFTER_GAP_MS + margin
    await sleep(THROTTLE.BATCH_AFTER_GAP_MS + 50)
    expect(count).toBe(1)
    // The actual flush happens at least 300ms after the throttledUpdate call
    expect(flushAtMs - callAt).toBeGreaterThanOrEqual(THROTTLE.BATCH_AFTER_GAP_MS - 20)
  })
})

// ---------------------------------------------------------------------------
// waitForFlush
// ---------------------------------------------------------------------------

describe('FlushController: waitForFlush', () => {
  it('returns immediately when no flush is running', async () => {
    const fc = new FlushController(async () => {})
    fc.setCardMessageReady(true)
    const start = Date.now()
    await fc.waitForFlush()
    expect(Date.now() - start).toBeLessThan(10)
  })

  it('waits for a running flush to finish', async () => {
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
// Constant sanity
// ---------------------------------------------------------------------------

describe('FlushController: THROTTLE constants', () => {
  it('CARDKIT_MS=100, PATCH_MS=1500', () => {
    expect(THROTTLE.CARDKIT_MS).toBe(100)
    expect(THROTTLE.PATCH_MS).toBe(1500)
  })
  it('LONG_GAP_THRESHOLD_MS=2000, BATCH_AFTER_GAP_MS=300', () => {
    expect(THROTTLE.LONG_GAP_THRESHOLD_MS).toBe(2000)
    expect(THROTTLE.BATCH_AFTER_GAP_MS).toBe(300)
  })
})
