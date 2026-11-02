import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { ApiError } from '@/api/client'
import { voiceApi, type VoiceLanguage, type VoiceTranscript } from '@/api/voice'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { VoiceRecordingTrace } from '@/features/voiceInput/VoiceRecordingBar'
import {
  correctedResult,
  markRanges,
  originalRanges,
  type CorrectionOutcome,
  type TextRange,
} from '@/features/voiceInput/correctionChanges'
import { normalizeDictationText } from '@/features/voiceInput/insertion'
import { startRecording, type ActiveRecording, type RecordingResult } from '@/features/voiceInput/recorder'
import { CORRECTION_RETRY_BUDGET_MS } from '@/features/voiceInput/useComposerDictation'
import { selectVoiceCorrectionTarget, useVoiceInputStore } from '@/stores/voiceInputStore'
import { recorderErrorKey, voiceErrorKey } from './useMicrophoneSelection'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'correcting'

/** How the correction step of a test ended. */
type CorrectionResult =
  | { ok: true; outcome: CorrectionOutcome; seconds: number; model: string }
  | { ok: false; reasonKey: TranslationKey }

function transcribeErrorKey(error: unknown): TranslationKey {
  return voiceErrorKey(error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined)
}

function correctionErrorKey(error: unknown): TranslationKey {
  const body = error instanceof ApiError && typeof error.body === 'object' && error.body !== null
    ? error.body as { error?: unknown; reason?: unknown }
    : {}
  if (body.error === 'voice/correction-unavailable') return 'voice.settings.test.correctionUnavailable'
  if (body.reason === 'auth') return 'voice.settings.test.correctionAuth'
  return 'voice.settings.test.correctionFailed'
}

type Props = {
  deviceId?: string
  providerId: string
  language: VoiceLanguage
  maxSeconds: number
  /** The selected provider's model is installed and can transcribe. */
  ready: boolean
  /** `isVoiceCaptureSupported()`: false on plain-HTTP H5 or without a recorder. */
  captureSupported: boolean
}

/**
 * Record a few seconds, run them through the real transcription route, and show
 * what came back — the same path the composer uses, so a passing test means
 * dictation will work. It also looks like the composer's recording bar (the
 * same trace, clock and stop disc), so the test reads as the feature it tests.
 */
