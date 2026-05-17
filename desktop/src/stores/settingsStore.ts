import { create } from 'zustand'
import { ApiError } from '../api/client'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import { isThemeMode, type H5AccessSettings, type PermissionMode, type EffortLevel, type ModelInfo, type ThemeMode, type WebSearchSettings, type AppMode, type AppModeConfig } from '../types/settings'
import { isTauriRuntime } from '../lib/desktopRuntime'
import type { Locale } from '../i18n'
import {
  APP_ZOOM_CONTROL_STEP,
  DEFAULT_APP_ZOOM,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  applyAppZoomLevel,
  normalizeAppZoomLevel,
  readStoredAppZoomLevel,
} from '../lib/appZoom'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'cc-haha-locale'
export const UI_ZOOM_MIN = MIN_APP_ZOOM
export const UI_ZOOM_MAX = MAX_APP_ZOOM
export const UI_ZOOM_STEP = APP_ZOOM_CONTROL_STEP
export const UI_ZOOM_DEFAULT = DEFAULT_APP_ZOOM
let desktopNotificationsSaveQueue: Promise<void> = Promise.resolve()

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  thinkingEnabled: boolean
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  webSearch: WebSearchSettings
  h5Access: H5AccessSettings
  h5AccessError: string | null
  responseLanguage: string
  uiZoom: number
  isLoading: boolean
  error: string | null

  appMode: AppModeConfig
  appModeRequiresRestart: boolean

  fetchAll: () => Promise<void>
  fetchH5Access: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setThinkingEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  enableH5Access: () => Promise<string>
  disableH5Access: () => Promise<void>
  regenerateH5AccessToken: () => Promise<string>
  updateH5AccessSettings: (input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }) => Promise<void>
  setResponseLanguage: (language: string) => Promise<void>
  fetchAppMode: () => Promise<void>
  setAppMode: (mode: AppMode, portableDir?: string | null) => Promise<void>
  setUiZoom: (zoom: number) => void
}

const DEFAULT_H5_ACCESS_SETTINGS: H5AccessSettings = {
  enabled: false,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'medium',
  thinkingEnabled: true,
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
  h5Access: DEFAULT_H5_ACCESS_SETTINGS,
  h5AccessError: null,
  responseLanguage: '',
  uiZoom: readStoredAppZoomLevel(),
  isLoading: false,
  error: null,

  appMode: { mode: 'default', portableDir: null, defaultPortableDir: null },
  appModeRequiresRestart: false,
  setUiZoom: (zoom: number) => {
    const level = normalizeAppZoomLevel(zoom)
    set({ uiZoom: level })
    void applyAppZoomLevel(level)
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const previousH5Access = get().h5Access
      const [{ mode }, modelsRes, { model }, { level }, userSettings, h5AccessResult] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        loadH5AccessSettings(previousH5Access),
      ])
      const theme = isThemeMode(userSettings.theme) ? userSettings.theme : 'white'
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        thinkingEnabled: userSettings.alwaysThinkingEnabled !== false,
        theme,
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        h5Access: h5AccessResult.settings,
        h5AccessError: h5AccessResult.error,
        responseLanguage: typeof userSettings.language === 'string' ? userSettings.language : '',
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

  fetchH5Access: async () => {
    const result = await loadH5AccessSettings(get().h5Access)
    set({ h5Access: result.settings, h5AccessError: result.error })
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

  setThinkingEnabled: async (enabled) => {
    const prev = get().thinkingEnabled
    set({ thinkingEnabled: enabled })
    try {
      await settingsApi.updateUser({ alwaysThinkingEnabled: enabled })
    } catch {
      set({ thinkingEnabled: prev })
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

  setDesktopNotificationsEnabled: async (enabled) => {
    const prev = get().desktopNotificationsEnabled
    set({ desktopNotificationsEnabled: enabled })
    const save = desktopNotificationsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (get().desktopNotificationsEnabled !== enabled) return
        await settingsApi.updateUser({ desktopNotificationsEnabled: enabled })
      })

    desktopNotificationsSaveQueue = save

    try {
      await save
    } catch {
      if (get().desktopNotificationsEnabled === enabled) {
        set({ desktopNotificationsEnabled: prev })
      }
    }
  },

  setWebSearch: async (webSearch) => {
    const prev = get().webSearch
    const next = normalizeWebSearchSettings(webSearch)
    set({ webSearch: next })
    try {
      await settingsApi.updateUser({ webSearch: next })
    } catch {
      set({ webSearch: prev })
    }
  },

  enableH5Access: async () => {
    set({ h5AccessError: null })
    try {
      const { settings, token } = await h5AccessApi.enable()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      return token
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to enable H5 access.') })
      throw error
    }
  },

  disableH5Access: async () => {
    set({ h5AccessError: null })
    try {
      const { settings } = await h5AccessApi.disable()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to disable H5 access.') })
      throw error
    }
  },

  regenerateH5AccessToken: async () => {
    set({ h5AccessError: null })
    try {
      const { settings, token } = await h5AccessApi.regenerate()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      return token
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to regenerate the H5 token.') })
      throw error
    }
  },

  updateH5AccessSettings: async (input) => {
    set({ h5AccessError: null })
    try {
      const { settings } = await h5AccessApi.update(input)
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to update H5 access settings.') })
      throw error
    }
  },

  setResponseLanguage: async (language) => {
    const prev = get().responseLanguage
    set({ responseLanguage: language })
    try {
      await settingsApi.updateUser({ language: language || undefined })
    } catch {
      set({ responseLanguage: prev })
    }
  },

  fetchAppMode: async () => {
    if (!isTauriRuntime()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: AppModeConfig = await invoke('get_app_mode')
      set({ appMode: result })
    } catch { /* silently ignore - not in Tauri or command unavailable */ }
  },

  setAppMode: async (mode, portableDir) => {
    if (!isTauriRuntime()) return
    const prev = get().appMode
    const newMode: AppModeConfig = {
      ...prev,
      mode,
      portableDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
    }
    set({ appMode: newMode, appModeRequiresRestart: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_app_mode', {
        mode,
        portableDir: newMode.portableDir || null,
      })
    } catch {
      set({ appMode: prev, appModeRequiresRestart: false })
    }
  },
}))

function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): WebSearchSettings {
  return {
    mode: settings?.mode ?? 'auto',
    tavilyApiKey: settings?.tavilyApiKey ?? '',
    braveApiKey: settings?.braveApiKey ?? '',
  }
}

function normalizeH5AccessSettings(settings: H5AccessSettings | undefined): H5AccessSettings {
  return {
    enabled: settings?.enabled === true,
    tokenPreview: settings?.tokenPreview ?? null,
    allowedOrigins: Array.isArray(settings?.allowedOrigins) ? settings.allowedOrigins : [],
    publicBaseUrl: settings?.publicBaseUrl ?? null,
  }
}

async function loadH5AccessSettings(previousH5Access: H5AccessSettings): Promise<{
  settings: H5AccessSettings
  error: string | null
}> {
  try {
    const { settings } = await h5AccessApi.get()
    return {
      settings: normalizeH5AccessSettings(settings),
      error: null,
    }
  } catch (error) {
    if (isLegacyH5EndpointError(error)) {
      return {
        settings: DEFAULT_H5_ACCESS_SETTINGS,
        error: null,
      }
    }

    return {
      settings: previousH5Access,
      error: getErrorMessage(error, 'Failed to load H5 access settings.'),
    }
  }
}

function isLegacyH5EndpointError(error: unknown) {
  const status = error instanceof ApiError
    ? error.status
    : typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null
  return status === 404 || status === 405
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}
