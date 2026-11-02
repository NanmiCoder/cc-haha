/**
 * Global registry for cleanup functions that should run during graceful shutdown.
 * This module is separate from gracefulShutdown.ts to avoid circular dependencies.
 */

// Global registry for cleanup functions
const cleanupFunctions = new Set<() => Promise<void>>()
const cleanupTimeouts = new Map<() => Promise<void>, number>()

/**
 * Register a cleanup function to run during graceful shutdown.
 * @param cleanupFn - Function to run during cleanup (can be sync or async)
 * @returns Unregister function that removes the cleanup handler
 */
export function registerCleanup(cleanupFn: () => Promise<void>, options: { timeoutMs?: number } = {}): () => void {
  cleanupFunctions.add(cleanupFn)
  if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
    cleanupTimeouts.set(cleanupFn, Math.min(4_500, Math.max(2_000, options.timeoutMs)))
  }
  return () => {
    cleanupFunctions.delete(cleanupFn)
    cleanupTimeouts.delete(cleanupFn)
  }
}

export function getCleanupTimeoutMs(): number {
  return Math.max(2_000, ...cleanupTimeouts.values())
}

/**
 * Run all registered cleanup functions.
 * Used internally by gracefulShutdown.
 */
export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
