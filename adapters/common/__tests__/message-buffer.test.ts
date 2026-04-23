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
