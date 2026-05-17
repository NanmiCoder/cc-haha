import { create } from 'zustand'
import { openTargetsApi, type OpenTarget } from '../api/openTargets'

export type { OpenTarget } from '../api/openTargets'

const CLIENT_CACHE_TTL_MS = 60_000

type OpenTargetState = {
  targets: OpenTarget[]
  platform: string | null
  primaryTargetId: string | null
  lastSuccessfulTargetId: string | null
  loading: boolean
  error: string | null
  fetchedAt: number
  ensureTargets: () => Promise<void>
  refreshTargets: () => Promise<void>
  openTarget: (targetId: string, path: string) => Promise<void>
}

function choosePrimaryTarget(targets: OpenTarget[], apiPrimary: string | null, lastSuccessful: string | null) {
  if (lastSuccessful && targets.some((target) => target.id === lastSuccessful)) return lastSuccessful
  if (apiPrimary && targets.some((target) => target.id === apiPrimary)) return apiPrimary
  return targets[0]?.id ?? null
}

export const useOpenTargetStore = create<OpenTargetState>((set, get) => ({
  targets: [],
  platform: null,
  primaryTargetId: null,
  lastSuccessfulTargetId: null,
  loading: false,
  error: null,
  fetchedAt: 0,

  ensureTargets: async () => {
    const state = get()
    if (state.loading) return
    if (state.fetchedAt > 0 && Date.now() - state.fetchedAt < CLIENT_CACHE_TTL_MS) return
    await get().refreshTargets()
  },

  refreshTargets: async () => {
    set({ loading: true, error: null })
    try {
      const result = await openTargetsApi.list()
      const primaryTargetId = choosePrimaryTarget(
        result.targets,
        result.primaryTargetId,
        get().lastSuccessfulTargetId,
      )
      set({
        targets: result.targets,
        platform: result.platform,
        primaryTargetId,
        fetchedAt: Date.now(),
        loading: false,
        error: null,
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  openTarget: async (targetId, path) => {
    try {
      await openTargetsApi.open(targetId, path)
      set({ lastSuccessfulTargetId: targetId, primaryTargetId: targetId, error: null })
    } catch (error) {
      await get().refreshTargets()
      set({ error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
}))
