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
}

export type McpWritableScope = 'local' | 'project' | 'user'

export type McpUpsertPayload = {
  scope: McpWritableScope
  config: McpEditableConfig
}

/** Single tool advertised by a connected MCP server. Mirrors backend's `RawMcpToolInfo`. */
export type McpToolInfo = {
  /** Unqualified tool name (`navigate_page`). */
  name: string
  /** Fully qualified `mcp__server__tool` name used by the agent. */
  qualifiedName: string
  /** Description from the MCP server. Empty string when not provided. */
  description: string
  /** Raw JSON Schema for the tool's input. */
  inputSchema: unknown
  /** Optional human-readable title from MCP annotations. */
  title?: string
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    openWorldHint: boolean
    idempotentHint: boolean
  }
  /**
   * Whether the tool is currently visible to the agent. Backed by the user's
   * global override map (`disabledMcpTools` in the global Claude config).
   * Disabled tools still appear in the listing so the user can toggle them
   * back on; the agent loop hides them via `fetchToolsForClient`.
   */
  enabled: boolean
}

export type McpToolToggleResult = {
  serverName: string
  toolName: string
  enabled: boolean
}

export type McpToolsResult = {
  serverName: string
  /** When the server is unreachable, `tools` will be empty and `error` describes the reason. */
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled'
  tools: McpToolInfo[]
  error?: string
}

/** Coarse marketplace category. Mirrors backend `MarketplaceCategory`. */
export type MarketplaceCategory =
  | 'browser'
  | 'dev-platform'
  | 'data'
  | 'memory'
  | 'search'
  | 'productivity'
  | 'ai'
  | 'utility'

export type MarketplaceTransport =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'http' | 'sse'; url: string }

export type MarketplaceEntry = {
  id: string
  name: string
  description: string
  category: MarketplaceCategory
  transport: MarketplaceTransport
  requiresEnv?: { name: string; description: string }[]
  homepage?: string
  /** Source identifier — `'builtin'` for shipped entries, otherwise a remote source id. */
  source: string
}

export type MarketplaceRemoteSource = {
  id: string
  url: string
  label?: string
  enabled: boolean
  fetchedAt?: number
  error?: string
}

export type MarketplaceCatalog = {
  entries: MarketplaceEntry[]
  remoteSources: MarketplaceRemoteSource[]
}
