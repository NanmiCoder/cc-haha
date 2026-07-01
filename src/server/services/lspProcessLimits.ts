/**
 * Resource limits for spawned LSP processes.
 *
 * The spec for Phase 3 task 20 lists three strategies:
 *   - posix-rlimit (POSIX setrlimit, requires native binding)
 *   - windows-job-object (requires N-API plugin / sidecar)
 *   - poll-fallback (pure JS sampling)
 *
 * Native rlimit / job-object support requires extra build infrastructure
 * (native modules, signed sidecars) we don't want to take on in this PR.
 * So we ship the poll-fallback strategy for both platforms — it's the
 * universal floor anyway, and an LSP server that misbehaves once will be
 * caught after at most two sampling windows (~10 s).
 *
 * If a future PR lands native limits, expose them through this same
 * `LspProcessLimits` interface so call sites don't change.
 *
 * _Requirements: 7.4 (Phase 3 task 20)_
 */

import type { ChildProcess } from 'node:child_process'

const SAMPLE_INTERVAL_MS = 5_000
const CONSECUTIVE_OVERAGES_TO_TERMINATE = 2

export type LspProcessLimitsConfig = {
  /** Maximum resident memory in bytes — exceed this twice in a row to terminate. */
  maxMemoryBytes: number
  /** Override the sampling interval (ms). Defaults to 5 s. */
  sampleIntervalMs?: number
  /** Override the consecutive-overage termination threshold. Defaults to 2. */
  consecutiveOveragesToTerminate?: number
  /** Optional notifier for the manager — called when limits trip. */
  onLimitExceeded?: (info: { reason: 'memory'; rssBytes: number; observed: number }) => void
}

export type LspProcessLimits = {
  /** Returns the strategy actually in use — currently always 'poll-fallback'. */
  strategy: 'poll-fallback' | 'posix-rlimit' | 'windows-job-object'
  /** Stop sampling and clear the underlying timer. */
  dispose(): void
}

export type ResourceSampler = (pid: number) => Promise<{ rssBytes: number } | null>

/**
 * Default `process.memoryUsage`-derived sampler is **not** suitable here
 * because it reports the parent (server) process memory, not the LSP
 * child. On every platform we'd need either `ps -o rss` (POSIX) or
 * `Get-Process` (Windows) to read child RSS. Until that's wired through a
 * native helper, the manager passes a stub sampler in tests; in
 * production the manager will wire one through `lspManager.ts`.
 *
 * Keeping the sampler abstract here lets unit tests assert the loop's
 * decision logic without touching real processes.
 */
export function attachLspProcessLimits(
  child: ChildProcess,
  config: LspProcessLimitsConfig,
  sampler: ResourceSampler,
): LspProcessLimits {
  const interval = config.sampleIntervalMs ?? SAMPLE_INTERVAL_MS
  const threshold = config.consecutiveOveragesToTerminate ?? CONSECUTIVE_OVERAGES_TO_TERMINATE
  let consecutiveOverages = 0
  let disposed = false

  const handle = setInterval(async () => {
    if (disposed || child.exitCode !== null || child.killed || !child.pid) return
    let observation: { rssBytes: number } | null
    try {
      observation = await sampler(child.pid)
    } catch {
      return // transient sampler failure — try again next tick
    }
    if (!observation) return

    if (observation.rssBytes > config.maxMemoryBytes) {
      consecutiveOverages += 1
      if (consecutiveOverages >= threshold) {
        config.onLimitExceeded?.({
          reason: 'memory',
          rssBytes: observation.rssBytes,
          observed: consecutiveOverages,
        })
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore — child may have died between observation and kill */
        }
      }
    } else {
      consecutiveOverages = 0
    }
  }, interval)

  // Allow Node.js to exit even if the interval is still active.
  if (typeof handle.unref === 'function') handle.unref()

  return {
    strategy: 'poll-fallback',
    dispose() {
      disposed = true
      clearInterval(handle)
    },
  }
}
