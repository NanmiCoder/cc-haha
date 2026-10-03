/** Shared maintenance boundary for sidecar-owned IM transports and disk writes. */
export class AdapterMigrationLifecycle {
  private quiescing = false
  private pending = new Set<Promise<unknown>>()
  private shutdown = new Set<() => Promise<void> | void>()
  private failures: unknown[] = []
  private stopping: Promise<void> | null = null

  get isQuiescing(): boolean { return this.quiescing }

  registerShutdown(cleanup: () => Promise<void> | void): void { this.shutdown.add(cleanup) }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), error => {
      this.pending.delete(operation)
      if (this.quiescing) this.failures.push(error)
    })
    return operation
  }

  quiesce(): Promise<void> {
    if (this.stopping) return this.stopping
    this.quiescing = true
    this.stopping = this.drain()
    return this.stopping
  }

  private async drain(): Promise<void> {
    const cleanupResults = await Promise.allSettled([...this.shutdown].map(cleanup => Promise.resolve().then(cleanup)))
    for (const result of cleanupResults) {
      if (result.status === 'rejected') this.failures.push(result.reason)
    }
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
    if (this.failures.length > 0) throw this.failures[0]
  }
}

export const adapterMigrationLifecycle = new AdapterMigrationLifecycle()

export function registerAdapterShutdown(cleanup: () => Promise<void> | void): void {
  adapterMigrationLifecycle.registerShutdown(cleanup)
  const stop = () => {
    void adapterMigrationLifecycle.quiesce().then(() => process.exit(0), error => {
      console.error('[Adapter] Shutdown failed', error)
      process.exit(1)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
