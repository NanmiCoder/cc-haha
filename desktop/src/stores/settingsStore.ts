import { create } from 'zustand'
import { ApiError } from '../api/client'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import { tracesApi } from '../api/traces'
import {
  isThemeMode,
  type AppMode,
  type AppModeConfig,
  type ChatSendBehavior,
  type DesktopTerminalSettings,
  type DesktopTerminalStartupShell,
  type H5AccessDiagnostics,
  type H5AccessSettings,
  type H5TunnelMode,
  type NetworkSettings,
  type OutputStyleOption,
  type OutputStylesResponse,
  type PermissionMode,
  type EffortLevel,
  type ModelInfo,
  type ThemeMode,
  type UpdateProxyMode,
  type UpdateProxySettings,
  type WebSearchSettings,
  type WorkspaceLspSettings,
} from '../types/settings'
import type { TraceCaptureSettings } from '../types/trace'
import { getDesktopHost } from '../lib/desktopHost'
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

const VALID_LOCALES: readonly Locale[] = ['en', 'zh', 'zh-TW', 'jp', 'kr']

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored && (VALID_LOCALES as readonly string[]).includes(stored)) return stored as Locale
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  thinkingEnabled: boolean
  thinkingAutoCollapse: boolean
  autoDreamEnabled: boolean
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  chatSendBehavior: ChatSendBehavior
  outputStyle: string
  outputStyles: OutputStyleOption[]
  outputStyleScope: OutputStylesResponse['scope']
  outputStyleWorkDir: string | null
  outputStylesLoading: boolean
  outputStyleError: string | null
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  desktopTerminal: DesktopTerminalSettings
  workspaceLsp: WorkspaceLspSettings
  webSearch: WebSearchSettings
  updateProxy: UpdateProxySettings
  network: NetworkSettings
  traceCapture: TraceCaptureSettings
  h5Access: H5AccessSettings
  h5AccessDiagnostics: H5AccessDiagnostics | null
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
  setThinkingAutoCollapse: (enabled: boolean) => Promise<void>
  setAutoDreamEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setChatSendBehavior: (behavior: ChatSendBehavior) => Promise<void>
  fetchOutputStyles: (workDir?: string | null) => Promise<void>
  setOutputStyle: (outputStyle: string, workDir?: string | null) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setDesktopTerminal: (settings: DesktopTerminalSettings) => Promise<void>
  setWorkspaceLsp: (settings: WorkspaceLspSettings) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  setUpdateProxy: (settings: UpdateProxySettings) => Promise<void>
  setNetwork: (settings: NetworkSettings) => Promise<void>
  setTraceCaptureEnabled: (enabled: boolean) => Promise<void>
  enableH5Access: () => Promise<string>
  disableH5Access: () => Promise<void>
  regenerateH5AccessToken: () => Promise<string>
  updateH5AccessSettings: (input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
    fixedPort?: number | null
    disconnectGraceSeconds?: number | null
    tunnelToken?: string | null
    tunnelMode?: H5TunnelMode | null
  }) => Promise<void>
  startH5Tunnel: (options: { mode: H5TunnelMode; token?: string | null; namedUrl?: string | null }) => Promise<void>
  stopH5Tunnel: () => Promise<void>
  setResponseLanguage: (language: string) => Promise<void>
  fetchAppMode: () => Promise<void>
  setAppMode: (mode: AppMode, portableDir?: string | null) => Promise<void>
  setUiZoom: (zoom: number) => void
}

type NetworkSettingsInput = Partial<Omit<NetworkSettings, 'proxy'>> & {
  proxy?: Partial<NetworkSettings['proxy']>
}

const DEFAULT_H5_ACCESS_SETTINGS: H5AccessSettings = {
  enabled: false,
  token: null,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
  fixedPort: null,
  disconnectGraceSeconds: null,
}

const DEFAULT_DESKTOP_TERMINAL_SETTINGS: DesktopTerminalSettings = {
  startupShell: 'system',
  customShellPath: '',
}

const DEFAULT_UPDATE_PROXY_SETTINGS: UpdateProxySettings = {
  mode: 'system',
  url: '',
}

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: 600_000,
  proxy: {
    mode: 'system',
    url: '',
  },
}

