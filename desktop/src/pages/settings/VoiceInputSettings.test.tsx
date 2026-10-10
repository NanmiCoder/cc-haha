import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type {
  VoiceCatalog,
  VoiceLanguage,
  VoicePreparationState,
  VoiceProviderStatus,
  VoiceTranscript,
} from '@/api/voice'

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

vi.mock('@/features/voiceInput/devices', () => ({
  listAudioInputs: vi.fn(),
}))

vi.mock('@/features/voiceInput/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/voiceInput/recorder')>()),
  isVoiceCaptureSupported: vi.fn(),
  startRecording: vi.fn(),
}))

import { voiceApi } from '@/api/voice'
import { listAudioInputs } from '@/features/voiceInput/devices'
import { getPreferredMicrophoneId } from '@/features/voiceInput/devicePreference'
import {
  isVoiceCaptureSupported,
  startRecording,
  VoiceRecorderError,
  type StartRecordingOptions,
} from '@/features/voiceInput/recorder'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { VoiceInputSettings } from './VoiceInputSettings'

const api = vi.mocked(voiceApi)
const listInputs = vi.mocked(listAudioInputs)
const captureSupported = vi.mocked(isVoiceCaptureSupported)
const start = vi.mocked(startRecording)

const MODEL_BYTES = 241_357_257

function makeProvider(
  preparation: VoicePreparationState,
  overrides: Partial<VoiceProviderStatus['info']> = {},
): VoiceProviderStatus {
  return {
    info: {
      id: 'sensevoice-local',
      name: 'SenseVoice (local)',
      location: 'local',
      languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      downloadBytes: MODEL_BYTES,
      ...overrides,
    },
    preparation,
  }
}

function makeCatalog(
  preparation: VoicePreparationState,
  patch: Partial<VoiceCatalog> = {},
): VoiceCatalog {
  return {
    supported: true,
    providers: [makeProvider(preparation)],
    preferences: { enabled: false, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 5_000_000 },
    ...patch,
  }
}

const READY: VoicePreparationState = { phase: 'ready' }
const UNPREPARED: VoicePreparationState = { phase: 'unprepared' }

async function renderPage(catalog: VoiceCatalog) {
  api.catalog.mockResolvedValue(catalog)
  render(<VoiceInputSettings />)
  await screen.findByRole('heading', { name: 'Voice Input' })
  await screen.findByTestId('voice-model-status')
}

/** The library Dropdown: a trigger button, then a listbox of role=option rows once opened. */
const trigger = (name: string) => screen.getByRole('button', { name })
function openPicker(name: string) {
  fireEvent.click(trigger(name))
  return screen.getByRole('listbox', { name })
}
const optionLabels = (list: HTMLElement) =>
  within(list).getAllByRole('option').map(option => option.querySelector('.font-medium')?.textContent)

function fakeRecording(overrides: Partial<{ level: number; wav: Blob; seconds: number }> = {}) {
  const wav = overrides.wav ?? new Blob(['wav'], { type: 'audio/wav' })
  return {
    getLevel: vi.fn(() => overrides.level ?? 0.5),
    stop: vi.fn().mockResolvedValue({ wav, seconds: overrides.seconds ?? 5.6 }),
    cancel: vi.fn(),
  }
}

const TRANSCRIPT: VoiceTranscript = { text: 'hello from the microphone', audioSeconds: 5.6, inferenceSeconds: 0.104 }

let mediaDevices: EventTarget
let objectUrlCounter: number
const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useVoiceInputStore.setState({ catalog: null, loading: false, error: null })
  captureSupported.mockReturnValue(true)
  listInputs.mockResolvedValue([])
  api.updatePreferences.mockImplementation(async (patch) => ({
    preferences: { ...useVoiceInputStore.getState().catalog!.preferences, ...patch },
  }))

  mediaDevices = new EventTarget()
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true })
  objectUrlCounter = 0
  createObjectURL.mockImplementation(() => `blob:voice-${++objectUrlCounter}`)
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true })
})

