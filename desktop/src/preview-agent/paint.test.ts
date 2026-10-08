import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterNextPaint } from './paint'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('afterNextPaint', () => {
  it('resolves only after a second animation frame, once the first has been drawn', async () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
    let settled = false
    const done = afterNextPaint().then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    frames.shift()!(0)
    await Promise.resolve()
    expect(settled).toBe(false)
    frames.shift()!(16)
    await done
    expect(settled).toBe(true)
  })

  it('gives up after the timeout when the page never paints', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    let settled = false
    const done = afterNextPaint(250).then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(249)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toBe(true)
  })
})
