// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type ThemeMode = 'light' | 'dark'

export type ModelInfo = {
  id: string
  name: string
  description: string
  context: string
}

export type MonitoredRepo = {
  owner: string
  repo: string
  autoReply: boolean
}

export type UserSettings = {
  model?: string
  modelContext?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  theme?: ThemeMode
  skipWebFetchPreflight?: boolean
  githubMonitoredRepos?: MonitoredRepo[]
  [key: string]: unknown
}
