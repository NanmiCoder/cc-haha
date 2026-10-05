import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceCatalog, VoicePreparationState, VoiceProviderStatus } from '@/api/voice'

vi.mock('@/api/voice', () => ({
  voiceApi: {
    catalog: vi.fn(),
    updatePreferences: vi.fn(),
    prepare: vi.fn(),
    cancelPrepare: vi.fn(),
    providerStatus: vi.fn(),
    removeAssets: vi.fn(),
  },
}))

import { voiceApi } from '@/api/voice'
import {
  selectActiveVoiceProvider,
  selectVoiceInputNeedsModel,
  selectVoiceInputReady,
  useVoiceInputStore,
} from './voiceInputStore'

const api = vi.mocked(voiceApi)
const ID = 'sensevoice-local'

function provider(preparation: VoicePreparationState, id = ID): VoiceProviderStatus {
  return {
    info: { id, name: id, location: 'local', languages: ['auto', 'zh'], downloadBytes: 1000 },
    preparation,
  }
}

function catalog(preparation: VoicePreparationState, patch: Partial<VoiceCatalog> = {}): VoiceCatalog {
  return {
    supported: true,
    providers: [provider(preparation)],
    preferences: { enabled: true, providerId: ID, language: 'auto', downloadSource: 'auto' },
    limits: { maxAudioSeconds: 60, maxAudioBytes: 1_000_000 },
    ...patch,
  }
}

const phase = () => useVoiceInputStore.getState().catalog?.providers[0]!.preparation.phase

