import { describe, expect, test } from 'bun:test'
import { StreamToolInputDurationGuard } from './streamToolInputDurationGuard.js'

describe('StreamToolInputDurationGuard', () => {
  test('fires once when a tool input exceeds its generation budget', async () => {
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
    guard.stop(1)
    disabled.start(2)
    await Bun.sleep(15)

    expect(timedOut).toEqual([])
    guard.clear()
    disabled.clear()
  })
})
