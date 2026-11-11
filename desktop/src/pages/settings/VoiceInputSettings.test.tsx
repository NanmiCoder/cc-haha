import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type {
  VoiceCatalog,
  VoiceCorrectionTarget,
  VoiceLanguage,
  VoicePreferences,
  VoicePreparationState,
  VoiceProviderStatus,
  VoiceTranscript,
  VoiceVocabulary,
} from '@/api/voice'
import type { SavedProvider } from '@/types/provider'

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    providerStatus: vi.fn(),
    removeAssets: vi.fn(),
    transcribe: vi.fn(),
    correct: vi.fn(),
    vocabulary: vi.fn(),
    addVocabulary: vi.fn(),
    updateVocabulary: vi.fn(),
    removeVocabulary: vi.fn(),
    dismissSuggestion: vi.fn(),
    historySources: vi.fn(),
    suggestFromHistory: vi.fn(),
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
import { useProviderStore } from '@/stores/providerStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceInputStore } from '@/stores/voiceInputStore'
import { useVoiceVocabularyStore } from '@/stores/voiceVocabularyStore'
import { VoiceInputSettings } from './VoiceInputSettings'

const api = vi.mocked(voiceApi)
const listInputs = vi.mocked(listAudioInputs)
const captureSupported = vi.mocked(isVoiceCaptureSupported)
const start = vi.mocked(startRecording)

const MODEL_BYTES = 241_357_257
const DEFAULT_TARGET: VoiceCorrectionTarget = { providerId: 'deepseek', providerName: 'DeepSeek', modelId: 'deepseek-flash' }

function prefs(patch: Partial<VoicePreferences> = {}): VoicePreferences {
  return {
    enabled: false,
    providerId: 'sensevoice-local',
    language: 'auto',
    downloadSource: 'auto',
    correctionEnabled: false,
    correctionProviderId: null,
    correctionModelId: null,
    ...patch,
  }
}

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
    preferences: prefs(),
    limits: { maxAudioSeconds: 60, maxAudioBytes: 5_000_000 },
    correction: { defaultTarget: DEFAULT_TARGET, target: null },
    ...patch,
  }
}

const READY: VoicePreparationState = { phase: 'ready' }
const UNPREPARED: VoicePreparationState = { phase: 'unprepared' }

const FUNASR = { id: 'funasr-nano-local', name: 'Fun-ASR-Nano', languages: ['auto'] as VoiceLanguage[], downloadBytes: 950 * 1024 * 1024 }
const QWEN = { id: 'qwen3-asr-local', name: 'Qwen3-ASR 0.6B', languages: ['auto'] as VoiceLanguage[], downloadBytes: 980 * 1024 * 1024 }

/** The three local models in server order; each phase can be set, the rest are not downloaded. */
function threeModels(
  phases: { sense?: VoicePreparationState; nano?: VoicePreparationState; qwen?: VoicePreparationState } = {},
  preferences: Partial<VoicePreferences> = {},
): VoiceCatalog {
  return makeCatalog(READY, {
    providers: [
      makeProvider(phases.sense ?? READY),
      makeProvider(phases.nano ?? UNPREPARED, FUNASR),
      makeProvider(phases.qwen ?? UNPREPARED, QWEN),
    ],
    preferences: prefs(preferences),
  })
}

const EMPTY_VOCABULARY: VoiceVocabulary = { terms: [], suggestions: [], history: null, maxTerms: 500 }

async function renderPage(catalog: VoiceCatalog) {
  api.catalog.mockResolvedValue(catalog)
  render(<VoiceInputSettings />)
  await screen.findByRole('heading', { name: 'Voice Input' })
  await screen.findAllByTestId('voice-model-row')
}

