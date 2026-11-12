import type {
  PermissionMode,
  ServerMessage,
  TokenUsage,
} from '../../../src/server/ws/events'
/** Wire types are imported as types only: no desktop/server runtime is bundled. */
export type {
  ClientMessage,
  PermissionMode,
  ServerMessage as ServerEvent,
  TokenUsage,
} from '../../../src/server/ws/events'

/** Safe metadata only. Never put credentials or pairing secrets in this shape. */
export type Host = Readonly<{
  id: string
  name: string
  url: string
  auth: 'lan' | 'remote'
  /**
   * The H5 page's own computer (never stored). The browser already loaded the
   * page from this origin, so its cookie or loopback authentication can be used
   * without going through the native access-token or device-pairing form.
   */
  page?: true
}>
export type RuntimeConfig = {
  providerId: string | null
  modelId: string
  effortLevel?: string
  openAIFastMode?: boolean
}
export type Session = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot?: string | null
  workDir: string | null
  workDirExists: boolean
  workspaceState?: 'available' | 'worktree_removed' | 'missing'
  agentProfile?: 'standard' | 'lean'
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}
export type CreateSessionInput = {
  workDir?: string
  permissionMode?: PermissionMode
  agentProfile?: 'standard' | 'lean'
  repository?: { branch?: string | null; worktree?: boolean }
}
export type HistoryEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  timestamp: string
  toolUseResult?: unknown
  model?: string
  parentToolUseId?: string
  isSidechain?: boolean
}
export type HistoryPage = {
  messages: HistoryEntry[]
  taskNotifications?: unknown[]
  page?: {
    nextCursor: string | null
    previousCursor?: string | null
    hasMore: boolean
    historyComplete: boolean
    sourceVersion: string
    scannedBytes: number
    omittedOversizedEntries: number
    contentTruncated?: boolean
    /** Only newer computers provide it: a cursor to read only newly added records forward from the end of this page. */
    tailCursor?: string
    /** false: this forward read hit the page limit, and there are more new records after it. */
    tailComplete?: boolean
  }
}
export type PairRequest = { id: string; claimSecret: string }
export type PairClaim =
  | { status: 'pending' | 'rejected' }
  | {
      status: 'approved'
      token: string
      tokenType: 'Bearer'
      deviceId: string
      expiresAt: number
    }
export type PermissionRequest = Extract<
  ServerMessage,
  { type: 'permission_request' }
>
export type ComputerUsePermissionRequest = Extract<
  ServerMessage,
  { type: 'computer_use_permission_request' }
>
export type ChatItem = {
  id: string
  /** Durable transcript record id; live stream ids must never be used for branch/rewind. */
  sourceMessageId?: string
  /** Complete text-only user record, safe to use for rewind/edit; absent for mixed material. */
  editableText?: string
  attachments?: import('../../../src/server/ws/events').AttachmentRef[]
  type: 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error'
  text: string
  timestamp?: string
  model?: string
  toolName?: string
  toolUseId?: string
  parentToolUseId?: string
  input?: unknown
  partialInput?: string
  result?: unknown
  isError?: boolean
  pending?: boolean
  delivery?: 'pending' | 'confirmed' | 'uncertain'
  /**
   * User messages sent locally and still waiting for the server replay. The turn may end first (pending cleared) 
   * and the replay arrives afterwards; keeping this flag lets it match the original instead of appending a duplicate bubble.
   */
  awaitingReplay?: boolean
  /** Agent The team member who sent this message (only shown on the member page). */
  teammateFrom?: string
  /** Images in tool results (read screenshots etc). */
  images?: ToolImage[]
}
/**
 * One image in a tool result. The computer gives an address by reference, downloaded only when used; 
 * older computers without reference support still inline base64, shown directly.
 */
export type ToolImage = {
  mimeType: string
  /** Read address on the computer (/api/sessions/:id/tool-images/...). */
  url?: string
  /** base64 inlined by older computers. */
  data?: string
  width?: number
  height?: number
}
/** The latest tool call step of a subagent (the part available in live events). */
export type SubagentStep = {
  toolUseId: string
  toolName: string
  input?: unknown
  /** Result received. */
  done: boolean
  isError?: boolean
}
/**
 * Live trajectory of a subagent, accumulated from WebSocket events: `agent_run_event`, tool events with parentToolUseId,
 * and `task_progress` notifications. Keeps only the last few steps, with a cap on count, never growing without bound.
 */
export type SubagentLive = {
  steps: SubagentStep[]
  /** Distinct file paths read (capped). */
  reads: string[]
  /** Total tool call count given by the computer in task_progress; the authoritative value. */
  toolUses?: number
  finished?: boolean
}
export type ChatState = {
  sessionId: string
  items: ChatItem[]
  status:
    | 'idle'
    | 'thinking'
    | 'compacting'
    | 'tool_executing'
    | 'streaming'
    | 'permission_pending'
  turnActive: boolean
  connected: boolean
  configPending: boolean
  permissions: PermissionRequest[]
  computerUsePermissions: ComputerUsePermissionRequest[]
  backgroundTaskIds: string[]
  /** Live subagent trajectories, keyed as in core/subagentLive.ts; absent when there are no events. */
  subagents?: Record<string, SubagentLive>
  runtime?: RuntimeConfig
  permissionMode?: PermissionMode
  usage?: TokenUsage
  error?: { message: string; code: string; retryable?: boolean }
  title?: string
  /** Team plan change pushed by the computer (planId:revision:state); reread the plan when it changes. */
  teamPlanSignal?: string
  nextId: number
  activeTextId?: string
  activeThinkingId?: string
  activeToolId?: string
}
