import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  createSdkSuggestionState,
  type SdkPromptSuggestionMessage,
  setSdkPromptSuggestions,
  startSdkPushSuggestion,
  takeOwedSdkSuggestionContext,
  takeSdkSuggestionContext,
} from './sdkPushSuggestion.js'

const params = (label: string) => ({ label }) as unknown as CacheSafeParams

function turn(overrides: Partial<Parameters<typeof takeSdkSuggestionContext>[1]> = {}) {
  const before = params('before')
  return {
    enabled: true,
    userStartedTurn: true,
    resultHeld: false,
    cacheSafeParams: params('after'),
    cacheSafeParamsAtTurnStart: before,
    ...overrides,
  }
}

describe('takeSdkSuggestionContext', () => {
  test('predicts after a finished user turn from the context it saved', () => {
    const state = createSdkSuggestionState()
    const fresh = params('fresh')
    expect(takeSdkSuggestionContext(state, turn({ cacheSafeParams: fresh }))).toBe(fresh)
  })

  test('skips when disabled or when the user did not start the turn', () => {
    const state = createSdkSuggestionState()
    expect(takeSdkSuggestionContext(state, turn({ enabled: false }))).toBeNull()
    expect(takeSdkSuggestionContext(state, turn({ userStartedTurn: false }))).toBeNull()
    expect(state.deferredUntilAgentsSettle).toBe(false)
  })

  test('skips interrupted turns and local commands that left the previous context in place', () => {
    const state = createSdkSuggestionState()
    const previous = params('previous')
    expect(takeSdkSuggestionContext(state, turn({ cacheSafeParams: previous, cacheSafeParamsAtTurnStart: previous }))).toBeNull()
    expect(takeSdkSuggestionContext(state, turn({ cacheSafeParams: null, cacheSafeParamsAtTurnStart: null }))).toBeNull()
  })

  test('defers a user turn held for background agents to the follow-up turn', () => {
    const state = createSdkSuggestionState()
    expect(takeSdkSuggestionContext(state, turn({ resultHeld: true }))).toBeNull()
    expect(state.deferredUntilAgentsSettle).toBe(true)

    // Still held after a follow-up: keep waiting.
    expect(takeSdkSuggestionContext(state, turn({ userStartedTurn: false, resultHeld: true }))).toBeNull()
    expect(state.deferredUntilAgentsSettle).toBe(true)

    // The follow-up is not user-started, but it settles the owed prediction.
    const settled = params('settled')
    expect(takeSdkSuggestionContext(state, turn({ userStartedTurn: false, cacheSafeParams: settled }))).toBe(settled)
    expect(state.deferredUntilAgentsSettle).toBe(false)
  })
})

describe('takeOwedSdkSuggestionContext', () => {
  test('returns the context only for an owed prediction while enabled, and clears it', () => {
    const state = createSdkSuggestionState()
    const context = params('owed')
    expect(takeOwedSdkSuggestionContext(state, true, context)).toBeNull()

    state.deferredUntilAgentsSettle = true
    expect(takeOwedSdkSuggestionContext(state, true, context)).toBe(context)
    expect(state.deferredUntilAgentsSettle).toBe(false)

    state.deferredUntilAgentsSettle = true
    expect(takeOwedSdkSuggestionContext(state, false, context)).toBeNull()
    expect(state.deferredUntilAgentsSettle).toBe(false)
  })
})

describe('setSdkPromptSuggestions', () => {
  test('toggles the app-state flag and drops in-flight, pending and owed suggestions when turned off', () => {
    let appState = { promptSuggestionEnabled: false } as AppState
    const setAppState = (update: (prev: AppState) => AppState) => { appState = update(appState) }
    const state = createSdkSuggestionState()

    setSdkPromptSuggestions(state, true, setAppState)
    expect(appState.promptSuggestionEnabled).toBe(true)
    const unchanged = appState
    setSdkPromptSuggestions(state, true, setAppState)
    expect(appState).toBe(unchanged)

    const inflight = new AbortController()
    Object.assign(state, {
      abortController: inflight,
      pendingSuggestion: { type: 'prompt_suggestion', suggestion: 'x', uuid: crypto.randomUUID(), session_id: 's' },
      pendingLastEmittedEntry: { text: 'x', promptId: 'user_intent', generationRequestId: null },
      lastEmitted: { text: 'x', emittedAt: 1, promptId: 'user_intent', generationRequestId: null },
      deferredUntilAgentsSettle: true,
    })
    setSdkPromptSuggestions(state, false, setAppState)
    expect(appState.promptSuggestionEnabled).toBe(false)
    expect(inflight.signal.aborted).toBe(true)
    expect(state).toEqual(createSdkSuggestionState())
  })
})

