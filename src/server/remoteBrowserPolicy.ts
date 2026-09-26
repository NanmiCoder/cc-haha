import type { RequestCompatibility, SavedProvider } from './types/provider.js'
import { AUTO_QUESTION_TIMEOUT_OPTIONS, normalizeAutoQuestionSettings } from '../shared/autoQuestionSettings.js'

export type ApiRequestContext = { remoteBrowser?: boolean }
const READ_SETTINGS = ['alwaysThinkingEnabled', 'sendThinkingHistory', 'vccCompactBackend', 'workflowKeywordTriggerEnabled', 'agentTeamsEnabled', 'autoDreamEnabled', 'skipAutoPermissionPrompt', 'disableUpdates', 'chatSendBehavior', 'outputStyle', 'skipWebFetchPreflight', 'desktopNotificationsEnabled', 'language', 'webSearch', 'updateProxy', 'network', 'cleanupPeriodDays']
// `skipAutoPermissionPrompt` is writable so the H5 "auto mode" opt-in dialog can
// persist from the phone; `disableUpdates` is writable so the H5 "disable updates"
// switch can persist the same way — both only flip a persistent userSettings
// boolean, same risk class as the other booleans below. The remaining General
// settings (agent teams / auto dream / web-fetch preflight / notifications /
// web search / update proxy / network / retention) are writable too: chapter 九
// lets the H5 render the full GeneralSettings, so every field that UI can touch
// must round-trip or the phone gets 400 "Unsupported General setting".
// `autoQuestion` (upstream) is a nested object, projected/validated via its normalizer.
const WRITE_SETTINGS = new Set(['language', 'chatSendBehavior', 'alwaysThinkingEnabled', 'sendThinkingHistory', 'vccCompactBackend', 'workflowKeywordTriggerEnabled', 'outputStyle', 'skipAutoPermissionPrompt', 'disableUpdates', 'agentTeamsEnabled', 'autoDreamEnabled', 'skipWebFetchPreflight', 'desktopNotificationsEnabled', 'webSearch', 'updateProxy', 'network', 'cleanupPeriodDays', 'autoQuestion'])
const RESERVED_PROVIDER_PATHS = new Set(['settings', 'cc-switch', 'test', 'models', 'presets', 'auth-status', 'official', 'reorder'])
const REMOTE_COMPATIBILITY_KEYS = new Set(['maxOutputTokens', 'outputTokenLimit', 'outputTokenField', 'sampling', 'reasoning', 'parallelTools', 'structuredOutput'])

/** The browser replaces the fields it can edit, while hidden extensions stay on the desktop. */
export function replaceRemoteCompatibility(current: RequestCompatibility | undefined, input: Record<string, unknown> | null) {
  const hidden = Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => !REMOTE_COMPATIBILITY_KEYS.has(key)))
  const editable = Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => REMOTE_COMPATIBILITY_KEYS.has(key)))
  const result = { ...hidden, ...editable }
  return Object.keys(result).length ? result : null
}

export function remoteProviderRouteAllowed(parts: string[], method: string): boolean {
  const id = parts[2]
  if (!id) return method === 'GET' || method === 'POST'
  if (parts.length === 3) {
    if (['presets', 'auth-status'].includes(id)) return method === 'GET'
    if (id === 'official') return method === 'POST'
    if (id === 'reorder') return method === 'PUT'
    return !RESERVED_PROVIDER_PATHS.has(id) && ['GET', 'PUT', 'DELETE'].includes(method)
  }
  return parts.length === 4 && !RESERVED_PROVIDER_PATHS.has(id) && parts[3] === 'activate' && method === 'POST'
}

// The phone can reach `/settings/user` plus the two General-sub-page endpoints
// the desktop UI drives from there: the output-style picker (its list read and
// the style write) and transcript retention (`/session-cleanup`). Everything
// else (project settings, CLI launcher, permission mode, …) stays desktop-only.
export function remoteSettingsRouteAllowed(parts: string[], method: string): boolean {
  if (parts.length !== 3) return false
  if (parts[2] === 'user') return ['GET', 'PUT'].includes(method)
  if (parts[2] === 'output-styles') return method === 'GET'
  if (parts[2] === 'output-style') return method === 'PUT'
  if (parts[2] === 'session-cleanup') return method === 'POST'
  return false
}

const DESKTOP_TERMINAL_SHELLS = ['', 'system', 'pwsh', 'powershell', 'cmd', 'custom']

function isDesktopTerminalPatch(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (entry.startupShell !== undefined && !DESKTOP_TERMINAL_SHELLS.includes(entry.startupShell as string)) return false
  if (entry.customShellPath !== undefined && entry.customShellPath !== null && typeof entry.customShellPath !== 'string') return false
  if (entry.startupShell === 'custom') {
    const customShellPath = typeof entry.customShellPath === 'string' ? entry.customShellPath.trim() : ''
    if (!customShellPath) return false
  }
  return true
}

