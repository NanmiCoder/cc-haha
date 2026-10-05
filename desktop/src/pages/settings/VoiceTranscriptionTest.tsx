import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { ApiError } from '@/api/client'
import { voiceApi, type VoiceLanguage, type VoiceTranscript } from '@/api/voice'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { VoiceRecordingTrace } from '@/features/voiceInput/VoiceRecordingBar'
import { startRecording, type ActiveRecording, type RecordingResult } from '@/features/voiceInput/recorder'
import { recorderErrorKey, voiceErrorKey } from './useMicrophoneSelection'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'

function transcribeErrorKey(error: unknown): TranslationKey {
  return voiceErrorKey(error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined)
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
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)

  const recordingRef = useRef<ActiveRecording | null>(null)
  const startAbortRef = useRef<AbortController | null>(null)
  const transcribeAbortRef = useRef<AbortController | null>(null)
  const playbackUrlRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  // The limit/interrupt callbacks outlive the render that created them by up to
  // `maxSeconds`, so they read the latest choices from here, not from closure.
  const latestRef = useRef({ providerId, language })
  latestRef.current = { providerId, language }

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
    try {
      const result = await voiceApi.transcribe(recorded.wav, { ...latestRef.current, signal: controller.signal })
      if (mountedRef.current) setTranscript(result)
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted) setErrorKey(transcribeErrorKey(error))
    } finally {
      if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null
      if (mountedRef.current) setPhase('idle')
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

      {phase === 'recording' || phase === 'transcribing' ? (
        // One element across both phases, so recognition freezes the trace that
        // was just recorded instead of starting a new one.
        <div className="flex min-w-0 items-center gap-2">
          <VoiceRecordingTrace
            phase={phase}
            startedAt={startedAt}
            limitSeconds={maxSeconds}
            transcribingLabel={t('voice.settings.test.transcribing')}
            getLevel={readLevel}
            height={32}
            levelLabel={t('voice.settings.test.level')}
          />
          <IconButton
            icon={<Square size={12} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />}
            label={phase === 'transcribing' ? t('voice.settings.test.transcribing') : t('voice.settings.test.stop')}
            shape="circle"
            soft
            loading={phase === 'transcribing'}
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

      {transcript ? (
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