const DEFAULT_OUTPUT_STYLE = 'default'
const DEFAULT_OUTPUT_STYLE_OPTIONS: OutputStyleOption[] = [
  {
    value: DEFAULT_OUTPUT_STYLE,
    label: 'Default',
    description: 'Claude completes coding tasks efficiently and provides concise responses',
    source: 'built-in',
  },
]

const DEFAULT_TRACE_CAPTURE_SETTINGS: TraceCaptureSettings = {
  enabled: true,
  storageDir: '',
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'max',
  thinkingEnabled: true,
  thinkingAutoCollapse: true,
  autoDreamEnabled: false,
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  chatSendBehavior: 'enter',
  outputStyle: DEFAULT_OUTPUT_STYLE,
  outputStyles: DEFAULT_OUTPUT_STYLE_OPTIONS,
  outputStyleScope: 'userSettings',
  outputStyleWorkDir: null,
  outputStylesLoading: false,
  outputStyleError: null,
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  desktopTerminal: DEFAULT_DESKTOP_TERMINAL_SETTINGS,
  workspaceLsp: {},
  webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
  updateProxy: DEFAULT_UPDATE_PROXY_SETTINGS,
  network: DEFAULT_NETWORK_SETTINGS,
  traceCapture: DEFAULT_TRACE_CAPTURE_SETTINGS,
  h5Access: DEFAULT_H5_ACCESS_SETTINGS,
  h5AccessDiagnostics: null,
  h5AccessError: null,
  responseLanguage: '',
  uiZoom: readStoredAppZoomLevel(),
  isLoading: false,
  error: null,

  appMode: {
    mode: 'default',
    portableDir: null,
    defaultPortableDir: null,
    activeConfigDir: null,
    configDirSource: 'system',
  },
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
      const [{ mode }, modelsRes, { model }, { level }, userSettings, h5AccessResult, traceCapture] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        loadH5AccessSettings(previousH5Access),
        loadTraceCaptureSettings(),
      ])
      const serverTheme = isThemeMode(userSettings.theme) ? userSettings.theme : 'dark'
      // 'system' is a desktop-only logical mode that never gets persisted to the
      // server (the server rejects it). If the user previously chose 'system' and
      // it was stored locally, honour the local value instead of overwriting it
      // with whatever concrete theme the server last saw.
      const localTheme = useUIStore.getState().theme
      const theme = localTheme === 'system' ? 'system' : serverTheme
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        thinkingEnabled: userSettings.alwaysThinkingEnabled !== false,
        thinkingAutoCollapse: userSettings.thinkingAutoCollapse !== false,
        autoDreamEnabled: userSettings.autoDreamEnabled === true,
        theme,
        chatSendBehavior: normalizeChatSendBehavior(userSettings.chatSendBehavior),
        outputStyle: normalizeOutputStyle(userSettings.outputStyle),
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        desktopTerminal: normalizeDesktopTerminalSettings(userSettings.desktopTerminal),
        workspaceLsp: normalizeWorkspaceLspSettings(userSettings.workspaceLsp),
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        updateProxy: normalizeUpdateProxySettings(userSettings.updateProxy),
        network: normalizeNetworkSettings(userSettings.network),
        traceCapture,
        h5Access: h5AccessResult.settings,
        h5AccessDiagnostics: h5AccessResult.diagnostics,
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
    set({
      h5Access: result.settings,
      h5AccessDiagnostics: result.diagnostics,
      h5AccessError: result.error,
    })
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

  setThinkingAutoCollapse: async (enabled) => {
    const prev = get().thinkingAutoCollapse
    set({ thinkingAutoCollapse: enabled })
    try {
      await settingsApi.updateUser({ thinkingAutoCollapse: enabled })
    } catch {
      set({ thinkingAutoCollapse: prev })
    }
  },

  setAutoDreamEnabled: async (enabled) => {
    const prev = get().autoDreamEnabled
    set({ autoDreamEnabled: enabled })
    try {
      await settingsApi.updateUser({ autoDreamEnabled: enabled })
    } catch (error) {
      set({ autoDreamEnabled: prev })
      throw error
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
    // 'system' is a desktop-only logical mode (resolves to light/dark via OS preference).
    // The server only persists concrete themes; skip the round-trip to avoid validation errors.
    if (theme === 'system') return
    try {
      await settingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setChatSendBehavior: async (behavior) => {
    const prev = get().chatSendBehavior
    const next = normalizeChatSendBehavior(behavior)
    set({ chatSendBehavior: next })
    try {
      await settingsApi.updateUser({ chatSendBehavior: next })
    } catch (error) {
      set({ chatSendBehavior: prev })
      throw error
    }
  },

  fetchOutputStyles: async (workDir) => {
    set({ outputStylesLoading: true, outputStyleError: null })
    try {
      const response = await settingsApi.getOutputStyles(workDir)
      set({
        outputStyle: normalizeOutputStyle(response.outputStyle),
        outputStyles: normalizeOutputStyleOptions(response.styles),
        outputStyleScope: response.scope,
        outputStyleWorkDir: response.workDir,
        outputStylesLoading: false,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStylesLoading: false,
        outputStyleError: getErrorMessage(error, 'Failed to load output styles.'),
      })
      throw error
    }
  },

  setOutputStyle: async (outputStyle, workDir) => {
    const prev = {
      outputStyle: get().outputStyle,
      outputStyleScope: get().outputStyleScope,
      outputStyleWorkDir: get().outputStyleWorkDir,
      outputStyleError: get().outputStyleError,
    }
    set({
      outputStyle,
      outputStyleError: null,
    })
    try {
      const result = await settingsApi.setOutputStyle(outputStyle, workDir)
      set({
        outputStyle: normalizeOutputStyle(result.outputStyle),
        outputStyleScope: result.scope,
        outputStyleWorkDir: result.workDir,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStyle: prev.outputStyle,
        outputStyleScope: prev.outputStyleScope,
        outputStyleWorkDir: prev.outputStyleWorkDir,
        outputStyleError: getErrorMessage(error, 'Failed to save output style.'),
      })
      throw error
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

  setDesktopTerminal: async (settings) => {
    const prev = get().desktopTerminal
    const next = normalizeDesktopTerminalSettings(settings)
    set({ desktopTerminal: next })
    try {
      await settingsApi.updateUser({ desktopTerminal: next })
    } catch (error) {
      set({ desktopTerminal: prev })
      throw error
    }
  },

  setWorkspaceLsp: async (settings) => {
    const prev = get().workspaceLsp
    const next = normalizeWorkspaceLspSettings(settings)
    set({ workspaceLsp: next })
    try {
      await settingsApi.updateUser({ workspaceLsp: next })
    } catch (error) {
      set({ workspaceLsp: prev })
      throw error
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

  setUpdateProxy: async (settings) => {
    const prev = get().updateProxy
    const next = normalizeUpdateProxySettings(settings)
    set({ updateProxy: next })
    try {
      await settingsApi.updateUser({ updateProxy: next })
    } catch (error) {
      set({ updateProxy: prev })
      throw error
    }
  },

  setNetwork: async (settings) => {
    const prev = get().network
    const next = normalizeNetworkSettings(settings)
    set({ network: next })
    try {
      await settingsApi.updateUser({ network: next })
    } catch (error) {
      set({ network: prev })
      throw error
    }
  },

  setTraceCaptureEnabled: async (enabled) => {
    const prev = get().traceCapture
    set({ traceCapture: { ...prev, enabled } })
    try {
      const next = await tracesApi.updateSettings({ enabled })
      set({ traceCapture: normalizeTraceCaptureSettings(next) })
    } catch (error) {
      set({ traceCapture: prev })
      throw error
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
      await refreshH5DiagnosticsSilent(set)
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
      await refreshH5DiagnosticsSilent(set)
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
      await refreshH5DiagnosticsSilent(set)
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
      await refreshH5DiagnosticsSilent(set)
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to update H5 access settings.') })
      throw error
    }
  },

  startH5Tunnel: async (options) => {
    set({ h5AccessError: null })
    try {
      await h5AccessApi.startTunnel(options)
      // The main process reports the tunnel URL back to the server, so a
      // diagnostics refresh picks up the new effective publicBaseUrl + status.
      await refreshH5DiagnosticsSilent(set)
      const error = get().h5AccessDiagnostics?.tunnel?.error
      if (error) {
        set({ h5AccessError: error })
        throw new Error(error)
      }
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to start the tunnel.') })
      throw error
    }
  },

  stopH5Tunnel: async () => {
    set({ h5AccessError: null })
    try {
      await h5AccessApi.stopTunnel()
      await refreshH5DiagnosticsSilent(set)
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to stop the tunnel.') })
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
    const host = getDesktopHost()
    if (!host.isDesktop) return
    try {
      const result: AppModeConfig = await host.appMode.get()
      set({ appMode: result })
    } catch { /* silently ignore - not in Tauri or command unavailable */ }
  },

  setAppMode: async (mode, portableDir) => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    const prev = get().appMode
    const newMode: AppModeConfig = {
      ...prev,
      mode,
      portableDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      activeConfigDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      configDirSource: mode === 'portable' ? 'portable' : 'system',
    }
    set({ appMode: newMode, appModeRequiresRestart: true })
    try {
      await host.appMode.set({
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

function normalizeChatSendBehavior(value: unknown): ChatSendBehavior {
  return value === 'modifierEnter' ? 'modifierEnter' : 'enter'
}

function normalizeOutputStyle(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : DEFAULT_OUTPUT_STYLE
}

function normalizeOutputStyleOptions(styles: OutputStyleOption[] | undefined): OutputStyleOption[] {
  if (!Array.isArray(styles) || styles.length === 0) return DEFAULT_OUTPUT_STYLE_OPTIONS
  const normalized = styles
    .filter((style): style is OutputStyleOption =>
      typeof style?.value === 'string' &&
      style.value.trim().length > 0 &&
      typeof style.label === 'string' &&
      typeof style.description === 'string',
    )
    .map(style => ({
      ...style,
      value: style.value.trim(),
      label: style.label.trim() || style.value.trim(),
      description: style.description.trim(),
    }))
  return normalized.length > 0 ? normalized : DEFAULT_OUTPUT_STYLE_OPTIONS
}

function isUpdateProxyMode(value: unknown): value is UpdateProxyMode {
  return value === 'system' || value === 'manual'
}

function normalizeUpdateProxySettings(
  settings: Partial<UpdateProxySettings> | undefined,
): UpdateProxySettings {
  const mode = isUpdateProxyMode(settings?.mode)
    ? settings.mode
    : DEFAULT_UPDATE_PROXY_SETTINGS.mode
  return {
    mode,
    url: typeof settings?.url === 'string' ? settings.url.trim() : '',
  }
}

function normalizeNetworkSettings(
  settings: NetworkSettingsInput | undefined,
): NetworkSettings {
  const timeout = typeof settings?.aiRequestTimeoutMs === 'number' && Number.isFinite(settings.aiRequestTimeoutMs)
    ? Math.min(Math.max(Math.round(settings.aiRequestTimeoutMs), 30_000), 1_800_000)
    : DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  const proxyMode = settings?.proxy?.mode === 'manual' ? 'manual' : 'system'

  return {
    aiRequestTimeoutMs: timeout,
    proxy: {
      mode: proxyMode,
      url: typeof settings?.proxy?.url === 'string' ? settings.proxy.url.trim() : '',
    },
  }
}

function normalizeTraceCaptureSettings(
  settings: TraceCaptureSettings | undefined,
): TraceCaptureSettings {
  return {
    enabled: settings?.enabled !== false,
    storageDir: typeof settings?.storageDir === 'string' ? settings.storageDir : '',
  }
}

function normalizeDesktopTerminalSettings(
  settings: Partial<DesktopTerminalSettings> | undefined,
): DesktopTerminalSettings {
  const startupShell = isDesktopTerminalStartupShell(settings?.startupShell)
    ? settings.startupShell
    : DEFAULT_DESKTOP_TERMINAL_SETTINGS.startupShell

  return {
    startupShell,
    customShellPath: typeof settings?.customShellPath === 'string'
      ? settings.customShellPath
      : DEFAULT_DESKTOP_TERMINAL_SETTINGS.customShellPath,
  }
}

function normalizeWorkspaceLspSettings(
  settings: WorkspaceLspSettings | undefined,
): WorkspaceLspSettings {
  const server = settings?.server
  if (!server || typeof server !== 'object') return {}

  const normalizedServer: NonNullable<WorkspaceLspSettings['server']> = {}
  const name = typeof server.name === 'string' ? server.name.trim() : ''
  if (name) normalizedServer.name = name

  const pathValue = typeof server.path === 'string' ? server.path.trim() : ''
  const commandValue = typeof server.command === 'string' ? server.command.trim() : ''
  if (pathValue) normalizedServer.path = pathValue
  if (!pathValue && commandValue && isBareWorkspaceLspCommand(commandValue)) {
    normalizedServer.command = commandValue
  }

  if (Array.isArray(server.args)) {
    normalizedServer.args = server.args.filter((arg): arg is string => typeof arg === 'string')
  }

  const extensionToLanguage = normalizeWorkspaceLspExtensionMap(server.extensionToLanguage)
  if (extensionToLanguage) normalizedServer.extensionToLanguage = extensionToLanguage

  return normalizedServer.path || normalizedServer.command || normalizedServer.extensionToLanguage
    ? { server: normalizedServer }
    : {}
}

function isBareWorkspaceLspCommand(command: string): boolean {
  return !/[\s"'`$&|;<>()]/.test(command)
}

function normalizeWorkspaceLspExtensionMap(
  mapping: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return undefined
  const normalized: Record<string, string> = {}
  for (const [rawExt, rawLanguage] of Object.entries(mapping)) {
    if (typeof rawLanguage !== 'string') continue
    const ext = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`
    const language = rawLanguage.trim()
    if (!/^\.[A-Za-z0-9_+-]+$/.test(ext) || !language) continue
    normalized[ext] = language
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeH5AccessSettings(settings: H5AccessSettings | undefined): H5AccessSettings {
  return {
    enabled: settings?.enabled === true,
    token: typeof settings?.token === 'string' && settings.token ? settings.token : null,
    tokenPreview: settings?.tokenPreview ?? null,
    allowedOrigins: Array.isArray(settings?.allowedOrigins) ? settings.allowedOrigins : [],
    publicBaseUrl: settings?.publicBaseUrl ?? null,
    fixedPort: typeof settings?.fixedPort === 'number' ? settings.fixedPort : null,
    disconnectGraceSeconds: typeof settings?.disconnectGraceSeconds === 'number' ? settings.disconnectGraceSeconds : null,
  }
}

async function loadTraceCaptureSettings(): Promise<TraceCaptureSettings> {
  try {
    return normalizeTraceCaptureSettings(await tracesApi.getSettings())
  } catch {
    return DEFAULT_TRACE_CAPTURE_SETTINGS
  }
}

async function refreshH5DiagnosticsSilent(
  set: (partial: Partial<SettingsStore>) => void,
): Promise<void> {
  // Best-effort diagnostics refresh. Failure here must not surface as an
  // error on the main H5 action (enable/disable/regenerate/update), because
  // the main action has already succeeded by the time we reach this point.
  try {
    const response = await h5AccessApi.get()
    const diagnostics = response?.diagnostics ?? null
    set({ h5AccessDiagnostics: diagnostics })
  } catch {
    // silent: keep previous diagnostics value
  }
}

async function loadH5AccessSettings(previousH5Access: H5AccessSettings): Promise<{
  settings: H5AccessSettings
  diagnostics: H5AccessDiagnostics | null
  error: string | null
}> {
  try {
    const { settings, diagnostics } = await h5AccessApi.get()
    return {
      settings: normalizeH5AccessSettings(settings),
      diagnostics: diagnostics ?? null,
      error: null,
    }
  } catch (error) {
    if (isLegacyH5EndpointError(error)) {
      return {
        settings: DEFAULT_H5_ACCESS_SETTINGS,
        diagnostics: null,
        error: null,
      }
    }

    return {
      settings: previousH5Access,
      diagnostics: null,
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

function isDesktopTerminalStartupShell(value: unknown): value is DesktopTerminalStartupShell {
  return value === 'system'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'custom'
}
