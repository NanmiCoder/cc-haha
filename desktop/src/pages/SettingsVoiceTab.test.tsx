import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    providerStatus: vi.fn(),
    removeAssets: vi.fn(),
    transcribe: vi.fn(),
  },
}))
vi.mock('@/features/voiceInput/devices', () => ({ listAudioInputs: vi.fn().mockResolvedValue([]) }))
vi.mock('@/features/voiceInput/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voiceInput/recorder')>()),
  isVoiceCaptureSupported: vi.fn(() => true),
}))
// The browser (H5) shell renders these two panels; their own tests cover them.
vi.mock('./settings/ProviderSettings', () => ({ ProviderSettings: () => <div>provider-panel</div> }))
vi.mock('./settings/H5GeneralSettings', () => ({ H5GeneralSettings: () => <div>general-panel</div> }))

import { voiceApi } from '@/api/voice'
import { DesktopSettings } from './Settings'
import { H5Settings } from './settings/H5Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useVoiceInputStore } from '../stores/voiceInputStore'

const catalog = {
  supported: true,
  providers: [{
    info: { id: 'sensevoice-local', name: 'SenseVoice (local)', location: 'local' as const, languages: ['auto' as const], downloadBytes: 1 },
    preparation: { phase: 'unprepared' as const },
  }],
  preferences: { enabled: false, providerId: 'sensevoice-local', language: 'auto' as const, downloadSource: 'auto' as const },
  limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() })
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
  useVoiceInputStore.setState({ catalog: null, loading: false, error: null })
  vi.mocked(voiceApi.catalog).mockResolvedValue(catalog)
})

afterEach(() => {
  cleanup()
  useUIStore.setState({ activeSettingsTab: 'providers', pendingSettingsTab: null })
})

describe('Voice Input settings tab wiring', () => {
  it('adds a Voice Input entry to the desktop rail that opens the panel and remembers the choice', async () => {
    render(<DesktopSettings />)

    fireEvent.click(within(screen.getByTestId('settings-navigation')).getByRole('button', { name: 'Voice Input' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Voice Input' })).toBeInTheDocument()
    expect(useUIStore.getState().activeSettingsTab).toBe('voice')
    expect(localStorage.getItem('cc-haha-active-settings-tab')).toBe('voice')
  })

  it('opens the panel for a pending request, so other screens can deep-link to it', async () => {
    useUIStore.setState({ pendingSettingsTab: 'voice' })
    render(<DesktopSettings />)

    expect(await screen.findByRole('heading', { level: 2, name: 'Voice Input' })).toBeInTheDocument()
    expect(useUIStore.getState().pendingSettingsTab).toBeNull()
    expect(screen.getByRole('button', { name: 'Voice Input', current: 'page' })).toBeInTheDocument()
  })

  it('restores the tab from storage on the next launch', async () => {
    localStorage.setItem('cc-haha-active-settings-tab', 'voice')
    vi.resetModules()
    const fresh = await import('../stores/uiStore')
    expect(fresh.useUIStore.getState().activeSettingsTab).toBe('voice')
  })

  it('keeps voice out of the browser shell: a stored voice tab opens the settings list instead', async () => {
    useUIStore.setState({ activeSettingsTab: 'voice' })
    render(<H5Settings />)

    expect(await screen.findByTestId('h5-settings-providers')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Voice Input' })).not.toBeInTheDocument()
  })
})
