/**
 * WebSocket event type definitions
 *
 * 定义客户端与服务器之间 WebSocket 通信的消息类型。
 */

// ============================================================================
// Client → Server
// ============================================================================

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'auto'

export type ClientMessage =
  | { type: 'prewarm_session' }
  | { type: 'sync_state' }
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[] }
  | {
      type: 'permission_response'
      requestId: string
      allowed: boolean
      rule?: string
      updatedInput?: Record<string, unknown>
      denyMessage?: string
      permissionUpdates?: unknown[]
    }
  | {
      type: 'computer_use_permission_response'
      requestId: string
      response: ComputerUsePermissionResponse
    }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'set_runtime_config'; providerId: string | null; modelId: string; effortLevel?: string }
  | { type: 'stop_generation' }
  | { type: 'stop_background_task'; taskId: string }
  | { type: 'ping' }

export type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string // base64 for images
  mimeType?: string
  isDirectory?: boolean
}

// ============================================================================
// Server → Client
// ============================================================================

export const RUNTIME_CONFIG_APPLIED_EVENT = 'runtime_config_applied' as const

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | {
      type: 'session_state'
      turnState: 'running' | 'idle'
      activeBackgroundTaskIds?: string[]
    }
  | {
      type: 'agent_run_event'
      runAgentId: string
      streamId: string
      targetAgentId: string
      targetAgentScopeId?: string
      event: AgentRunStreamMessage
    }
  | { type: 'content_start'; blockType: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; originalToolUseId?: string; parentToolUseId?: string }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; originalToolUseId?: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; originalToolUseId?: string; content: unknown; isError: boolean; parentToolUseId?: string }
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
  | {
      type: 'permission_resolved'
      requestId: string
      permissionType: 'tool' | 'computer_use'
      allowed?: boolean
    }
  | {
      type: 'permission_requests_snapshot'
      toolRequestIds: string[]
      computerUseRequestIds: string[]
      turnActive: boolean
    }
  | { type: 'user_message_replay'; content: string }
  | { type: 'message_complete'; usage: TokenUsage }
  /**
   * `text` is a fragment when the CLI streams `thinking_delta`, and a whole block when
   * it hands over a finished `thinking` block. The client has to concatenate the first
   * kind and separate the second, so the emit site says which it is instead of leaving
   * the renderer to guess from content.
   */
  | { type: 'thinking'; text: string; complete?: boolean }
  | { type: 'status'; state: ChatState; verb?: string; attemptStart?: boolean }
  | {
      type: typeof RUNTIME_CONFIG_APPLIED_EVENT
      providerId: string | null
      modelId: string
      effortLevel?: string
    }
  // CLI 是权限模式的唯一真相来源。当 CLI 内部 mode 变化（如 ExitPlanMode 后
  // 恢复到进入 plan 前的模式、Shift+Tab 切换）时，把新模式回传给前端，让桌面端
  // 选择器与 CLI 保持同步，而不是停留在本地影子值上。
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
  // 流式请求失败、CLI 已降级为非流式重试。非流式响应要等完整生成才返回，
  // 期间没有任何增量输出，前端据此显示"慢速模式"轻提示而不是裸转圈。
  | { type: 'streaming_fallback'; cause: StreamingFallbackCause }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string }
  | { type: 'background_task_stop_failed'; taskId: string; message: string }
  | { type: 'system_notification'; subtype: string; message?: string; data?: unknown }
  | { type: 'pong' }
  | { type: 'team_update'; teamName: string; members: TeamMemberStatus[]; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_created'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_workbench_updated'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_deleted'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'task_update'; taskId: string; status: string; progress?: string }
  | { type: 'session_title_updated'; sessionId: string; title: string }

export type AgentRunStreamMessage =
  | { type: 'content_start'; blockType: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; originalToolUseId?: string; parentToolUseId?: string }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; originalToolUseId?: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; originalToolUseId?: string; content: unknown; isError: boolean; parentToolUseId?: string }
  | { type: 'thinking'; text: string; complete?: boolean }
  | { type: 'status'; state: ChatState; verb?: string; attemptStart?: boolean }
  | { type: 'api_retry'; attempt: number; maxRetries: number; retryDelayMs: number; errorStatus: number | null; errorType?: string; errorMessage?: string }
  | { type: 'streaming_fallback'; cause: StreamingFallbackCause }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string }

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

export type ChatState = 'idle' | 'thinking' | 'compacting' | 'tool_executing' | 'streaming' | 'permission_pending'

// 与 CLI 的 streaming_fallback cause 对齐；unknown 兜底未来新增的 cause 值，
// 避免新 CLI + 旧 server 组合下丢消息。
export type StreamingFallbackCause = 'watchdog' | 'stream_error' | '404_stream_creation' | 'stream_retry' | 'unknown'

export type TeamMemberStatus = {
  agentId: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  /**
   * Omitted when the watcher cannot tell, so a receiver keeps whatever the last
   * full team read established rather than being told the member went quiet.
   */
  activity?: 'active' | 'idle' | 'exited' | 'unknown'
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

// ============================================================================
// Internal types
// ============================================================================

export type WebSocketSession = {
  sessionId: string
  connectedAt: number
  abortController?: AbortController
  isGenerating: boolean
}
