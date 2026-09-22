/**
 * Collapses a burst into one active refresh plus at most one trailing refresh.
 * The trailing run preserves an update that arrived while the first snapshot
 * was being read without allowing unbounded concurrent work.
 */
export function createAsyncRefreshCoalescer(task: () => Promise<void>) {
  let running: Promise<void> | null = null
  let queued = false

  const request = (): Promise<void> => {
    queued = true
    if (running) return running

    const drain = async () => {
      do {
        queued = false
        await task()
      } while (queued)
    }
    running = drain().finally(() => {
      running = null
      if (queued) void request()
    })
    return running
  }

  return request
}
