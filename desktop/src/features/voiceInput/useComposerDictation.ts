import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ApiError } from '@/api/client'
import { voiceApi, type VoiceCorrectionChange } from '@/api/voice'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { useVoiceVocabularyStore, vocabularyKey } from '@/stores/voiceVocabularyStore'
import type { MentionComposerHandle } from '@/components/chat/MentionComposer'
import { correctedResult, revertCorrectionChange, type CorrectionOutcome } from './correctionChanges'
import { getPreferredMicrophoneId } from './devicePreference'
import { registerDictationTarget } from './shortcutController'
import {
  normalizeDictationText,
  placeDictationResult,
  withDictationSpacing,
  type InsertionPoint,
} from './insertion'
import {
  startRecording,
  VoiceRecorderError,
  type ActiveRecording,
  type VoiceRecorderErrorCode,
} from './recorder'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'correcting'

/** Doubles as the suffix of the `voice.composer.error.*` translation keys. */
export type DictationIssue =
  | 'permission'
  | 'noDevice'
  | 'deviceBusy'
  | 'unavailable'
  | 'interrupted'
  | 'notReady'
  | 'invalidAudio'
  | 'unknownProvider'
  | 'failed'
  | 'noSpeech'
  | 'tooShort'

/** How AI correction ended for text that was just written into the draft. */
export type CorrectionFallback = 'timeout' | 'failed' | 'auth' | 'unavailable'

export type CorrectionNoticeKind =
  /** The corrected text went in; `changes` can be reverted one by one. */
  | 'changes'
  /** The recognized text went in because correction did not finish. */
  | CorrectionFallback
  /** "Correct again" is running. */
  | 'retrying'
  /** "Correct again" came back with nothing to change. */
  | 'unchanged'

export type CorrectionNotice = {
  /** New for every notice, so its auto-hide restarts; kept while its changes are reverted. */
  id: number
  kind: CorrectionNoticeKind
  /** Offsets index the dictated text as it stands in the draft now. */
  changes: VoiceCorrectionChange[]
  model: string | null
  seconds: number | null
}

/** How long a dictation waits for AI correction before writing what was heard. */
export const CORRECTION_BUDGET_MS = 3_000
/** "Correct again" is an explicit wait, so it gets the server's full allowance. */
export const CORRECTION_RETRY_BUDGET_MS = 10_000

type Run = {
  controller: AbortController
  recording: ActiveRecording | null
  revisionAtStart: number
  point: InsertionPoint
  stopping: boolean
  /** Send the draft once the text is written. Can be asked for until recognition ends. */
  send: boolean
  /** Asked to stop while the microphone was still opening (a short hold). */
  stopWhenReady: boolean
  /** Set while AI correction runs on `heard`. */
  correction: AbortController | null
  heard: string
}

/** What one dictation produced, ready to write. */
type DictationResult = CorrectionOutcome & {
  /** Why it went in uncorrected, when correction was asked for. */
  fallback?: CorrectionFallback
}

/** The dictated text as it sits in the draft, for reverting or re-correcting it in place. */
type WrittenSpan = {
  start: number
  text: string
  heard: string
}

type ComposerDictationOptions = {
  composerRef: RefObject<MentionComposerHandle | null>
  /** The composer's current projected text; every distinct value is one revision. */
  draft: string
  /** The composer cannot take text right now (disabled, or a message is being sent). */
  blocked: boolean
  /** Identifies what the composer is editing; a change abandons any dictation. */
  contextKey: string | null | undefined
  /**
   * Sends the draft through the composer's own submit path. Called after the
   * render that carries the dictated text, so it reads the draft with it.
   */
  onSubmit?: () => void
}

/** Recordings shorter than this are a mis-tap, not speech. */
const MIN_SECONDS = 0.4
const ISSUE_TIMEOUT_MS = 8_000

function issueFromRecorder(code: VoiceRecorderErrorCode): DictationIssue {
  switch (code) {
    case 'permission': return 'permission'
    case 'no-device': return 'noDevice'
    case 'device-busy': return 'deviceBusy'
    case 'unavailable': return 'unavailable'
    case 'interrupted': return 'interrupted'
    default: return 'failed'
  }
}

