import { describe, expect, test } from 'bun:test'
import { StreamToolInputDurationGuard } from './streamToolInputDurationGuard.js'

describe('StreamToolInputDurationGuard', () => {
  test('fires once when a tool input makes no progress before its deadline', async () => {
    const timedOut: number[] = []
    const guard = new StreamToolInputDurationGuard({
      enabled: true,
      timeoutMs: 5,
      onTimeout: index => timedOut.push(index),
    })

    guard.start(3)
    await Bun.sleep(15)

    expect(timedOut).toEqual([3])
    guard.clear()
  })

  test('cancels completed inputs and supports a disabled budget', async () => {
    const timedOut: number[] = []
    const guard = new StreamToolInputDurationGuard({
      enabled: true,
      timeoutMs: 5,
      onTimeout: index => timedOut.push(index),
    })
    const disabled = new StreamToolInputDurationGuard({
      enabled: false,
      timeoutMs: 5,
      onTimeout: index => timedOut.push(index),
    })

    guard.start(1)
    expect(guard.hasActiveInput()).toBe(true)
    guard.stop(1)
    expect(guard.hasActiveInput()).toBe(false)
    disabled.start(2)
    expect(disabled.hasActiveInput()).toBe(false)
    await Bun.sleep(15)

    expect(timedOut).toEqual([])
    guard.clear()
    disabled.clear()
  })

  test('allows continued progress but times out after progress stops', async () => {
    const timedOut: number[] = []
    const guard = new StreamToolInputDurationGuard({
      enabled: true,
      timeoutMs: 100,
      onTimeout: index => timedOut.push(index),
    })

    guard.start(4)
    await Bun.sleep(30)
    guard.progress(4)
    await Bun.sleep(30)
    guard.progress(4)
    await Bun.sleep(50)

    expect(timedOut).toEqual([])

    await Bun.sleep(70)

    expect(timedOut).toEqual([4])
    guard.clear()
  })
})
