import { beforeEach, describe, expect, it } from 'vitest'
import {
  readVoiceShortcutPreference,
  selectActiveVoiceShortcut,
  useVoiceShortcutStore,
  VOICE_SHORTCUT_STORAGE_KEY,
} from './shortcutPreference'

beforeEach(() => {
  localStorage.clear()
  useVoiceShortcutStore.setState({ enabled: true, shortcut: null, platform: 'mac' })
})

describe('reading', () => {
  it('starts switched on with the platform default when nothing was saved', () => {
    expect(readVoiceShortcutPreference()).toEqual({ enabled: true, shortcut: null })
  })

  it.each([
    ['not JSON', '{oops'],
    ['not an object', '"AltRight"'],
    ['null', 'null'],
  ])('falls back to the defaults when the stored value is %s', (_name, raw) => {
    localStorage.setItem(VOICE_SHORTCUT_STORAGE_KEY, raw)
    expect(readVoiceShortcutPreference()).toEqual({ enabled: true, shortcut: null })
  })

  it('keeps the switch but drops a shortcut it cannot read', () => {
    localStorage.setItem(VOICE_SHORTCUT_STORAGE_KEY, JSON.stringify({ enabled: false, shortcut: { kind: 'modifier', code: 'KeyQ' } }))
    expect(readVoiceShortcutPreference()).toEqual({ enabled: false, shortcut: null })
  })
})

describe('writing', () => {
  it('saves a custom shortcut and reads it back', () => {
    useVoiceShortcutStore.getState().setShortcut({ kind: 'chord', modifiers: ['shift', 'meta'], code: 'Space' })
    expect(readVoiceShortcutPreference()).toEqual({
      enabled: true,
      shortcut: { kind: 'chord', modifiers: ['shift', 'meta'], code: 'Space' },
    })
  })

  it('stores nothing for the default, so it keeps following the platform default', () => {
    const store = useVoiceShortcutStore.getState()
    store.setShortcut({ kind: 'chord', modifiers: ['shift', 'meta'], code: 'Space' })
    store.setShortcut({ kind: 'modifier', code: 'AltRight' })
    expect(useVoiceShortcutStore.getState().shortcut).toBeNull()
    expect(localStorage.getItem(VOICE_SHORTCUT_STORAGE_KEY)).toBeNull()
  })

  it('remembers being switched off', () => {
    useVoiceShortcutStore.getState().setEnabled(false)
    expect(readVoiceShortcutPreference().enabled).toBe(false)
    expect(selectActiveVoiceShortcut(useVoiceShortcutStore.getState())).toBeNull()
  })
})
