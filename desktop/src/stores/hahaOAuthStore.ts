// desktop/src/stores/hahaOAuthStore.ts

import { create } from 'zustand'
import { hahaOAuthApi, type HahaOAuthStatus } from '../api/hahaOAuth'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '../constants/openaiOfficialProvider'
import { useProviderStore } from './providerStore'
import { useSettingsStore } from './settingsStore'
import { useUsageSummaryStore } from './usageSummaryStore'

const POLL_INTERVAL_MS = 2_000

type HahaOAuthState = {
  status: HahaOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null

  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useHahaOAuthStore = create<HahaOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,

    fetchStatus: async () => {
      try {
        const previous = get().status
        const status = await hahaOAuthApi.status()
        set({ status, error: null })
        const accountChanged = previous !== null && (
          previous.loggedIn !== status.loggedIn ||
          (previous.loggedIn && status.loggedIn && previous.subscriptionType !== status.subscriptionType)
        )
        if (accountChanged) {
          useProviderStore.getState().clearOfficialCatalog(CLAUDE_OFFICIAL_PROVIDER_ID)
        }
        if (
          status.loggedIn &&
          (
            previous?.loggedIn !== true ||
            previous.expiresAt !== status.expiresAt ||
            previous.subscriptionType !== status.subscriptionType
          )
        ) {
          await useSettingsStore.getState().fetchAll()
        }
        if (previous !== null && previous.loggedIn !== status.loggedIn) {
          void useUsageSummaryStore.getState().fetchSummary({ force: true })
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const res = await hahaOAuthApi.start()
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
      set({ isLoading: true })
      try {
        await hahaOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false })
        useProviderStore.getState().clearOfficialCatalog(CLAUDE_OFFICIAL_PROVIDER_ID)
        void useUsageSummaryStore.getState().fetchSummary({ force: true })
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
