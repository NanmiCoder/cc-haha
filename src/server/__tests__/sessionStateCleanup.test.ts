import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Session-state cleanup completeness.
 *
 * `src/server/ws/handler.ts` keeps ~30 module-level containers of per-session state
 * and one `cleanupSessionRuntimeState` that is supposed to release them. Nothing kept
 * the two in sync: adding a container, or moving one while splitting the file, drops
 * it out of the cleanup path silently, and the result is state that survives session
 * deletion and leaks into the next session under the same id.
 *
 * Every module-level container must therefore be classified here. `cleared` entries
 * are checked against the real cleanup closure; anything else needs a reason that a
 * future reader can evaluate instead of re-deriving.
 */

/**
 * Sources that together own per-session state. `handler.ts` is being split, so the
 * cleanup closure now spans files: `clearAgentRuntimeState` and the six agent/task
 * containers live in `agentTaskState.ts` while `cleanupSessionRuntimeState` still
 * calls it from `handler.ts`. Add a file here when a further cut moves state out.
 */
const SOURCE_PATHS = [
  fileURLToPath(new URL('../ws/handler.ts', import.meta.url)),
  fileURLToPath(new URL('../ws/agentTaskState.ts', import.meta.url)),
]
const CLEANUP_ENTRY = 'cleanupSessionRuntimeState'

type Classification =
  /** Released by the cleanup closure. Verified against the source below. */
  | { kind: 'cleared' }
  /** Not per-session state at all. */
  | { kind: 'not-session-state'; reason: string }
  /** Per-session, but released by its own paired lifecycle rather than cleanup. */
  | { kind: 'self-managed'; reason: string }
  /** Per-session and deliberately outlives cleanup. Deleting it would be a bug. */
  | { kind: 'retained'; reason: string }

const CONTAINERS: Record<string, Classification> = {
  activeAgentTasks: { kind: 'cleared' },
  activeBackgroundTaskIds: { kind: 'cleared' },
  activeCliRuns: { kind: 'cleared' },
  activeNonAgentTasks: { kind: 'cleared' },
  activeUserTurns: { kind: 'cleared' },
  agentStopRequestedSessions: { kind: 'cleared' },
  authoritativeStoppedTaskIds: { kind: 'cleared' },
  deferredPermissionModes: { kind: 'cleared' },
  deferredRuntimeRestarts: { kind: 'cleared' },
  interruptedSessionChats: { kind: 'cleared' },
  lastResolvedStartupWorkDirs: { kind: 'cleared' },
  legacyQueuedSessionChats: { kind: 'cleared' },
  pendingInterruptedTurnResults: { kind: 'cleared' },
  prewarmIdleTimers: { kind: 'cleared' },
  prewarmPendingSessions: { kind: 'cleared' },
  prewarmedSessions: { kind: 'cleared' },
  runtimeExitStoppedSessions: { kind: 'cleared' },
  runtimeOverrides: { kind: 'cleared' },
  runtimeTransitionPromises: { kind: 'cleared' },
  sessionDisconnectWatchers: { kind: 'cleared' },
  sessionSlashCommands: { kind: 'cleared' },
  sessionStartupPromises: { kind: 'cleared' },
  sessionStopRequested: { kind: 'cleared' },
  sessionStreamStates: { kind: 'cleared' },
  sessionTitleState: { kind: 'cleared' },
  taskNotificationPersistence: { kind: 'cleared' },
  terminalSessionChatStates: { kind: 'cleared' },

  activeSessions: {
    kind: 'not-session-state',
    reason: 'The live socket registry itself; entries are removed when a socket closes.',
  },
  clientOutputCallbacks: {
    kind: 'not-session-state',
    reason: 'Keyed by socket, released with the socket rather than with the session.',
  },
  interruptedTurnResultMessages: {
    kind: 'not-session-state',
    reason: 'WeakMap keyed by the CLI message object, so entries die with the message.',
  },
  validPermissionModes: {
    kind: 'not-session-state',
    reason: 'Constant lookup set, never written at runtime, so it has no session lifetime.',
  },

  sessionCleanupTimers: {
    kind: 'self-managed',
    reason: 'Timer registry: every scheduling site clears its own entry when the timer fires or is cancelled.',
  },
  sessionClearInProgress: {
    kind: 'self-managed',
    reason: 'Re-entrancy guard added and removed around one awaited block.',
  },
  sessionStartupRuntimeVersions: {
    kind: 'self-managed',
    reason:
      'Paired with sessionStartupPromises in a finally. A stale entry can outlive a cleanup that races an in-flight startup, but it is unreachable: the only read is gated on sessionStartupPromises, which cleanup does release.',
  },

  runtimeOverrideVersions: {
    kind: 'retained',
    reason:
      'Monotonic staleness guard for runtime overrides. Deleting it on cleanup would reset the counter, so an in-flight result captured before a bump could compare equal against a fresh 0 and be applied as current.',
  },
  sessionTranscriptEpochs: {
    kind: 'retained',
    reason:
      'Monotonic staleness guard for transcript loads (handler.ts checks the epoch after an await). Same reset hazard as runtimeOverrideVersions: a load that snapshotted epoch 0 before a clear bumped it to 1 would compare equal again once the entry is gone, and apply a stale transcript.',
  },
}

