export type NativeConnectorId = 'feishu' | 'dingtalk' | 'wecom'
export type ConnectorId = string
export type ConnectorCategory = 'office' | 'development' | 'search' | 'maps' | 'data' | 'design' | 'productivity' | 'finance' | 'legal'
export type ConnectorAction = 'prepare' | 'authenticate' | 'check' | 'cancel' | 'deactivate' | 'remove'
export type ConnectorStatus = 'not-installed' | 'preparing' | 'needs-auth' | 'authorizing' | 'configured' | 'ready' | 'disabled' | 'error'

export type ConnectorDefinition = {
  id: ConnectorId
  displayName?: string
  description?: string
  category?: ConnectorCategory
  capabilities?: string[]
  setupFields?: Array<{ key: string, label: string, placeholder?: string, secret?: boolean }>
  collection?: 'services' | 'tools'
  region?: 'china' | 'global'
  transport?: 'cli' | 'mcp' | 'skills'
  example?: string
  requirements?: string
  pluginId: string
  packageName: string
  version: string
  homepage: string
  credentialMode: 'isolated' | 'shared'
  platforms: string[]
}

export type ConnectorOperation = {
  id: string
  kind: ConnectorAction
  phase: string
  startedAt: string
  authUrl?: string
}

export type ConnectorDto = ConnectorDefinition & {
  supported: boolean
  installed: boolean
  installedVersion?: string
  updateAvailable?: boolean
  enabled: boolean
  connection: 'disconnected' | 'connected' | 'needs-auth'
  runtime: 'missing' | 'ready' | 'error'
  status: ConnectorStatus
  operation?: ConnectorOperation
  error?: string
  failedPhase?: string
  lastCheckedAt?: string
  accountLabel?: string
  verification?: 'local' | 'remote'
}

export type ConnectorActionOptions = {
  configuration?: Record<string, string>
  acknowledgeSharedCredentials?: boolean
  sessionId?: string
}

export type ConnectorInstallation = {
  directory: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type ConnectorCheck = {
  authenticated: boolean
  accountLabel?: string
  verification?: 'local' | 'remote'
}

export type ConnectorProgress = (phase: string, authUrl?: string) => void

export interface ConnectorAdapter {
  configure?(configuration: Record<string, string>): Promise<void>
  prepare(signal: AbortSignal, progress: ConnectorProgress): Promise<ConnectorInstallation>
  authenticate(installation: ConnectorInstallation, signal: AbortSignal, progress: ConnectorProgress): Promise<void>
  check(installation: ConnectorInstallation, signal: AbortSignal): Promise<ConnectorCheck>
  deactivate(): Promise<void>
  remove(installation: ConnectorInstallation): Promise<void>
}

export type RemoteConnectorRecipe = {
  id: string
  pluginId: string
  version: string
  endpoint: string
  transport: 'http' | 'sse'
  auth: { type: 'none' } | { type: 'oauth', clientId?: string } | { type: 'api-key', in: 'header' | 'query', name: string, prefix?: string }
}

export type SkillBundleRecipe = {
  id: string
  version: string
  repository: string
  commit: string
  license: string
  files: Array<{ source: string, target: string, integrity: string }>
}
