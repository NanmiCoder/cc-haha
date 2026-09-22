import { describe, expect, it, vi } from 'vitest'
import { createAsyncRefreshCoalescer } from './asyncRefreshCoalescer'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('async refresh coalescer', () => {
  it('bounds a burst to one active and one trailing refresh', async () => {
    const first = deferred()
    const second = deferred()
    const task = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const request = createAsyncRefreshCoalescer(task)

    const pending = request()
    request()
    request()
    expect(task).toHaveBeenCalledTimes(1)

    first.resolve()
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2))
    second.resolve()
    await pending
    expect(task).toHaveBeenCalledTimes(2)
  })
})
