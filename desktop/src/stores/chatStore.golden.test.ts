import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useChatStore, type PerSessionState } from './chatStore'
import { chatStoreGoldenScenarios } from './chatStore.golden'

// Vitest transforms this module through Vite, so `import.meta.url` is not a file
// URL here. Both entry points that run this suite (`check:desktop` and
// `check:chat-contract`) execute with the desktop package as the working directory.
const GOLDEN_PATH = resolve(process.cwd(), 'src/stores/__fixtures__/chat-store.golden.json')
const UPDATE = process.env.UPDATE_CHAT_STORE_GOLDEN === '1'
/** The store batches text and tool-input deltas behind a 50ms timer. */
const DELTA_FLUSH_MS = 50
/**
 * Pinned wall clock. `nextId()` and `apiRetry.receivedAt` both read `Date.now()`,
 * and fake timers start from the real clock, so without this the recorded and
 * verified runs disagree on every timestamped field. Pinning removes the
 * non-determinism at the source instead of normalizing it away, which keeps a
 * change to how those fields are computed visible in the diff.
 */
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5)

type GoldenStep = { in: string; state: unknown }
type GoldenFile = Record<string, GoldenStep[]>

const initialState = useChatStore.getState()

function makeSession(): PerSessionState {
  return {
    messages: [],
    chatState: 'idle',
    connectionState: 'connected',
    historyStatus: 'idle',
    historyError: null,
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    apiRetry: null,
    slashCommands: [],
    agentTaskNotifications: {},
    backgroundAgentTasks: {},
    elapsedTimer: null,
  } as unknown as PerSessionState
}

/**
 * The rendered slice of session state. Deliberately broader than any single
 * scenario needs: a refactor that drops a field the UI reads should fail here even
 * if no example test happened to assert it.
 */
const OBSERVED_KEYS = [
  'messages',
  'chatState',
  'streamingText',
  'streamingToolInput',
  'activeToolUseId',
  'activeToolName',
  'pendingPermission',
  'pendingPermissions',
  'tokenUsage',
  'statusVerb',
  'apiRetry',
  'streamingFallback',
  'compactCount',
] as const

/**
 * Ids embed a process-wide counter and a wall clock, and every UIMessage carries a
 * timestamp. Both are normalized per scenario so the snapshot is stable — but
 * normalization is positional, so inserting, dropping, or reordering a message still
 * shifts the mapping and fails the comparison.
 */
function normalize(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (!/^msg-\d+-\d+$/.test(value)) return value
    if (!ids.has(value)) ids.set(value, `msg#${ids.size + 1}`)
    return ids.get(value)
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, ids))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === 'timestamp' ? 0 : normalize(entry, ids)
    }
    return out
  }
  return value
}

function observedState(sessionId: string, ids: Map<string, string>) {
  const session = useChatStore.getState().sessions[sessionId] as Record<string, unknown> | undefined
  if (!session) return null
  const slice: Record<string, unknown> = {}
  for (const key of OBSERVED_KEYS) {
    if (session[key] !== undefined) slice[key] = session[key]
  }
  return normalize(slice, ids)
}

function replay(scenario: (typeof chatStoreGoldenScenarios)[number], salt: string): GoldenStep[] {
  const sessionId = `golden-${scenario.id}-${salt}`
  // Each scenario re-pins the clock rather than relying on beforeEach. Advancing the
  // delta timer moves the fake clock forward, so scenarios grouped into one test
  // would otherwise start at a different time than scenarios run one per test —
  // which is exactly how the recorded and verified runs first drifted apart.
  vi.setSystemTime(FIXED_NOW)
  useChatStore.setState({ ...initialState, sessions: { [sessionId]: makeSession() } })
  const ids = new Map<string, string>()

  return scenario.messages.map((message) => {
    useChatStore.getState().handleServerMessage(sessionId, message)
    // Flush the delta batching timer so the snapshot reflects settled state rather
    // than whatever happened to have been written before the timer fired.
    vi.advanceTimersByTime(DELTA_FLUSH_MS + 1)
    return { in: message.type, state: observedState(sessionId, ids) }
  })
}

function loadGolden(): GoldenFile {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `Missing golden file ${GOLDEN_PATH}. Regenerate with UPDATE_CHAT_STORE_GOLDEN=1 and review the diff before committing.`,
    )
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile
}

describe('chatStore golden session state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    useChatStore.setState({ ...initialState, sessions: {} })
  })

  if (UPDATE) {
    it('regenerates the golden file', () => {
      const regenerated: GoldenFile = {}
      for (const scenario of chatStoreGoldenScenarios) {
        regenerated[scenario.id] = replay(scenario, 'record')
      }
      writeFileSync(GOLDEN_PATH, JSON.stringify(regenerated, null, 2) + '\n')
      expect(Object.keys(regenerated)).toHaveLength(chatStoreGoldenScenarios.length)
    })
    return
  }

  const golden = loadGolden()

  /**
   * Indexing the golden file can miss — a hand-edited or partially regenerated file
   * is exactly when these tests matter most. Fail with the scenario name instead of
   * letting an undefined slip into `.at(-1)` and surface as a TypeError.
   */
  function stepsFor(id: string): GoldenStep[] {
    const steps = golden[id]
    if (!steps) {
      throw new Error(`Golden file has no entry for "${id}". Regenerate with UPDATE_CHAT_STORE_GOLDEN=1.`)
    }
    return steps
  }

  it('records every scenario and nothing else', () => {
    expect(Object.keys(golden).sort()).toEqual(chatStoreGoldenScenarios.map((s) => s.id).sort())
  })

  it('is not vacuous: every scenario ends with rendered messages unless it declares otherwise', () => {
    // Guards against a change that made the store drop everything regenerating into
    // an all-empty golden that then passes forever.
    for (const scenario of chatStoreGoldenScenarios) {
      const last = stepsFor(scenario.id).at(-1)?.state as { messages?: unknown[] } | null
      if (scenario.expectsNoRenderedMessages) {
        // Pure state transitions render nothing; pinning that is the point, so a
        // change that started emitting transcript entries here would fail.
        expect(last?.messages?.length, `${scenario.id} now renders transcript messages`).toBe(0)
        continue
      }
      expect(last?.messages?.length, `${scenario.id} rendered no messages`).toBeGreaterThan(0)
    }
  })

  for (const scenario of chatStoreGoldenScenarios) {
    it(`${scenario.id}: ${scenario.description}`, () => {
      expect(replay(scenario, 'verify')).toEqual(stepsFor(scenario.id))
    })
  }

  it('is independent of session id and replay order', () => {
    // The store keeps module-level maps keyed by session id plus a process-wide
    // message counter. If any of that leaked across sessions, replaying in reverse
    // under different ids would drift from the recorded run.
    for (const scenario of [...chatStoreGoldenScenarios].reverse()) {
      expect(replay(scenario, 'reordered'), `${scenario.id} depends on global state or order`)
        .toEqual(stepsFor(scenario.id))
    }
  })
})
