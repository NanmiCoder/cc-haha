import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import type { ComposerDictation } from './useComposerDictation'
import { VoiceTrail } from './VoiceTrail'

/** The clock turns into a countdown this close to the recording limit… */
export const COUNTDOWN_SECONDS = 15

/** …or in the last third of a short one, so a 30 s test is not half countdown. */
export function countdownSeconds(limitSeconds: number): number {
  return Math.min(COUNTDOWN_SECONDS, limitSeconds / 3)
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The phases a recording surface is on screen for. */
export type RecordingPhase = 'starting' | 'recording' | 'transcribing'

type ClockProps = {
  phase: RecordingPhase
  /** `Date.now()` when the microphone opened. */
  startedAt: number
  limitSeconds: number
  transcribingLabel: string
  hint?: string
}

/** Its own component so the 4 Hz tick re-renders a span, not the surface around it. */
function RecordingClock({ phase, startedAt, limitSeconds, transcribingLabel, hint }: ClockProps) {
  const t = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (phase !== 'recording') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [phase])

  const className = 'shrink-0 whitespace-nowrap text-[13px] tabular-nums'
  if (phase === 'transcribing') {
    return <span className={`${className} text-[var(--color-text-tertiary)]`}>{transcribingLabel}</span>
  }

  const elapsed = phase === 'recording' ? Math.max(0, (now - startedAt) / 1000) : 0
  const remaining = limitSeconds - elapsed
  const countdown = phase === 'recording' && limitSeconds > 0 && remaining <= countdownSeconds(limitSeconds)
  return (
    <span
      data-testid="voice-input-timer"
      data-countdown={countdown || undefined}
      title={hint}
      className={`${className} ${countdown ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-tertiary)]'}`}
    >
      {countdown
        ? t('voice.composer.remaining', { time: formatClock(Math.ceil(Math.max(0, remaining))) })
        : formatClock(elapsed)}
    </span>
  )
}

type VoiceRecordingTraceProps = ClockProps & {
  getLevel: () => number
  height: number
  /** Names the trace for screen readers where no surrounding group does. */
  levelLabel?: string
}

/**
 * What every recording surface shows between its buttons: the trace of what
 * the microphone heard, then the clock. Shared by the composer's recording bar
 * and the settings page's transcription test, so the two read as one feature.
 */
export function VoiceRecordingTrace({ getLevel, height, levelLabel, ...clock }: VoiceRecordingTraceProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div role={levelLabel ? 'img' : undefined} aria-label={levelLabel} className="min-w-0 flex-1">
        <VoiceTrail getLevel={getLevel} frozen={clock.phase === 'transcribing'} height={height} className="w-full" />
      </div>
      <RecordingClock {...clock} />
    </div>
  )
}

type VoiceRecordingBarProps = {
  dictation: ComposerDictation
  /** 44px touch targets, matching the composer's other mobile controls. */
  mobile?: boolean
}

// Keep the caret in the composer: a click would otherwise blur it, and the
// write-back position is the caret the user left there.
const keepCaret = (event: MouseEvent) => event.preventDefault()

/**
 * The composer's toolbar while dictation is under way: cancel, what the
 * microphone hears, the clock, stop (text goes into the draft) and send (text
 * goes into the draft, then the draft is sent).
 *
 * The composer renders it in place of its toolbar controls for every phase but
 * `idle`, keeping those controls mounted and hidden so their own state (an open
 * model menu, a fetched context size) survives the recording.
 */
export function VoiceRecordingBar({ dictation, mobile = false }: VoiceRecordingBarProps) {
  const t = useTranslation()
  const { phase, startedAt, limitSeconds, sendRequested, getLevel, focusComposer } = dictation
  const barRef = useRef<HTMLDivElement>(null)
  const stopRef = useRef<HTMLButtonElement>(null)
  /** Focus entered the bar: the user is driving it from the keyboard. */
  const focusedRef = useRef(false)
  const starting = phase === 'starting'
  const transcribing = phase === 'transcribing'

  // Started from the keyboard, the microphone button that had focus is now
  // hidden; hand focus to the control that ends the recording. Ending it hides
  // the bar in turn, so focus goes back to the draft the text was written into.
  // Mouse clicks never move focus here (every button prevents its mousedown),
  // so a mouse user's focus is left wherever it was.
  useLayoutEffect(() => {
    if (document.activeElement?.closest('[hidden]')) stopRef.current?.focus()
    const bar = barRef.current
    return () => {
      if (!focusedRef.current) return
      // A disabled button drops focus to the body, so that counts as ours too.
      const current = document.activeElement
      if (!current || current === document.body || bar?.contains(current)) focusComposer()
    }
  }, [focusComposer])

  if (phase === 'idle') return null

  const iconSize = mobile ? 20 : 16
  const size = mobile ? '2xl' : 'md'
  const stopLabel = starting
    ? t('voice.composer.starting')
    : transcribing
      ? t('voice.composer.transcribing')
      : t('voice.composer.stop')

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={t('voice.composer.recordingBar')}
      data-testid="voice-recording-bar"
      data-phase={phase}
      onFocus={() => { focusedRef.current = true }}
      className={`animate-overlay-in flex min-w-0 flex-1 items-center ${mobile ? 'gap-1' : 'gap-2'}`}
    >
      <IconButton
        icon={<X size={iconSize} strokeWidth={1.75} aria-hidden="true" />}
        label={t('voice.composer.cancel')}
        size={size}
        shape="circle"
        soft
        onMouseDown={keepCaret}
        onClick={dictation.cancel}
      />
      <VoiceRecordingTrace
        phase={phase}
        startedAt={startedAt}
        limitSeconds={limitSeconds}
        transcribingLabel={sendRequested ? t('voice.composer.transcribingThenSend') : t('voice.composer.transcribing')}
        hint={t('voice.composer.recordingHint')}
        getLevel={getLevel}
        height={mobile ? 44 : 32}
      />
      <IconButton
        ref={stopRef}
        icon={<Square size={mobile ? 14 : 12} strokeWidth={1.75} fill="currentColor" aria-hidden="true" />}
        label={stopLabel}
        size={size}
        shape="circle"
        soft
        // The spinner belongs to whichever button the user is waiting on.
        loading={transcribing && !sendRequested}
        disabled={transcribing}
        aria-busy={starting || transcribing ? true : undefined}
        onMouseDown={keepCaret}
        onClick={dictation.toggle}
      />
      {/* The composer's send key, so it reads as "send" without a word next to
          it; it only differs in waiting for the text first. */}
      <Button
        variant="accent"
        size="base"
        shape="circle"
        loading={transcribing && sendRequested}
        // Nothing has been recorded until the microphone opens.
        disabled={starting}
        aria-label={t('voice.composer.sendNow')}
        title={t('voice.composer.sendNow')}
        onMouseDown={keepCaret}
        onClick={dictation.stopAndSend}
        className={`shrink-0 ${mobile ? 'h-11 w-11' : ''}`}
        icon={<ArrowUp size={mobile ? 18 : 16} strokeWidth={2} aria-hidden="true" />}
      />
    </div>
  )
}
