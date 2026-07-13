import { create } from 'zustand'
import { hahaGrokOAuthApi, type HahaGrokOAuthStatus } from '../api/hahaGrokOAuth'

const POLL_INTERVAL_MS = 2_000

type HahaGrokOAuthState = {
  status: HahaGrokOAuthStatus | null
  isPolling: boolean
  isLoading: boolean
  error: string | null
  fetchStatus: () => Promise<void>
  login: () => Promise<{ authorizeUrl: string }>
  logout: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}

export const useHahaGrokOAuthStore = create<HahaGrokOAuthState>((set, get) => {
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  return {
    status: null,
    isPolling: false,
    isLoading: false,
    error: null,

    fetchStatus: async () => {
      try {
        set({ status: await hahaGrokOAuthApi.status(), error: null })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    login: async () => {
      set({ isLoading: true, error: null })
      try {
        const result = await hahaGrokOAuthApi.start()
        set({ isLoading: false })
        return { authorizeUrl: result.authorizeUrl }
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
        await hahaGrokOAuthApi.logout()
        set({ status: { loggedIn: false }, isLoading: false })
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
          if (get().status?.loggedIn) {
            get().stopPolling()
          } else if (get().isPolling) {
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