/** A model's row in the recognition list. */
const modelRow = (id = 'sensevoice-local') => {
  const row = screen.getAllByTestId('voice-model-row').find(element => element.dataset.provider === id)
  if (!row) throw new Error(`no row for ${id}`)
  return row
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

const KIMI: SavedProvider = {
  id: 'kimi',
  presetId: 'custom',
  name: 'Kimi',
  apiKey: 'fixture',
  baseUrl: 'http://127.0.0.1:1',
  apiFormat: 'anthropic',
  models: { main: 'kimi-k2', haiku: 'kimi-k2', sonnet: '', opus: '' },
}

let mediaDevices: EventTarget
let objectUrlCounter: number
const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useVoiceInputStore.setState({ catalog: null, loading: false, error: null })
  useVoiceVocabularyStore.setState({ vocabulary: null, loading: false, error: null })
  // Saved providers are already known, so the correction field never fetches.
  useProviderStore.setState({ providers: [KIMI], activeId: 'kimi', hasLoadedProviders: true, isLoading: false })
  captureSupported.mockReturnValue(true)
  listInputs.mockResolvedValue([])
  api.vocabulary.mockResolvedValue(EMPTY_VOCABULARY)
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
  for (const id of ['sensevoice-local', FUNASR.id, QWEN.id]) await useVoiceInputStore.getState().cancelPrepare(id)
  Reflect.deleteProperty(navigator, 'mediaDevices')
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useProviderStore.setState(useProviderStore.getInitialState(), true)
  useUIStore.setState(useUIStore.getInitialState(), true)
})

