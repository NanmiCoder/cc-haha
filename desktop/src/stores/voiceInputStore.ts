import { create } from 'zustand'
import {
  voiceApi,
  type VoiceCatalog,
  type VoicePreferences,
  type VoiceProviderStatus,
} from '@/api/voice'

const POLL_INTERVAL_MS = 500
// A blip must not freeze the progress of a download the server is still running.
const MAX_CONSECUTIVE_POLL_FAILURES = 3
const TERMINAL_PHASES = new Set(['ready', 'failed', 'cancelled', 'unprepared'])

const pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Bumped on every stop so a status request already in flight when the user
// cancels or deletes cannot land afterwards and restart the loop.
const pollGenerations = new Map<string, number>()

type VoiceInputState = {
  catalog: VoiceCatalog | null
  loading: boolean
  error: string | null
  /** Loads the catalog once; safe to call from every consumer. */
  loadCatalog: (options?: { force?: boolean }) => Promise<void>
  updatePreferences: (patch: Partial<VoicePreferences>) => Promise<void>
  /** Starts (or joins) a download and polls until it reaches a terminal phase. */
  prepare: (providerId: string) => Promise<void>
  cancelPrepare: (providerId: string) => Promise<void>
  removeAssets: (providerId: string) => Promise<void>
}

function replaceProvider(catalog: VoiceCatalog | null, status: VoiceProviderStatus): VoiceCatalog | null {
  if (!catalog) return catalog
  return {
    ...catalog,
    providers: catalog.providers.map(item => item.info.id === status.info.id ? status : item),
  }
}

export const useVoiceInputStore = create<VoiceInputState>((set, get) => {
  const applyStatus = (status: VoiceProviderStatus) => {
    set(state => ({ catalog: replaceProvider(state.catalog, status) }))
  }

  const stopPolling = (providerId: string) => {
    const timer = pollTimers.get(providerId)
    if (timer) clearTimeout(timer)
    pollTimers.delete(providerId)
    pollGenerations.set(providerId, (pollGenerations.get(providerId) ?? 0) + 1)
  }

  const poll = (providerId: string) => {
    stopPolling(providerId)
    const generation = pollGenerations.get(providerId)
    let failures = 0
    const tick = async () => {
      try {
        const status = await voiceApi.providerStatus(providerId)
        if (pollGenerations.get(providerId) !== generation) return
        failures = 0
        applyStatus(status)
        if (TERMINAL_PHASES.has(status.preparation.phase)) {
          stopPolling(providerId)
          return
        }
      } catch (error) {
        if (pollGenerations.get(providerId) !== generation) return
        failures += 1
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          set({ error: String(error) })
          stopPolling(providerId)
          return
        }
      }
      pollTimers.set(providerId, setTimeout(tick, POLL_INTERVAL_MS))
    }
    pollTimers.set(providerId, setTimeout(tick, POLL_INTERVAL_MS))
  }

  return {
    catalog: null,
    loading: false,
    error: null,

    loadCatalog: async (options) => {
      if (get().loading) return
      if (get().catalog && !options?.force) return
      set({ loading: true })
      try {
        const catalog = await voiceApi.catalog()
        set({ catalog, error: null })
        // Resume progress display if the server is already downloading.
        for (const provider of catalog.providers) {
          if (provider.preparation.phase === 'downloading' || provider.preparation.phase === 'verifying') {
            poll(provider.info.id)
          }
        }
      } catch (error) {
        set({ error: String(error) })
      } finally {
        set({ loading: false })
      }
    },

    updatePreferences: async (patch) => {
      const { preferences } = await voiceApi.updatePreferences(patch)
      set(state => ({ catalog: state.catalog ? { ...state.catalog, preferences } : state.catalog }))
    },

    prepare: async (providerId) => {
      try {
        const status = await voiceApi.prepare(providerId)
        applyStatus(status)
        set({ error: null })
        if (!TERMINAL_PHASES.has(status.preparation.phase)) poll(providerId)
      } catch (error) {
        set({ error: String(error) })
      }
    },

    cancelPrepare: async (providerId) => {
      stopPolling(providerId)
      try {
        applyStatus(await voiceApi.cancelPrepare(providerId))
      } catch (error) {
        set({ error: String(error) })
      }
    },

    removeAssets: async (providerId) => {
      stopPolling(providerId)
      try {
        applyStatus(await voiceApi.removeAssets(providerId))
        set({ error: null })
      } catch (error) {
        set({ error: String(error) })
      }
    },
  }
})

/** The provider the user selected, or undefined before the catalog loads. */
export function selectActiveVoiceProvider(state: Pick<VoiceInputState, 'catalog'>): VoiceProviderStatus | undefined {
  const catalog = state.catalog
  return catalog?.providers.find(item => item.info.id === catalog.preferences.providerId)
}

/** True when the composer should offer the dictation button as usable. */
export function selectVoiceInputReady(state: Pick<VoiceInputState, 'catalog'>): boolean {
  const catalog = state.catalog
  if (!catalog?.supported || !catalog.preferences.enabled) return false
  return selectActiveVoiceProvider(state)?.preparation.phase === 'ready'
}

/**
 * Switched on, but the model cannot transcribe yet: never downloaded, still
 * downloading, failed, or removed. The composer keeps the microphone and sends
 * the user to the download instead of recording.
 */
export function selectVoiceInputNeedsModel(state: Pick<VoiceInputState, 'catalog'>): boolean {
  const catalog = state.catalog
  if (!catalog?.supported || !catalog.preferences.enabled) return false
  return selectActiveVoiceProvider(state)?.preparation.phase !== 'ready'
}
