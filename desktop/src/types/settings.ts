// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReasoningEffortLevel = EffortLevel
/**
 * The six 「纸 · 墨 · 印」 palettes, in the order the appearance picker shows
 * them: four paper grounds, then two ink ones. Each name matches a
 * `[data-theme]` block in theme/globals.css.
 *
 * `light` was the pre-redesign key for the warm workspace; it migrates to
 * `warm-classic` (see lib/persistenceMigrations.ts).
 */
export const THEME_MODES = ['white', 'paper', 'warm-classic', 'celadon', 'dark', 'ink-blue'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** The two themes on a dark ground. Drives `color-scheme` and Mermaid. */
export const DARK_THEME_MODES = ['dark', 'ink-blue'] as const
export type DarkThemeMode = (typeof DARK_THEME_MODES)[number]

/**
 * The four paper grounds. Following the system only yields a dark/light
 * signal, so each half carries its own preference — these are the values the
 * light half can resolve to.
 */
export const LIGHT_THEME_MODES = ['white', 'paper', 'warm-classic', 'celadon'] as const
export type LightThemeMode = (typeof LIGHT_THEME_MODES)[number]

/**
 * Every palette belongs to exactly one half. This fails to compile if a
 * seventh theme is added without deciding which ground it sits on — the
 * appearance switch would otherwise silently never resolve to it.
 */
const _everyThemeHasAGround: ThemeMode extends LightThemeMode | DarkThemeMode ? true : never = true
void _everyThemeHasAGround

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export function isDarkTheme(theme: ThemeMode): boolean {
  return (DARK_THEME_MODES as readonly string[]).includes(theme)
}

export function isLightThemeMode(value: unknown): value is LightThemeMode {
  return typeof value === 'string' && (LIGHT_THEME_MODES as readonly string[]).includes(value)
}

export function isDarkThemeMode(value: unknown): value is DarkThemeMode {
  return typeof value === 'string' && (DARK_THEME_MODES as readonly string[]).includes(value)
}

export type WebSearchMode = 'auto' | 'anthropic' | 'tavily' | 'brave' | 'disabled'

export type ChatSendBehavior = 'enter' | 'modifierEnter'

export type OutputStyleSource =
  | 'built-in'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'plugin'

export type OutputStyleOption = {
  value: string
  label: string
  description: string
  source: OutputStyleSource
}

export type OutputStylesResponse = {
  outputStyle: string
  styles: OutputStyleOption[]
  scope: 'userSettings' | 'localSettings'
  workDir: string | null
}

export type WebSearchSettings = {
  mode?: WebSearchMode
  tavilyApiKey?: string
  braveApiKey?: string
}

export type UpdateProxyMode = 'system' | 'manual'

export type UpdateProxySettings = {
  mode: UpdateProxyMode
  url: string
}

export type NetworkProxyMode = 'direct' | 'system' | 'manual'

export type NetworkProxySettings = {
  mode: NetworkProxyMode
  url: string
}

export type NetworkSettings = {
  aiRequestTimeoutMs: number
  proxy: NetworkProxySettings
}

export type H5AccessSettings = {
  enabled: boolean
  /** Full token, recoverable at any time from the desktop app. Null for pre-#767 data until the token is regenerated. */
  token: string | null
  tokenPreview: string | null
  allowedOrigins: string[]
  publicBaseUrl: string | null
  /** Preferred fixed server port. Applied by the Tauri launcher on next app start. */
  fixedPort: number | null
  /** Idle grace period (seconds) before a disconnected, idle session's CLI is stopped. null = built-in 30s default. */
  disconnectGraceSeconds: number | null
}

export type H5HostStaleness = 'ok' | 'unreachable' | 'proxy' | 'unset'

export type H5AccessDiagnostics = {
  storedHostStaleness: H5HostStaleness
  storedPublicBaseUrl: string | null
  effectivePublicBaseUrl: string | null
  suggestedHost: string | null
  localInterfaceHosts: string[]
  activePort?: number
}

export type DesktopTerminalStartupShell =
  | 'system'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'custom'

export type DesktopTerminalSettings = {
  startupShell: DesktopTerminalStartupShell
  customShellPath: string
}

export type ModelInfo = {
  id: string
  name: string
  description: string
  context: string
  defaultReasoningEffort?: ReasoningEffortLevel
  supportedReasoningEfforts?: ReasoningEffortLevel[]
}

export type UserSettings = {
  model?: string
  modelContext?: string
  effort?: EffortLevel
  alwaysThinkingEnabled?: boolean
  workflowKeywordTriggerEnabled?: boolean
  autoDreamEnabled?: boolean
  skipAutoPermissionPrompt?: boolean
  permissionMode?: PermissionMode
  theme?: ThemeMode
  chatSendBehavior?: ChatSendBehavior
  outputStyle?: string
  skipWebFetchPreflight?: boolean
  desktopNotificationsEnabled?: boolean
  webSearch?: WebSearchSettings
  updateProxy?: Partial<UpdateProxySettings>
  network?: {
    aiRequestTimeoutMs?: number
    proxy?: Partial<NetworkProxySettings>
  }
  language?: string
  desktopTerminal?: Partial<DesktopTerminalSettings>
  [key: string]: unknown
}

export type AppMode = 'default' | 'portable'

export type AppModeConfig = {
  mode: AppMode
  portableDir: string | null
  activeConfigDir?: string | null
  configDirSource?: 'system' | 'environment' | 'portable'
}
