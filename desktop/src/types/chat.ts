import type { PermissionMode } from './settings'
import type { RuntimeSelection } from './runtime'

// Source: src/server/ws/events.ts

// ─── Client → Server ──────────────────────────────────────────────

export type ClientMessage =
  | { type: 'prewarm_session' }
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[] }
  | {
      type: 'permission_response'
      requestId: string
      allowed: boolean
      rule?: string
      updatedInput?: Record<string, unknown>
      denyMessage?: string
      permissionUpdates?: PermissionUpdate[]
    }
  | {
      type: 'computer_use_permission_response'
      requestId: string
      response: ComputerUsePermissionResponse
    }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | ({ type: 'set_runtime_config' } & RuntimeSelection)
  | { type: 'set_coordinator_mode'; enabled: boolean }
  | { type: 'set_pipeline_mode'; flavor: 'solo' | 'normal' }
  | { type: 'set_handoff_summary'; previousSessionId: string; deep?: boolean }
  | { type: 'stop_generation' }
  | { type: 'ping' }

export type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string
  mimeType?: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  note?: string
  quote?: string
}

export type DisplayAttachmentRef = AttachmentRef & {
  /** UI-only preview URL. Never send to the websocket/server/model payload. */
  previewUrl?: string
}

export type PermissionUpdate =
  | {
      type: 'addRules' | 'replaceRules' | 'removeRules'
      rules: Array<{ toolName: string; ruleContent?: string }>
      behavior: 'allow' | 'deny' | 'ask'
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
    }
  | {
      type: 'setMode'
      mode: PermissionMode
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
    }
  | {
      type: 'addDirectories' | 'removeDirectories'
      directories: string[]
      destination: 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg'
    }

export type UIAttachment = {
  type: 'file' | 'image'
  name: string
  path?: string
  data?: string
  previewUrl?: string
  mimeType?: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  note?: string
  quote?: string
}

// ─── Server → Client ──────────────────────────────────────────────

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'content_start'; blockType: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; parentToolUseId?: string }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean; parentToolUseId?: string }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      toolUseId?: string
      input: unknown
      description?: string
    }
  | {
      type: 'computer_use_permission_request'
      requestId: string
      request: ComputerUsePermissionRequest
    }
  | { type: 'user_message_replay'; content: string }
  | { type: 'message_complete'; usage: TokenUsage }
  | { type: 'thinking'; text: string }
  | { type: 'status'; state: ChatState; verb?: string }
  // CLI 回传的权限模式变化（如 ExitPlanMode 退出 plan 后恢复、Shift+Tab）。
  // 桌面端据此把选择器校正回 CLI 的真实权限，避免本地影子值漂移。
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  | {
      type: 'api_retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      errorType?: string
      errorMessage?: string
    }
  // 流式请求失败、CLI 已降级为非流式重试：完整响应一次性返回，期间无增量输出。
  | { type: 'streaming_fallback'; cause: StreamingFallbackCause }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string }
  | { type: 'system_notification'; subtype: string; message?: string; data?: unknown }
  | { type: 'pong' }
  | { type: 'team_update'; teamName: string; members: TeamMemberStatus[] }
  | { type: 'team_created'; teamName: string }
  | { type: 'team_deleted'; teamName: string }
  | { type: 'task_update'; taskId: string; status: string; progress?: string }
  | { type: 'session_title_updated'; sessionId: string; title: string }
  /**
   * Provider-level compatibility event. Sent when the server-side WS
   * handler observes a provider rejecting an Anthropic-protocol field
   * with a 4xx — current detection: thinking-incompatible Bedrock
   * proxies returning "additionalModelRequestFields not supported".
   * The desktop providerCompatStore records this against the
   * provider id and shows a "思考不兼容" badge in Settings; cleared
   * on next provider edit.
   */
  | {
      type: 'provider_compat_event'
      providerId: string
      kind: 'thinking_incompatible'
      reason?: string
    }

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export type ChatState = 'idle' | 'thinking' | 'compacting' | 'tool_executing' | 'streaming' | 'permission_pending'

export type ApiRetryState = {
  attempt: number
  maxRetries: number
  retryDelayMs: number
  errorStatus: number | null
  errorType?: string
  errorMessage?: string
  receivedAt: number
}

export type StreamingFallbackCause = 'watchdog' | 'stream_error' | '404_stream_creation' | 'unknown'

// 活动回合状态（与 apiRetry 同生命周期），不进消息历史。
export type StreamingFallbackState = {
  cause: StreamingFallbackCause
  receivedAt: number
}

export type TeamMemberStatus = {
  agentId: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  currentTask?: string
}

