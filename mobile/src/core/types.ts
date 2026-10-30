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
   * 本地已发出、还在等服务端回放的用户消息。回合可能先结束（pending 被清掉），
   * 回放随后才到；保留这个标记才能对上原来那条，而不是再追加一个重复气泡。
   */
  awaitingReplay?: boolean
}
/** 子 Agent 最近的一步工具调用（实时事件里能拿到的部分）。 */
export type SubagentStep = {
  toolUseId: string
  toolName: string
  input?: unknown
  /** 已收到结果。 */
  done: boolean
  isError?: boolean
}
/**
 * 子 Agent 的实时轨迹，由 WebSocket 事件累积：`agent_run_event`、带 parentToolUseId 的
 * 工具事件、`task_progress` 通知。只留最近几步，条数有上限，不会无限增长。
 */
export type SubagentLive = {
  steps: SubagentStep[]
  /** 读过的不同文件路径（有上限）。 */
  reads: string[]
  /** 电脑在 task_progress 里给出的工具调用总数，权威值。 */
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
  /** 子 Agent 实时轨迹，键见 core/subagentLive.ts；没有事件时不存在。 */
  subagents?: Record<string, SubagentLive>
  runtime?: RuntimeConfig
  permissionMode?: PermissionMode
  usage?: TokenUsage
  error?: { message: string; code: string; retryable?: boolean }
  title?: string
  /** 电脑推来的团队方案变化（planId:revision:state）；变了就重新读取方案。 */
  teamPlanSignal?: string
  nextId: number
  activeTextId?: string
  activeThinkingId?: string
  activeToolId?: string
}