afterEach(async () => {
  cleanup()
  // Stop any status poll a test left running so it cannot leak into the next one.
  api.cancelPrepare.mockResolvedValue(makeProvider(UNPREPARED))
  await useVoiceInputStore.getState().cancelPrepare('sensevoice-local')
  Reflect.deleteProperty(navigator, 'mediaDevices')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('VoiceInputSettings loading states', () => {
  it('shows a retryable error when the catalog cannot be loaded', async () => {
    api.catalog.mockRejectedValueOnce(new Error('offline'))
    render(<VoiceInputSettings />)

    expect(await screen.findByText('Could not load voice input settings.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('offline')

    api.catalog.mockResolvedValue(makeCatalog(UNPREPARED))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('voice-model-status')).toBeInTheDocument()
  })

  it('replaces the whole page with a notice when the platform is unsupported', async () => {
    api.catalog.mockResolvedValue(makeCatalog(UNPREPARED, { supported: false }))
    render(<VoiceInputSettings />)

    expect(await screen.findByText('Local speech recognition is not supported on this platform yet')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-model-status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start test' })).not.toBeInTheDocument()
  })

  it('re-reads the catalog every time the tab is entered', async () => {
    useVoiceInputStore.setState({ catalog: makeCatalog(UNPREPARED) })
    api.catalog.mockResolvedValue(makeCatalog(READY))
    render(<VoiceInputSettings />)

    await waitFor(() => expect(screen.getByTestId('voice-model-status')).toHaveAttribute('data-phase', 'ready'))
    expect(api.catalog).toHaveBeenCalledTimes(1)
  })
})

describe('VoiceInputSettings layout', () => {
  it('keeps four cards under short headings: recognition, microphone, shortcut, test', async () => {
    await renderPage(makeCatalog(READY))

    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['Voice Input'])
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Recognition engine',
      'Microphone',
      'Keyboard shortcut',
      'Transcription test',
    ])
    // Enable, engine, model and language are rows of the first card, not cards of their own.
    const card = screen.getByRole('switch', { name: 'Enable voice input' }).closest('section')!
    expect(within(card).getByRole('button', { name: 'Engine' })).toBeInTheDocument()
    expect(within(card).getByTestId('voice-model-status')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Language' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Input device' }).closest('section')).not.toBe(card)
    // No bordered box nested in the card.
    expect(screen.getByTestId('voice-model-status').className).not.toMatch(/\bborder\b/)
  })

  it('separates the rows of a card with the divider token', async () => {
    await renderPage(makeCatalog(READY))
    const rows = screen.getByTestId('voice-model-status').parentElement!
    expect(rows.className).toContain('divide-y')
    expect(rows.className).toContain('divide-[var(--color-border)]')
  })
})

