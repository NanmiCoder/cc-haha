import type { VoiceCatalog, VoiceTranscript } from './voiceApi'
import type { VoiceRecording } from './voiceRecorderTypes'

export type VoiceSelection = { start: number, end: number }
export type VoiceIssue = { code: string, message: string }
export type VoiceDictationState = {
  phase: 'idle' | 'starting' | 'recording' | 'transcribing'
  startedAt: number
  limitSeconds: number
  sendRequested: boolean
  issue: VoiceIssue | null
  pendingText: string | null
}
export type VoiceDraft = {
  key: string
  text: string
  revision: number
  selection: VoiceSelection
  blocked: boolean
  canSend: boolean
}

type RecordingOptions = {
  maxSeconds: number
  signal: AbortSignal
  onLimitReached(): void
  onInterrupted(error: unknown): void
  onPermissionRequest(pending: boolean): void
}
type Dependencies = {
  read(): VoiceDraft
  write(text: string, cursor: number): void
  /** Submit only after the controlled composer has rendered this draft. */
  submitAfterWrite(text: string): void
  focus(): void
  changed(state: VoiceDictationState): void
  catalog(signal: AbortSignal): Promise<VoiceCatalog>
  record(options: RecordingOptions): Promise<VoiceRecording>
  transcribe(wav: Uint8Array, options: { providerId: string, language: VoiceCatalog['preferences']['language'], signal: AbortSignal }): Promise<VoiceTranscript>
  now?(): number
}
type Run = {
  draft: VoiceDraft
  abort: AbortController
  recording?: VoiceRecording
  finishing: boolean
  finishWhenReady: boolean
  permissionPending: boolean
  send: boolean
  limits: { seconds: number, maxBytes: number, providerId: string, language: VoiceCatalog['preferences']['language'] }
}

export const initialVoiceDictationState = (): VoiceDictationState => ({
  phase: 'idle', startedAt: 0, limitSeconds: 120, sendRequested: false, issue: null, pendingText: null,
})

export function voiceIssue(error: unknown): VoiceIssue {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'failed'
  const messages: Record<string, string> = {
    permission: 'Allow cc-haha to use the microphone in system settings.',
    unavailable: 'Cannot record in the current environment; update the phone app and retry.',
    interrupted: 'Recording was interrupted; please record again.',
    'no-device': 'No usable microphone found.',
    'device-busy': 'The microphone is in use by another app.',
    'voice/not-ready': 'Download and prepare the voice model in Settings → Voice input on the computer first.',
    'voice/invalid-audio': 'Recording invalid or over the limit; please record again.',
    'voice/unknown-provider': 'The voice model on the computer changed; please record again.',
    TIMEOUT: 'Transcription on the computer timed out; please retry.',
    NETWORK_ERROR: 'Cannot connect to the computer; check the connection and retry.',
  }
  return {
    code,
    message: messages[code] ?? (error instanceof Error ? error.message : 'Voice transcription did not finish; please retry.'),
  }
}

export function insertVoiceText(draft: string, point: VoiceSelection, raw: string) {
  const text = raw.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  const start = Math.min(draft.length, Math.max(0, point.start))
  const end = Math.min(draft.length, Math.max(start, point.end))
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const prefix = /[A-Za-z0-9.,;:!?)]$/.test(before) && /^[A-Za-z0-9(]/.test(text) ? ' ' : ''
  const suffix = /[A-Za-z0-9.,;:!?)]$/.test(text) && /^[A-Za-z0-9(]/.test(after) ? ' ' : ''
  return { text: before + prefix + text + suffix + after, cursor: before.length + prefix.length + text.length + suffix.length }
}