export type ComputerUseGrantFlags = {
  clipboardRead: boolean
  clipboardWrite: boolean
  systemKeyCombos: boolean
}

export type ComputerUseResolvedApp = {
  bundleId: string
  displayName: string
  path?: string
  iconDataUrl?: string
}

export type ComputerUseResolvedAppRequest = {
  requestedName: string
  resolved?: ComputerUseResolvedApp
  isSentinel: boolean
  alreadyGranted: boolean
  proposedTier: 'read' | 'click' | 'full'
}

export type ComputerUsePermissionRequest = {
  requestId: string
  reason: string
  apps: ComputerUseResolvedAppRequest[]
  requestedFlags: Partial<ComputerUseGrantFlags>
  screenshotFiltering: 'native' | 'none'
  tccState?: {
    accessibility: boolean
    screenRecording: boolean
  }
  willHide?: Array<{ bundleId: string; displayName: string }>
  autoUnhideEnabled?: boolean
}

export type ComputerUsePermissionResponse = {
  granted: Array<{
    bundleId: string
    displayName: string
    grantedAt: number
    tier?: 'read' | 'click' | 'full'
  }>
  denied: Array<{
    bundleId: string
    reason: 'user_denied' | 'not_installed'
  }>
  flags: ComputerUseGrantFlags
  userConsented?: boolean
}

export type AgentTaskNotification = {
  taskId: string
  toolUseId: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
  result?: string
  outputFile?: string
  usage?: BackgroundAgentTaskUsage
  timestamp?: string
}

export type BackgroundAgentTaskUsage = {
  totalTokens?: number
  toolUses?: number
  durationMs?: number
}

export type BackgroundAgentTask = {
  taskId: string
  toolUseId?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  description?: string
  taskType?: string
  workflowName?: string
  prompt?: string
  summary?: string
  lastToolName?: string
  outputFile?: string
  usage?: BackgroundAgentTaskUsage
  startedAt: number
  updatedAt: number
}

export type MemoryEventFile = {
  path: string
  action?: 'saved' | 'updated' | 'created' | 'deleted' | 'loaded' | 'failed'
  summary?: string
}

export type GoalEventAction = 'created' | 'replaced' | 'status' | 'paused' | 'resumed' | 'completed' | 'cleared' | 'message'

export type ActiveGoalState = {
  action: Exclude<GoalEventAction, 'cleared' | 'message'>
  status?: string
  objective?: string
  budget?: string
  elapsed?: string
  continuations?: string
  message?: string
  updatedAt: number
}

// ─── UI Message model (rendered in MessageList) ───────────────────

export type TaskSummaryItem = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export type UIMessage =
  | { id: string; type: 'user_text'; content: string; modelContent?: string; transcriptMessageId?: string; timestamp: number; attachments?: UIAttachment[]; pending?: boolean; optimisticQueued?: boolean }
  | { id: string; type: 'assistant_text'; content: string; transcriptMessageId?: string; timestamp: number; model?: string }
  | { id: string; type: 'thinking'; content: string; timestamp: number }
  | {
      id: string
      type: 'tool_use'
      toolName: string
      toolUseId: string
      input: unknown
      timestamp: number
      parentToolUseId?: string
      isPending?: boolean
      partialInput?: string
    }
  | { id: string; type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean; timestamp: number; parentToolUseId?: string }
  | { id: string; type: 'background_task'; task: BackgroundAgentTask; timestamp: number }
  | { id: string; type: 'system'; content: string; timestamp: number }
  | {
      id: string
      type: 'compact_summary'
      title: string
      phase?: 'compacting' | 'complete'
      summary?: string
      trigger?: 'manual' | 'auto'
      preTokens?: number
      messagesSummarized?: number
      timestamp: number
    }
  | {
      id: string
      type: 'goal_event'
      action: GoalEventAction
      status?: string
      objective?: string
      budget?: string
      elapsed?: string
      continuations?: string
      message?: string
      timestamp: number
    }
  | {
      id: string
      type: 'memory_event'
      event: 'saved' | 'updated' | 'loaded' | 'failed'
      files: MemoryEventFile[]
      message?: string
      teamCount?: number
      timestamp: number
    }
  | {
      id: string
      type: 'permission_request'
      requestId: string
      toolName: string
      toolUseId?: string
      input: unknown
      description?: string
      timestamp: number
    }
  | { id: string; type: 'error'; message: string; code: string; businessErrorCode?: string; timestamp: number }
  | { id: string; type: 'task_summary'; tasks: TaskSummaryItem[]; timestamp: number }