const sources = SOURCE_PATHS.map((path) => readFileSync(path, 'utf8'))
const source = sources.join('\n')

function declaredContainers(): string[] {
  return sources
    .flatMap((text) => [
      ...text.matchAll(/^(?:export )?const ([a-zA-Z][a-zA-Z0-9]*) = new (?:Map|Set|WeakMap|WeakSet)\b/gm),
    ])
    .map((match) => match[1])
    .sort()
}

function functionBody(name: string): string | null {
  // Searched per file: concatenating first would let a slice run past the end of one
  // file into the next, silently widening the closure.
  for (const text of sources) {
    const start = text.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm'))
    if (start === -1) continue
    const end = text.indexOf('\n}', start)
    return end === -1 ? text.slice(start) : text.slice(start, end)
  }
  return null
}

/**
 * Containers released by `cleanupSessionRuntimeState`, following the helpers it calls
 * one level deep. Resolving callees by name keeps the closure accurate when cleanup
 * is refactored into differently named helpers.
 */
function clearedByCleanupClosure(): Set<string> {
  const entry = functionBody(CLEANUP_ENTRY)
  if (!entry) throw new Error(`${CLEANUP_ENTRY} not found in any registered source`)

  const bodies = [entry]
  for (const call of new Set([...entry.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((m) => m[1]))) {
    if (call === CLEANUP_ENTRY) continue
    const body = functionBody(call)
    if (body) bodies.push(body)
  }

  const cleared = new Set<string>()
  for (const body of bodies) {
    for (const match of body.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\.delete\(/g)) {
      cleared.add(match[1])
    }
  }
  return cleared
}

describe('handler session-state cleanup', () => {
  test('classifies every module-level container in handler.ts', () => {
    const declared = declaredContainers()
    const classified = Object.keys(CONTAINERS).sort()

    // A new container must be classified deliberately. If this fails after adding
    // one, decide whether cleanup should release it — do not just add it as
    // `retained` to make the test pass.
    expect(declared.filter((name) => !(name in CONTAINERS))).toEqual([])
    // A classification left behind after its container is gone is dead weight.
    expect(classified.filter((name) => !declared.includes(name))).toEqual([])
    expect(declared.length).toBeGreaterThan(30)
    // Guards the split itself: the agent/task containers must stay findable after
    // they moved out of handler.ts.
    expect(declared).toContain('activeAgentTasks')
  })

  test('releases every container classified as cleared', () => {
    const cleared = clearedByCleanupClosure()
    const expected = Object.entries(CONTAINERS)
      .filter(([, value]) => value.kind === 'cleared')
      .map(([name]) => name)
      .sort()

    expect(expected.length).toBeGreaterThan(20)
    const missing = expected.filter((name) => !cleared.has(name))
    expect(
      missing,
      `these containers are classified as cleared but ${CLEANUP_ENTRY} no longer releases them`,
    ).toEqual([])
  })

  test('does not release containers that must outlive a session cleanup', () => {
    const cleared = clearedByCleanupClosure()
    const retained = Object.entries(CONTAINERS)
      .filter(([, value]) => value.kind === 'retained')
      .map(([name]) => name)

    // Both retained containers are monotonic staleness counters. Releasing one turns
    // a stale async result into a fresh-looking one, which is a correctness bug and
    // not a leak fix.
    expect(retained.length).toBeGreaterThan(0)
    expect(retained.filter((name) => cleared.has(name))).toEqual([])
  })

  test('documents why anything outside the cleanup closure is safe', () => {
    for (const [name, value] of Object.entries(CONTAINERS)) {
      if (value.kind === 'cleared') continue
      expect(value.reason.length, `${name} needs a reason a reader can evaluate`).toBeGreaterThan(40)
    }
  })

  test('keeps the test-only reset aligned with the cleanup closure', () => {
    // `__resetWebSocketHandlerStateForTests` exists so suites do not leak state into
    // each other. If it drifts from the real cleanup, tests start passing against
    // state that production never actually clears.
    const reset = functionBody('__resetWebSocketHandlerStateForTests')
    expect(reset).not.toBeNull()
    const resetCleared = new Set(
      [...reset!.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*)\.clear\(\)/g)].map((match) => match[1]),
    )
    expect(resetCleared.size).toBeGreaterThan(5)
    // Every container the reset clears must be a real container, not a stale name.
    expect([...resetCleared].filter((name) => !(name in CONTAINERS))).toEqual([])
  })
})
