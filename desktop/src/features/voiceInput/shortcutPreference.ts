import { create } from 'zustand'
import {
  defaultVoiceShortcut,
  detectShortcutPlatform,
  parseVoiceShortcut,
  sameShortcut,
  type ShortcutPlatform,
  type VoiceShortcut,
} from './shortcut'

/**
 * Kept on this device only, like the microphone choice: the right key depends
 * on the keyboard, layout and input method in front of the user.
 */
export const VOICE_SHORTCUT_STORAGE_KEY = 'cc-haha-voice-input-shortcut'

type StoredPreference = {
  enabled: boolean
  /** null: the platform default, which can then change without a migration. */
  shortcut: VoiceShortcut | null
}

const DEFAULT_PREFERENCE: StoredPreference = { enabled: true, shortcut: null }

/** Absent, unreadable or malformed storage all mean the defaults. */
export function readVoiceShortcutPreference(): StoredPreference {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(VOICE_SHORTCUT_STORAGE_KEY)
  } catch {
    return DEFAULT_PREFERENCE
  }
  if (!raw) return DEFAULT_PREFERENCE
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return DEFAULT_PREFERENCE
    const record = value as Record<string, unknown>
    return {
      enabled: record.enabled !== false,
      shortcut: parseVoiceShortcut(record.shortcut),
    }
  } catch {
    return DEFAULT_PREFERENCE
  }
}

function writeVoiceShortcutPreference(preference: StoredPreference): void {
  try {
    if (preference.enabled && !preference.shortcut) localStorage.removeItem(VOICE_SHORTCUT_STORAGE_KEY)
    else localStorage.setItem(VOICE_SHORTCUT_STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // Storage can be blocked or full; the choice then lasts only until reload.
  }
}

type VoiceShortcutState = StoredPreference & {
  platform: ShortcutPlatform
  setEnabled: (enabled: boolean) => void
  setShortcut: (shortcut: VoiceShortcut) => void
  resetShortcut: () => void
}

export const useVoiceShortcutStore = create<VoiceShortcutState>((set, get) => {
  const persist = (patch: Partial<StoredPreference>) => {
    const { enabled, shortcut } = { ...get(), ...patch }
    set(patch)
    writeVoiceShortcutPreference({ enabled, shortcut })
  }
  return {
    ...readVoiceShortcutPreference(),
    platform: detectShortcutPlatform(),
    setEnabled: enabled => persist({ enabled }),
    setShortcut: (shortcut) => {
      // Picking the default again stores nothing, so it keeps following the default.
      persist({ shortcut: sameShortcut(shortcut, defaultVoiceShortcut(get().platform)) ? null : shortcut })
    },
    resetShortcut: () => persist({ shortcut: null }),
  }
})

/** The shortcut in force, or null while switched off. */
export function selectActiveVoiceShortcut(state: Pick<VoiceShortcutState, 'enabled' | 'shortcut' | 'platform'>): VoiceShortcut | null {
  if (!state.enabled) return null
  return state.shortcut ?? defaultVoiceShortcut(state.platform)
}