describe('VoiceInputSettings model status', () => {
  it('shows a quiet local size line from the provider, and not for a cloud provider or an unknown size', async () => {
    await renderPage(makeCatalog(UNPREPARED))
    expect(screen.getByText('Local recognition · about 230 MB')).toBeInTheDocument()

    cleanup()
    useVoiceInputStore.setState({ catalog: null })
    const cloud = makeCatalog(UNPREPARED)
    cloud.providers[0]!.info.location = 'cloud'
    await renderPage(cloud)
    expect(screen.queryByText(/Local recognition/)).not.toBeInTheDocument()

    cleanup()
    useVoiceInputStore.setState({ catalog: null })
    const unknown = makeCatalog(UNPREPARED)
    delete unknown.providers[0]!.info.downloadBytes
    await renderPage(unknown)
    expect(screen.queryByText(/Local recognition/)).not.toBeInTheDocument()
  })

  it('offers the download and starts it on click', async () => {
    await renderPage(makeCatalog(UNPREPARED))
    expect(screen.getByText('The speech model is not downloaded.')).toBeInTheDocument()

    api.prepare.mockResolvedValue(makeProvider({ phase: 'downloading', step: 'runtime', resource: 'runtime.tar.gz', completedBytes: 0, totalBytes: 1000 }))
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'downloading', step: 'runtime', resource: 'runtime.tar.gz', completedBytes: 0, totalBytes: 1000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith('sensevoice-local'))
    await waitFor(() => expect(screen.getByTestId('voice-model-status')).toHaveAttribute('data-phase', 'downloading'))
    // Downloading only starts from the explicit click, never from the toggle or the page load.
    expect(api.prepare).toHaveBeenCalledTimes(1)
  })

  it('shows step, resource, byte counts, progress, resume note and source while downloading', async () => {
    api.providerStatus.mockResolvedValue(makeProvider(UNPREPARED))
    await renderPage(makeCatalog({
      phase: 'downloading',
      step: 'model',
      resource: 'model.int8.onnx',
      completedBytes: 100 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
      resumedFromBytes: 60 * 1024 * 1024,
      source: 'https://hf-mirror.com/model.int8.onnx',
    }))

    const card = screen.getByTestId('voice-model-status')
    expect(within(card).getByText(/Downloading speech model/)).toBeInTheDocument()
    expect(within(card).getByText('· model.int8.onnx')).toBeInTheDocument()
    expect(within(card).getByText('100 MB / 200 MB')).toBeInTheDocument()
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(within(card).getByText('Resumed from 60 MB that was already downloaded')).toBeInTheDocument()
    expect(within(card).getByText('Source: https://hf-mirror.com/model.int8.onnx')).toBeInTheDocument()
  })

  it('omits the resume note for a fresh download and uses an indeterminate bar without a total', async () => {
    api.providerStatus.mockResolvedValue(makeProvider(UNPREPARED))
    await renderPage(makeCatalog({ phase: 'downloading', step: 'runtime', resource: 'runtime.tar.gz' }))

    const card = screen.getByTestId('voice-model-status')
    expect(within(card).queryByText(/Resumed from/)).not.toBeInTheDocument()
    expect(within(card).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it('cancels a running download', async () => {
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'downloading', step: 'model', completedBytes: 1, totalBytes: 2 }))
    await renderPage(makeCatalog({ phase: 'downloading', step: 'model', completedBytes: 1, totalBytes: 2 }))

    api.cancelPrepare.mockResolvedValue(makeProvider({ phase: 'cancelled' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(api.cancelPrepare).toHaveBeenCalledWith('sensevoice-local'))
    await waitFor(() => expect(screen.getByTestId('voice-model-status')).toHaveAttribute('data-phase', 'cancelled'))
  })

  it('reports verification without offering cancel', async () => {
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'verifying' }))
    await renderPage(makeCatalog({ phase: 'verifying' }))

    const card = screen.getByTestId('voice-model-status')
    expect(within(card).getAllByText('Verifying downloaded files…').length).toBeGreaterThan(0)
    expect(within(card).queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows a paused download as resumable', async () => {
    await renderPage(makeCatalog({ phase: 'cancelled' }))
    expect(screen.getByText(/Paused\. Parts already downloaded are kept/)).toBeInTheDocument()

    api.prepare.mockResolvedValue(makeProvider({ phase: 'ready' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue download' }))
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith('sensevoice-local'))
  })

  it('confirms before deleting a ready model, and keeps it when the dialog is dismissed', async () => {
    await renderPage(makeCatalog(READY))
    expect(screen.getByText('Local model is ready. It wakes up automatically when you record.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete model' }))
    expect(await screen.findByText('Delete the local speech model?')).toBeInTheDocument()
    expect(api.removeAssets).not.toHaveBeenCalled()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Delete the local speech model?')).not.toBeInTheDocument())
    expect(api.removeAssets).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete model' }))
    api.removeAssets.mockResolvedValue(makeProvider(UNPREPARED))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.removeAssets).toHaveBeenCalledWith('sensevoice-local'))
    await waitFor(() => expect(screen.getByTestId('voice-model-status')).toHaveAttribute('data-phase', 'unprepared'))
    expect(screen.queryByText('Delete the local speech model?')).not.toBeInTheDocument()
  })

  it.each([
    ['network', 'Download failed: network connection problem'],
    ['dns', 'Download failed: could not resolve the download address'],
    ['timeout', 'Download failed: the connection timed out'],
    ['certificate', 'Download failed: the secure connection could not be verified'],
    ['http', 'Download failed: the server returned an error'],
    ['integrity', 'Download failed: the file check did not match, so the file will be downloaded again'],
    ['storage', 'Download failed: could not write to disk (check free space and permissions)'],
    ['unknown', 'Download failed for an unknown reason'],
  ] as const)('explains a %s failure and retries the download', async (reason, text) => {
    await renderPage(makeCatalog({
      phase: 'failed',
      error: { reason, source: 'https://huggingface.co/model.onnx', message: 'raw failure detail' },
    }))

    expect(screen.getByRole('alert', { name: '' })).toHaveTextContent(text)
    expect(screen.getByText('raw failure detail')).toBeInTheDocument()
    expect(screen.getByText('Source: https://huggingface.co/model.onnx')).toBeInTheDocument()

    api.prepare.mockResolvedValue(makeProvider({ phase: 'ready' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith('sensevoice-local'))
  })

  it('tells network-class failures that the downloaded part is kept, but not integrity failures', async () => {
    await renderPage(makeCatalog({ phase: 'failed', error: { reason: 'network', message: 'boom' } }))
    expect(screen.getByText(/Parts already downloaded are kept\. Retry once the network is back/)).toBeInTheDocument()

    cleanup()
    useVoiceInputStore.setState({ catalog: null })
    await renderPage(makeCatalog({ phase: 'failed', error: { reason: 'integrity', message: 'bad hash' } }))
    expect(screen.queryByText(/Retry once the network is back/)).not.toBeInTheDocument()
  })

  it('does not offer a retry on a platform the runtime cannot support', async () => {
    await renderPage(makeCatalog({ phase: 'failed', error: { reason: 'unsupported-platform', message: 'no runtime' } }))
    expect(screen.getByText('This platform is not supported by the local speech runtime')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})

describe('VoiceInputSettings partial downloads', () => {
  it.each([
    ['cancelled', { phase: 'cancelled', completedBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 }],
    ['failed', { phase: 'failed', completedBytes: 50 * 1024 * 1024, error: { reason: 'network', message: 'boom' } }],
    ['unprepared', { phase: 'unprepared', completedBytes: 50 * 1024 * 1024 }],
  ] as const)('lets a %s download with bytes on disk be deleted, after confirming', async (phase, preparation) => {
    await renderPage(makeCatalog(preparation as VoicePreparationState))
    expect(screen.getByTestId('voice-model-status')).toHaveAttribute('data-phase', phase)

    fireEvent.click(screen.getByRole('button', { name: 'Delete model' }))
    expect(await screen.findByText('Delete the local speech model?')).toBeInTheDocument()
    expect(api.removeAssets).not.toHaveBeenCalled()

    api.removeAssets.mockResolvedValue(makeProvider(UNPREPARED))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.removeAssets).toHaveBeenCalledWith('sensevoice-local'))
  })

  it.each([
    ['cancelled', { phase: 'cancelled' }],
    ['failed', { phase: 'failed', completedBytes: 0, error: { reason: 'network', message: 'boom' } }],
    ['unprepared', { phase: 'unprepared' }],
  ] as const)('offers no delete for a %s download with nothing on disk', async (_phase, preparation) => {
    await renderPage(makeCatalog(preparation as VoicePreparationState))
    expect(screen.queryByRole('button', { name: 'Delete model' })).not.toBeInTheDocument()
  })

  it('does not offer delete while a download is running', async () => {
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'downloading', completedBytes: 5, totalBytes: 10 }))
    await renderPage(makeCatalog({ phase: 'downloading', completedBytes: 5, totalBytes: 10 }))
    expect(screen.queryByRole('button', { name: 'Delete model' })).not.toBeInTheDocument()
  })
})

