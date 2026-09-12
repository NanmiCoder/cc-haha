// desktop/src/stores/hahaOpenAIOAuthStore.ts

import { create } from 'zustand'
import {
  hahaOpenAIOAuthApi,
  type HahaOpenAIOAuthStatus,
} from '../api/hahaOpenAIOAuth'
import { modelsApi } from '../api/models'
import { OPENAI_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
import type { ModelInfo } from '../types/settings'
import { useProviderStore } from './providerStore'
import { useSettingsStore } from './settingsStore'

const POLL_INTERVAL_MS = 2_000

function getAccountKey(status: HahaOpenAIOAuthStatus | null): string | null {
  return status?.loggedIn
    ? status.accountId ?? status.email ?? 'authenticated-default'
    : null
}

type HahaOpenAIOAuthState = {
  status: HahaOpenAIOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null
  models: ModelInfo[]

  fetchStatus: () => Promise<void>
  refreshModels: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useHahaOpenAIOAuthStore = create<HahaOpenAIOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let authGeneration = 0
  let modelRefresh: {
    accountKey: string
    generation: number
    promise: Promise<void>
  } | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,
    models: [],

    fetchStatus: async () => {
      let status: HahaOpenAIOAuthStatus
      try {
        status = await hahaOpenAIOAuthApi.status()
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
        return
      }

      const previousAccount = getAccountKey(get().status)
      const currentAccount = getAccountKey(status)
      if (currentAccount !== previousAccount) authGeneration += 1
      set({
        status,
        error: null,
        ...(!currentAccount || currentAccount !== previousAccount ? { models: [] } : {}),
      })
      if (currentAccount && (currentAccount !== previousAccount || get().models.length === 0)) {
        await get().refreshModels().catch(() => {})
      }
    },

    refreshModels: () => {
      const accountKey = getAccountKey(get().status)
      if (!accountKey) return Promise.resolve()
      const generation = authGeneration
      if (
        modelRefresh?.accountKey === accountKey &&
        modelRefresh.generation === generation
      ) return modelRefresh.promise

      const promise = modelsApi.list({
        providerId: OPENAI_OFFICIAL_PROVIDER_ID,
        refresh: true,
      }).then((response) => {
        if (
          authGeneration !== generation ||
          getAccountKey(get().status) !== accountKey
        ) return
        set({ models: response.models })
        if (useProviderStore.getState().activeId === OPENAI_OFFICIAL_PROVIDER_ID) {
          useSettingsStore.setState({
            availableModels: response.models,
            activeProviderName: response.provider?.name ?? null,
          })
        }
      }).finally(() => {
        if (modelRefresh?.promise === promise) modelRefresh = null
      })
      modelRefresh = { accountKey, generation, promise }
      return promise
    },

    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const res = await hahaOpenAIOAuthApi.start()
        set({ isLoading: false })
        return { authorizeUrl: res.authorizeUrl }
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    logout: async () => {
      get().stopPolling()
      authGeneration += 1
      modelRefresh = null
      set({ isLoading: true, error: null, models: [] })
      try {
        await hahaOpenAIOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false, models: [] })
      } catch (err) {
        set({
          isLoading: false,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },

    startPolling: () => {
      if (pollTimer) return
      set({ isPolling: true })

      const scheduleNext = () => {
        pollTimer = setTimeout(async () => {
          pollTimer = null
          await get().fetchStatus()
          const cur = get().status
          if (cur && cur.loggedIn) {
            get().stopPolling()
            return
          }
          if (get().isPolling) {
            scheduleNext()
          }
        }, POLL_INTERVAL_MS)
      }
      scheduleNext()
    },

    stopPolling: () => {
      if (pollTimer) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      set({ isPolling: false })
    },
  }
})