/** A single composer's recording and request lifetime; no state survives a context change. */
export function createVoiceDictation(deps: Dependencies) {
  let state = initialVoiceDictationState()
  let active: Run | undefined
  let pendingKey: string | undefined
  const change = (patch: Partial<VoiceDictationState>) => {
    state = { ...state, ...patch }
    deps.changed(state)
  }
  const current = (run: Run) => active === run && !run.abort.signal.aborted && deps.read().key === run.draft.key
  const cancel = () => {
    const run = active
    active = undefined
    run?.abort.abort()
    try { run?.recording?.cancel() } catch {}
    change({ phase: 'idle', sendRequested: false })
  }
  const fail = (run: Run, issue: VoiceIssue) => {
    if (!current(run)) return
    cancel()
    change({ issue })
  }
  const write = (text: string, point: VoiceSelection, send: boolean) => {
    const draft = deps.read()
    const next = insertVoiceText(draft.text, point, text)
    deps.write(next.text, next.cursor)
    if (send && draft.canSend) deps.submitAfterWrite(next.text)
    else deps.focus()
  }
  const finish = async (run: Run) => {
    if (!current(run) || run.finishing) return
    if (!run.recording) {
      run.finishWhenReady = true
      return
    }
    run.finishing = true
    change({ phase: 'transcribing' })
    try {
      const audio = await run.recording.stop()
      if (!current(run)) return
      if (audio.seconds < 0.25) {
        fail(run, { code: 'too-short', message: 'Recording too short; stop after you finish speaking.' })
        return
      }
      if (audio.wav.byteLength > run.limits.maxBytes || audio.seconds > run.limits.seconds + 0.01) {
        fail(run, voiceIssue({ code: 'voice/invalid-audio' }))
        return
      }
      const transcript = await deps.transcribe(audio.wav, {
        providerId: run.limits.providerId,
        language: run.limits.language,
        signal: run.abort.signal,
      })
      if (!current(run)) return
      const text = transcript.text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
      active = undefined
      change({ phase: 'idle', sendRequested: false })
      if (!text) {
        change({ issue: { code: 'no-speech', message: 'No speech detected; please retry.' } })
        return
      }
      const latest = deps.read()
      if (latest.blocked || latest.revision !== run.draft.revision) {
        pendingKey = run.draft.key
        change({ pendingText: text })
      } else write(text, run.draft.selection, run.send)
    } catch (error) {
      fail(run, voiceIssue(error))
    }
  }
  return {
    state: () => state,
    isPermissionRequestPending: () => active?.permissionPending === true,
    getLevel: () => active?.recording?.getLevel() ?? 0,
    async start() {
      const draft = deps.read()
      if (active || draft.blocked) return
      const run: Run = {
        draft: { ...draft, selection: { ...draft.selection } }, abort: new AbortController(),
        finishing: false, finishWhenReady: false, permissionPending: false, send: false,
        limits: { seconds: 120, maxBytes: 4 * 1024 * 1024, providerId: '', language: 'auto' },
      }
      active = run
      pendingKey = undefined
      change({ phase: 'starting', issue: null, pendingText: null, sendRequested: false })
      try {
        const catalog = await deps.catalog(run.abort.signal)
        if (!current(run)) return
        if (!catalog.supported || !catalog.preferences.enabled) {
          fail(run, { code: 'disabled', message: 'Turn on voice input in Settings → Voice input on the computer.' })
          return
        }
        const provider = catalog.providers.find(value => value.info.id === catalog.preferences.providerId)
        if (provider?.preparation.phase !== 'ready') {
          fail(run, voiceIssue({ code: 'voice/not-ready' }))
          return
        }
        const seconds = Math.min(120, catalog.limits.maxAudioSeconds)
        const maxBytes = Math.min(4 * 1024 * 1024, catalog.limits.maxAudioBytes)
        if (!(seconds > 0) || !(maxBytes > 44)) throw new Error('The computer returned an invalid recording limit.')
        run.limits = { seconds, maxBytes, providerId: provider.info.id, language: catalog.preferences.language }
        const recording = await deps.record({
          maxSeconds: seconds, signal: run.abort.signal,
          onLimitReached: () => { void finish(run) },
          onInterrupted: error => fail(run, voiceIssue(error)),
          onPermissionRequest: pending => { if (current(run)) run.permissionPending = pending },
        })
        if (!current(run)) {
          recording.cancel()
          return
        }
        run.recording = recording
        change({ phase: 'recording', startedAt: (deps.now ?? Date.now)(), limitSeconds: seconds })
        if (run.finishWhenReady) void finish(run)
      } catch (error) {
        fail(run, voiceIssue(error))
      }
    },
    stop(send = false) {
      if (!active) return
      if (send && deps.read().canSend) {
        active.send = true
        change({ sendRequested: true })
      }
      return finish(active)
    },
    cancel,
    abandon() {
      cancel()
      pendingKey = undefined
      change({ issue: null, pendingText: null })
    },
    dismissIssue: () => change({ issue: null }),
    dismissPending() {
      pendingKey = undefined
      change({ pendingText: null })
    },
    insertPending() {
      const draft = deps.read()
      if (state.pendingText === null || pendingKey !== draft.key || draft.blocked) return
      write(state.pendingText, draft.selection, false)
      pendingKey = undefined
      change({ pendingText: null })
    },
  }
}

export type VoiceDictation = ReturnType<typeof createVoiceDictation>