export function VoiceTranscriptionTest({ deviceId, providerId, language, maxSeconds, ready, captureSupported }: Props) {
  const t = useTranslation()
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  const [transcript, setTranscript] = useState<VoiceTranscript | null>(null)
  const [correction, setCorrection] = useState<CorrectionResult | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const correctionTarget = useVoiceInputStore(selectVoiceCorrectionTarget)
  const [startedAt, setStartedAt] = useState(0)

  const recordingRef = useRef<ActiveRecording | null>(null)
  const startAbortRef = useRef<AbortController | null>(null)
  const transcribeAbortRef = useRef<AbortController | null>(null)
  const playbackUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // The limit/interrupt callbacks outlive the render that created them by up to
  // `maxSeconds`, so they read the latest choices from here, not from closure.
  const latestRef = useRef({ providerId, language, correct: correctionTarget !== null })
  latestRef.current = { providerId, language, correct: correctionTarget !== null }

  const replacePlayback = (blob: Blob | null) => {
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
    const next = blob ? URL.createObjectURL(blob) : null
    playbackUrlRef.current = next
    setPlaybackUrl(next)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      startAbortRef.current?.abort()
      transcribeAbortRef.current?.abort()
      recordingRef.current?.cancel()
      recordingRef.current = null
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current)
      playbackUrlRef.current = null
    }
  }, [])

  const readLevel = useCallback(() => recordingRef.current?.getLevel() ?? 0, [])

  const finish = async () => {
    const recording = recordingRef.current
    if (!recording) return
    recordingRef.current = null
    setPhase('transcribing')

    let recorded: RecordingResult
    try {
      recorded = await recording.stop()
    } catch (error) {
      if (!mountedRef.current) return
      setErrorKey(recorderErrorKey(error))
      setPhase('idle')
      return
    }
    if (!mountedRef.current) return
    replacePlayback(recorded.wav)

    const controller = new AbortController()
    transcribeAbortRef.current = controller
    const { providerId: provider, language: lang, correct } = latestRef.current
    try {
      const result = await voiceApi.transcribe(recorded.wav, { providerId: provider, language: lang, signal: controller.signal })
      if (!mountedRef.current) return
      setTranscript(result)
      const heard = normalizeDictationText(result.text)
      // The same second step dictation takes, so the test shows what the
      // composer would receive.
      if (correct && heard) {
        setPhase('correcting')
        setCorrection(await runCorrection(heard, controller.signal))
      }
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) setErrorKey(transcribeErrorKey(error))
    } finally {
      if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null
      if (mountedRef.current) setPhase('idle')
    }
  }

  /** Never throws: a failed correction is part of the result being tested. */
  const runCorrection = async (heard: string, signal: AbortSignal): Promise<CorrectionResult | null> => {
    const controller = new AbortController()
    const followParent = () => controller.abort()
    signal.addEventListener('abort', followParent, { once: true })
    const timer = setTimeout(() => controller.abort(), CORRECTION_RETRY_BUDGET_MS)
    const startedAt = performance.now()
    try {
      const result = await voiceApi.correct(heard, { signal: controller.signal })
      return {
        ok: true,
        outcome: correctedResult(heard, result),
        seconds: result.seconds || (performance.now() - startedAt) / 1000,
        model: result.target.modelId,
      }
    } catch (error) {
      if (signal.aborted) return null
      return { ok: false, reasonKey: controller.signal.aborted ? 'voice.settings.test.correctionTimeout' : correctionErrorKey(error) }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', followParent)
    }
  }

  const handleInterrupted = () => {
    const recording = recordingRef.current
    recordingRef.current = null
    recording?.cancel()
    if (!mountedRef.current) return
    setErrorKey('voice.composer.error.interrupted')
    setPhase('idle')
  }

  const start = async () => {
    setErrorKey(null)
    setTranscript(null)
    setCorrection(null)
    replacePlayback(null)
    setPhase('starting')
    const controller = new AbortController()
    startAbortRef.current = controller
    try {
      const recording = await startRecording({
        deviceId,
        maxSeconds,
        signal: controller.signal,
        onLimitReached: () => { void finish() },
        onInterrupted: handleInterrupted,
      })
      if (!mountedRef.current || controller.signal.aborted) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
      setStartedAt(Date.now())
      setPhase('recording')
    } catch (error) {
      if (!mountedRef.current) return
      setErrorKey(recorderErrorKey(error))
      setPhase('idle')
    } finally {
      if (startAbortRef.current === controller) startAbortRef.current = null
    }
  }

  const canStart = ready && captureSupported

  return (
    <div className="space-y-3">
      {!captureSupported ? (
        <p className="text-[13px] leading-5 text-[var(--color-text-tertiary)]">{t('voice.settings.capture.unsupported')}</p>
      ) : !ready ? (
        <p className="text-[13px] leading-5 text-[var(--color-text-tertiary)]">{t('voice.settings.test.needModel')}</p>
      ) : null}

      {phase === 'recording' || phase === 'transcribing' || phase === 'correcting' ? (
        // One element across these phases, so recognition freezes the trace
        // that was just recorded instead of starting a new one.
        <div className="flex min-w-0 items-center gap-2">
          <VoiceRecordingTrace
            phase={phase === 'recording' ? 'recording' : 'transcribing'}
            startedAt={startedAt}
            limitSeconds={maxSeconds}
            transcribingLabel={phase === 'correcting' ? t('voice.composer.correcting') : t('voice.settings.test.transcribing')}
            getLevel={readLevel}
            height={32}
            levelLabel={t('voice.settings.test.level')}
          />
          <IconButton
            icon={<Square size={12} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />}
            label={phase === 'recording' ? t('voice.settings.test.stop') : phase === 'correcting' ? t('voice.composer.correcting') : t('voice.settings.test.transcribing')}
            shape="circle"
            soft
            loading={phase !== 'recording'}
            onClick={() => void finish()}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          size="base"
          icon={<Mic size={14} strokeWidth={1.75} aria-hidden="true" />}
          loading={phase === 'starting'}
          disabled={!canStart || phase === 'starting'}
          onClick={() => void start()}
        >
          {phase === 'starting' ? t('voice.settings.test.starting') : t('voice.settings.test.start')}
        </Button>
      )}

      {errorKey ? (
        <p role="alert" className="text-[13px] leading-5 text-[var(--color-error)]">{t(errorKey)}</p>
      ) : null}

      {transcript && (correction || phase === 'correcting') ? (
        <CorrectionComparison transcript={transcript} correction={correction} />
      ) : transcript ? (
        <div role="group" className="space-y-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-4 py-3" aria-label={t('voice.settings.test.result')}>
          <p className="text-xs font-medium text-[var(--color-text-tertiary)]">{t('voice.settings.test.result')}</p>
          {transcript.text.trim() ? (
            <p data-testid="voice-transcript" className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--color-text-primary)]">
              {transcript.text}
            </p>
          ) : (
            <p className="text-[13px] text-[var(--color-text-tertiary)]">{t('voice.composer.error.noSpeech')}</p>
          )}
          <p className="text-xs text-[var(--color-text-tertiary)]">
            {t('voice.settings.test.stats', {
              audio: transcript.audioSeconds.toFixed(1),
              inference: transcript.inferenceSeconds.toFixed(2),
            })}
          </p>
        </div>
      ) : null}

      {playbackUrl ? (
        <audio controls src={playbackUrl} aria-label={t('voice.settings.test.playback')} className="h-9 w-full max-w-md" />
      ) : null}
    </div>
  )
}