describe('startSdkPushSuggestion', () => {
  test('owns each generation before starting and until its real settlement, including superseded work', async () => {
    const state = createSdkSuggestionState()
    const activity: Array<{ generation: string; active: boolean }> = []
    const releases: Array<() => void> = []
    const start = () => {
      const deps = {
        cacheSafeParams: params('turn'), messages: [], getAppState: () => ({}) as AppState,
        isResultHeld: () => false, emit: () => {},
        onActivity: (generation: string, active: boolean) => activity.push({ generation, active }),
        generate: async () => {
          expect(activity.at(-1)?.active).toBe(true)
          await new Promise<void>(resolve => releases.push(resolve))
          return null
        },
      }
      startSdkPushSuggestion(state, deps)
      return state.inflightPromise!
    }
    const first = start()
    const second = start()
    try {
      expect(activity).toHaveLength(2)
      expect(activity[0]!.generation).not.toBe(activity[1]!.generation)
      setSdkPromptSuggestions(state, false, () => {})
      expect(activity.every(event => event.active)).toBe(true)
      releases[0]!()
      await first
      expect(activity[2]).toEqual({ ...activity[0]!, active: false })
      expect(state.inflightPromise).toBe(second)
      releases[1]!()
      await second
      expect(activity[3]).toEqual({ ...activity[1]!, active: false })
      expect(state.inflightPromise).toBeNull()
    } finally {
      for (const release of releases) release()
      await Promise.all([first, second])
    }
  })

  const generated = (suggestion: string) => async () => ({
    suggestion,
    promptId: 'user_intent' as const,
    generationRequestId: 'req_1',
  })

  function start(
    state: ReturnType<typeof createSdkSuggestionState>,
    generate: Parameters<typeof startSdkPushSuggestion>[1]['generate'],
    held = false,
  ) {
    const emitted: SdkPromptSuggestionMessage[] = []
    startSdkPushSuggestion(state, {
      cacheSafeParams: params('turn'),
      messages: [],
      getAppState: () => ({}) as AppState,
      isResultHeld: () => held,
      emit: message => emitted.push(message),
      generate,
    })
    return emitted
  }

  test('emits the suggestion and records it for acceptance tracking', async () => {
    const state = createSdkSuggestionState()
    const emitted = start(state, generated('运行测试'))
    expect(state.inflightPromise).not.toBeNull()
    await state.inflightPromise
    expect(emitted).toEqual([expect.objectContaining({ type: 'prompt_suggestion', suggestion: '运行测试' })])
    expect(state.lastEmitted).toMatchObject({ text: '运行测试', promptId: 'user_intent', generationRequestId: 'req_1' })
    expect(state.inflightPromise).toBeNull()
  })

  test('keeps the suggestion pending while the result is held', async () => {
    const state = createSdkSuggestionState()
    const emitted = start(state, generated('提交'), true)
    await state.inflightPromise
    expect(emitted).toEqual([])
    expect(state.pendingSuggestion?.suggestion).toBe('提交')
    expect(state.pendingLastEmittedEntry).toEqual({ text: '提交', promptId: 'user_intent', generationRequestId: 'req_1' })
    expect(state.lastEmitted).toBeNull()
  })

  test('emits nothing when suppressed, superseded or failed', async () => {
    const state = createSdkSuggestionState()
    const suppressed = start(state, async () => null)
    await state.inflightPromise
    expect(suppressed).toEqual([])

    // A newer start aborts the older generation before it can emit.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const older = start(state, async () => {
      await gate
      return { suggestion: 'old', promptId: 'user_intent', generationRequestId: null }
    })
    const olderPromise = state.inflightPromise
    const newer = start(state, generated('new'))
    release()
    await olderPromise
    await state.inflightPromise
    expect(older).toEqual([])
    expect(newer.map(message => message.suggestion)).toEqual(['new'])

    const aborted = start(state, async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    await state.inflightPromise
    expect(aborted).toEqual([])

    const failed = start(state, async () => {
      throw new Error('upstream down')
    })
    await state.inflightPromise
    expect(failed).toEqual([])
    expect(state.inflightPromise).toBeNull()
  })
})
