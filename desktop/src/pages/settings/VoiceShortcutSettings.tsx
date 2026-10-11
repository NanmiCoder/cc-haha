import { useEffect, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, Ban } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import {
  chordFromKeyEvent,
  classifyVoiceShortcut,
  isModifierCode,
  isSoloModifierCode,
  shortcutKeyLabels,
  type ShortcutConflictReason,
  type VoiceShortcut,
} from '@/features/voiceInput/shortcut'
import { suspendVoiceShortcut } from '@/features/voiceInput/shortcutController'
import { selectActiveVoiceShortcut, useVoiceShortcutStore } from '@/features/voiceInput/shortcutPreference'
import { keyLabelText, voiceShortcutText } from '@/features/voiceInput/shortcutText'

const REASON_KEYS: Record<ShortcutConflictReason, TranslationKey> = {
  typing: 'voice.settings.shortcut.reason.typing',
  editing: 'voice.settings.shortcut.reason.editing',
  app: 'voice.settings.shortcut.reason.app',
  system: 'voice.settings.shortcut.reason.system',
  unsupported: 'voice.settings.shortcut.reason.unsupported',
  inputMethod: 'voice.settings.shortcut.reason.inputMethod',
  altGr: 'voice.settings.shortcut.reason.altGr',
  launcher: 'voice.settings.shortcut.reason.launcher',
  menuBar: 'voice.settings.shortcut.reason.menuBar',
  desktopShortcut: 'voice.settings.shortcut.reason.desktopShortcut',
}

const KEYCAP_CLASS = 'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-1.5 font-mono text-xs leading-none text-[var(--color-text-primary)]'

type Rejection = { text: string; reason: ShortcutConflictReason }

/**
 * Settings → Voice input → Keyboard shortcut. Works only while the cc-haha
 * window is in front: a tap starts dictation and the next press ends it, a hold
 * records until release.
 *
 * Recording a new shortcut refuses cc-haha's own and the system's keys, and
 * keeps keys that input methods or common tools may take with a warning.
 */
export function VoiceShortcutSettings() {
  const t = useTranslation()
  const enabled = useVoiceShortcutStore(state => state.enabled)
  const custom = useVoiceShortcutStore(state => state.shortcut)
  const platform = useVoiceShortcutStore(state => state.platform)
  const active = useVoiceShortcutStore(selectActiveVoiceShortcut)
  const setEnabled = useVoiceShortcutStore(state => state.setEnabled)
  const setShortcut = useVoiceShortcutStore(state => state.setShortcut)
  const resetShortcut = useVoiceShortcutStore(state => state.resetShortcut)

  const [listening, setListening] = useState(false)
  /** A lone modifier that went down: becomes the shortcut if released alone. */
  const [pendingModifier, setPendingModifier] = useState<string | null>(null)
  const [rejection, setRejection] = useState<Rejection | null>(null)

  useEffect(() => {
    if (!listening) return
    return suspendVoiceShortcut()
  }, [listening])

  const stopListening = () => {
    setListening(false)
    setPendingModifier(null)
  }

  const offer = (candidate: VoiceShortcut) => {
    stopListening()
    const verdict = classifyVoiceShortcut(candidate, platform)
    if (verdict.level === 'blocked') {
      setRejection({ text: voiceShortcutText(candidate, platform, t), reason: verdict.reason })
      return
    }
    setRejection(null)
    setShortcut(candidate)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!listening) return
    event.preventDefault()
    event.stopPropagation()
    const native = event.nativeEvent
    if (native.isComposing || event.repeat) return
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      stopListening()
      return
    }
    if (isModifierCode(event.code)) {
      setPendingModifier(event.code)
      return
    }
    setPendingModifier(null)
    const chord = chordFromKeyEvent(native)
    if (chord) offer(chord)
  }

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!listening || !pendingModifier) return
    event.preventDefault()
    if (event.code !== pendingModifier) return
    if (isSoloModifierCode(event.code)) {
      offer({ kind: 'modifier', code: event.code })
    } else {
      // Caps Lock and Fn: the press and release do not arrive as a pair.
      stopListening()
      setRejection({ text: event.code === 'CapsLock' ? 'Caps Lock' : 'Fn', reason: 'unsupported' })
    }
  }

  const verdict = active ? classifyVoiceShortcut(active, platform) : null
  const shortcutText = active ? voiceShortcutText(active, platform, t) : ''

  let footer = null
  if (enabled && rejection) {
    footer = (
      <p role="alert" className="flex items-start gap-1.5 text-xs leading-[1.5] text-[var(--color-error)]">
        <Ban size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t('voice.settings.shortcut.rejected', { shortcut: rejection.text, reason: t(REASON_KEYS[rejection.reason]) })}</span>
      </p>
    )
  } else if (enabled && verdict && verdict.level !== 'ok') {
    footer = (
      <p role="status" className="flex items-start gap-1.5 text-xs leading-[1.5] text-[var(--color-warning)]">
        <AlertTriangle size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t('voice.settings.shortcut.mayConflict', { reason: t(REASON_KEYS[verdict.reason]) })}</span>
      </p>
    )
  }

  return (
    <SettingsSection title={t('voice.settings.shortcut.title')} description={t('voice.settings.shortcut.description')}>
      <SettingsGroup>
        <SettingsSwitchRow
          title={t('voice.settings.shortcut.enable.label')}
          description={t('voice.settings.shortcut.enable.description')}
          checked={enabled}
          onChange={(next) => {
            stopListening()
            setRejection(null)
            setEnabled(next)
          }}
        />
        {enabled ? (
          <SettingsRow
            title={t('voice.settings.shortcut.key.label')}
            description={t('voice.settings.shortcut.key.description')}
            footer={footer}
            layout="inline"
          >
            <div className="flex items-center gap-2">
              {custom ? (
                <Button variant="ghost" size="sm" onClick={() => { stopListening(); setRejection(null); resetShortcut() }}>
                  {t('voice.settings.shortcut.reset')}
                </Button>
              ) : null}
              <button
                type="button"
                data-testid="voice-shortcut-recorder"
                data-listening={listening || undefined}
                aria-label={listening
                  ? t('voice.settings.shortcut.key.listening')
                  : t('voice.settings.shortcut.key.change', { shortcut: shortcutText })}
                onClick={() => {
                  if (listening) {
                    stopListening()
                  } else {
                    setRejection(null)
                    setListening(true)
                  }
                }}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onBlur={stopListening}
                className={[
                  'inline-flex min-h-[30px] min-w-[96px] items-center justify-center gap-1 rounded-[var(--radius-md)] border px-1.5 py-1',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]',
                  listening
                    ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]'
                    : 'border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-container-lowest)] hover:bg-[var(--color-surface-hover)]',
                ].join(' ')}
              >
                {listening ? (
                  <span aria-live="polite" className="px-1 text-xs text-[var(--color-brand)]">
                    {t('voice.settings.shortcut.key.listening')}
                  </span>
                ) : active ? (
                  shortcutKeyLabels(active, platform).map((label, index) => (
                    <kbd key={index} className={KEYCAP_CLASS}>{keyLabelText(label, t)}</kbd>
                  ))
                ) : null}
              </button>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsGroup>
    </SettingsSection>
  )
}