const WEB_SEARCH_MODES = ['auto', 'anthropic', 'tavily', 'brave', 'disabled']
const UPDATE_PROXY_MODES = ['system', 'manual']
const NETWORK_PROXY_MODES = ['direct', 'system', 'manual']
const MAX_CLEANUP_PERIOD_DAYS = 3650
const NETWORK_TIMEOUT_MIN_MS = 30_000
const NETWORK_TIMEOUT_MAX_MS = Math.floor(2_147_483_647 / 1000) * 1000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidWebSearch(value: unknown): boolean {
  if (!isObject(value)) return false
  if (value.mode !== undefined && !(typeof value.mode === 'string' && WEB_SEARCH_MODES.includes(value.mode))) return false
  if (value.tavilyApiKey !== undefined && typeof value.tavilyApiKey !== 'string') return false
  if (value.braveApiKey !== undefined && typeof value.braveApiKey !== 'string') return false
  return true
}

function isValidUpdateProxy(value: unknown): boolean {
  return isObject(value) && typeof value.mode === 'string' && UPDATE_PROXY_MODES.includes(value.mode) && typeof value.url === 'string'
}

function isValidNetwork(value: unknown): boolean {
  if (!isObject(value) || typeof value.aiRequestTimeoutMs !== 'number' || !Number.isFinite(value.aiRequestTimeoutMs) || value.aiRequestTimeoutMs < NETWORK_TIMEOUT_MIN_MS || value.aiRequestTimeoutMs > NETWORK_TIMEOUT_MAX_MS) return false
  const proxy = value.proxy
  return isObject(proxy) && typeof proxy.mode === 'string' && NETWORK_PROXY_MODES.includes(proxy.mode) && typeof proxy.url === 'string'
}

function isValidCleanupPeriodDays(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CLEANUP_PERIOD_DAYS
}

export function projectRemoteSettings(settings: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const key of READ_SETTINGS) {
    const value = settings[key]
    if (key === 'webSearch') { if (isValidWebSearch(value)) result[key] = { ...value } }
    else if (key === 'updateProxy') { if (isValidUpdateProxy(value)) result[key] = { ...value } }
    else if (key === 'network') { if (isValidNetwork(value)) result[key] = { ...value, proxy: { ...(value.proxy as Record<string, unknown>) } } }
    else if (key === 'cleanupPeriodDays') { if (isValidCleanupPeriodDays(value)) result[key] = value }
    else if (['string', 'boolean', 'number'].includes(typeof value)) result[key] = value
  }
  if (settings.autoQuestion !== undefined) {
    result.autoQuestion = normalizeAutoQuestionSettings(settings.autoQuestion)
  }
  if (isDesktopTerminalPatch(settings.desktopTerminal)) {
    result.desktopTerminal = { ...(settings.desktopTerminal as Record<string, unknown>) }
  }
  return result
}

export function validateRemoteSettingsPatch(input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([key, value]) => {
    if (key === 'desktopTerminal') return isDesktopTerminalPatch(value)
    if (!WRITE_SETTINGS.has(key)) return false
    if (key === 'language') return typeof value === 'string' && value.length <= 80
    if (key === 'outputStyle') return typeof value === 'string' && ['default', 'Explanatory', 'Learning'].includes(value)
    if (key === 'chatSendBehavior') return value === 'enter' || value === 'modifierEnter'
    if (key === 'vccCompactBackend') return value === 'algorithm' || value === 'llm'
    if (key === 'webSearch') return isValidWebSearch(value)
    if (key === 'updateProxy') return isValidUpdateProxy(value)
    if (key === 'network') return isValidNetwork(value)
    if (key === 'cleanupPeriodDays') return isValidCleanupPeriodDays(value)
    if (key === 'autoQuestion') return value !== null && typeof value === 'object' &&
      !Array.isArray(value) && Object.keys(value).length === 2 &&
      Object.keys(value).every((field) => field === 'enabled' || field === 'timeoutMinutes') &&
      typeof (value as Record<string, unknown>).enabled === 'boolean' &&
      AUTO_QUESTION_TIMEOUT_OPTIONS.some((minutes) => minutes === (value as Record<string, unknown>).timeoutMinutes)
    return typeof value === 'boolean'
  })
}
export function projectRemoteProvider(provider: SavedProvider) {
  const publicKeys = [
    'id', 'presetId', 'name', 'authStrategy', 'baseUrl', 'apiFormat', 'runtimeKind', 'models',
    'model1mSupport', 'autoCompactWindow', 'modelContextWindows', 'toolSearchEnabled',
    'disableExperimentalBetas', 'supportsNestedToolResultMedia', 'notes',
  ] as const
  return {
    ...Object.fromEntries(publicKeys.filter(key => provider[key] !== undefined).map(key => [key, provider[key]])),
    apiKey: '',
    hasApiKey: !!provider.apiKey,
    ...(provider.requestCompatibility ? {
      requestCompatibility: Object.fromEntries([...REMOTE_COMPATIBILITY_KEYS].filter(key => provider.requestCompatibility![key] !== undefined).map(key => [key, provider.requestCompatibility![key]])),
    } : {}),
    ...(provider.imageGeneration ? {
      imageGeneration: {
        model: provider.imageGeneration.model,
        ...(provider.imageGeneration.baseUrl !== undefined ? { baseUrl: provider.imageGeneration.baseUrl } : {}),
        apiKey: '', hasApiKey: !!provider.imageGeneration.apiKey,
      },
    } : {}),
  }
}
