// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export const THEME_MODES = ['white', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export type WebSearchMode = 'auto' | 'anthropic' | 'tavily' | 'brave' | 'disabled'

export type WebSearchSettings = {
  mode?: WebSearchMode
  tavilyApiKey?: string
  braveApiKey?: string
}

export type H5AccessSettings = {
  enabled: boolean
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
}

export type ModelInfo = {
  id: string
  name: string
  description: string
  context: string
}

export type UserSettings = {
  model?: string
  modelContext?: string
  effort?: EffortLevel
  alwaysThinkingEnabled?: boolean
  permissionMode?: PermissionMode
  theme?: ThemeMode
  skipWebFetchPreflight?: boolean
  desktopNotificationsEnabled?: boolean
  webSearch?: WebSearchSettings
  language?: string
  [key: string]: unknown
}

export type AppMode = 'default' | 'portable'

export type AppModeConfig = {
  mode: AppMode
  portableDir: string | null
  defaultPortableDir: string | null
}
