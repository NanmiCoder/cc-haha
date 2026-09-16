export type McpEditableConfig =
  | {
      type: 'stdio'
      command: string
      args: string[]
      env: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers: Record<string, string>
      headersHelper?: string
      oauth?: {
        clientId?: string
        callbackPort?: number
      }
    }
  | {
      type: string
    }

export type McpServerRecord = {
  name: string
  scope: string
  transport: string
  enabled: boolean
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking'
  statusLabel: string
  statusDetail?: string
  configLocation: string
  summary: string
  canEdit: boolean
  canRemove: boolean
  canReconnect: boolean
  canToggle: boolean
  config: McpEditableConfig
  projectPath?: string
  activeInCurrentContext?: boolean
}

export type McpWritableScope = 'local' | 'project' | 'user'

export type McpUpsertPayload = {
  scope: McpWritableScope
  config: McpEditableConfig
}

export type McpSessionSync = {
  applied: boolean
  reason?: 'not_running' | 'different_project' | 'failed' | 'no_session'
  error?: string
}

export type McpToggleResult = {
  server: McpServerRecord
  sessionSync?: McpSessionSync
}
