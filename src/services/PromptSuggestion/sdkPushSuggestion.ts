import { randomUUID, type UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { toError } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  logSuggestionSuppressed,
  type PromptVariant,
  tryGenerateSuggestion,
} from './promptSuggestion.js'

/**
 * Push-model prompt suggestions for SDK consumers (`--print` stream-json):
 * the CLI emits a `prompt_suggestion` after each user-started turn while the
 * consumer has turned them on with `set_prompt_suggestions`.
 */

export type SdkPromptSuggestionMessage = {
  type: 'prompt_suggestion'
  suggestion: string
  uuid: UUID
  session_id: string
}

export type SdkSuggestionState = {
  abortController: AbortController | null
  inflightPromise: Promise<void> | null
  lastEmitted: {
    text: string
    emittedAt: number
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
  pendingSuggestion: SdkPromptSuggestionMessage | null
  pendingLastEmittedEntry: {
    text: string
    promptId: PromptVariant
    generationRequestId: string | null
  } | null
  /** A user turn's prediction waits until its background agents settle. */
  deferredUntilAgentsSettle: boolean
}

export function createSdkSuggestionState(): SdkSuggestionState {
  return {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
    deferredUntilAgentsSettle: false,
  }
}

/**
 * `set_prompt_suggestions`: unlike the initialize option it can arrive at any
 * time. Turning suggestions off drops in-flight, pending and owed ones.
 */
export function setSdkPromptSuggestions(
  state: SdkSuggestionState,
  enabled: boolean,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev =>
    prev.promptSuggestionEnabled === enabled
      ? prev
      : { ...prev, promptSuggestionEnabled: enabled },
  )
  if (enabled) return
  state.abortController?.abort()
  state.abortController = null
  state.pendingSuggestion = null
  state.pendingLastEmittedEntry = null
  state.lastEmitted = null
  state.deferredUntilAgentsSettle = false
}

/**
 * Decides, after a turn, whether to predict now. Only turns the user started
 * get one: task notifications, scheduled tasks, teammate mail and host
 * notices would spend a fork request on a prediction nobody is waiting for.
 * Returns the fork context to generate from, or null.
 */
export function takeSdkSuggestionContext(
  state: SdkSuggestionState,
  turn: {
    enabled: boolean
    userStartedTurn: boolean
    /** The turn's result is held back while background agents run. */
    resultHeld: boolean
    cacheSafeParams: CacheSafeParams | null
    /** Fork context saved before the turn ran. */
    cacheSafeParamsAtTurnStart: CacheSafeParams | null
  },
): CacheSafeParams | null {
  if (!turn.enabled) return null
  if (!turn.userStartedTurn && !state.deferredUntilAgentsSettle) return null
  if (turn.resultHeld) {
    // The follow-up turn that reports the agents would discard a suggestion
    // made now. Predict once the whole exchange has settled instead.
    state.deferredUntilAgentsSettle = true
    return null
  }
  state.deferredUntilAgentsSettle = false
  if (
    turn.cacheSafeParams &&
    turn.cacheSafeParams !== turn.cacheSafeParamsAtTurnStart
  ) {
    return turn.cacheSafeParams
  }
  // Stop hooks save a fresh fork context only when a turn finishes normally:
  // after an interrupt or a local slash command the saved context still
  // belongs to the previous turn, so a prediction from it would be stale.
  logSuggestionSuppressed(
    turn.cacheSafeParams ? 'stale_context' : 'sdk_no_params',
    undefined,
    undefined,
    'sdk',
  )
  return null
}

/**
 * The held result went out without a follow-up turn (the agents settled
 * quietly): returns the context for the prediction the user turn is owed.
 */
export function takeOwedSdkSuggestionContext(
  state: SdkSuggestionState,
  enabled: boolean,
  cacheSafeParams: CacheSafeParams | null,
): CacheSafeParams | null {
  const owed = state.deferredUntilAgentsSettle
  state.deferredUntilAgentsSettle = false
  return owed && enabled ? cacheSafeParams : null
}

export function startSdkPushSuggestion(
  state: SdkSuggestionState,
  deps: {
    cacheSafeParams: CacheSafeParams
    messages: Message[]
    getAppState: () => AppState
    /** The turn's result is still held back for background agents. */
    isResultHeld: () => boolean
    emit: (message: SdkPromptSuggestionMessage) => void
    /** A generation owns work until its promise settles, even after abort. */
    onActivity?: (generationId: string, active: boolean) => void
    generate?: typeof tryGenerateSuggestion
  },
): void {
  state.abortController?.abort()
  const localAbort = new AbortController()
  state.abortController = localAbort
  const generate = deps.generate ?? tryGenerateSuggestion
  const generationId = randomUUID()
  deps.onActivity?.(generationId, true)
  // Use a ref object so the IIFE's finally can compare against its own
  // promise without a self-reference (which upsets TypeScript's flow analysis).
  const ref: { promise: Promise<void> | null } = { promise: null }
  ref.promise = (async () => {
    try {
      const result = await generate(
        localAbort,
        deps.messages,
        deps.getAppState,
        deps.cacheSafeParams,
        'sdk',
      )
      if (!result || localAbort.signal.aborted) return
      const suggestionMsg: SdkPromptSuggestionMessage = {
        type: 'prompt_suggestion',
        suggestion: result.suggestion,
        uuid: randomUUID(),
        session_id: getSessionId(),
      }
      // Defer emission if the result is being held for background agents,
      // so that prompt_suggestion always arrives after result. Only set
      // lastEmitted when the suggestion is actually delivered to the
      // consumer; deferred suggestions may be discarded before delivery if a
      // new command arrives first.
      if (deps.isResultHeld()) {
        state.pendingSuggestion = suggestionMsg
        state.pendingLastEmittedEntry = {
          text: result.suggestion,
          promptId: result.promptId,
          generationRequestId: result.generationRequestId,
        }
      } else {
        state.lastEmitted = {
          text: result.suggestion,
          emittedAt: Date.now(),
          promptId: result.promptId,
          generationRequestId: result.generationRequestId,
        }
        deps.emit(suggestionMsg)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'APIUserAbortError')
      ) {
        logSuggestionSuppressed('aborted', undefined, undefined, 'sdk')
        return
      }
      logError(toError(error))
    } finally {
      if (state.inflightPromise === ref.promise) {
        state.inflightPromise = null
      }
      deps.onActivity?.(generationId, false)
    }
  })()
  state.inflightPromise = ref.promise
}
