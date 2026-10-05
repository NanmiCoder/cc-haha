import { useEffect, useState } from 'react'
import { Mic, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { isDesktopRuntime } from '@/lib/desktopRuntime'
import { SETTINGS_TAB_ID, useTabStore } from '@/stores/tabStore'
import { useUIStore } from '@/stores/uiStore'
import {
  selectActiveVoiceProvider,
  selectVoiceInputNeedsModel,
  selectVoiceInputReady,
  useVoiceInputStore,
} from '@/stores/voiceInputStore'
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

/**
 * The composer's dictation control. Shown in the desktop app while voice input
 * is switched on.
 *
 * Once the model is downloaded it starts a dictation and reports how the last
 * one ended (an issue, or text held back from the draft); while one is under
 * way the composer hides its toolbar, this button with it, and shows
 * `VoiceRecordingBar` instead. Until then it opens Settings → Voice input,
 * where the download is — the model is never fetched behind the user's back.
 *
 * Never in the browser (H5): over the usual plain-HTTP LAN address the page is
 * not a secure context, so the browser offers no microphone at all; the HTTPS
 * path has not been verified on phones; and the H5 settings have no voice page
 * to send anyone to.
 */
export function VoiceInputButton({ dictation, blocked = false, mobile = false }: VoiceInputButtonProps) {
  const t = useTranslation()
  const ready = useVoiceInputStore(selectVoiceInputReady)
  const needsModel = useVoiceInputStore(selectVoiceInputNeedsModel)
  const modelPhase = useVoiceInputStore(state => selectActiveVoiceProvider(state)?.preparation.phase)
  const loadCatalog = useVoiceInputStore(state => state.loadCatalog)
  const [supported] = useState(() => isDesktopRuntime() && isVoiceCaptureSupported())
  const { phase, issue, pendingText } = dictation

  useEffect(() => {
    if (supported) void loadCatalog()
  }, [loadCatalog, supported])

  const engaged = phase !== 'idle' || pendingText !== null || issue !== null
  if (!supported || (!ready && !needsModel && !engaged)) return null

  const openVoiceSettings = () => {
    useUIStore.getState().setPendingSettingsTab('voice')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }
  const label = !needsModel
    ? t('voice.composer.start')
    : modelPhase === 'downloading' || modelPhase === 'verifying'
      ? t('voice.composer.modelDownloading')
      : t('voice.composer.needsModel')

  return (
    <div data-testid="voice-input" className="relative flex shrink-0 items-center">
      <IconButton
        icon={<Mic size={mobile ? 20 : 16} strokeWidth={1.75} aria-hidden="true" />}
        label={label}
        size={mobile ? '2xl' : 'md'}
        tone="secondary"
        data-needs-model={needsModel || undefined}
        // Keep the caret in the composer: a click would otherwise blur it, and
        // the write-back position is the caret the user left there.
        onMouseDown={event => event.preventDefault()}
        onClick={needsModel ? openVoiceSettings : dictation.toggle}
      />

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