function MarkedText({ text, ranges, tone }: { text: string; ranges: TextRange[]; tone: 'removed' | 'added' }) {
  return (
    <>
      {markRanges(text, ranges).map((segment, index) => segment.marked ? (
        <mark
          key={index}
          data-change={tone}
          className={tone === 'added'
            ? 'rounded-[var(--radius-xs)] bg-[var(--color-success-container)] px-0.5 text-[var(--color-on-success-container)]'
            : 'bg-transparent text-inherit line-through decoration-[var(--color-error)]'}
        >
          {segment.text}
        </mark>
      ) : (
        <span key={index}>{segment.text}</span>
      ))}
    </>
  )
}

/**
 * What was heard beside what correction made of it, with each change marked
 * on both sides, and the time each step took.
 */
function CorrectionComparison({ transcript, correction }: { transcript: VoiceTranscript; correction: CorrectionResult | null }) {
  const t = useTranslation()
  const heard = normalizeDictationText(transcript.text)
  const outcome = correction?.ok ? correction.outcome : null
  const changes = outcome?.changes ?? []
  const card = 'min-w-0 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2.5'
  const label = 'mb-1.5 text-[11px] text-[var(--color-text-tertiary)]'

  return (
    <div role="group" aria-label={t('voice.settings.test.result')} className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={`${card} bg-[var(--color-surface-container)]`}>
          <p className={label}>{t('voice.settings.test.heard')}</p>
          <p data-testid="voice-transcript" className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--color-text-secondary)]">
            <MarkedText text={heard} ranges={originalRanges(changes)} tone="removed" />
          </p>
        </div>
        <div className={`${card} bg-[var(--color-surface-container-lowest)]`}>
          <p className={label}>
            {!correction
              ? t('voice.composer.correcting')
              : !correction.ok
                ? t('voice.settings.test.corrected')
                : changes.length > 0
                  ? t('voice.settings.test.correctedChanges', { count: changes.length })
                  : t('voice.settings.test.correctedNone')}
          </p>
          {correction?.ok ? (
            <p data-testid="voice-corrected" className="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--color-text-primary)]">
              <MarkedText text={correction.outcome.text} ranges={changes} tone="added" />
            </p>
          ) : correction ? (
            // A failed correction is information about the setup, not an error in this test.
            <p role="status" className="text-[13px] leading-6 text-[var(--color-text-secondary)]">{t(correction.reasonKey)}</p>
          ) : null}
        </div>
      </div>
      <p className="text-xs tabular-nums text-[var(--color-text-tertiary)]">
        {correction?.ok
          ? t('voice.settings.test.correctionStats', {
            audio: transcript.audioSeconds.toFixed(1),
            inference: transcript.inferenceSeconds.toFixed(2),
            correction: correction.seconds.toFixed(2),
            model: correction.model,
          })
          : t('voice.settings.test.stats', {
            audio: transcript.audioSeconds.toFixed(1),
            inference: transcript.inferenceSeconds.toFixed(2),
          })}
      </p>
    </div>
  )
}
