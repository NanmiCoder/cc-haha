/**
 * WebSocket event type definitions
 *
 * 定义客户端与服务器之间 WebSocket 通信的消息类型。
 */

// ============================================================================
// Client → Server
// ============================================================================

export type ClientMessage =
  | { type: 'prewarm_session' }
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[] }
  | {
      type: 'permission_response'
      requestId: string
      allowed: boolean
      rule?: string
      updatedInput?: Record<string, unknown>
    }
  | {
      type: 'computer_use_permission_response'
      requestId: string
      response: ComputerUsePermissionResponse
    }
  | { type: 'set_permission_mode'; mode: string }
  | { type: 'set_runtime_config'; providerId: string | null; modelId: string; effortLevel?: string; thinkingEnabled?: boolean }
  | { type: 'set_coordinator_mode'; enabled: boolean }
  | { type: 'set_pipeline_mode'; flavor: 'solo' | 'normal' }
  | { type: 'set_handoff_summary'; previousSessionId: string; deep?: boolean }
  | { type: 'stop_generation' }
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
  | { type: 'message_complete'; usage: TokenUsage }
  | { type: 'thinking'; text: string }
  | { type: 'status'; state: ChatState; verb?: string; elapsed?: number; tokens?: number }
  // CLI 是权限模式的唯一真相来源。当 CLI 内部 mode 变化（如 ExitPlanMode 后
  // 恢复到进入 plan 前的模式、Shift+Tab 切换）时，把新模式回传给前端，让桌面端
  // 选择器与 CLI 保持同步，而不是停留在本地影子值上。
  | { type: 'permission_mode_changed'; mode: string }
  | {
      type: 'api_retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      errorType?: string
      errorMessage?: string
    }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string }
  | { type: 'system_notification'; subtype: string; message?: string; data?: unknown }
  | { type: 'pong' }
  | { type: 'team_update'; teamName: string; members: TeamMemberStatus[] }
  | { type: 'team_created'; teamName: string }
  | { type: 'team_deleted'; teamName: string }
  | { type: 'task_update'; taskId: string; status: string; progress?: string }
  | { type: 'session_title_updated'; sessionId: string; title: string }
  /**
   * Provider-level compatibility event. Sent when cc-haha's WS handler
   * observes a provider-level incompatibility — e.g. the active
   * provider returned a 4xx like "additionalModelRequestFields not
   * supported", which is the giveaway pattern for a Bedrock proxy
   * that can't relay Anthropic's `thinking` field. The desktop
   * `providerCompatStore` records this against the provider id and
   * shows a "思考不兼容" badge in Settings; cleared on next
   * provider edit.
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

// ============================================================================
// Internal types
// ============================================================================

export type WebSocketSession = {
  sessionId: string
  connectedAt: number
  abortController?: AbortController
  isGenerating: boolean
}
