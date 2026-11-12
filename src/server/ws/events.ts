import type { ScheduledTaskMetadata } from '../../utils/scheduledTaskMessage.js'
/**
 * WebSocket event type definitions
 *
 * Defines the message types for WebSocket communication between client and server.
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
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[]; sessionReferences?: { sessionId: string }[]; powerActivityLeaseId?: string }
  | {
      type: 'permission_response'
      requestId: string
      allowed: boolean
      rule?: string
      updatedInput?: Record<string, unknown>
      denyMessage?: string
      permissionUpdates?: unknown[]
      // Optional execution-model switch applied together with an approval
      // (currently honored for ExitPlanMode only): same-provider switches are
      // applied in-process via the SDK set_model control request before the
      // allow response; cross-provider switches approve → interrupt → restart
      // the CLI with the new env → auto-continue execution.
      runtimeOverride?: { providerId: string | null; modelId: string; effortLevel?: string; openAIFastMode?: boolean }
    }
  | {
      type: 'computer_use_permission_response'
      requestId: string
      response: ComputerUsePermissionResponse
    }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'set_runtime_config'; providerId: string | null; modelId: string; effortLevel?: string; openAIFastMode?: boolean }
  | { type: 'stop_generation' }
  | { type: 'ask_user_question_activity'; requestId: string }
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
      displayName?: string
      /** Server epoch milliseconds; null cancels a previously announced automatic-answer timer. */
      autoAnswerDeadline?: number | null
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
  | { type: 'user_message_replay'; content: string; sessionReferences?: { sessionId: string }[]; scheduledTask?: ScheduledTaskMetadata }
  | { type: 'message_complete'; usage: TokenUsage; timing?: TurnTiming; scheduledTask?: ScheduledTaskMetadata }
  /**
   * `text` is a fragment when the CLI streams `thinking_delta`, and a whole block when
   * it hands over a finished `thinking` block. The client has to concatenate the first
   * kind and separate the second, so the emit site says which it is instead of leaving
   * the renderer to guess from content.
   */
  | { type: 'thinking'; text: string; complete?: boolean }
  | { type: 'status'; state: ChatState; verb?: string; attemptStart?: boolean; compactProgress?: { outputChars: number } }
  | {
      type: typeof RUNTIME_CONFIG_APPLIED_EVENT
      requestedConfig?: { providerId: string | null; modelId: string; effortLevel?: string; openAIFastMode?: boolean }
      providerId: string | null
      modelId: string
      effortLevel?: string
      openAIFastMode?: boolean
    }
  // The CLI is the single source of truth for permission mode. When the CLI's internal mode changes (e.g. restoring
  // the pre-plan mode after ExitPlanMode, Shift+Tab switching), send the new mode back to the frontend so the desktop
  // picker stays in sync with the CLI instead of a stale local shadow value.
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  | {
      type: 'api_retry'
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
      errorType?: string
      errorMessage?: string
      requestId?: string
    }
  // The streaming request failed and the CLI fell back to a non-streaming retry. Non-streaming responses return only after full generation,
  // with no incremental output in between; the frontend uses this to show a light "slow mode" hint instead of a bare spinner.
  | { type: 'streaming_fallback'; cause: StreamingFallbackCause }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string; transcriptMessageId?: string }
  | { type: 'background_task_stop_failed'; taskId: string; message: string }
  | { type: 'system_notification'; subtype: string; message?: string; data?: unknown }
  | { type: 'pong' }
  | { type: 'team_update'; teamName: string; members: TeamMemberStatus[]; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_plan_updated'; teamName: string; sessionId: string; planId: string; incarnationId: string; revision: number; state: string }
  | { type: 'team_created'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_workbench_updated'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'team_deleted'; teamName: string; incarnationId?: string; leadSessionId?: string; createdAt?: number }
  | { type: 'task_update'; taskId: string; status: string; progress?: string }
  | { type: 'session_title_updated'; sessionId: string; title: string }
  /** Predicted next user prompt for the composer; sent after a turn ends. */
  | { type: 'prompt_suggestion'; suggestion: string }

export type AgentRunStreamMessage =
  | { type: 'content_start'; blockType: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; originalToolUseId?: string; parentToolUseId?: string }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; originalToolUseId?: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; originalToolUseId?: string; content: unknown; isError: boolean; parentToolUseId?: string }
  | { type: 'thinking'; text: string; complete?: boolean }
  | { type: 'status'; state: ChatState; verb?: string; attemptStart?: boolean; compactProgress?: { outputChars: number } }
  | { type: 'api_retry'; attempt: number; maxRetries: number; retryDelayMs: number; errorStatus: number | null; errorType?: string; errorMessage?: string; requestId?: string }
  | { type: 'streaming_fallback'; cause: StreamingFallbackCause }
  | { type: 'error'; message: string; code: string; retryable?: boolean; businessErrorCode?: string }

export type TokenUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

/**
 * Generation timings for one turn, in milliseconds.
 *
 * `duration_ms` is wall clock and therefore includes tool execution; `duration_api_ms` covers
 * only the API requests but includes prefill. `decode_ms` is the span over which the model was
 * actually emitting tokens — it excludes both — and is the right denominator for tokens/sec.
 * `ttft_ms` is carried so a client can explain the gap between `duration_api_ms` and `decode_ms`.
 *
 * Absent when the turn produced no timed stream; never treat a missing value as zero seconds.
 */
export type TurnTiming = {
  duration_ms: number
  duration_api_ms: number
  ttft_ms: number
  decode_ms: number
}

export type ChatState = 'idle' | 'thinking' | 'compacting' | 'tool_executing' | 'streaming' | 'permission_pending'

// Aligned with the CLI's streaming_fallback cause; unknown covers cause values added in the future,
// avoiding dropped messages with a new CLI + old server combination.
export type StreamingFallbackCause = 'watchdog' | 'stream_error' | '404_stream_creation' | 'stream_retry' | 'unknown'

export type TeamMemberStatus = {
  agentId: string
  role: string
  status: 'running' | 'idle' | 'completed' | 'error'
  /**
   * Omitted when the watcher cannot tell, so a receiver keeps whatever the last
   * full team read established rather than being told the member went quiet.
   */
  activity?: 'active' | 'idle' | 'exited' | 'stopped' | 'unknown'
  currentTask?: string
  /**
   * Why the member's last turn failed; `null` says it has recovered. Only the
   * process-backed (desktop) runtime records it.
   */
  lastError?: string | null
  /** A pending automatic continuation after a transient provider failure; `null` once settled. */
  autoRetry?: { attempt: number; max: number; nextAt: number } | null
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
