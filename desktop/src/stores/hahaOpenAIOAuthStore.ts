// desktop/src/stores/hahaOpenAIOAuthStore.ts

import { create } from 'zustand'
import {
  hahaOpenAIOAuthApi,
  type HahaOpenAIOAuthStatus,
} from '../api/hahaOpenAIOAuth'
import { useUsageSummaryStore } from './usageSummaryStore'

const POLL_INTERVAL_MS = 2_000

type HahaOpenAIOAuthState = {
  status: HahaOpenAIOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null

  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useHahaOpenAIOAuthStore = create<HahaOpenAIOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,

    fetchStatus: async () => {
      try {
        const previous = get().status
        const status = await hahaOpenAIOAuthApi.status()
        set({ status, error: null })
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
      set({ isLoading: true, error: null })
      try {
        await hahaOpenAIOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false })
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
