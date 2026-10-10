import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/voiceInput/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voiceInput/recorder')>()),
  isVoiceCaptureSupported: () => true,
}))

import { translate } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/en'
import { browserHost } from '@/lib/desktopHost/browserHost'
import { registerDictationTarget } from '@/features/voiceInput/shortcutController'
import { useVoiceShortcutStore, VOICE_SHORTCUT_STORAGE_KEY } from '@/features/voiceInput/shortcutPreference'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { VoiceShortcutSettings } from './VoiceShortcutSettings'

const en = (key: TranslationKey, params?: Record<string, string>) => translate('en', key, params)

const recorder = () => screen.getByTestId('voice-shortcut-recorder')

function keyDown(init: { code: string; key: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }) {
  fireEvent.keyDown(recorder(), init)
}

function keyUp(init: { code: string; key: string }) {
  fireEvent.keyUp(recorder(), init)
}

function startListening() {
  fireEvent.click(recorder())
  expect(recorder()).toHaveAttribute('data-listening', 'true')
}

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useVoiceShortcutStore.setState({ enabled: true, shortcut: null, platform: 'mac' })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'desktopHost')
})

describe('VoiceShortcutSettings', () => {
  it('shows the platform default as keycaps', () => {
    render(<VoiceShortcutSettings />)
    expect(recorder()).toHaveAccessibleName(en('voice.settings.shortcut.key.change', { shortcut: 'Right ⌥' }))
    expect(recorder()).toHaveTextContent('Right ⌥')
    expect(screen.queryByRole('button', { name: en('voice.settings.shortcut.reset') })).toBeNull()
  })

  it('records a combination, saves it, and can go back to the default', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'ShiftLeft', key: 'Shift', shiftKey: true })
    keyDown({ code: 'MetaLeft', key: 'Meta', shiftKey: true, metaKey: true })
    keyDown({ code: 'Space', key: ' ', shiftKey: true, metaKey: true })

    expect(recorder()).not.toHaveAttribute('data-listening')
    expect(recorder()).toHaveAccessibleName(en('voice.settings.shortcut.key.change', { shortcut: '⇧⌘Space' }))
    expect(JSON.parse(localStorage.getItem(VOICE_SHORTCUT_STORAGE_KEY)!)).toEqual({
      enabled: true,
      shortcut: { kind: 'chord', modifiers: ['shift', 'meta'], code: 'Space' },
    })

    fireEvent.click(screen.getByRole('button', { name: en('voice.settings.shortcut.reset') }))
    expect(recorder()).toHaveTextContent('Right ⌥')
    expect(localStorage.getItem(VOICE_SHORTCUT_STORAGE_KEY)).toBeNull()
  })

  it('records a modifier pressed and released on its own', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'ControlRight', key: 'Control', ctrlKey: true })
    keyUp({ code: 'ControlRight', key: 'Control' })

    expect(useVoiceShortcutStore.getState().shortcut).toEqual({ kind: 'modifier', code: 'ControlRight' })
    expect(recorder()).toHaveTextContent('Right ⌃')
  })

  it('refuses a key cc-haha already uses and keeps the old one', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'KeyK', key: 'k', metaKey: true })

    expect(screen.getByRole('alert')).toHaveTextContent(en('voice.settings.shortcut.rejected', {
      shortcut: '⌘K',
      reason: en('voice.settings.shortcut.reason.app'),
    }))
    expect(useVoiceShortcutStore.getState().shortcut).toBeNull()
    expect(recorder()).toHaveTextContent('Right ⌥')
  })

  it('refuses Caps Lock, whose press and release do not pair up', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'CapsLock', key: 'CapsLock' })
    keyUp({ code: 'CapsLock', key: 'CapsLock' })

    expect(screen.getByRole('alert')).toHaveTextContent(en('voice.settings.shortcut.reason.unsupported'))
    expect(useVoiceShortcutStore.getState().shortcut).toBeNull()
  })

  it('keeps a key input methods may take, with a warning', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'Space', key: ' ', ctrlKey: true })

    expect(useVoiceShortcutStore.getState().shortcut).toEqual({ kind: 'chord', modifiers: ['ctrl'], code: 'Space' })
    expect(screen.getByRole('status')).toHaveTextContent(en('voice.settings.shortcut.mayConflict', {
      reason: en('voice.settings.shortcut.reason.inputMethod'),
    }))
  })

  it('Esc stops listening and changes nothing', () => {
    render(<VoiceShortcutSettings />)
    startListening()
    keyDown({ code: 'Escape', key: 'Escape' })

    expect(recorder()).not.toHaveAttribute('data-listening')
    expect(useVoiceShortcutStore.getState().shortcut).toBeNull()
  })

  it('hides the key row while switched off, and remembers the switch', () => {
    render(<VoiceShortcutSettings />)
    fireEvent.click(screen.getByRole('switch', { name: en('voice.settings.shortcut.enable.label') }))

    expect(screen.queryByTestId('voice-shortcut-recorder')).toBeNull()
    expect(JSON.parse(localStorage.getItem(VOICE_SHORTCUT_STORAGE_KEY)!)).toEqual({ enabled: false, shortcut: null })
  })

  it('does not dictate while a new shortcut is being recorded', () => {
    window.desktopHost = { ...browserHost, kind: 'electron', isDesktop: true }
    useVoiceInputStore.setState({
      catalog: {
        supported: true,
        providers: [{
          info: { id: 'sensevoice-local', name: 'SenseVoice', location: 'local', languages: ['auto'] },
          preparation: { phase: 'ready' },
        }],
        preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
        limits: { maxAudioSeconds: 60, maxAudioBytes: 10_000_000 },
      },
    })
    const target = { hasFocus: () => false, isActive: () => false, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }
    const unregister = registerDictationTarget(target)
    try {
      render(<VoiceShortcutSettings />)
      startListening()
      // The current shortcut itself, pressed to record it again.
      keyDown({ code: 'AltRight', key: 'Alt', altKey: true })
      keyUp({ code: 'AltRight', key: 'Alt' })
      expect(recorder()).not.toHaveAttribute('data-listening')
      expect(target.start).not.toHaveBeenCalled()

      // Once recording is over, the same tap dictates.
      fireEvent.keyDown(document.body, { code: 'AltRight', key: 'Alt', altKey: true })
      fireEvent.keyUp(document.body, { code: 'AltRight', key: 'Alt' })
      expect(target.start).toHaveBeenCalledTimes(1)
    } finally {
      unregister()
    }
  })
})
