// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ReasoningEffortLevel = EffortLevel
/**
 * The two canonical Direction C (Warm Editorial Studio) palettes: pure white
 * light and matte charcoal dark. Each name matches a `[data-theme]` block in
 * theme/globals.css.
 *
 * Legacy themes (`light`, `paper`, `warm-classic`, `celadon` -> `white`;
 * `ink-blue`, `neutral-dark` -> `dark`) are forward-migrated in
 * `normalizeThemeMode()`, `theme/systemAppearance.ts`, `index.html`, and
 * `lib/persistenceMigrations.ts`.
 */
export const THEME_MODES = ['white', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** The dark palette. Drives `color-scheme` and Mermaid. */
export const DARK_THEME_MODES = ['dark'] as const
export type DarkThemeMode = (typeof DARK_THEME_MODES)[number]

/** The light palette. */
export const LIGHT_THEME_MODES = ['white'] as const
export type LightThemeMode = (typeof LIGHT_THEME_MODES)[number]

/** Forward-migration map for retired theme keys. */
export const LEGACY_THEME_MIGRATIONS: Readonly<Record<string, ThemeMode>> = {
  light: 'white',
  paper: 'white',
  'warm-classic': 'white',
  celadon: 'white',
  'ink-blue': 'dark',
  'neutral-dark': 'dark',
}

/**
 * Every palette belongs to exactly one half. This fails to compile if a
 * new theme is added without deciding which ground it sits on — the
 * appearance switch would otherwise silently never resolve to it.
 */
const _everyThemeHasAGround: ThemeMode extends LightThemeMode | DarkThemeMode ? true : never = true
void _everyThemeHasAGround

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

/** Resolves current and legacy persisted theme keys into the 2-theme system. */
export function normalizeThemeMode(value: unknown): ThemeMode | null {
  if (typeof value !== 'string') return null
  if (isThemeMode(value)) return value
  return LEGACY_THEME_MIGRATIONS[value] ?? null
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

export type WebSearchMode = 'auto' | 'anthropic' | 'tavily' | 'brave' | 'deepseek' | 'disabled'

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
  deepseekApiKey?: string
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
  /** An installed font family name; empty keeps the built-in monospace stack. */
  fontFamily: string
  fontSize: number
}

export type ModelInfo = {
  id: string
  name: string
  description: string
  context: string
  /** Highest window a user may set for this model; absent when no cap is known. */
  maxContext?: string
  defaultReasoningEffort?: ReasoningEffortLevel
  supportedReasoningEfforts?: ReasoningEffortLevel[]
}

/** 缺省或 null 表示不限；配置上限时必须使用正安全整数。 */
export function isMaxConcurrentSubagents(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
}

export type UserSettings = {
  model?: string
  modelContext?: string
  effort?: EffortLevel
  alwaysThinkingEnabled?: boolean
  /** Claude fast mode (persisted in ~/.claude/settings.json as fastMode; null clears it). */
  fastMode?: boolean | null
  workflowKeywordTriggerEnabled?: boolean
  /** Desktop composer next-prompt suggestions; absent means off (opt-in, costs tokens). */
  nextPromptSuggestionsEnabled?: boolean
  leanModeEnabled?: boolean
  includeCyberRiskInstruction?: boolean
  agentTeamsEnabled?: boolean
  /** 同一会话的普通前台/后台 SubAgent 并发上限，缺省或 null 表示不限。 */
  maxConcurrentSubagents?: number | null
  autoDreamEnabled?: boolean
  autoQuestion?: import('../../../src/shared/autoQuestionSettings').AutoQuestionSettings
  skipAutoPermissionPrompt?: boolean
  permissionMode?: PermissionMode
  theme?: ThemeMode
  chatSendBehavior?: ChatSendBehavior
  outputStyle?: string
  skipWebFetchPreflight?: boolean
  desktopNotificationsEnabled?: boolean
  autoUpdateEnabled?: boolean
  webSearch?: WebSearchSettings
  updateProxy?: Partial<UpdateProxySettings>
  network?: {
    aiRequestTimeoutMs?: number
    proxy?: Partial<NetworkProxySettings>
  }
  language?: string
  desktopTerminal?: Partial<DesktopTerminalSettings>
  /** Days to keep transcripts. 0 disables session persistence entirely. */
  cleanupPeriodDays?: number
  /** Max output tokens escalation mode; absent means 'auto' (follow GrowthBook). */
  maxOutputTokensEscalationMode?: 'auto' | 'enabled' | 'disabled'
  /** Non-persisted read hint naming General settings hydrated from cc-haha/settings.json fallback. */
  ccHahaFallbackKeys?: Array<'effort' | 'language'>
  [key: string]: unknown
}

export type SessionCleanupResult = {
  ok: true
  days: number
  dryRun: boolean
  /** Transcript / tool-result files matched by the cleanup. */
  files: number
  errors: number
}

export type AppMode = 'default' | 'portable'

export type AppModeConfig = {
  mode: AppMode
  portableDir: string | null
  activeConfigDir?: string | null
  configDirSource?: 'system' | 'environment' | 'portable'
}