function errorBody(error: unknown): { error?: unknown; reason?: unknown } {
  return error instanceof ApiError && typeof error.body === 'object' && error.body !== null
    ? error.body as { error?: unknown; reason?: unknown }
    : {}
}

function issueFromError(error: unknown): DictationIssue {
  if (error instanceof VoiceRecorderError) return issueFromRecorder(error.code)
  if (error instanceof ApiError) {
    const code = errorBody(error).error
    if (code === 'voice/not-ready') return 'notReady'
    if (code === 'voice/invalid-audio') return 'invalidAudio'
    if (code === 'voice/unknown-provider') return 'unknownProvider'
    if (code === 'voice/failed') return 'failed'
    if (error.status === 409) return 'notReady'
    if (error.status === 400) return 'invalidAudio'
    if (error.status === 404) return 'unknownProvider'
  }
  return 'failed'
}

/** A correction that did not come back still leaves the user with what they said. */
function fallbackFromError(error: unknown): CorrectionFallback {
  const { error: code, reason } = errorBody(error)
  if (code === 'voice/correction-unavailable') return 'unavailable'
  if (reason === 'auth') return 'auth'
  if (reason === 'timeout') return 'timeout'
  return 'failed'
}

/**
 * Dictation for a ProseMirror composer: record, transcribe, optionally let AI
 * correction fix misheard terms, and write the text into the draft without
 * ever overwriting what the user did meanwhile.
 *
 * Shared by both composers (ChatInput and EmptySession) so the write-back rules
 * cannot drift between them.
 */
