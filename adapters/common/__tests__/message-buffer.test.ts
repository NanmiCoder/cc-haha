import { describe, it, expect, beforeEach } from 'bun:test'
import { MessageBuffer } from '../message-buffer.js'

describe('MessageBuffer', () => {
  it('accumulates text and flushes on complete', async () => {
    const flushed: Array<{ text: string; isComplete: boolean }> = []
    const buf = new MessageBuffer(
      (text, isComplete) => { flushed.push({ text, isComplete }) },
      500,  // 500ms interval
      1000, // 1000 char threshold
    )

    buf.append('Hello ')
    buf.append('World')
    await buf.complete()

    expect(flushed.length).toBeGreaterThanOrEqual(1)
    const allText = flushed.map((f) => f.text).join('')
    expect(allText).toBe('Hello World')
    // Last flush should be marked complete
    expect(flushed[flushed.length - 1]!.isComplete).toBe(true)
  })

  it('flushes when character threshold is reached', async () => {
    const flushed: string[] = []
    const buf = new MessageBuffer(
      (text) => { flushed.push(text) },
      10000, // very long interval (won't trigger)
      10,    // 10 char threshold
    )

    buf.append('12345678901') // 11 chars > threshold

    // Wait for microtask
    await new Promise((r) => setTimeout(r, 10))
    expect(flushed.length).toBeGreaterThanOrEqual(1)

    buf.reset()
  })

  it('flushes on timer interval', async () => {
    const flushed: string[] = []
    const buf = new MessageBuffer(
      (text) => { flushed.push(text) },
      50, // 50ms interval
      1000,
    )

    buf.append('hi')

    // Wait for timer
    await new Promise((r) => setTimeout(r, 80))
    expect(flushed).toContain('hi')

    buf.reset()
  })

  it('complete() waits for in-flight flush before sending final isComplete=true', async () => {
    const flushed: Array<{ text: string; isComplete: boolean }> = []
    let resolveFlush!: () => void
    const buf = new MessageBuffer(
      (text, isComplete) => {
        flushed.push({ text, isComplete })
        // First flush returns a promise that we control so we can force the
        // "flushing = true" branch to be active when complete() is called.
        if (flushed.length === 1) {
          return new Promise<void>((r) => { resolveFlush = r })
        }
      },
      50,    // short interval
      1000,
    )

    buf.append('part1')
    // Trigger a timer-based flush and wait until onFlush has been entered.
    await new Promise((r) => setTimeout(r, 80))
    // onFlush is now blocking (flushing = true). Append more text and complete.
    buf.append('part2')
    const completePromise = buf.complete()
    // Unblock the first flush.
    resolveFlush()
    await completePromise

    const allText = flushed.map((f) => f.text).join('')
    expect(allText).toBe('part1part2')
    expect(flushed[flushed.length - 1]!.isComplete).toBe(true)
  })

  it('does not flush empty buffer on complete', async () => {
    const flushed: string[] = []
    const buf = new MessageBuffer(
      (text) => { flushed.push(text) },
    )

    await buf.complete()
    expect(flushed.length).toBe(0)
  })

  it('resets properly between messages', async () => {
    const flushed: string[] = []
    const buf = new MessageBuffer(
      (text) => { flushed.push(text) },
      500,
      1000,
    )

    buf.append('first')
    buf.reset()
    buf.append('second')
    await buf.complete()

    const allText = flushed.map((f) => f).join('')
    expect(allText).toBe('second')
  })
})
