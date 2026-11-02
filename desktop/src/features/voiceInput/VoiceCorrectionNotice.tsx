import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { AlertTriangle, ArrowRight, Check, Clock, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '@/i18n'
import { VoiceVocabularySkippedError } from '@/stores/voiceVocabularyStore'
import type { TranslationKey } from '@/i18n/locales/en'
import { isVocabularyCandidate } from './correctionChanges'
import type { ComposerDictation, CorrectionNoticeKind } from './useComposerDictation'

/** How long a correction notice stays up when nobody is looking at it. */
export const CORRECTION_NOTICE_MS = 6_000

const MESSAGE_KEYS: Record<Exclude<CorrectionNoticeKind, 'changes'>, TranslationKey> = {
  timeout: 'voice.correction.notice.timeout',
  failed: 'voice.correction.notice.failed',
  auth: 'voice.correction.notice.auth',
  unavailable: 'voice.correction.notice.unavailable',
  retrying: 'voice.composer.correcting',
  unchanged: 'voice.correction.notice.unchanged',
}

// Keep the caret in the composer: reverting writes at the dictated span, and a
// click that blurs the editor would also hide the composer's selection.
const keepCaret = (event: MouseEvent) => event.preventDefault()

type Props = {
  dictation: ComposerDictation
  onOpenSettings: () => void
}

/**
 * What AI correction did to the text that was just dictated: a short pill
 * beside the microphone ("AI changed 2 · View · Restore original"), and a
 * panel listing each change to revert or add to the vocabulary.
 *
 * Fallbacks (timeout, a rejected key, no model) are said here at info level:
 * the user's words still went in, so none of them is an error.
 */
export function VoiceCorrectionNotice({ dictation, onOpenSettings }: Props) {
  const t = useTranslation()
  const notice = dictation.correctionNotice
  const [panelOpen, setPanelOpen] = useState(false)
  const [attended, setAttended] = useState(false)
  const [adding, setAdding] = useState<number | null>(null)
  const [addFailed, setAddFailed] = useState<'failed' | 'skipped' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dismiss = dictation.dismissCorrectionNotice

  const kind = notice?.kind
  const id = notice?.id

  // A different notice starts closed; a change list that empties closes it.
  useEffect(() => {
    setPanelOpen(false)
    setAddFailed(null)
  }, [id])

  useDismissable({ open: panelOpen, refs: [rootRef], onDismiss: () => setPanelOpen(false) })

  // Auto-hide, paused while the panel is open or the pointer/focus is on the
  // notice, and never while "correct again" is still running.
  useEffect(() => {
    if (id === undefined || panelOpen || attended || kind === 'retrying') return
    const timer = setTimeout(dismiss, CORRECTION_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [attended, dismiss, id, kind, panelOpen])

  if (!notice) return null

  const leave = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAttended(false)
  }

  const addToVocabulary = async (index: number) => {
    setAdding(index)
    setAddFailed(null)
    try {
      await dictation.addCorrectionToVocabulary(index)
    } catch (error) {
      setAddFailed(error instanceof VoiceVocabularySkippedError ? 'skipped' : 'failed')
    } finally {
      setAdding(null)
    }
  }

  const changeCount = notice.changes.length

  return (
    <div
      ref={rootRef}
      data-testid="voice-correction-notice"
      data-kind={notice.kind}
      onPointerEnter={() => setAttended(true)}
      onPointerLeave={() => setAttended(false)}
      onFocus={() => setAttended(true)}
      onBlur={leave}
      className="absolute bottom-full right-0 z-[var(--z-popover)] mb-2 flex w-max max-w-[min(26rem,calc(100vw-2rem))] flex-col items-end gap-2"
    >
      {panelOpen && notice.kind === 'changes' ? (
        <div
          role="dialog"
          aria-label={t('voice.correction.panel.title')}
          data-testid="voice-correction-panel"
          className="w-[26rem] max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-1.5 shadow-[var(--shadow-overlay)]"
        >
          <p className="px-2.5 py-2 text-xs text-[var(--color-text-tertiary)]">
            {[
              t('voice.correction.notice.changed', { count: changeCount }),
              notice.model,
              notice.seconds !== null ? t('voice.correction.panel.seconds', { seconds: notice.seconds.toFixed(2) }) : null,
            ].filter(Boolean).join(' · ')}
          </p>
          <ul className="space-y-0.5">
            {notice.changes.map((change, index) => (
              <li
                key={`${change.start}:${change.to}`}
                data-testid="voice-correction-change"
                className="flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-2 hover:bg-[var(--color-surface-hover)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px]">
                    <span className="break-all text-[var(--color-text-tertiary)] line-through">
                      {change.from || t('voice.correction.panel.nothing')}
                    </span>
                    <ArrowRight size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="break-all font-mono text-[var(--color-text-primary)]">
                      {change.to || t('voice.correction.panel.nothing')}
                    </span>
                  </p>
                  {change.inVocabulary || isVocabularyCandidate(change.to) ? (
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                      {change.inVocabulary ? t('voice.correction.panel.fromVocabulary') : t('voice.correction.panel.notInVocabulary')}
                    </p>
                  ) : null}
                </div>
                {!change.inVocabulary && isVocabularyCandidate(change.to) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={adding === index}
                    disabled={adding !== null}
                    onMouseDown={keepCaret}
                    onClick={() => { void addToVocabulary(index) }}
                  >
                    {t('voice.correction.panel.addToVocabulary')}
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t('voice.correction.panel.revertOne', { from: change.from, to: change.to })}
                  onMouseDown={keepCaret}
                  onClick={() => dictation.revertCorrection(index)}
                >
                  {t('voice.correction.panel.revert')}
                </Button>
              </li>
            ))}
          </ul>
          {addFailed ? (
            <p role="status" className="px-2.5 pt-1 text-xs text-[var(--color-text-secondary)]">
              {t(addFailed === 'skipped' ? 'voice.correction.panel.addSkipped' : 'voice.correction.panel.addFailed')}
            </p>
          ) : null}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-1 pt-1.5">
            <Button variant="link" size="sm" onClick={onOpenSettings}>
              {t('voice.correction.panel.settings')}
            </Button>
            <Button variant="ghost" size="sm" onMouseDown={keepCaret} onClick={dictation.revertAllCorrections}>
              {t('voice.correction.panel.revertAll')}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        role="status"
        className="inline-flex min-h-[30px] max-w-full items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 pl-3 pr-1 text-xs text-[var(--color-text-secondary)] shadow-[var(--shadow-overlay)]"
      >
        <NoticeIcon kind={notice.kind} />
        <span className="min-w-0 flex-1">
          {notice.kind === 'changes'
            ? t('voice.correction.notice.changed', { count: changeCount })
            : t(MESSAGE_KEYS[notice.kind])}
        </span>
        {notice.kind === 'changes' ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={panelOpen}
              aria-haspopup="dialog"
              className="shrink-0"
              onMouseDown={keepCaret}
              onClick={() => setPanelOpen(open => !open)}
            >
              {t('voice.correction.notice.view')}
            </Button>
            <Button variant="ghost" size="sm" className="shrink-0" onMouseDown={keepCaret} onClick={dictation.revertAllCorrections}>
              {t('voice.correction.notice.restore')}
            </Button>
          </>
        ) : notice.kind === 'timeout' || notice.kind === 'failed' ? (
          <Button variant="secondary" size="sm" className="shrink-0" onMouseDown={keepCaret} onClick={() => { void dictation.retryCorrection() }}>
            {t('voice.correction.notice.retry')}
          </Button>
        ) : notice.kind === 'auth' || notice.kind === 'unavailable' ? (
          <Button variant="secondary" size="sm" className="shrink-0" onClick={onOpenSettings}>
            {t('voice.correction.notice.openSettings')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function NoticeIcon({ kind }: { kind: CorrectionNoticeKind }) {
  const props = { size: 13, strokeWidth: 1.75, 'aria-hidden': true } as const
  switch (kind) {
    case 'changes':
      return <Check {...props} className="shrink-0 text-[var(--color-success)]" />
    case 'retrying':
      return <Spinner size={13} />
    case 'timeout':
      return <Clock {...props} className="shrink-0 text-[var(--color-text-tertiary)]" />
    case 'auth':
    case 'unavailable':
      // Info level: the words went in. Warning tone only says "something to fix in Settings".
      return <AlertTriangle {...props} className="shrink-0 text-[var(--color-warning)]" />
    default:
      return <Info {...props} className="shrink-0 text-[var(--color-text-tertiary)]" />
  }
}