/** Lets pending promise continuations run without advancing the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useVoiceInputStore.setState({ catalog: null, loading: false, error: null })
})

afterEach(async () => {
  // Poll timers live at module scope; cancelling is the public way to stop them.
  api.cancelPrepare.mockResolvedValue(provider({ phase: 'unprepared' }))
  await useVoiceInputStore.getState().cancelPrepare(ID)
  vi.useRealTimers()
})

describe('voiceInputStore.loadCatalog', () => {
  it('loads once and reuses the cached catalog', async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'ready' }))
    await useVoiceInputStore.getState().loadCatalog()
    await useVoiceInputStore.getState().loadCatalog()

    expect(api.catalog).toHaveBeenCalledTimes(1)
    expect(useVoiceInputStore.getState().catalog?.supported).toBe(true)
  })

  it('reloads when forced', async () => {
    api.catalog.mockResolvedValueOnce(catalog({ phase: 'unprepared' }))
    await useVoiceInputStore.getState().loadCatalog()
    api.catalog.mockResolvedValueOnce(catalog({ phase: 'ready' }))
    await useVoiceInputStore.getState().loadCatalog({ force: true })

    expect(api.catalog).toHaveBeenCalledTimes(2)
    expect(phase()).toBe('ready')
  })

  it('joins an in-flight load instead of issuing a second request', async () => {
    let resolve!: (value: VoiceCatalog) => void
    api.catalog.mockImplementation(() => new Promise(r => { resolve = r }))

    const first = useVoiceInputStore.getState().loadCatalog()
    const second = useVoiceInputStore.getState().loadCatalog({ force: true })
    resolve(catalog({ phase: 'ready' }))
    await Promise.all([first, second])

    expect(api.catalog).toHaveBeenCalledTimes(1)
  })

  it('records a failed load, clears the loading flag, and retries on the next call', async () => {
    api.catalog.mockRejectedValueOnce(new Error('offline'))
    await useVoiceInputStore.getState().loadCatalog()

    expect(useVoiceInputStore.getState().error).toContain('offline')
    expect(useVoiceInputStore.getState().loading).toBe(false)
    expect(useVoiceInputStore.getState().catalog).toBeNull()

    api.catalog.mockResolvedValueOnce(catalog({ phase: 'ready' }))
    await useVoiceInputStore.getState().loadCatalog()
    expect(useVoiceInputStore.getState().error).toBeNull()
    expect(phase()).toBe('ready')
  })

  it('resumes polling when the server is already downloading, and stops at the terminal phase', async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'downloading', completedBytes: 10, totalBytes: 100 }))
    api.providerStatus
      .mockResolvedValueOnce(provider({ phase: 'downloading', completedBytes: 60, totalBytes: 100 }))
      .mockResolvedValueOnce(provider({ phase: 'ready' }))

    await useVoiceInputStore.getState().loadCatalog()
    expect(api.providerStatus).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(api.providerStatus).toHaveBeenCalledTimes(1)
    expect(useVoiceInputStore.getState().catalog?.providers[0]!.preparation.completedBytes).toBe(60)

    await vi.advanceTimersByTimeAsync(500)
    expect(phase()).toBe('ready')

    await vi.advanceTimersByTimeAsync(5000)
    expect(api.providerStatus).toHaveBeenCalledTimes(2)
  })

  it('also resumes polling for a download in the verifying phase', async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'verifying' }))
    api.providerStatus.mockResolvedValue(provider({ phase: 'ready' }))
    await useVoiceInputStore.getState().loadCatalog()

    await vi.advanceTimersByTimeAsync(500)
    expect(phase()).toBe('ready')
  })

  it.each(['ready', 'unprepared', 'failed', 'cancelled'] as const)('does not poll a catalog that is %s', async (value) => {
    api.catalog.mockResolvedValue(catalog({ phase: value }))
    await useVoiceInputStore.getState().loadCatalog()
    await vi.advanceTimersByTimeAsync(3000)

    expect(api.providerStatus).not.toHaveBeenCalled()
  })
})

describe('voiceInputStore.prepare', () => {
  beforeEach(async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'unprepared' }))
    await useVoiceInputStore.getState().loadCatalog()
  })

  it('polls until the download reaches a terminal phase and then stops', async () => {
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', step: 'runtime', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus
      .mockResolvedValueOnce(provider({ phase: 'downloading', step: 'model', completedBytes: 50, totalBytes: 100 }))
      .mockResolvedValueOnce(provider({ phase: 'verifying' }))
      .mockResolvedValueOnce(provider({ phase: 'ready' }))

    await useVoiceInputStore.getState().prepare(ID)
    expect(api.prepare).toHaveBeenCalledWith(ID)
    expect(phase()).toBe('downloading')

    await vi.advanceTimersByTimeAsync(500)
    expect(useVoiceInputStore.getState().catalog?.providers[0]!.preparation.step).toBe('model')
    await vi.advanceTimersByTimeAsync(500)
    expect(phase()).toBe('verifying')
    await vi.advanceTimersByTimeAsync(500)
    expect(phase()).toBe('ready')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.providerStatus).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['failed', { phase: 'failed', error: { reason: 'network', message: 'boom' } }],
    ['cancelled', { phase: 'cancelled' }],
  ] as const)('stops polling on a %s terminal phase', async (expected, terminal) => {
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus.mockResolvedValue(provider(terminal as VoicePreparationState))

    await useVoiceInputStore.getState().prepare(ID)
    await vi.advanceTimersByTimeAsync(500)
    expect(phase()).toBe(expected)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.providerStatus).toHaveBeenCalledTimes(1)
  })

  it('does not poll when the server answers with a terminal phase straight away', async () => {
    api.prepare.mockResolvedValue(provider({ phase: 'ready' }))
    await useVoiceInputStore.getState().prepare(ID)
    await vi.advanceTimersByTimeAsync(2000)

    expect(phase()).toBe('ready')
    expect(api.providerStatus).not.toHaveBeenCalled()
  })

  it('keeps a single poll loop when prepare is joined twice', async () => {
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 1, totalBytes: 100 }))

    await useVoiceInputStore.getState().prepare(ID)
    await useVoiceInputStore.getState().prepare(ID)
    await vi.advanceTimersByTimeAsync(500)

    expect(api.providerStatus).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed request without touching the catalog, and clears the error on success', async () => {
    api.prepare.mockRejectedValueOnce(new Error('server down'))
    await useVoiceInputStore.getState().prepare(ID)
    expect(useVoiceInputStore.getState().error).toContain('server down')
    expect(phase()).toBe('unprepared')

    api.prepare.mockResolvedValueOnce(provider({ phase: 'ready' }))
    await useVoiceInputStore.getState().prepare(ID)
    expect(useVoiceInputStore.getState().error).toBeNull()
  })

  it('gives up and reports the error after three failed status requests in a row', async () => {
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus.mockRejectedValue(new Error('lost server'))

    await useVoiceInputStore.getState().prepare(ID)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(500)
    expect(useVoiceInputStore.getState().error).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(useVoiceInputStore.getState().error).toContain('lost server')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.providerStatus).toHaveBeenCalledTimes(3)
  })

  it('rides out transient status failures and keeps the download progress moving', async () => {
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(provider({ phase: 'downloading', completedBytes: 40, totalBytes: 100 }))
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(provider({ phase: 'ready' }))

    await useVoiceInputStore.getState().prepare(ID)
    await vi.advanceTimersByTimeAsync(500 * 6)

    // Two failures, a success, two more failures: the streak was reset, so it never reached three.
    expect(phase()).toBe('ready')
    expect(useVoiceInputStore.getState().error).toBeNull()
  })
})

describe('voiceInputStore.cancelPrepare and removeAssets', () => {
  beforeEach(async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'unprepared' }))
    await useVoiceInputStore.getState().loadCatalog()
    api.prepare.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 0, totalBytes: 100 }))
    api.providerStatus.mockResolvedValue(provider({ phase: 'downloading', completedBytes: 1, totalBytes: 100 }))
    await useVoiceInputStore.getState().prepare(ID)
  })

  it('cancel stops the poll loop and applies the server answer', async () => {
    api.cancelPrepare.mockResolvedValue(provider({ phase: 'cancelled' }))
    await useVoiceInputStore.getState().cancelPrepare(ID)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(api.cancelPrepare).toHaveBeenCalledWith(ID)
    expect(phase()).toBe('cancelled')
    expect(api.providerStatus).not.toHaveBeenCalled()
  })

  it('a late status answer cannot resurrect a cancelled download', async () => {
    // The poll request is in flight when the user cancels; its response arrives after.
    let resolveStatus!: (value: VoiceProviderStatus) => void
    api.providerStatus.mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))
    await vi.advanceTimersByTimeAsync(500)

    api.cancelPrepare.mockResolvedValue(provider({ phase: 'cancelled' }))
    await useVoiceInputStore.getState().cancelPrepare(ID)
    resolveStatus(provider({ phase: 'downloading', completedBytes: 90, totalBytes: 100 }))
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(api.providerStatus).toHaveBeenCalledTimes(1)
    expect(phase()).toBe('cancelled')
  })

  it('removeAssets stops polling and applies the unprepared status', async () => {
    api.removeAssets.mockResolvedValue(provider({ phase: 'unprepared' }))
    await useVoiceInputStore.getState().removeAssets(ID)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(api.removeAssets).toHaveBeenCalledWith(ID)
    expect(phase()).toBe('unprepared')
    expect(api.providerStatus).not.toHaveBeenCalled()
  })

  it('removeAssets reports a failure', async () => {
    api.removeAssets.mockRejectedValue(new Error('locked'))
    await useVoiceInputStore.getState().removeAssets(ID)
    expect(useVoiceInputStore.getState().error).toContain('locked')
  })
})

describe('voiceInputStore.updatePreferences', () => {
  it('merges the server-confirmed preferences into the catalog, leaving providers alone', async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'ready' }, { preferences: { enabled: false, providerId: ID, language: 'auto', downloadSource: 'auto' } }))
    await useVoiceInputStore.getState().loadCatalog()
    api.updatePreferences.mockResolvedValue({ preferences: { enabled: true, providerId: ID, language: 'zh', downloadSource: 'auto' } })

    await useVoiceInputStore.getState().updatePreferences({ enabled: true, language: 'zh' })

    expect(api.updatePreferences).toHaveBeenCalledWith({ enabled: true, language: 'zh' })
    expect(useVoiceInputStore.getState().catalog?.preferences).toEqual({ enabled: true, providerId: ID, language: 'zh', downloadSource: 'auto' })
    expect(phase()).toBe('ready')
  })

  it('leaves the catalog unchanged and lets the caller see the failure', async () => {
    api.catalog.mockResolvedValue(catalog({ phase: 'ready' }, { preferences: { enabled: false, providerId: ID, language: 'auto', downloadSource: 'auto' } }))
    await useVoiceInputStore.getState().loadCatalog()
    api.updatePreferences.mockRejectedValue(new Error('read-only'))

    await expect(useVoiceInputStore.getState().updatePreferences({ enabled: true })).rejects.toThrow('read-only')
    expect(useVoiceInputStore.getState().catalog?.preferences.enabled).toBe(false)
  })
})

describe('selectVoiceInputReady', () => {
  const ready = catalog({ phase: 'ready' })

  it('is true only when supported, enabled and the selected provider is ready', () => {
    expect(selectVoiceInputReady({ catalog: ready })).toBe(true)
  })

  it('is false before the catalog loads', () => {
    expect(selectVoiceInputReady({ catalog: null })).toBe(false)
  })

  it('is false on an unsupported platform even if everything else is set', () => {
    expect(selectVoiceInputReady({ catalog: { ...ready, supported: false } })).toBe(false)
  })

  it('is false while disabled', () => {
    expect(selectVoiceInputReady({
      catalog: { ...ready, preferences: { ...ready.preferences, enabled: false } },
    })).toBe(false)
  })

  it.each(['unprepared', 'downloading', 'verifying', 'failed', 'cancelled'] as const)('is false while the model is %s', (value) => {
    expect(selectVoiceInputReady({ catalog: catalog({ phase: value }) })).toBe(false)
  })

  it('looks at the selected provider, not just any ready one', () => {
    const other = provider({ phase: 'ready' }, 'other')
    const state = {
      catalog: catalog({ phase: 'unprepared' }, {
        providers: [provider({ phase: 'unprepared' }), other],
      }),
    }
    expect(selectVoiceInputReady(state)).toBe(false)
    state.catalog.preferences.providerId = 'other'
    expect(selectVoiceInputReady(state)).toBe(true)
  })

  it('is false when the selected provider is not in the catalog', () => {
    expect(selectVoiceInputReady({
      catalog: { ...ready, preferences: { ...ready.preferences, providerId: 'missing' } },
    })).toBe(false)
    expect(selectActiveVoiceProvider({
      catalog: { ...ready, preferences: { ...ready.preferences, providerId: 'missing' } },
    })).toBeUndefined()
  })
})

describe('selectVoiceInputNeedsModel', () => {
  it.each(['unprepared', 'downloading', 'verifying', 'failed', 'cancelled'] as const)('is true while switched on and the model is %s', (value) => {
    expect(selectVoiceInputNeedsModel({ catalog: catalog({ phase: value }) })).toBe(true)
  })

  it('is false once the model is ready: the button records instead', () => {
    expect(selectVoiceInputNeedsModel({ catalog: catalog({ phase: 'ready' }) })).toBe(false)
  })

  it('is false while switched off, unsupported, or before the catalog loads', () => {
    const missing = catalog({ phase: 'unprepared' })
    expect(selectVoiceInputNeedsModel({ catalog: { ...missing, preferences: { ...missing.preferences, enabled: false } } })).toBe(false)
    expect(selectVoiceInputNeedsModel({ catalog: { ...missing, supported: false } })).toBe(false)
    expect(selectVoiceInputNeedsModel({ catalog: null })).toBe(false)
  })
})
