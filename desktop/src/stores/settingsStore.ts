import { create } from 'zustand'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { githubApi } from '../api/github'
import type { PermissionMode, EffortLevel, ModelInfo, ThemeMode, MonitoredRepo } from '../types/settings'
import type { Locale } from '../i18n'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'cc-haha-locale'

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* localStorage unavailable */ }
  return 'en'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  skipWebFetchPreflight: boolean
  githubStatus: { connected: boolean; username?: string; avatar?: string } | null
  githubMonitoredRepos: MonitoredRepo[]
  isLoading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  fetchGitHubStatus: () => Promise<void>
  saveGitHubToken: (token: string) => Promise<void>
  deleteGitHubToken: () => Promise<void>
  updateGitHubRepos: (repos: MonitoredRepo[]) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'medium',
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  skipWebFetchPreflight: true,
  githubStatus: null,
  githubMonitoredRepos: [],
  isLoading: false,
  error: null,

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const [{ mode }, modelsRes, { model }, { level }, userSettings, ghStatus] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        githubApi.getStatus().catch(() => ({ connected: false })),
      ])
      const theme = userSettings.theme === 'dark' ? 'dark' : 'light'
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        theme,
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        githubStatus: ghStatus,
        githubMonitoredRepos: Array.isArray(userSettings.githubMonitoredRepos)
          ? userSettings.githubMonitoredRepos
          : [],
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  setPermissionMode: async (mode) => {
    const prev = get().permissionMode
    set({ permissionMode: mode })
    try {
      await settingsApi.setPermissionMode(mode)
    } catch {
      set({ permissionMode: prev })
    }
  },

  setModel: async (modelId) => {
    await modelsApi.setCurrent(modelId)
    const { model } = await modelsApi.getCurrent()
    set({ currentModel: model })
  },

  setEffort: async (level) => {
    const prev = get().effortLevel
    set({ effortLevel: level })
    try {
      await modelsApi.setEffort(level)
    } catch {
      set({ effortLevel: prev })
    }
  },

  setLocale: (locale) => {
    set({ locale })
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
  },

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme })
    useUIStore.getState().setTheme(theme)
    try {
      await settingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await settingsApi.updateUser({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  fetchGitHubStatus: async () => {
    try {
      const status = await githubApi.getStatus()
      set({ githubStatus: status })
    } catch {
      set({ githubStatus: { connected: false } })
    }
  },

  saveGitHubToken: async (token) => {
    const result = await githubApi.saveToken({ token })
    set({
      githubStatus: {
        connected: true,
        username: result.username,
        avatar: result.avatar,
      },
    })
  },

  deleteGitHubToken: async () => {
    await githubApi.deleteToken()
    set({ githubStatus: { connected: false }, githubMonitoredRepos: [] })
  },

  updateGitHubRepos: async (repos) => {
    const prev = get().githubMonitoredRepos
    set({ githubMonitoredRepos: repos })
    try {
      await settingsApi.updateUser({ githubMonitoredRepos: repos })
    } catch {
      set({ githubMonitoredRepos: prev })
    }
  },
}))