describe('VoiceInputSettings loading states', () => {
  it('shows a retryable error when the catalog cannot be loaded', async () => {
    api.catalog.mockRejectedValueOnce(new Error('offline'))
    render(<VoiceInputSettings />)

    expect(await screen.findByText('Could not load voice input settings.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('offline')

    api.catalog.mockResolvedValue(makeCatalog(UNPREPARED))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('voice-model-row')).toBeInTheDocument()
  })

  it('replaces the whole page with a notice when the platform is unsupported', async () => {
    api.catalog.mockResolvedValue(makeCatalog(UNPREPARED, { supported: false }))
    render(<VoiceInputSettings />)

    expect(await screen.findByText('Local speech recognition is not supported on this platform yet')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('voice-model-row')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start test' })).not.toBeInTheDocument()
  })

  it('re-reads the catalog every time the tab is entered', async () => {
    useVoiceInputStore.setState({ catalog: makeCatalog(UNPREPARED) })
    api.catalog.mockResolvedValue(makeCatalog(READY))
    render(<VoiceInputSettings />)

    await waitFor(() => expect(modelRow()).toHaveAttribute('data-phase', 'ready'))
    expect(api.catalog).toHaveBeenCalledTimes(1)
  })
})

describe('VoiceInputSettings layout', () => {
  it('orders the sections: models, AI correction, vocabulary, microphone, shortcut, test', async () => {
    await renderPage(threeModels())

    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['Voice Input'])
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([
      'Recognition model',
      'AI correction',
      expect.stringMatching(/^Personal vocabulary/),
      'Microphone',
      'Keyboard shortcut',
      'Transcription test',
    ])
    // The header says recognition is local and correction sends only text.
    expect(screen.getByText(/it sends the text, never the audio/)).toBeInTheDocument()
  })

  it('keeps the on switch and the model list in one card, with language and source under it', async () => {
    await renderPage(threeModels({ qwen: UNPREPARED }))
    const section = screen.getByRole('switch', { name: 'Enable voice input' }).closest('section')!
    const list = within(section).getByRole('radiogroup', { name: 'Recognition model' })
    expect(within(list).getAllByRole('radio').map(radio => radio.getAttribute('aria-labelledby') && document.getElementById(radio.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['SenseVoice (local)', 'Fun-ASR-Nano', 'Qwen3-ASR 0.6B'])
    expect(within(section).getByRole('button', { name: 'Language' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Download source' })).toBeInTheDocument()
    expect(list.className).toContain('divide-[var(--color-border)]')
  })
})

describe('VoiceInputSettings recognition models', () => {
  it('describes each known model: badges, what it is good at, vendor, size, speed and memory', async () => {
    await renderPage(threeModels())

    const sense = modelRow('sensevoice-local')
    expect(within(sense).getByText('Default')).toBeInTheDocument()
    expect(within(sense).getByText('In use')).toBeInTheDocument()
    expect(sense).toHaveTextContent('The fastest: text appears almost as soon as you stop.')
    expect(sense).toHaveTextContent('Alibaba Tongyi · 230 MB · about 0.1 s per sentence · about 1 GB of memory while running')

    const qwen = modelRow(QWEN.id)
    expect(within(qwen).queryByText('Default')).toBeNull()
    expect(within(qwen).queryByText('In use')).toBeNull()
    expect(qwen).toHaveTextContent('Alibaba Qwen · 980 MB · about 0.6 s per sentence · about 3 GB of memory while running')
    expect(modelRow(FUNASR.id)).toHaveTextContent('about 0.5 s per sentence · about 3 GB of memory')
  })

  it('falls back to name and size for a model it has no copy for, and to nothing without a size', async () => {
    const catalog = threeModels()
    catalog.providers.push(makeProvider(UNPREPARED, { id: 'future-local', name: 'Future ASR', downloadBytes: 10 * 1024 * 1024 }))
    catalog.providers.push(makeProvider(UNPREPARED, { id: 'cloud-asr', name: 'Cloud ASR', location: 'cloud', downloadBytes: undefined }))
    await renderPage(catalog)

    expect(modelRow('future-local')).toHaveTextContent('Future ASRLocal recognition · about 10 MB')
    expect(modelRow('cloud-asr')).not.toHaveTextContent('Local recognition')
  })

  it('lets only a downloaded model be picked, and saves it with a language it supports', async () => {
    await renderPage(threeModels({ nano: READY }, { language: 'zh' }))

    const radio = (id: string) => within(modelRow(id)).getByRole('radio')
    expect(radio('sensevoice-local')).toBeChecked()
    expect(radio(FUNASR.id)).toBeEnabled()
    expect(radio(FUNASR.id)).not.toBeChecked()
    expect(radio(QWEN.id)).toBeDisabled()
    expect(modelRow(FUNASR.id)).toHaveTextContent('Select it to switch; it takes effect from the next dictation.')

    fireEvent.click(radio(FUNASR.id))

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ providerId: FUNASR.id, language: 'auto' }))
    await waitFor(() => expect(radio(FUNASR.id)).toBeChecked())
    expect(within(modelRow(FUNASR.id)).getByText('In use')).toBeInTheDocument()
  })

  it('downloads a model from its own row', async () => {
    await renderPage(threeModels())
    const downloading = makeProvider({ phase: 'downloading', step: 'model', completedBytes: 0, totalBytes: 1000 }, QWEN)
    api.prepare.mockResolvedValue(downloading)
    api.providerStatus.mockResolvedValue(downloading)

    fireEvent.click(within(modelRow(QWEN.id)).getByRole('button', { name: 'Download Qwen3-ASR 0.6B' }))

    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith(QWEN.id))
    await waitFor(() => expect(modelRow(QWEN.id)).toHaveAttribute('data-phase', 'downloading'))
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

    const row = modelRow()
    expect(row).toHaveTextContent('Downloading speech model · model.int8.onnx')
    expect(within(row).getByText('100 MB / 200 MB')).toBeInTheDocument()
    expect(within(row).getByRole('progressbar', { name: 'SenseVoice (local) download progress' })).toHaveAttribute('aria-valuenow', '50')
    expect(within(row).getByText('Resumed from 60 MB that was already downloaded')).toBeInTheDocument()
    expect(within(row).getByText('Source: https://hf-mirror.com/model.int8.onnx')).toBeInTheDocument()
    expect(within(row).getByRole('radio')).toBeDisabled()
  })

  it('omits the resume note for a fresh download and uses an indeterminate bar without a total', async () => {
    api.providerStatus.mockResolvedValue(makeProvider(UNPREPARED))
    await renderPage(makeCatalog({ phase: 'downloading', step: 'runtime', resource: 'runtime.tar.gz' }))

    const row = modelRow()
    expect(within(row).queryByText(/Resumed from/)).not.toBeInTheDocument()
    expect(within(row).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })

  it('pauses a running download, and the paused one can continue', async () => {
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'downloading', step: 'model', completedBytes: 1, totalBytes: 2 }))
    await renderPage(makeCatalog({ phase: 'downloading', step: 'model', completedBytes: 1, totalBytes: 2 }))

    api.cancelPrepare.mockResolvedValue(makeProvider({ phase: 'cancelled', completedBytes: 1 }))
    fireEvent.click(within(modelRow()).getByRole('button', { name: 'Pause' }))

    await waitFor(() => expect(api.cancelPrepare).toHaveBeenCalledWith('sensevoice-local'))
    await waitFor(() => expect(modelRow()).toHaveAttribute('data-phase', 'cancelled'))
    expect(modelRow()).toHaveTextContent('Paused. Parts already downloaded are kept')

    api.prepare.mockResolvedValue(makeProvider(READY))
    fireEvent.click(within(modelRow()).getByRole('button', { name: 'Continue download' }))
    await waitFor(() => expect(api.prepare).toHaveBeenCalledWith('sensevoice-local'))
  })

  it('reports verification without offering any action', async () => {
    api.providerStatus.mockResolvedValue(makeProvider({ phase: 'verifying' }))
    await renderPage(makeCatalog({ phase: 'verifying' }))

    const row = modelRow()
    expect(within(row).getAllByText('Verifying downloaded files…').length).toBeGreaterThan(0)
    expect(within(row).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(within(row).queryByRole('button')).not.toBeInTheDocument()
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

    const row = modelRow()
    expect(within(row).getByRole('alert')).toHaveTextContent(text)
    expect(within(row).getByText('raw failure detail')).toBeInTheDocument()
    expect(within(row).getByText('Source: https://huggingface.co/model.onnx')).toBeInTheDocument()

    api.prepare.mockResolvedValue(makeProvider(READY))
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }))
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

  it('confirms before deleting a downloaded model, and keeps it when the dialog is dismissed', async () => {
    await renderPage(threeModels({ nano: READY }))
    const remove = () => within(modelRow(FUNASR.id)).getByRole('button', { name: 'Delete Fun-ASR-Nano' })
    expect(within(modelRow(FUNASR.id)).getByText('Downloaded')).toBeInTheDocument()

    fireEvent.click(remove())
    expect(await screen.findByText('Delete Fun-ASR-Nano?')).toBeInTheDocument()
    expect(api.removeAssets).not.toHaveBeenCalled()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Delete Fun-ASR-Nano?')).not.toBeInTheDocument())
    expect(api.removeAssets).not.toHaveBeenCalled()

    fireEvent.click(remove())
    api.removeAssets.mockResolvedValue(makeProvider(UNPREPARED, FUNASR))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.removeAssets).toHaveBeenCalledWith(FUNASR.id))
    await waitFor(() => expect(modelRow(FUNASR.id)).toHaveAttribute('data-phase', 'unprepared'))
    // Not the model in use, so the choice stays where it was.
    expect(api.updatePreferences).not.toHaveBeenCalled()
  })

  it('switches back to SenseVoice after deleting the model in use', async () => {
    await renderPage(threeModels({ qwen: READY }, { enabled: true, providerId: QWEN.id }))

    fireEvent.click(within(modelRow(QWEN.id)).getByRole('button', { name: 'Delete Qwen3-ASR 0.6B' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('This is the model in use; once it is deleted, dictation switches back to SenseVoice (local).')

    api.removeAssets.mockResolvedValue(makeProvider(UNPREPARED, QWEN))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ providerId: 'sensevoice-local' }))
    await waitFor(() => expect(within(modelRow('sensevoice-local')).getByRole('radio')).toBeChecked())
  })

  it.each([
    ['cancelled', { phase: 'cancelled', completedBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 }],
    ['failed', { phase: 'failed', completedBytes: 50 * 1024 * 1024, error: { reason: 'network', message: 'boom' } }],
    ['unprepared', { phase: 'unprepared', completedBytes: 50 * 1024 * 1024 }],
  ] as const)('lets a %s download with bytes on disk be deleted, after confirming', async (phase, preparation) => {
    await renderPage(makeCatalog(preparation as VoicePreparationState))
    expect(modelRow()).toHaveAttribute('data-phase', phase)

    fireEvent.click(screen.getByRole('button', { name: 'Delete SenseVoice (local)' }))
    expect(await screen.findByText('Delete SenseVoice (local)?')).toBeInTheDocument()

    api.removeAssets.mockResolvedValue(makeProvider(UNPREPARED))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.removeAssets).toHaveBeenCalledWith('sensevoice-local'))
  })

  it.each([
    ['cancelled', { phase: 'cancelled' }],
    ['failed', { phase: 'failed', completedBytes: 0, error: { reason: 'network', message: 'boom' } }],
    ['unprepared', { phase: 'unprepared' }],
    ['downloading', { phase: 'downloading', completedBytes: 5, totalBytes: 10 }],
  ] as const)('offers no delete for a %s model with nothing finished on disk', async (_phase, preparation) => {
    api.providerStatus.mockResolvedValue(makeProvider(preparation as VoicePreparationState))
    await renderPage(makeCatalog(preparation as VoicePreparationState))
    expect(screen.queryByRole('button', { name: 'Delete SenseVoice (local)' })).not.toBeInTheDocument()
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
    await renderPage(makeCatalog(READY, { preferences: prefs({ enabled: true }) }))
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

  it('offers only the languages the model in use lists, labelled, and saves the pick', async () => {
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

  it('locks the language for a model that only detects it itself', async () => {
    await renderPage(threeModels({ qwen: READY }, { providerId: QWEN.id }))

    expect(trigger('Language')).toBeDisabled()
    expect(trigger('Language')).toHaveTextContent('Auto detect')
    expect(screen.getByText('Qwen3-ASR 0.6B detects the language automatically.')).toBeInTheDocument()
  })
})

describe('VoiceInputSettings download source', () => {
  const hint = () => screen.getByRole('button', { name: 'Change proxy' }).closest('p')!

  it('offers the three sources for every model and saves the chosen one', async () => {
    await renderPage(threeModels())

    expect(hint()).toHaveTextContent('Applies to every model.')
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

  it('hides the source picker once every model is installed', async () => {
    await renderPage(threeModels({ nano: READY, qwen: READY }))

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

describe('VoiceInputSettings AI correction', () => {
  const correctionSwitch = () => screen.getByRole('switch', { name: 'Fix terms with AI after recognition' })
  const modelField = () => screen.getByRole('button', { name: 'Correction model' })

  it('is off by default: only the switch, explained, and nothing to pick', async () => {
    await renderPage(threeModels())

    expect(correctionSwitch()).not.toBeChecked()
    expect(screen.getByText('Only the recognized text is sent, never the audio. Each dictation takes about 1 second longer.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correction model' })).not.toBeInTheDocument()
    // The "?" card says what it is, who it suits and what it costs.
    fireEvent.click(screen.getByRole('button', { name: 'What is AI correction?' }))
    expect(await screen.findByText(/the audio never does/)).toBeInTheDocument()
  })

  it('switches on and then offers the model, following the default provider\'s fast model', async () => {
    await renderPage(threeModels())
    api.catalog.mockResolvedValue(makeCatalog(READY, { correction: { defaultTarget: DEFAULT_TARGET, target: DEFAULT_TARGET } }))

    fireEvent.click(correctionSwitch())

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ correctionEnabled: true }))
    await waitFor(() => expect(correctionSwitch()).toBeChecked())
    expect(modelField()).toHaveTextContent('Follow default provider')
    expect(modelField()).toHaveTextContent('deepseek-flash')
    expect(screen.getByText(/If nothing comes back within 3 seconds, the original text is used\./)).toBeInTheDocument()
  })

  it('pins a saved provider\'s model, and goes back to following the default', async () => {
    await renderPage(threeModels({}, { correctionEnabled: true }))

    fireEvent.click(modelField())
    const picker = screen.getByTestId('model-selector-dropdown')
    expect(within(picker).getByRole('button', { name: /^Follow default provider/ })).toHaveTextContent('Uses DeepSeek\'s Haiku model')
    expect(within(picker).getByText('Kimi')).toBeInTheDocument()
    fireEvent.click(within(picker).getByRole('button', { name: /^kimi-k2/ }))

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ correctionProviderId: 'kimi', correctionModelId: 'kimi-k2' }))
    await waitFor(() => expect(modelField()).toHaveTextContent('kimi-k2'))

    fireEvent.click(modelField())
    fireEvent.click(within(screen.getByTestId('model-selector-dropdown')).getByRole('button', { name: /^Follow default provider/ }))
    await waitFor(() => expect(api.updatePreferences).toHaveBeenLastCalledWith({ correctionProviderId: null, correctionModelId: null }))
  })

  it('cannot be switched on without any model service, and points to where one is added', async () => {
    useProviderStore.setState({ providers: [], activeId: null })
    useUIStore.setState({ activeSettingsTab: 'voice' })
    await renderPage(makeCatalog(READY, { correction: { defaultTarget: null, target: null } }))

    expect(correctionSwitch()).toBeDisabled()
    expect(screen.getByText('Add a model provider first.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add a provider' }))
    expect(useUIStore.getState().activeSettingsTab).toBe('providers')
  })

  it('says when the chosen model is gone and dictation falls back to the original text', async () => {
    await renderPage(makeCatalog(READY, {
      preferences: prefs({ correctionEnabled: true, correctionProviderId: 'deleted', correctionModelId: 'k3.1-pro' }),
      correction: { defaultTarget: DEFAULT_TARGET, target: null },
    }))

    expect(screen.getByText(/The model you chose earlier, "k3.1-pro", is no longer in your providers\./)).toBeInTheDocument()
    // The field keeps naming the saved choice rather than quietly showing another model.
    expect(modelField()).toHaveTextContent('k3.1-pro')
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
    const catalog = makeCatalog(READY, { preferences: prefs({ enabled: true, language: 'zh' }) })
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

describe('VoiceInputSettings transcription test with AI correction', () => {
  const HEARD = '开源的这一个 agent brother skills，后来在 coded 里面去用'
  const CORRECTED = '开源的这一个 Agent Browser skills，后来在 Codex 里面去用'
  const at = (to: string) => CORRECTED.indexOf(to)

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    // The trace's animation frames are not what these cases are about.
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** The test returns to idle once both steps have finished. */
  const idle = () => waitFor(() => expect(screen.getByRole('button', { name: 'Start test' })).toBeEnabled())

  async function runTest() {
    start.mockResolvedValue(fakeRecording())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })
  }

  const correctionOn = () => makeCatalog(READY, {
    preferences: prefs({ enabled: true, correctionEnabled: true }),
    correction: { defaultTarget: DEFAULT_TARGET, target: DEFAULT_TARGET },
  })

  it('shows what was heard beside the corrected text, with each change marked, and both timings', async () => {
    await renderPage(correctionOn())
    api.transcribe.mockResolvedValue({ text: HEARD, audioSeconds: 4.2, inferenceSeconds: 0.12 })
    let finish!: (value: Awaited<ReturnType<typeof api.correct>>) => void
    api.correct.mockImplementation(() => new Promise((resolve) => { finish = resolve }))

    await runTest()

    // The second step shows while it runs.
    expect(await screen.findByRole('button', { name: 'AI correcting…' })).toBeInTheDocument()
    expect(api.correct).toHaveBeenCalledWith(HEARD, expect.objectContaining({ signal: expect.any(AbortSignal) }))

    await act(async () => {
      finish({
        text: CORRECTED,
        changes: [
          { from: 'agent brother', to: 'Agent Browser', start: at('Agent Browser'), end: at('Agent Browser') + 13, inVocabulary: true },
          { from: 'coded', to: 'Codex', start: at('Codex'), end: at('Codex') + 5, inVocabulary: false },
        ],
        target: DEFAULT_TARGET,
        seconds: 0.84,
      })
    })

    const heard = screen.getByTestId('voice-transcript')
    expect(heard).toHaveTextContent(HEARD)
    expect([...heard.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['agent brother', 'coded'])
    const corrected = screen.getByTestId('voice-corrected')
    expect(corrected).toHaveTextContent(CORRECTED)
    expect([...corrected.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['Agent Browser', 'Codex'])
    expect(screen.getByText('Corrected · changes: 2')).toBeInTheDocument()
    expect(screen.getByText('Audio 4.2 s · Recognition 0.12 s · Correction 0.84 s · deepseek-flash')).toBeInTheDocument()
    await idle()
  })

  it('shows a failed correction as part of the result, not as an error', async () => {
    await renderPage(correctionOn())
    api.transcribe.mockResolvedValue({ text: HEARD, audioSeconds: 4.2, inferenceSeconds: 0.12 })
    api.correct.mockRejectedValue(new ApiError(502, { error: 'voice/correction-failed', reason: 'auth', message: 'x' }))

    await runTest()

    expect(await screen.findByText('The correction model\'s API key is invalid.')).toBeInTheDocument()
    expect(screen.getByTestId('voice-transcript')).toHaveTextContent(HEARD)
    expect(screen.queryByRole('alert')).toBeNull()
    await idle()
  })

  it('skips the second step while correction is off', async () => {
    await renderPage(makeCatalog(READY))
    api.transcribe.mockResolvedValue(TRANSCRIPT)

    await runTest()

    expect(await screen.findByTestId('voice-transcript')).toHaveTextContent('hello from the microphone')
    expect(api.correct).not.toHaveBeenCalled()
    expect(screen.queryByTestId('voice-corrected')).toBeNull()
    await idle()
  })
})
