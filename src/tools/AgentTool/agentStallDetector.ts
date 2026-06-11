/**
 * Stall detector for subagent yield loops.
 *
 * Workers in coordinator mode push results back through `<task-notification>`
 * once they finish. If a worker takes a long time mid-step (long thinking
 * block, slow tool, network hiccup) the coordinator has no signal — the
 * panel just shows the same description and an incrementing elapsed
 * counter. The user can't tell "still working" from "wedged."
 *
 * This module is a pure detector: callers tell it "I yielded" via notify()
 * and ask "is it stalled?" via check(now). When notify() lands during a
 * stall, check() reports a transition (resumed=true once) so the caller
 * can update UI back. No timers — the caller drives the cadence (a
 * setInterval in runAgent, or React's tick in tests).
 *
 * Design note: kept side-effect-free so tests can drive `now` directly
 * via Date.now mocks. Real wall-clock callers pass `Date.now()` to check().
 */

export type StallDetectorOptions = {
  /**
   * Idle window before a worker is reported as stalled. Default 90s,
   * tuned to be longer than typical tool calls (search/edit are sub-30s)
   * but short enough to surface a real wedge before the user gets
   * frustrated.
   */
  thresholdMs?: number
  /**
   * Initial baseline for the "last activity" timestamp. Defaults to
   * Date.now() when the detector is created. Tests pass an explicit
   * value so they don't depend on real time.
   */
  startedAt?: number
}

export type StallStatus =
  | { kind: 'idle'; idleMs: number; isStalled: false; transitioned: false }
  | { kind: 'stalled'; idleMs: number; isStalled: true; transitioned: boolean }
  | { kind: 'resumed'; idleMs: number; isStalled: false; transitioned: true }

export type StallDetector = {
  /**
   * Record a yield / progress event. Resets the idle window. If the
   * detector was previously stalled, the next check() call will return a
   * `resumed` transition.
   */
  notify(now: number): void
  /**
   * Probe the current state at wall-clock `now`. Returns:
   *   - idle: never been stalled
   *   - stalled: idle window crossed; transitioned=true on the FIRST
   *     check that observes the stall (so callers fire onStalled exactly
   *     once per stall cycle)
   *   - resumed: was stalled, then notify() reset the timer; transitioned
   *     fires once
   */
  check(now: number): StallStatus
  /**
   * True if the detector currently considers the worker stalled.
   * Convenience for tests / callers that just want a boolean.
   */
  isStalled(): boolean
}

const DEFAULT_THRESHOLD_MS = 90_000

/**
 * Create a fresh stall detector. The detector is single-flight: it tracks
 * one worker's idle window. Spawn a separate detector per worker.
 */
export function createStallDetector(
  opts: StallDetectorOptions = {},
): StallDetector {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new Error(
      `createStallDetector: thresholdMs must be a positive number, got ${thresholdMs}`,
    )
  }
  let lastActivityAt = opts.startedAt ?? Date.now()
  let stalled = false
  // True from the moment the stall is first observed by check() until the
  // caller has been told about that stall transition. Mirrors the
  // "transitioned" flag returned exactly once.
  let stalledTransitionPending = false
  // True from notify() lands during a stall, until the caller has been
  // told about the resumed transition.
  let resumedTransitionPending = false

  return {
    notify(now: number): void {
      lastActivityAt = now
      if (stalled) {
        stalled = false
        stalledTransitionPending = false
        resumedTransitionPending = true
      }
    },
    check(now: number): StallStatus {
      const idleMs = Math.max(0, now - lastActivityAt)
      if (resumedTransitionPending) {
        resumedTransitionPending = false
        return {
          kind: 'resumed',
          idleMs,
          isStalled: false,
          transitioned: true,
        }
      }
      if (!stalled && idleMs >= thresholdMs) {
        stalled = true
        stalledTransitionPending = true
      }
      if (stalled) {
        const transitioned = stalledTransitionPending
        stalledTransitionPending = false
        return {
          kind: 'stalled',
          idleMs,
          isStalled: true,
          transitioned,
        }
      }
      return {
        kind: 'idle',
        idleMs,
        isStalled: false,
        transitioned: false,
      }
    },
    isStalled(): boolean {
      return stalled
    },
  }
}

/**
 * Format a stalled progress summary suitable for assignment to
 * AgentProgress.summary. Truncates the underlying description so the
 * combined string fits comfortably in a single panel line. The caller is
 * responsible for clearing this back to the original summary when the
 * detector reports `resumed`.
 */
export function formatStalledSummary(
  idleMs: number,
  underlyingSummary: string | undefined,
  underlyingDescription: string,
): string {
  const idleSec = Math.floor(idleMs / 1000)
  const base = (underlyingSummary || underlyingDescription).trim()
  // Mark with a short, stable prefix the user can scan for. The numeric
  // bucket is rounded down to 5s steps so quick re-renders don't flicker
  // the second digit on every tick.
  const bucketSec = Math.max(0, Math.floor(idleSec / 5) * 5)
  return `(stalled ${bucketSec}s) ${base}`
}
