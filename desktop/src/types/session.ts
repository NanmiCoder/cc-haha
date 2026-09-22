// Source: src/server/services/sessionService.ts

import type { ReasoningEffortLevel } from './settings'

export type LocalIndexMode = 'off' | 'shadow' | 'on'
export type LocalIndexState = 'off' | 'building' | 'ready' | 'degraded'

export type LocalIndexStatus = {
  mode: LocalIndexMode
  state: LocalIndexState
  discovered: number
  indexed: number
  degradedSources: number
  databaseBytes: number
  walBytes: number
  lastUpdatedAt: string | null
  lastErrorCode: string | null
}

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  workDirExists: boolean
  workspaceState?: SessionWorkspaceState
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: ReasoningEffortLevel
}

export type SessionWorkspaceState = 'available' | 'worktree_removed' | 'missing'

export type MessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageEntry = {
  sessionReferences?: Array<{ sessionId: string }>
  /** Present when this user-position message was delivered from another session. */
  collaboration?: { sourceSessionId: string; messageId?: string }
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  toolUseResult?: unknown
  timestamp: string
  model?: string
  usage?: MessageUsage
  /**
   * Identity of the API response this `usage` belongs to, when it has one. One assistant reply
   * is persisted as several lines that each repeat the whole `usage` object, so anything that
   * totals usage must count each key once. Absent means the line carries no id — count it.
   */
  usageKey?: string
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
}

export type SessionDetail = SessionListItem & {
  messages: MessageEntry[]
}
