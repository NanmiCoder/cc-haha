import { useEffect, useRef, useState } from 'react'
import { Mic, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { selectVoiceInputReady, useVoiceInputStore } from '@/stores/voiceInputStore'
import { isVoiceCaptureSupported } from './recorder'
import type { ComposerDictation, DictationIssue } from './useComposerDictation'

type VoiceInputButtonProps = {
  dictation: ComposerDictation
  /** The composer cannot take text right now; a held result must wait. */
  blocked?: boolean
  /** 44px touch target, matching the composer's other mobile controls. */
  mobile?: boolean
}

const ISSUE_KEYS: Record<DictationIssue, TranslationKey> = {
  permission: 'voice.composer.error.permission',
  noDevice: 'voice.composer.error.noDevice',
  deviceBusy: 'voice.composer.error.deviceBusy',
  unavailable: 'voice.composer.error.unavailable',
  interrupted: 'voice.composer.error.interrupted',
  notReady: 'voice.composer.error.notReady',
  invalidAudio: 'voice.composer.error.invalidAudio',
  unknownProvider: 'voice.composer.error.unknownProvider',
  failed: 'voice.composer.error.failed',
  noSpeech: 'voice.composer.error.noSpeech',
  tooShort: 'voice.composer.error.tooShort',
}

/** Nothing was wrong; there was just nothing to write. */
const SOFT_ISSUES = new Set<DictationIssue>(['noSpeech', 'tooShort'])

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The composer's dictation control. Renders nothing until the voice service is
 * enabled, its model is downloaded, and this environment can capture audio.
 */
export function VoiceInputButton({ dictation, blocked = false, mobile = false }: VoiceInputButtonProps) {
  const t = useTranslation()
  const ready = useVoiceInputStore(selectVoiceInputReady)
  const loadCatalog = useVoiceInputStore(state => state.loadCatalog)
  const [supported] = useState(isVoiceCaptureSupported)
  const { phase, issue, pendingText, startedAt, getLevel } = dictation
  const haloRef = useRef<HTMLSpanElement>(null)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  // Loudness drives the halo straight through the DOM: a 60 Hz value has no
  // business re-rendering the composer.
  useEffect(() => {
    if (phase !== 'recording') return
    let frame = 0
    const tick = () => {
      const halo = haloRef.current
      if (halo) {
        const level = getLevel()
        halo.style.transform = `scale(${1 + level * 0.6})`
        halo.style.opacity = String(0.25 + level * 0.75)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [getLevel, phase])

  useEffect(() => {
    if (phase !== 'recording') return
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => clearInterval(timer)
  }, [phase, startedAt])

  const engaged = phase !== 'idle' || pendingText !== null || issue !== null
  if (!supported || (!ready && !engaged)) return null

  const size = mobile ? '2xl' : 'md'
  const recording = phase === 'recording'
  const label = phase === 'idle'
    ? t('voice.composer.start')
    : phase === 'starting'
      ? t('voice.composer.starting')
      : recording
        ? t('voice.composer.stop')
        : t('voice.composer.transcribing')

  return (
    <div data-testid="voice-input" className="relative flex shrink-0 items-center gap-1.5">
      {recording && (
        <span
          data-testid="voice-input-timer"
          className="text-xs tabular-nums text-[var(--color-error)]"
          title={t('voice.composer.recordingHint')}
        >
          {formatElapsed(elapsed)}
        </span>
      )}
      <span className="relative inline-flex">
        {recording && (
          <span
            ref={haloRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[var(--radius-lg)] bg-[var(--color-error-soft)]"
          />
        )}
        <IconButton
          icon={recording
            ? <Square size={mobile ? 18 : 14} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />
            : <Mic size={mobile ? 20 : 16} strokeWidth={1.75} aria-hidden="true" />}
          label={label}
          size={size}
          tone={recording ? 'danger' : 'secondary'}
          solid={recording}
          loading={phase === 'transcribing'}
          // A toggle only while it is recording. The label changes with the
          // phase, so pressed would contradict it during the other phases;
          // those are busy instead (`loading` already sets it for transcribing).
          pressed={recording ? true : undefined}
          aria-busy={phase === 'starting' || phase === 'transcribing' ? true : undefined}
          // Keep the caret in the composer: a click would otherwise blur it, and
          // the write-back position is the caret the user left there.
          onMouseDown={event => event.preventDefault()}
          onClick={dictation.toggle}
          className="relative"
        />
      </span>

      {issue && (
        <div
          role="alert"
          data-testid="voice-input-issue"
          className={[
            'absolute bottom-full right-0 z-[var(--z-popover)] mb-2 flex w-max max-w-[min(20rem,calc(100vw-2rem))] items-start gap-2',
            'rounded-[var(--radius-lg)] px-3 py-2 text-xs shadow-[var(--shadow-overlay)]',
            SOFT_ISSUES.has(issue)
              ? 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
              : 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]',
          ].join(' ')}
        >
          <span className="min-w-0 flex-1">{t(ISSUE_KEYS[issue])}</span>
          <button
            type="button"
            aria-label={t('voice.composer.dismiss')}
            onClick={dictation.dismissIssue}
            className="shrink-0 rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      )}

      {pendingText !== null && (
        <div
          role="group"
          aria-label={t('voice.composer.pendingTitle')}
          data-testid="voice-input-pending"
          className={[
            'absolute bottom-full right-0 z-[var(--z-popover)] mb-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2',
            'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3',
            'shadow-[var(--shadow-overlay)]',
          ].join(' ')}
        >
          <p className="text-xs text-[var(--color-text-tertiary)]">{t('voice.composer.pendingHint')}</p>
          <p data-testid="voice-input-pending-text" className="line-clamp-4 break-words text-sm text-[var(--color-text-primary)]">
            {pendingText}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={dictation.dismissPending}>
              {t('voice.composer.discard')}
            </Button>
            <Button
              variant="tonal"
              size="sm"
              disabled={blocked}
              onMouseDown={event => event.preventDefault()}
              onClick={dictation.insertPending}
            >
              {t('voice.composer.insertText')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
