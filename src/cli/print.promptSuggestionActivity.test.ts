import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import type { CacheSafeParams } from '../utils/forkedAgent.js'
import { SDKPromptSuggestionActivityMessageSchema } from '../entrypoints/sdk/coreSchemas.js'
import { createSdkSuggestionState, setSdkPromptSuggestions, startSdkPushSuggestion } from '../services/PromptSuggestion/sdkPushSuggestion.js'
import { createPromptSuggestionActivityEmitter } from './print.js'
import { StructuredIO } from './structuredIO.js'

async function* emptyInput(): AsyncGenerator<string> {}

test('SDK stream publishes ownership before model work and a distinct terminal event only after cancellation settles', async () => {
  const io = new StructuredIO(emptyInput())
  const publish = createPromptSuggestionActivityEmitter(io)
  const state = createSdkSuggestionState()
  let release!: () => void
  const model = new Promise<void>(resolve => { release = resolve })
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let first: unknown
  let signal: AbortSignal | undefined
  startSdkPushSuggestion(state, {
    cacheSafeParams: {} as CacheSafeParams, messages: [], getAppState: () => ({}) as AppState,
    isResultHeld: () => false, emit: () => {}, onActivity: publish,
    generate: async controller => {
      signal = controller.signal
      first = (await io.outbound.next()).value
      markStarted()
      await model
      return null
    },
  })
  const inFlight = state.inflightPromise!
  try {
    await started
    const begin = SDKPromptSuggestionActivityMessageSchema().parse(JSON.parse(JSON.stringify(first)))
    expect(begin.active).toBe(true)
    expect(begin.generation_id.length).toBeGreaterThan(0)
    const terminal = io.outbound.next()
    let delivered = false
    void terminal.then(() => { delivered = true })
    setSdkPromptSuggestions(state, false, () => {})
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(delivered).toBe(false)
    release()
    await inFlight
    const end = SDKPromptSuggestionActivityMessageSchema().parse(JSON.parse(JSON.stringify((await terminal).value)))
    expect(end.active).toBe(false)
    expect(end.generation_id).toBe(begin.generation_id)
    expect(end.session_id).toBe(begin.session_id)
    // Reusing the start UUID would make server replay dedup drop the release.
    expect(end.uuid).not.toBe(begin.uuid)
    expect(state.inflightPromise).toBeNull()
  } finally {
    release()
    await inFlight
    io.outbound.done()
  }
})