describe('VoiceInputSettings preferences', () => {
  it('saves the enable switch and warns, without downloading, when the model is missing', async () => {
    await renderPage(makeCatalog(UNPREPARED))
    expect(screen.queryByText(/Voice input is on, but the speech model is not downloaded yet/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable voice input' }))

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ enabled: true }))
    expect(await screen.findByText(/Voice input is on, but the speech model is not downloaded yet/)).toBeInTheDocument()
    expect(api.prepare).not.toHaveBeenCalled()
  })

  it('does not warn about a missing model once it is ready', async () => {
    await renderPage(makeCatalog(READY, { preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' } }))
    expect(screen.getByRole('switch', { name: 'Enable voice input' })).toBeChecked()
    expect(screen.queryByText(/Voice input is on, but the speech model is not downloaded yet/)).not.toBeInTheDocument()
  })

  it('shows a save failure instead of pretending the switch worked', async () => {
    await renderPage(makeCatalog(READY))
    api.updatePreferences.mockRejectedValueOnce(new Error('disk full'))

    fireEvent.click(screen.getByRole('switch', { name: 'Enable voice input' }))

    expect(await screen.findByText('Could not save this setting. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable voice input' })).not.toBeChecked()
  })

  it('offers only the languages the provider lists, labelled, and saves the pick', async () => {
    const catalog = makeCatalog(READY)
    catalog.providers[0]!.info.languages = ['auto', 'zh', 'yue']
    await renderPage(catalog)

    expect(trigger('Language')).toHaveTextContent('Auto detect')
    const list = openPicker('Language')
    expect(optionLabels(list)).toEqual(['Auto detect', 'Chinese (Mandarin)', 'Cantonese'])
    expect(within(list).getByRole('option', { name: 'Auto detect' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(within(list).getByRole('option', { name: 'Cantonese' }))
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ language: 'yue' }))
    await waitFor(() => expect(trigger('Language')).toHaveTextContent('Cantonese'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('falls back to the raw code for a language it has no label for', async () => {
    const catalog = makeCatalog(READY)
    catalog.providers[0]!.info.languages = ['auto', 'fr' as VoiceLanguage]
    await renderPage(catalog)

    expect(within(openPicker('Language')).getByRole('option', { name: 'fr' })).toBeInTheDocument()
  })

  it('renders every provider and moves to a language the new provider supports', async () => {
    const second: VoiceProviderStatus = makeProvider(READY, { id: 'other-engine', name: 'Other engine', languages: ['auto', 'en'] })
    const catalog = makeCatalog(READY, {
      preferences: { enabled: true, providerId: 'sensevoice-local', language: 'yue', downloadSource: 'auto' },
    })
    catalog.providers.push(second)
    await renderPage(catalog)

    expect(optionLabels(openPicker('Engine'))).toEqual(['SenseVoice (local)', 'Other engine'])

    fireEvent.click(screen.getByRole('option', { name: 'Other engine' }))
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ providerId: 'other-engine', language: 'auto' }))
  })

  it('renders a single provider as a normal engine control', async () => {
    await renderPage(makeCatalog(READY))
    expect(trigger('Engine')).toHaveTextContent('SenseVoice (local)')
    expect(within(openPicker('Engine')).getAllByRole('option')).toHaveLength(1)
  })
})

describe('VoiceInputSettings download source', () => {
  const hint = () => screen.getByRole('button', { name: 'Change proxy' }).closest('p')!

  it('offers the three sources before a download and saves the chosen one', async () => {
    await renderPage(makeCatalog(UNPREPARED))

    const list = openPicker('Download source')
    expect(optionLabels(list)).toEqual([
      'Automatic (first to respond)',
      'Official (Hugging Face, npm)',
      'China mirror (hf-mirror, npmmirror)',
    ])
    expect(within(list).getByRole('option', { name: 'Automatic (first to respond)' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(within(list).getByRole('option', { name: 'Official (Hugging Face, npm)' }))
    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ downloadSource: 'official' }))
    await waitFor(() => expect(trigger('Download source')).toHaveTextContent('Official (Hugging Face, npm)'))
  })

  it('hides the source picker once the model is installed', async () => {
    await renderPage(makeCatalog(READY))

    expect(screen.queryByRole('button', { name: 'Download source' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change proxy' })).not.toBeInTheDocument()
  })

  it('names the network proxy the download goes through', async () => {
    useSettingsStore.setState({ network: { ...useSettingsStore.getState().network, proxy: { mode: 'system', url: '' } } })
    await renderPage(makeCatalog(UNPREPARED))
    expect(hint()).toHaveTextContent('(current: System proxy)')
    cleanup()

    useSettingsStore.setState({
      network: { ...useSettingsStore.getState().network, proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } },
    })
    await renderPage(makeCatalog(UNPREPARED))
    expect(hint()).toHaveTextContent('(current: Manual proxy http://127.0.0.1:7890)')
    cleanup()

    useSettingsStore.setState({ network: { ...useSettingsStore.getState().network, proxy: { mode: 'direct', url: '' } } })
    await renderPage(makeCatalog(UNPREPARED))
    expect(hint()).toHaveTextContent('(current: Direct connection)')
  })

  it('opens the General tab, where the network proxy lives', async () => {
    useUIStore.setState({ activeSettingsTab: 'voice' })
    await renderPage(makeCatalog(UNPREPARED))

    fireEvent.click(screen.getByRole('button', { name: 'Change proxy' }))

    expect(useUIStore.getState().activeSettingsTab).toBe('general')
  })
})

describe('VoiceInputSettings microphone', () => {
  it('lists devices without asking for permission and stores the choice locally', async () => {
    listInputs.mockResolvedValue([
      { deviceId: 'mic-a', label: 'Built-in Microphone' },
      { deviceId: 'mic-b', label: 'USB Microphone' },
    ])
    await renderPage(makeCatalog(READY))

    expect(listInputs).toHaveBeenCalledWith(undefined)
    expect(trigger('Input device')).toHaveTextContent('System default')
    const list = openPicker('Input device')
    await within(list).findByRole('option', { name: 'USB Microphone' })
    expect(optionLabels(list)).toEqual(['System default', 'Built-in Microphone', 'USB Microphone'])
    // The system default is the empty id; it must show as the selected row.
    expect(within(list).getByRole('option', { name: 'System default' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: 'Allow microphone access to show device names' })).not.toBeInTheDocument()

    fireEvent.click(within(list).getByRole('option', { name: 'USB Microphone' }))
    expect(getPreferredMicrophoneId()).toBe('mic-b')
    expect(trigger('Input device')).toHaveTextContent('USB Microphone')
    expect(within(openPicker('Input device')).getByRole('option', { name: 'USB Microphone' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('option', { name: 'System default' }))
    expect(getPreferredMicrophoneId()).toBeUndefined()
    expect(trigger('Input device')).toHaveTextContent('System default')
    expect(within(openPicker('Input device')).getByRole('option', { name: 'System default' })).toHaveAttribute('aria-selected', 'true')
    expect(api.updatePreferences).not.toHaveBeenCalled()
  })

  it('unlocks device names on request and re-lists with the labels', async () => {
    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: '' }])
    await renderPage(makeCatalog(READY))

    expect(await within(openPicker('Input device')).findByRole('option', { name: 'Microphone 1' })).toBeInTheDocument()
    fireEvent.click(trigger('Input device'))

    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: 'Built-in Microphone' }])
    fireEvent.click(screen.getByRole('button', { name: 'Allow microphone access to show device names' }))

    await waitFor(() => expect(listInputs).toHaveBeenLastCalledWith(expect.objectContaining({ requestPermission: true })))
    expect(await within(openPicker('Input device')).findByRole('option', { name: 'Built-in Microphone' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow microphone access to show device names' })).not.toBeInTheDocument()
  })

  const ALLOW = 'Allow microphone access to show device names'

  it('reports a refused permission prompt when Chromium lists a single blank entry', async () => {
    // Unauthorized or system-denied Chromium reports one audioinput with empty id and label.
    listInputs.mockResolvedValue([{ deviceId: '', label: '' }])
    await renderPage(makeCatalog(READY))
    await screen.findByRole('button', { name: ALLOW })
    expect(screen.queryByText(/Microphone access was denied/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: ALLOW }))

    expect(await screen.findByText(/Microphone access was denied/)).toBeInTheDocument()
    expect(screen.queryByText('No microphone was detected.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: ALLOW })).toBeInTheDocument()
  })

  it('reports a refused permission prompt when ids come back without names', async () => {
    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: '' }])
    await renderPage(makeCatalog(READY))
    await screen.findByRole('button', { name: ALLOW })

    fireEvent.click(screen.getByRole('button', { name: ALLOW }))

    expect(await screen.findByText(/Microphone access was denied/)).toBeInTheDocument()
  })

  it('reports a refusal the browser states explicitly, even with an empty device list', async () => {
    listInputs.mockImplementation(async (options) => {
      options?.onPermissionError?.(new DOMException('denied', 'NotAllowedError'))
      return []
    })
    await renderPage(makeCatalog(READY))

    fireEvent.click(await screen.findByRole('button', { name: ALLOW }))

    expect(await screen.findByText(/Microphone access was denied/)).toBeInTheDocument()
    expect(screen.queryByText('No microphone was detected.')).not.toBeInTheDocument()
  })

  it('does not call it a missing microphone before permission, when the browser lists one blank entry', async () => {
    listInputs.mockResolvedValue([{ deviceId: '', label: '' }])
    await renderPage(makeCatalog(READY))

    expect(await screen.findByText(/The microphone opens briefly to unlock device names/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: ALLOW })).toBeInTheDocument()
    expect(screen.queryByText('No microphone was detected.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says no microphone was found only when there really is no input device', async () => {
    listInputs.mockResolvedValue([])
    await renderPage(makeCatalog(READY))

    expect(await screen.findByText('No microphone was detected.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: ALLOW }))
    await waitFor(() => expect(listInputs).toHaveBeenLastCalledWith(expect.objectContaining({ requestPermission: true })))

    expect(screen.getByText('No microphone was detected.')).toBeInTheDocument()
    expect(screen.queryByText(/Microphone access was denied/)).not.toBeInTheDocument()
  })

  it('names a device that is in use when the permission stream cannot open', async () => {
    listInputs.mockImplementation(async (options) => {
      options?.onPermissionError?.(new DOMException('busy', 'NotReadableError'))
      return [{ deviceId: 'mic-a', label: '' }]
    })
    await renderPage(makeCatalog(READY))

    fireEvent.click(await screen.findByRole('button', { name: ALLOW }))

    expect(await screen.findByText(/in use by another app/)).toBeInTheDocument()
    expect(screen.queryByText(/Microphone access was denied/)).not.toBeInTheDocument()
  })

  it('clears the refusal once a later grant unlocks the names', async () => {
    listInputs.mockResolvedValue([{ deviceId: '', label: '' }])
    await renderPage(makeCatalog(READY))
    fireEvent.click(await screen.findByRole('button', { name: ALLOW }))
    await screen.findByText(/Microphone access was denied/)

    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: 'Built-in Microphone' }])
    act(() => { mediaDevices.dispatchEvent(new Event('devicechange')) })

    expect(await within(openPicker('Input device')).findByRole('option', { name: 'Built-in Microphone' })).toBeInTheDocument()
    expect(screen.queryByText(/Microphone access was denied/)).not.toBeInTheDocument()
  })

  it('refreshes the list when a device is plugged in', async () => {
    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: 'Built-in Microphone' }])
    await renderPage(makeCatalog(READY))
    const list = openPicker('Input device')
    await within(list).findByRole('option', { name: 'Built-in Microphone' })

    listInputs.mockResolvedValue([
      { deviceId: 'mic-a', label: 'Built-in Microphone' },
      { deviceId: 'mic-c', label: 'Headset' },
    ])
    act(() => { mediaDevices.dispatchEvent(new Event('devicechange')) })

    expect(await within(list).findByRole('option', { name: 'Headset' })).toBeInTheDocument()
  })

  it('stops listening for device changes when the page closes', async () => {
    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: 'Built-in Microphone' }])
    await renderPage(makeCatalog(READY))
    await waitFor(() => expect(listInputs).toHaveBeenCalledTimes(1))

    cleanup()
    mediaDevices.dispatchEvent(new Event('devicechange'))
    await Promise.resolve()

    expect(listInputs).toHaveBeenCalledTimes(1)
  })

  it('falls back to the system default, with a notice, when the saved device is gone', async () => {
    localStorage.setItem('cc-haha-voice-input-device', 'mic-unplugged')
    listInputs.mockResolvedValue([{ deviceId: 'mic-a', label: 'Built-in Microphone' }])
    await renderPage(makeCatalog(READY))

    expect(await screen.findByText('The microphone you chose earlier is not available. The system default is used instead.')).toBeInTheDocument()
    expect(trigger('Input device')).toHaveTextContent('System default')
    expect(within(openPicker('Input device')).getByRole('option', { name: 'System default' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(trigger('Input device'))

    // The test records from the default device, not the vanished one.
    const recording = fakeRecording()
    start.mockResolvedValue(recording)
    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(start.mock.calls[0]![0].deviceId).toBeUndefined()
  })

  it('keeps a saved device selected while names are still hidden', async () => {
    localStorage.setItem('cc-haha-voice-input-device', 'mic-a')
    listInputs.mockResolvedValue([])
    await renderPage(makeCatalog(READY))

    await waitFor(() => expect(trigger('Input device')).toHaveTextContent('Saved microphone'))
    expect(screen.queryByText(/is not available\. The system default/)).not.toBeInTheDocument()
  })

  it('explains that recording needs a secure context instead of crashing', async () => {
    captureSupported.mockReturnValue(false)
    await renderPage(makeCatalog(READY))

    expect(screen.getAllByText(/The microphone is not available in this context/)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Input device' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start test' })).toBeDisabled()
    expect(listInputs).not.toHaveBeenCalled()
  })
})

