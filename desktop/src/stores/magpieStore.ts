import { create } from 'zustand'

import { providersApi } from '../api/providers'
import type { MagpieModel, MagpieState, OpenMagpieResult, SavedProvider } from '../types/provider'

export const MAGPIE_PRESET_ID = 'magpie'

/** The connect bar was closed with ×; it stays closed on this computer. */
export const MAGPIE_BANNER_DISMISSED_KEY = 'cc-haha-magpie-banner-dismissed'

function readBannerDismissed(): boolean {
  try {
    return localStorage.getItem(MAGPIE_BANNER_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function isMagpieProvider(provider: Pick<SavedProvider, 'presetId'> | null | undefined): boolean {
  return provider?.presetId === MAGPIE_PRESET_ID
}

type MagpieStore = {
  state: MagpieState | null
  /** A check is in flight; the previous state stays shown meanwhile. */
  loading: boolean
  bannerDismissed: boolean
  /** Asks the server, which also writes a moved port and the catalog's limits back to saved Magpie providers. */
  refresh: (options?: { force?: boolean }) => Promise<MagpieState | null>
  open: () => Promise<OpenMagpieResult>
  dismissBanner: () => void
}

export const useMagpieStore = create<MagpieStore>((set) => ({
  state: null,
  loading: false,
  bannerDismissed: readBannerDismissed(),

  refresh: async (options) => {
    set({ loading: true })
    try {
      const state = await providersApi.magpie(options?.force === true)
      set({ state })
      return state
    } catch {
      // Our own server failed, not Magpie: keep what was shown.
      return null
    } finally {
      set({ loading: false })
    }
  },

  open: async () => {
    try {
      return await providersApi.openMagpie()
    } catch {
      return { ok: false }
    }
  },

  dismissBanner: () => {
    try {
      localStorage.setItem(MAGPIE_BANNER_DISMISSED_KEY, '1')
    } catch {
      // Storage unavailable: closed for this run only.
    }
    set({ bannerDismissed: true })
  },
}))

/** "256K", "1M": how the model lists show a window or reply limit. */
export function formatTokenLimit(tokens: number): string {
  // Vendors state windows both ways: 262,144 is "256K" and 200,000 is "200K".
  const unit = tokens % 1_024 === 0 ? 1_024 : 1_000
  if (tokens >= unit * unit) {
    const millions = tokens / (unit * unit)
    return `${Number.isInteger(millions) ? millions : Number(millions.toFixed(1))}M`
  }
  return `${Math.round(tokens / unit)}K`
}

/**
 * Models grouped by the Magpie provider serving them, routing groups first
 * (`label` is null for them; the caller names that group).
 */
export function groupMagpieModels(
  models: readonly MagpieModel[],
): Array<{ key: string; label: string | null; models: MagpieModel[] }> {
  const groups = new Map<string, { label: string | null; models: MagpieModel[] }>()
  for (const model of models) {
    const key = model.isGroup ? '' : model.provider || model.id.split('/')[0] || ''
    const group = groups.get(key) ?? { label: model.isGroup ? null : model.providerName || key, models: [] }
    group.models.push(model)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0))
    .map(([key, group]) => ({ key, ...group }))
}
