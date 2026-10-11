import type { TranslationKey } from '@/i18n'
import { shortcutKeyLabels, type ShortcutKeyLabel, type ShortcutPlatform, type VoiceShortcut } from './shortcut'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** One keycap's text, with "Right"/"Left" spelled out for a lone modifier. */
export function keyLabelText(label: ShortcutKeyLabel, t: Translate): string {
  if (label.side === 'right') return t('voice.shortcut.side.right', { key: label.text })
  if (label.side === 'left') return t('voice.shortcut.side.left', { key: label.text })
  return label.text
}

/** The whole shortcut as one line of text, for tooltips and messages. */
export function voiceShortcutText(shortcut: VoiceShortcut, platform: ShortcutPlatform, t: Translate): string {
  return shortcutKeyLabels(shortcut, platform).map(label => keyLabelText(label, t)).join(platform === 'mac' ? '' : '+')
}
