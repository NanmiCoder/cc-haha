// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type ReasoningEffortLevel = EffortLevel | 'xhigh'
export const THEME_MODES = ['white', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
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