describe('VoiceInputSettings transcription test', () => {
  let frames: Array<FrameRequestCallback>
  let now: number
  const canvasContext = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), fillRect: vi.fn(),
    globalAlpha: 1, fillStyle: '',
  }

  beforeEach(() => {
    frames = []
    now = 1_000
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as never)
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, 'clientWidth')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Runs every frame queued so far (the wave and the clock each keep one). */
  function runFrame() {
    const batch = frames.splice(0)
    if (batch.length === 0) throw new Error('no animation frame scheduled')
    act(() => { for (const callback of batch) callback(now) })
  }

  it('is disabled with a hint until the model is downloaded', async () => {
    await renderPage(makeCatalog(UNPREPARED))
    expect(screen.getByRole('button', { name: 'Start test' })).toBeDisabled()
    expect(screen.getByText('Download the speech model above before testing.')).toBeInTheDocument()
    expect(start).not.toHaveBeenCalled()
  })

  it('records with the chosen device, draws the trace, and shows text, duration and timing', async () => {
    // Only the clock's interval and Date: the trace's frames are driven by hand.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    localStorage.setItem('cc-haha-voice-input-device', 'mic-b')
    listInputs.mockResolvedValue([
      { deviceId: 'mic-a', label: 'Built-in Microphone' },
      { deviceId: 'mic-b', label: 'USB Microphone' },
    ])
    const catalog = makeCatalog(READY, { preferences: { enabled: true, providerId: 'sensevoice-local', language: 'zh', downloadSource: 'auto' } })
    await renderPage(catalog)
    await waitFor(() => expect(trigger('Input device')).toHaveTextContent('USB Microphone'))

    const recording = fakeRecording({ level: 0.42 })
    start.mockResolvedValue(recording)
    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))

    const stopButton = await screen.findByRole('button', { name: 'Stop' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![0]).toMatchObject({ deviceId: 'mic-b', maxSeconds: 30 })

    // The trace is decorative (canvas, aria-hidden); the wrapper carries the name for screen readers.
    const trace = screen.getByRole('img', { name: 'Microphone level' })
    expect(trace.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true')
    runFrame()
    expect(recording.getLevel).toHaveBeenCalled()
    expect(canvasContext.fill).toHaveBeenCalled()
    expect(screen.getByTestId('voice-input-timer')).toHaveTextContent('0:00')

    act(() => { vi.advanceTimersByTime(3_200) })
    expect(screen.getByTestId('voice-input-timer')).toHaveTextContent('0:03')
    // Recording is not a failure: the composer's recording bar and this test
    // share one look, and neither is painted in the error color.
    expect(stopButton.closest('div')!.outerHTML).not.toMatch(/--color-error/)

    let finishTranscription!: (value: typeof TRANSCRIPT) => void
    api.transcribe.mockImplementation(() => new Promise((resolve) => { finishTranscription = resolve }))
    fireEvent.click(stopButton)

    // Recognition keeps the recorded trace on screen and puts its state where the clock was.
    const recognizing = await screen.findByRole('button', { name: 'Recognizing…' })
    expect(recognizing).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('img', { name: 'Microphone level' })).toBe(trace)
    expect(screen.queryByTestId('voice-input-timer')).toBeNull()
    await act(async () => { finishTranscription(TRANSCRIPT) })

    expect(await screen.findByTestId('voice-transcript')).toHaveTextContent('hello from the microphone')
    expect(screen.getByText('Audio 5.6 s · Inference 0.10 s')).toBeInTheDocument()
    expect(recording.stop).toHaveBeenCalledTimes(1)
    expect(api.transcribe).toHaveBeenCalledTimes(1)
    const [wav, options] = api.transcribe.mock.calls[0]!
    expect(wav).toBeInstanceOf(Blob)
    expect(options).toMatchObject({ providerId: 'sensevoice-local', language: 'zh' })

    const player = screen.getByLabelText('Play back the recording')
    expect(player).toHaveAttribute('src', 'blob:voice-1')
    expect(screen.getByRole('button', { name: 'Start test' })).toBeEnabled()
  })

  it('caps the test at the server limit when that is shorter than 30 seconds', async () => {
    await renderPage(makeCatalog(READY, { limits: { maxAudioSeconds: 12, maxAudioBytes: 1_000_000 } }))
    start.mockResolvedValue(fakeRecording())
    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(start.mock.calls[0]![0].maxSeconds).toBe(12)
  })

  it('revokes the previous playback URL on a new test and the last one on unmount', async () => {
    await renderPage(makeCatalog(READY))
    api.transcribe.mockResolvedValue(TRANSCRIPT)

    for (const expected of ['blob:voice-1', 'blob:voice-2']) {
      start.mockResolvedValue(fakeRecording())
      fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
      await waitFor(() => expect(screen.getByLabelText('Play back the recording')).toHaveAttribute('src', expected))
    }
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-1')

    cleanup()
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:voice-2')
  })

  it('keeps the recording playable when transcription fails', async () => {
    await renderPage(makeCatalog(READY))
    start.mockResolvedValue(fakeRecording())
    api.transcribe.mockRejectedValue(new ApiError(500, { error: 'voice/failed', message: 'worker crashed' }))

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('Transcription failed. Try again.')).toBeInTheDocument()
    expect(screen.getByLabelText('Play back the recording')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-transcript')).not.toBeInTheDocument()
  })

  it.each([
    ['voice/not-ready', 409, 'The speech model is not ready. Check Settings → Voice input.'],
    ['voice/invalid-audio', 400, 'The recording could not be read. Try again.'],
    ['voice/unknown-provider', 404, 'The selected speech engine is unavailable.'],
  ])('maps the server error %s', async (code, status, text) => {
    await renderPage(makeCatalog(READY))
    start.mockResolvedValue(fakeRecording())
    api.transcribe.mockRejectedValue(new ApiError(status, { error: code, message: 'x' }))

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('falls back to a generic message when the server cannot be reached', async () => {
    await renderPage(makeCatalog(READY))
    start.mockResolvedValue(fakeRecording())
    api.transcribe.mockRejectedValue(new TypeError('Failed to fetch'))

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('Transcription failed. Try again.')).toBeInTheDocument()
  })

  it('says when nothing was recognized', async () => {
    await renderPage(makeCatalog(READY))
    start.mockResolvedValue(fakeRecording())
    api.transcribe.mockResolvedValue({ text: '  ', audioSeconds: 1, inferenceSeconds: 0.02 })

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(await screen.findByText('No speech was recognized.')).toBeInTheDocument()
  })

  it.each([
    ['unavailable', 'Dictation is not available in this environment.'],
    ['permission', 'Microphone access was denied. Allow it in your system settings and try again.'],
    ['no-device', 'No microphone was found. Connect one and try again.'],
    ['device-busy', 'The microphone is in use by another app.'],
    ['interrupted', 'The microphone stopped unexpectedly. Recording was discarded.'],
    ['failed', 'Transcription failed. Try again.'],
  ] as const)('shows a clear message when the recorder fails to start with %s', async (code, text) => {
    await renderPage(makeCatalog(READY))
    start.mockRejectedValue(new VoiceRecorderError(code))

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('button', { name: 'Start test' })).toBeEnabled()
    expect(api.transcribe).not.toHaveBeenCalled()
  })

  it('transcribes on its own when the recorder hits the length cap', async () => {
    await renderPage(makeCatalog(READY))
    const recording = fakeRecording()
    let options: StartRecordingOptions | undefined
    start.mockImplementation(async (received) => {
      options = received
      return recording
    })
    api.transcribe.mockResolvedValue(TRANSCRIPT)

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await screen.findByRole('button', { name: 'Stop' })
    act(() => { options!.onLimitReached!() })

    expect(await screen.findByTestId('voice-transcript')).toBeInTheDocument()
    expect(recording.stop).toHaveBeenCalledTimes(1)
  })

  it('stops with an error when the device disappears mid-recording', async () => {
    await renderPage(makeCatalog(READY))
    const recording = fakeRecording()
    let options: StartRecordingOptions | undefined
    start.mockImplementation(async (received) => {
      options = received
      return recording
    })

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await screen.findByRole('button', { name: 'Stop' })
    act(() => { options!.onInterrupted!(new VoiceRecorderError('interrupted')) })

    expect(await screen.findByRole('alert')).toHaveTextContent('The microphone stopped unexpectedly')
    expect(recording.cancel).toHaveBeenCalled()
    expect(api.transcribe).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Start test' })).toBeEnabled()
  })

  it('releases the microphone and aborts the upload when the page is left mid-test', async () => {
    await renderPage(makeCatalog(READY))
    const recording = fakeRecording()
    start.mockResolvedValue(recording)

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await screen.findByRole('button', { name: 'Stop' })
    cleanup()

    expect(recording.cancel).toHaveBeenCalled()
    expect(api.transcribe).not.toHaveBeenCalled()
  })

  it('cancels a recording that finishes opening after the page was left', async () => {
    await renderPage(makeCatalog(READY))
    const recording = fakeRecording()
    let resolveStart!: (value: ReturnType<typeof fakeRecording>) => void
    start.mockImplementation(() => new Promise(resolve => { resolveStart = resolve }))

    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await waitFor(() => expect(start).toHaveBeenCalled())
    const signal = start.mock.calls[0]![0].signal
    cleanup()
    expect(signal?.aborted).toBe(true)

    await act(async () => { resolveStart(recording) })
    expect(recording.cancel).toHaveBeenCalled()
  })
})