export function useComposerDictation({ composerRef, draft, blocked, contextKey, onSubmit }: ComposerDictationOptions) {
  const providerId = useVoiceInputStore(state => state.catalog?.preferences.providerId)
  const language = useVoiceInputStore(state => state.catalog?.preferences.language)
  const maxSeconds = useVoiceInputStore(state => state.catalog?.limits.maxAudioSeconds)
  const correctionEnabled = useVoiceInputStore(state => state.catalog?.preferences.correctionEnabled ?? false)

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [issue, setIssue] = useState<DictationIssue | null>(null)
  const [pendingText, setPendingText] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [limitSeconds, setLimitSeconds] = useState(0)
  const [sendRequested, setSendRequested] = useState(false)
  const [correctingText, setCorrectingText] = useState<string | null>(null)
  const [correctionNotice, setCorrectionNoticeState] = useState<CorrectionNotice | null>(null)

  const activeRef = useRef<Run | null>(null)
  const draftRef = useRef(draft)
  const revisionRef = useRef(0)
  const blockedRef = useRef(blocked)
  const settingsRef = useRef({ providerId, language, maxSeconds, correctionEnabled })
  const composingRef = useRef(false)
  const pendingRef = useRef<string | null>(null)
  const previousContextRef = useRef(contextKey)
  const onSubmitRef = useRef(onSubmit)
  /** Dictated text was written for a send; submit once the draft carries it. */
  const submitAfterWriteRef = useRef(false)
  /** The next draft change is our own write, not the user editing. */
  const ownWriteRef = useRef(false)
  const spanRef = useRef<WrittenSpan | null>(null)
  const noticeRef = useRef<CorrectionNotice | null>(null)
  const noticeSeqRef = useRef(0)
  const retryRef = useRef<AbortController | null>(null)

  blockedRef.current = blocked
  settingsRef.current = { providerId, language, maxSeconds, correctionEnabled }
  onSubmitRef.current = onSubmit

  const setNotice = useCallback((notice: CorrectionNotice | null) => {
    noticeRef.current = notice
    setCorrectionNoticeState(notice)
  }, [])

  const clearNotice = useCallback(() => {
    retryRef.current?.abort()
    retryRef.current = null
    spanRef.current = null
    setNotice(null)
  }, [setNotice])

  /** A new notice about the span just written; restarts the auto-hide. */
  const showNotice = useCallback((notice: Omit<CorrectionNotice, 'id'>) => {
    noticeSeqRef.current += 1
    setNotice({ ...notice, id: noticeSeqRef.current })
  }, [setNotice])

  useEffect(() => {
    if (draftRef.current !== draft) {
      draftRef.current = draft
      revisionRef.current += 1
      // The user edited the draft: the dictated span may have moved or
      // changed, so there is nothing left the notice could safely revert.
      if (ownWriteRef.current) ownWriteRef.current = false
      else if (spanRef.current) clearNotice()
    }
    // Submitting from `deliver` itself would send the draft as the parent last
    // rendered it — without the text that was just written.
    if (!submitAfterWriteRef.current) return
    submitAfterWriteRef.current = false
    onSubmitRef.current?.()
  }, [clearNotice, draft])

  const setPending = useCallback((text: string | null) => {
    pendingRef.current = text
    setPendingText(text)
  }, [])

  const capturePoint = useCallback((): InsertionPoint => {
    const composer = composerRef.current
    if (composer?.hasFocus()) {
      const { start, end } = composer.getSelectionOffsets()
      return { start, end }
    }
    const length = draftRef.current.length
    return { start: length, end: length }
  }, [composerRef])

  /** Writes at `start..end` of the draft through the editor, as one undo step. */
  const replaceRange = useCallback((start: number, end: number, text: string, flash: boolean): boolean => {
    const composer = composerRef.current
    if (!composer || !text) return false
    const current = draftRef.current
    if (`${current.slice(0, start)}${text}${current.slice(end)}` !== current) ownWriteRef.current = true
    composer.insertTextAtOffsets(start, end, text, { flash })
    return true
  }, [composerRef])

  /** Writes dictated text at `point`; returns where the text (after any spacing) starts. */
  const writeText = useCallback((text: string, point: InsertionPoint): number | null => {
    const current = draftRef.current
    const start = Math.min(point.start, current.length)
    const end = Math.min(Math.max(point.end, start), current.length)
    const spaced = withDictationSpacing(current.slice(0, start), text, current.slice(end))
    if (!replaceRange(start, end, spaced, true)) return null
    return start + spaced.indexOf(text)
  }, [replaceRange])

  /**
   * Rewrites the dictated span in place, only while it is still exactly what
   * we last wrote there; otherwise the notice has nothing safe to act on.
   */
  const rewriteSpan = useCallback((next: string): boolean => {
    const span = spanRef.current
    if (!span || blockedRef.current) return false
    if (draftRef.current.slice(span.start, span.start + span.text.length) !== span.text) {
      clearNotice()
      return false
    }
    if (next === span.text) return true
    if (!replaceRange(span.start, span.start + span.text.length, next, false)) return false
    span.text = next
    return true
  }, [clearNotice, replaceRange])

  const settle = useCallback(() => {
    setPhase('idle')
    setSendRequested(false)
    setCorrectingText(null)
  }, [])

  /** Drops the dictation in flight, whatever stage it is at. */
  const discard = useCallback(() => {
    const run = activeRef.current
    activeRef.current = null
    if (run) {
      run.controller.abort()
      run.correction?.abort()
      run.recording?.cancel()
    }
    submitAfterWriteRef.current = false
    settle()
  }, [settle])

  const abandon = useCallback(() => {
    discard()
    setPending(null)
    setIssue(null)
    clearNotice()
  }, [clearNotice, discard, setPending])

  const deliver = useCallback((run: Run, result: DictationResult) => {
    const placement = placeDictationResult({
      revisionAtStart: run.revisionAtStart,
      revisionNow: revisionRef.current,
      blocked: blockedRef.current,
      composing: composingRef.current,
    })
    if (placement === 'insert') {
      const start = writeText(result.text, run.point)
      if (start === null) return
      if (run.send) {
        // Sent straight away: there is no draft left to revert in.
        submitAfterWriteRef.current = true
        return
      }
      spanRef.current = { start, text: result.text, heard: result.heard }
      if (result.changes?.length) {
        showNotice({
          kind: 'changes',
          changes: result.changes,
          model: result.model ?? null,
          seconds: result.seconds ?? null,
        })
      } else if (result.fallback) {
        showNotice({ kind: result.fallback, changes: [], model: null, seconds: null })
      } else {
        clearNotice()
      }
      return
    }
    // Held text is never sent on its own: the draft changed, or cannot take
    // text, so the user has to look at it first.
    setPending(result.text)
  }, [clearNotice, setPending, showNotice, writeText])

  /** Hands the run's text over and leaves it; anything still running for it is stopped. */
  const conclude = useCallback((run: Run) => {
    activeRef.current = null
    run.correction?.abort()
    settle()
  }, [settle])

  const correct = useCallback(async (run: Run, heard: string) => {
    const controller = new AbortController()
    run.correction = controller
    run.heard = heard
    const followRun = () => controller.abort()
    run.controller.signal.addEventListener('abort', followRun, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CORRECTION_BUDGET_MS)
    setCorrectingText(heard)
    setPhase('correcting')
    try {
      const correction = await voiceApi.correct(heard, { signal: controller.signal })
      if (activeRef.current !== run) return
      conclude(run)
      deliver(run, correctedResult(heard, correction))
    } catch (error) {
      // Skipped or discarded: whoever ended the run already handled the text.
      if (activeRef.current !== run) return
      conclude(run)
      const fallback = timedOut ? 'timeout' : fallbackFromError(error)
      // Our cached catalog promised a model the server no longer has.
      if (fallback === 'unavailable') void useVoiceInputStore.getState().loadCatalog({ force: true })
      deliver(run, { heard, text: heard, fallback })
    } finally {
      clearTimeout(timer)
      run.controller.signal.removeEventListener('abort', followRun)
    }
  }, [conclude, deliver])

  const finish = useCallback(async (run: Run) => {
    if (activeRef.current !== run || !run.recording || run.stopping) return
    run.stopping = true
    setPhase('transcribing')
    const fail = (next: DictationIssue) => {
      activeRef.current = null
      settle()
      setIssue(next)
    }
    try {
      const { wav, seconds } = await run.recording.stop()
      if (activeRef.current !== run) return
      if (seconds < MIN_SECONDS) {
        fail('tooShort')
        return
      }
      const { providerId: provider, language: lang } = settingsRef.current
      if (!provider || !lang) {
        fail('notReady')
        return
      }
      const transcript = await voiceApi.transcribe(wav, {
        providerId: provider,
        language: lang,
        signal: run.controller.signal,
      })
      if (activeRef.current !== run) return
      const heard = normalizeDictationText(transcript.text)
      if (!heard) {
        fail('noSpeech')
        return
      }
      // Asked even when the cached catalog says no model is usable: the server
      // resolves the target on every request, so a default provider fixed in
      // another settings tab works right away. A 409 says it is still unusable
      // and refreshes the catalog (see `correct`).
      if (settingsRef.current.correctionEnabled) {
        await correct(run, heard)
        return
      }
      conclude(run)
      deliver(run, { heard, text: heard })
    } catch (error) {
      if (activeRef.current !== run) return
      const next = issueFromError(error)
      // The server disagrees with our cached catalog (the model was deleted
      // behind our back); refresh it so the button stops being offered.
      if (next === 'notReady') void useVoiceInputStore.getState().loadCatalog({ force: true })
      fail(next)
    }
  }, [conclude, correct, deliver, settle])

  /**
   * Stops waiting for AI correction and writes what was heard. A requested send
   * still goes out unless `keepDraft`: Esc backs out of the send too, so the
   * words land in the draft and nothing is sent.
   */
  const skipCorrection = useCallback((options: { keepDraft?: boolean } = {}) => {
    const run = activeRef.current
    if (!run?.correction) return
    if (options.keepDraft) {
      run.send = false
      setSendRequested(false)
    }
    conclude(run)
    deliver(run, { heard: run.heard, text: run.heard })
  }, [conclude, deliver])

  /**
   * Backs out of the dictation. Once the words are recognized, backing out of
   * the correction keeps them: only the wait is cancelled, not the speech. It
   * never sends: before correction existed, Esc during "transcribe, then send"
   * sent nothing, and backing out must not turn into sending.
   */
  const cancel = useCallback(() => {
    if (activeRef.current?.correction) skipCorrection({ keepDraft: true })
    else discard()
  }, [discard, skipCorrection])

  const start = useCallback(async () => {
    const settings = settingsRef.current
    if (activeRef.current || !settings.providerId || !settings.maxSeconds) return
    const run: Run = {
      controller: new AbortController(),
      recording: null,
      revisionAtStart: revisionRef.current,
      point: capturePoint(),
      stopping: false,
      send: false,
      stopWhenReady: false,
      correction: null,
      heard: '',
    }
    activeRef.current = run
    submitAfterWriteRef.current = false
    // Starting over is a deliberate choice; the previous held text goes.
    setPending(null)
    setIssue(null)
    clearNotice()
    setSendRequested(false)
    setPhase('starting')

    let recording: ActiveRecording
    try {
      recording = await startRecording({
        deviceId: getPreferredMicrophoneId(),
        maxSeconds: settings.maxSeconds,
        signal: run.controller.signal,
        onLimitReached: () => { void finish(run) },
        onInterrupted: (error) => {
          if (activeRef.current !== run) return
          activeRef.current = null
          settle()
          setIssue(issueFromRecorder(error.code))
        },
      })
    } catch (error) {
      if (activeRef.current !== run) return
      activeRef.current = null
      settle()
      setIssue(issueFromError(error))
      return
    }
    // Cancelled while the permission prompt was open, or another run took over.
    if (activeRef.current !== run) {
      recording.cancel()
      return
    }
    run.recording = recording
    setStartedAt(Date.now())
    setLimitSeconds(settings.maxSeconds)
    setPhase('recording')
    if (run.stopWhenReady) void finish(run)
  }, [capturePoint, clearNotice, finish, setPending, settle])

  const toggle = useCallback(() => {
    const run = activeRef.current
    if (!run) {
      void start()
    } else if (run.recording) {
      void finish(run)
    } else {
      discard()
    }
  }, [discard, finish, start])

  /** Ends the recording and transcribes it, as soon as there is one to end. */
  const stop = useCallback(() => {
    const run = activeRef.current
    if (!run) return
    if (run.recording) void finish(run)
    else run.stopWhenReady = true
  }, [finish])

  /**
   * Ends the recording and sends the draft once the text is in it. Also works
   * while recognition is running, for a user who decides late.
   */
  const stopAndSend = useCallback(() => {
    const run = activeRef.current
    if (!run?.recording || run.send) return
    run.send = true
    setSendRequested(true)
    void finish(run)
  }, [finish])

  const insertPending = useCallback(() => {
    const text = pendingRef.current
    if (text === null || blockedRef.current) return
    writeText(text, capturePoint())
    setPending(null)
    composerRef.current?.focus()
  }, [capturePoint, composerRef, setPending, writeText])

  const dismissPending = useCallback(() => setPending(null), [setPending])

  const dismissIssue = useCallback(() => setIssue(null), [])

  /** Puts one corrected word back to what was heard. */
  const revertCorrection = useCallback((index: number) => {
    const notice = noticeRef.current
    const span = spanRef.current
    if (notice?.kind !== 'changes' || !span) return
    const next = revertCorrectionChange(span.text, notice.changes, index)
    if (!next || !rewriteSpan(next.text)) return
    if (next.changes.length === 0) clearNotice()
    else setNotice({ ...notice, changes: next.changes })
  }, [clearNotice, rewriteSpan, setNotice])

  /** Puts the whole dictated span back to what was heard. */
  const revertAllCorrections = useCallback(() => {
    const span = spanRef.current
    if (!span) return
    if (rewriteSpan(span.heard)) clearNotice()
  }, [clearNotice, rewriteSpan])

  /** Adds a corrected word to the vocabulary, with what it was heard as. */
  const addCorrectionToVocabulary = useCallback(async (index: number) => {
    const change = noticeRef.current?.changes[index]
    if (!change) return
    const term = change.to.trim()
    if (!term) return
    const heardAs = change.from.trim()
    await useVoiceVocabularyStore.getState().add(
      [{ term, aliases: heardAs && vocabularyKey(heardAs) !== vocabularyKey(term) ? [heardAs] : [] }],
      { source: 'correction' },
    )
    const notice = noticeRef.current
    if (notice?.kind !== 'changes') return
    const key = vocabularyKey(term)
    setNotice({
      ...notice,
      changes: notice.changes.map(other => vocabularyKey(other.to) === key ? { ...other, inVocabulary: true } : other),
    })
  }, [setNotice])

  /** Runs correction again on text that went in uncorrected, and rewrites it in place. */
  const retryCorrection = useCallback(async () => {
    const span = spanRef.current
    const notice = noticeRef.current
    if (!span || !notice || (notice.kind !== 'timeout' && notice.kind !== 'failed')) return
    if (draftRef.current.slice(span.start, span.start + span.text.length) !== span.text) {
      clearNotice()
      return
    }
    retryRef.current?.abort()
    const controller = new AbortController()
    retryRef.current = controller
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CORRECTION_RETRY_BUDGET_MS)
    const asked = span.text
    setNotice({ ...notice, kind: 'retrying' })
    try {
      const correction = await voiceApi.correct(asked, { signal: controller.signal })
      if (retryRef.current !== controller) return
      const result = correctedResult(asked, correction)
      if (!result.changes?.length) {
        showNotice({ kind: 'unchanged', changes: [], model: result.model ?? null, seconds: null })
        return
      }
      if (!rewriteSpan(result.text)) {
        // The composer could not take the text right now (disabled while a
        // question is pending, for one). Offer the retry again instead of
        // leaving a spinner that never ends; an edited span already cleared it.
        if (noticeRef.current?.kind === 'retrying') setNotice(notice)
        return
      }
      span.heard = asked
      showNotice({
        kind: 'changes',
        changes: result.changes,
        model: result.model ?? null,
        seconds: result.seconds ?? null,
      })
    } catch (error) {
      if (retryRef.current !== controller) return
      showNotice({ kind: timedOut ? 'timeout' : fallbackFromError(error), changes: [], model: null, seconds: null })
    } finally {
      clearTimeout(timer)
      if (retryRef.current === controller) retryRef.current = null
    }
  }, [clearNotice, rewriteSpan, setNotice, showNotice])

  const dismissCorrectionNotice = clearNotice

  const focusComposer = useCallback(() => composerRef.current?.focus(), [composerRef])

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
  }, [])

  // Esc backs out of a recording or an in-flight recognition, and stops
  // waiting for correction (keeping the words). Captured ahead of the composer
  // so it does not also close a menu or interrupt a turn.
  useEffect(() => {
    if (phase === 'idle') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancel, phase])

  useEffect(() => {
    if (!issue) return
    const timer = setTimeout(() => setIssue(null), ISSUE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [issue])

  // A different session means a different draft: nothing recorded or held for
  // the old one belongs here.
  useEffect(() => {
    if (previousContextRef.current === contextKey) return
    previousContextRef.current = contextKey
    abandon()
  }, [abandon, contextKey])

  useEffect(() => abandon, [abandon])

  // The keyboard shortcut records into a composer the user can see; a hidden
  // one (contextKey null) is not a target.
  const shortcutHandlersRef = useRef({ start, stop, cancel })
  shortcutHandlersRef.current = { start, stop, cancel }
  const listening = contextKey !== null && contextKey !== undefined
  useEffect(() => {
    if (!listening) return
    return registerDictationTarget({
      hasFocus: () => composerRef.current?.hasFocus() ?? false,
      isActive: () => activeRef.current !== null,
      start: () => { void shortcutHandlersRef.current.start() },
      stop: () => shortcutHandlersRef.current.stop(),
      cancel: () => shortcutHandlersRef.current.cancel(),
    })
  }, [composerRef, listening])

  const getLevel = useCallback(() => activeRef.current?.recording?.getLevel() ?? 0, [])

  return useMemo(() => ({
    phase,
    issue,
    pendingText,
    startedAt,
    limitSeconds,
    sendRequested,
    correctingText,
    correctionNotice,
    toggle,
    stopAndSend,
    cancel,
    skipCorrection,
    insertPending,
    dismissPending,
    dismissIssue,
    revertCorrection,
    revertAllCorrections,
    addCorrectionToVocabulary,
    retryCorrection,
    dismissCorrectionNotice,
    getLevel,
    focusComposer,
    compositionHandlers: { onCompositionStart, onCompositionEnd },
  }), [
    phase,
    issue,
    pendingText,
    startedAt,
    limitSeconds,
    sendRequested,
    correctingText,
    correctionNotice,
    toggle,
    stopAndSend,
    cancel,
    skipCorrection,
    insertPending,
    dismissPending,
    dismissIssue,
    revertCorrection,
    revertAllCorrections,
    addCorrectionToVocabulary,
    retryCorrection,
    dismissCorrectionNotice,
    getLevel,
    focusComposer,
    onCompositionStart,
    onCompositionEnd,
  ])
}

export type ComposerDictation = ReturnType<typeof useComposerDictation>
