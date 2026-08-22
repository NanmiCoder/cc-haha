/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type {
  AgentRunStreamMessage,
  ClientMessage,
  PermissionMode,
  ServerMessage,
  TokenUsage,
} from './events.js'
import { RUNTIME_CONFIG_APPLIED_EVENT } from './events.js'
import * as os from 'node:os'
import {
  ConversationStartupError,
  conversationService,
} from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import {
  sessionService,
} from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { getPresetDefaultEnv } from '../services/providerRuntimeEnv.js'
import { isOpenAIOfficialProviderId } from '../services/openaiOfficialProvider.js'
import { isGrokOfficialProviderId } from '../services/grokOfficialProvider.js'
import { getOpenAICodexModelCatalog } from '../../services/openaiAuth/modelCatalog.js'
import {
  OPENAI_DEFAULT_MAIN_MODEL,
  getOpenAIModelCatalogEntry,
  isOpenAIReasoningEffort,
} from '../../services/openaiAuth/models.js'
import { GROK_DEFAULT_MAIN_MODEL } from '../../services/grokAuth/models.js'
import { getGrokModelCatalog } from '../../services/grokAuth/modelCatalog.js'
import { hahaGrokOAuthService } from '../services/hahaGrokOAuthService.js'
import { resolveClaudeOfficialRuntimeModel } from '../services/claudeOfficialRuntime.js'
import {
  getModelReasoningCapabilityOverride,
  isModelReasoningEffort,
  normalizeModelReasoningEffort,
} from '../../shared/modelReasoning.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import {
  buildConversationTitleInput,
  deriveTitle,
  generateTitle,
  resolveTitleLanguagePreference,
  saveAiTitle,
  type TitleConversationTurn,
} from '../services/titleService.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import { archiveRemoteSession } from '../../utils/teleport/api.js'
import { shouldCreateWorktreeForSessionLaunch } from '../services/repositoryLaunchService.js'
import { getDisconnectGraceMs } from './disconnectGraceConfig.js'
import {
  isPetClientMessageAllowed,
  toPetServerMessage,
} from '../petAccessPolicy.js'
import {
  activeBackgroundTaskIds,
  activeAgentTasks,
  activeNonAgentTasks,
  authoritativeStoppedTaskIds,
  agentStopRequestedSessions,
  runtimeExitStoppedSessions,
  getCliBackgroundTaskLifecycle,
  isAgentTaskType,
  untrackCliBackgroundTask,
  clearAgentRuntimeState,
  markTaskAuthoritativelyStopped,
  hasActiveBackgroundTasks,
  clearAgentStopFinalizationRetry,
  markActiveAgentsStopping,
} from './agentTaskState.js'
import type {
  ActiveAgentTaskState,
  CliBackgroundTaskLifecycle,
} from './agentTaskState.js'
import {
  ROOT_STREAM_SCOPE,
  extractAssistantStreamTextForTitle,
  extractAssistantMessageTextForTitle,
  cliParentToolUseId,
  cliStreamScope,
  scopedToolUseId,
  extractAssistantText,
  normalizeAskUserQuestionToolResult,
  classifyRuntimeErrorCode,
  toApiRetryServerMessage,
  toStreamingFallbackServerMessage,
  extractLocalCommandOutput,
  isCompactLocalCommandOutput,
  extractLocalCommand,
  extractGoalEvent,
  looksLikeGoalCommandOutput,
  getCompactBoundaryMessage,
  isCompactSummaryMessageContent,
  extractReplayUserText,
  normalizeCliTaskNotification,
} from './cliMessageParsing.js'
import {
  resetCurrentStreamAttempt,
  streamBlockKey,
  rememberActiveBlockScope,
  forgetActiveBlockScope,
  resolveActiveBlockKey,
  pendingToolBlockKey,
  rememberToolParentUseId,
  forgetToolParentUseId,
  consumeToolParentUseId,
} from './streamBlocks.js'
import type {
  SessionStreamState,
} from './streamBlocks.js'

const settingsService = new SettingsService()
const providerService = new ProviderService()

function buildSdkWebSocketUrl(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string {
  const url = new URL(`ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}`)
  url.searchParams.set('token', crypto.randomUUID())
  return url.toString()
}

/**
 * Cache slash commands from CLI init messages, keyed by sessionId.
 */
export type SessionSlashCommand = {
  name: string
  description: string
  argumentHint?: string
}

const sessionSlashCommands = new Map<string, SessionSlashCommand[]>()

/**
 * Timers for delayed session cleanup after client disconnect.
 * If a client reconnects before the timer fires, the timer is cancelled.
 */
const PENDING_PERMISSION_DISCONNECT_CLEANUP_MS = 30 * 60_000
const sessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Per-session removers for the active-work watcher (issue #764). When the last
 * client disconnects while a turn or background task is still running, we let
 * that work finish instead of killing the CLI, then start the idle grace timer.
 * The remover is also cleared on reconnect/cleanup.
 */
const sessionDisconnectWatchers = new Map<string, () => void>()

/**
 * Track sessions where user requested stop. Until a replacement turn begins
 * or the runtime is cleaned up, this keeps late foreground output from
 * reviving the renderer and suppresses the CLI_ERROR produced by the interrupt.
 */
const sessionStopRequested = new Set<string>()

/**
 * Track user message count and title state per session for auto-title generation.
 */
const sessionTitleState = new Map<string, {
  userMessageCount: number
  hasCustomTitle: boolean
  hasExistingTranscript: boolean
  firstUserMessage: string
  completedTurns: TitleConversationTurn[]
  activeTurn?: TitleConversationTurn & { count: number }
  startedGenerationKeys: Set<string>
  generationSeq: number
}>()

type RuntimeOverride = {
  providerId: string | null
  modelId: string
  effort?: string
}

type ActiveUserTurnState = {
  messageSent: boolean
  sendStarted?: boolean
  interruptBoundaryPending?: boolean
  replacementAfterStop?: boolean
  expectedReplayUuid?: string
  expectedLocalCommand?: NonNullable<ReturnType<typeof parseSlashCommand>>
  cancelled?: boolean
}




const runtimeOverrides = new Map<string, RuntimeOverride>()
const activeUserTurns = new Map<string, ActiveUserTurnState>()
const activeCliRuns = new Set<string>()
const pendingInterruptedTurnResults = new Map<string, number>()
const interruptedTurnResultMessages = new WeakMap<object, string>()
const sessionClearInProgress = new Set<string>()
const deferredRuntimeRestarts = new Map<string, RuntimeOverride>()
const deferredPermissionModes = new Map<string, PermissionMode>()

export type SessionChatActivityState =
  | 'waiting'
  | 'failed'
  | 'review'
  | 'running'
  | 'idle'

/**
 * Pet/activity status deliberately reuses the authoritative WebSocket turn and
 * permission state above. Only failures and the legacy REST queue fallback
 * need their own memory; successful completion returns directly to idle.
 */
const terminalSessionChatStates = new Map<string, 'failed'>()
const legacyQueuedSessionChats = new Set<string>()
const interruptedSessionChats = new Set<string>()

function beginSessionChatActivity(sessionId: string): void {
  terminalSessionChatStates.delete(sessionId)
  legacyQueuedSessionChats.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
}

function failSessionChatActivity(sessionId: string): void {
  legacyQueuedSessionChats.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
  terminalSessionChatStates.set(sessionId, 'failed')
}

function settleSessionChatActivity(sessionId: string, cliMsg: any): void {
  if (cliMsg?.type !== 'result') return

  legacyQueuedSessionChats.delete(sessionId)
  if (interruptedSessionChats.has(sessionId)) {
    terminalSessionChatStates.delete(sessionId)
    return
  }
  if (cliMsg.is_error) {
    terminalSessionChatStates.set(sessionId, 'failed')
    return
  }

  // A successful result is complete. Keeping the tab open does not imply that
  // the user has an outstanding review action.
  terminalSessionChatStates.delete(sessionId)
}







function trackCliBackgroundTaskLifecycle(
  sessionId: string,
  cliMsg: any,
): CliBackgroundTaskLifecycle | null {
  const rawTaskId = cliMsg?.type === 'system' && typeof cliMsg.task_id === 'string'
    ? cliMsg.task_id.trim()
    : ''
  if (rawTaskId && authoritativeStoppedTaskIds.get(sessionId)?.has(rawTaskId)) {
    // The lifecycle parser intentionally ignores progress and tool-activity
    // messages. Check the raw task id first so no late task-scoped event can
    // revive an Agent after its durable stopped bookend has been published.
    return {
      taskId: rawTaskId,
      running: false,
      status: 'stopped',
      suppressForward: true,
    }
  }

  const lifecycle = getCliBackgroundTaskLifecycle(cliMsg)
  if (!lifecycle) return null

  const existingAgentTask = activeAgentTasks.get(sessionId)?.get(lifecycle.taskId)
  if (
    lifecycle.running &&
    existingAgentTask?.stopIntent &&
    existingAgentTask.localStopConfirmed
  ) {
    // Once the local task has acknowledged Stop, any queued start/progress
    // event is stale. Do not let it revive Activity or cancel idle cleanup
    // while strict archive/bookend finalization is being retried.
    return {
      ...lifecycle,
      running: false,
      status: 'stopped',
      suppressForward: true,
    }
  }

  if (lifecycle.running) {
    let taskIds = activeBackgroundTaskIds.get(sessionId)
    if (!taskIds) {
      taskIds = new Set()
      activeBackgroundTaskIds.set(sessionId, taskIds)
    }
    taskIds.add(lifecycle.taskId)
    if (isAgentTaskType(lifecycle.taskType)) {
      let sessionAgentTasks = activeAgentTasks.get(sessionId)
      if (!sessionAgentTasks) {
        sessionAgentTasks = new Map()
        activeAgentTasks.set(sessionId, sessionAgentTasks)
      }
      const existing = sessionAgentTasks.get(lifecycle.taskId)
      if (existing) {
        existing.toolUseId = lifecycle.toolUseId ?? existing.toolUseId
        if (lifecycle.remoteSessionId) existing.remoteSessionId = lifecycle.remoteSessionId
        if (lifecycle.description) existing.description = lifecycle.description
        if (lifecycle.ownerAgentId) existing.ownerAgentId = lifecycle.ownerAgentId
      } else {
        sessionAgentTasks.set(lifecycle.taskId, {
          taskId: lifecycle.taskId,
          taskType: lifecycle.taskType,
          toolUseId: lifecycle.toolUseId ?? lifecycle.taskId,
          ...(lifecycle.remoteSessionId
            ? { remoteSessionId: lifecycle.remoteSessionId }
            : {}),
          ...(lifecycle.description ? { description: lifecycle.description } : {}),
          ...(lifecycle.ownerAgentId ? { ownerAgentId: lifecycle.ownerAgentId } : {}),
          stopIntent: false,
          stopRequested: false,
          localStopConfirmed: false,
          bookendPending: false,
          finalizationRetryCount: 0,
        })
      }
    } else {
      let sessionNonAgentTasks = activeNonAgentTasks.get(sessionId)
      if (!sessionNonAgentTasks) {
        sessionNonAgentTasks = new Map()
        activeNonAgentTasks.set(sessionId, sessionNonAgentTasks)
      }
      const existing = sessionNonAgentTasks.get(lifecycle.taskId)
      if (existing) {
        existing.toolUseId = lifecycle.toolUseId ?? existing.toolUseId
        if (lifecycle.taskType) existing.taskType = lifecycle.taskType
        if (lifecycle.description) existing.description = lifecycle.description
        if (lifecycle.ownerAgentId) existing.ownerAgentId = lifecycle.ownerAgentId
      } else {
        sessionNonAgentTasks.set(lifecycle.taskId, {
          taskId: lifecycle.taskId,
          ...(lifecycle.taskType ? { taskType: lifecycle.taskType } : {}),
          toolUseId: lifecycle.toolUseId ?? lifecycle.taskId,
          ...(lifecycle.description ? { description: lifecycle.description } : {}),
          ...(lifecycle.ownerAgentId ? { ownerAgentId: lifecycle.ownerAgentId } : {}),
        })
      }
    }
    return lifecycle
  }

  const sessionAgentTasks = activeAgentTasks.get(sessionId)
  const agentTask = sessionAgentTasks?.get(lifecycle.taskId)
  if (agentTask?.stopIntent) {
    // A terminal event proves the local Agent process/poller has stopped. Turn
    // it into the same durable synthetic bookend used by the control response
    // so a renderer that disconnected during Stop can reconcile from history.
    // Remote Agents additionally remain gated on strict archive confirmation.
    agentTask.localStopConfirmed = true
    void emitAuthoritativeAgentStopped(sessionId, agentTask)
    return { ...lifecycle, suppressForward: true }
  }

  untrackCliBackgroundTask(sessionId, lifecycle.taskId)
  return lifecycle
}


function trackCliRunState(sessionId: string, cliMsg: any): 'running' | 'idle' | null {
  if (
    cliMsg?.type === 'result' &&
    cliMsg.is_error === true &&
    !conversationService.hasSession(sessionId)
  ) {
    // ConversationService removes a crashed subprocess before publishing its
    // synthetic terminal result. No CLI idle event can follow that exit.
    activeCliRuns.delete(sessionId)
    return 'idle'
  }
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'session_state_changed') {
    return null
  }
  if (cliMsg.state === 'running') {
    activeCliRuns.add(sessionId)
    return 'running'
  }
  if (cliMsg.state === 'idle') {
    activeCliRuns.delete(sessionId)
    return 'idle'
  }
  return null
}

function hasActiveCliRun(sessionId: string): boolean {
  return activeCliRuns.has(sessionId)
}

function hasActiveSessionWork(sessionId: string): boolean {
  return hasPendingOrActiveUserTurn(sessionId) ||
    hasActiveCliRun(sessionId) ||
    hasActiveBackgroundTasks(sessionId)
}

export function getSessionChatActivityState(sessionId: string): SessionChatActivityState {
  // An explicit stop wins over permission queues that the CLI has not emitted
  // cancellation events for yet. Otherwise the stopped pet would remain stuck
  // in waiting until that asynchronous cleanup arrived.
  if (interruptedSessionChats.has(sessionId)) return 'idle'
  if (
    conversationService.getPendingPermissionRequests(sessionId).length > 0 ||
    computerUseApprovalService.getPendingRequests(sessionId).length > 0
  ) {
    return 'waiting'
  }
  if (
    activeUserTurns.has(sessionId) ||
    hasActiveCliRun(sessionId) ||
    hasActiveBackgroundTasks(sessionId)
  ) return 'running'
  return terminalSessionChatStates.get(sessionId)
    ?? (legacyQueuedSessionChats.has(sessionId) ? 'running' : 'idle')
}

/** Compatibility fallback for the legacy REST enqueue endpoint. */
export function markSessionChatQueued(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  legacyQueuedSessionChats.add(sessionId)
}

/** Compatibility reset for the legacy REST stop endpoint. */
export function clearLegacySessionChatState(sessionId: string): void {
  legacyQueuedSessionChats.delete(sessionId)
  terminalSessionChatStates.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
}
const validPermissionModes = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
])

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && validPermissionModes.has(value as PermissionMode)
}

const runtimeTransitionPromises = new Map<string, Promise<void>>()
const sessionStartupPromises = new Map<string, Promise<void>>()
const runtimeOverrideVersions = new Map<string, number>()
const sessionStartupRuntimeVersions = new Map<string, number>()
const lastResolvedStartupWorkDirs = new Map<string, string>()
const prewarmPendingSessions = new Set<string>()
const prewarmedSessions = new Set<string>()
const prewarmIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEFAULT_PREWARM_IDLE_TIMEOUT_MS = 5 * 60_000
const VALID_CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

async function sendRepositoryStartupStatus(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  reason: 'user_message' | 'prewarm_session',
): Promise<void> {
  if (reason !== 'user_message') return

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  const repository = launchInfo?.repository
  if (!repository) return

  if (shouldCreateWorktreeForSessionLaunch(launchInfo)) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Creating worktree' })
  }
}

export function getSlashCommands(sessionId: string): SessionSlashCommand[] {
  return sessionSlashCommands.get(sessionId) || []
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function translateCliUsage(usage: unknown): TokenUsage {
  const record = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : {}
  const cacheReadTokens = usageNumber(record.cache_read_input_tokens ?? record.cache_read_tokens)
  const cacheCreationTokens = usageNumber(record.cache_creation_input_tokens ?? record.cache_creation_tokens)

  return {
    input_tokens: usageNumber(record.input_tokens),
    output_tokens: usageNumber(record.output_tokens),
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

export type WebSocketData = {
  sessionId: string
  connectedAt: number
  channel: 'client' | 'sdk'
  clientKind?: 'full' | 'pet'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket clients, grouped by session. Desktop, H5, and IM adapters can
// legitimately watch the same running session at the same time.
const activeSessions = new Map<string, Set<ServerWebSocket<WebSocketData>>>()
let activePetClient: ServerWebSocket<WebSocketData> | null = null

const clientOutputCallbacks = new Map<
  ServerWebSocket<WebSocketData>,
  {
    sessionId: string
    callback: (cliMsg: any) => void
  }
>()
const taskNotificationPersistence = new Map<string, Map<string, Promise<void>>>()
const sessionTranscriptEpochs = new Map<string, number>()

export const handleWebSocket = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const { sessionId, channel, sdkToken } = ws.data

    if (channel === 'sdk') {
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected SDK connection for session: ${sessionId}`)
        ws.close(1008, 'Invalid SDK token')
        return
      }

      conversationService.attachSdkConnection(sessionId, ws)
      console.log(`[WS] SDK connected for session: ${sessionId}`)
      return
    }

    if (ws.data.clientKind === 'pet') {
      const previousPetClient = activePetClient
      activePetClient = ws
      if (previousPetClient && previousPetClient !== ws) {
        previousPetClient.close(1000, 'Pet session switched')
      }
    }

    console.log(`[WS] Client connected for session: ${sessionId}`)

    // Cancel pending cleanup timer if client reconnects
    const pendingTimer = sessionCleanupTimers.get(sessionId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      sessionCleanupTimers.delete(sessionId)
    }
    // Cancel any "let the running turn finish, then clean up" watcher too —
    // the session is observed again (issue #764).
    cancelSessionDisconnectWatcher(sessionId)

    addActiveClient(sessionId, ws)
    if (prewarmPendingSessions.has(sessionId) || prewarmedSessions.has(sessionId)) {
      bindPrewarmMetadataCapture(sessionId)
    } else {
      bindClientSessionOutput(sessionId, ws)
    }

    const msg: ServerMessage = { type: 'connected', sessionId }
    sendMessage(ws, msg)
    const toolRequestIds = replayPendingPermissionRequests(ws, sessionId)
    const computerUseRequestIds = replayPendingComputerUsePermissionRequests(ws, sessionId)
    sendMessage(ws, {
      type: 'permission_requests_snapshot',
      toolRequestIds,
      computerUseRequestIds,
      turnActive: hasLiveUserTurnForClient(sessionId),
    })
    replayAgentStopFailures(ws, sessionId)
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const { sessionId, sdkToken } = ws.data
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected stale SDK message for session: ${sessionId}`)
        ws.close(1008, 'Stale SDK token')
        return
      }
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(sessionId, payload, {
        canAcceptPermissionRequest: (message) =>
          canAcceptPermissionRequestDuringStop(sessionId, message),
      })
      return
    }

    try {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as ClientMessage

      if (ws.data.clientKind === 'pet' && !isPetClientMessageAllowed(message)) {
        sendError(
          ws,
          `Message type ${(message as { type?: unknown }).type ?? 'unknown'} is not available to the pet window`,
          'PET_CAPABILITY_DENIED',
        )
        return
      }

      switch (message.type) {
        case 'user_message': {
          const activeTurn: ActiveUserTurnState = { messageSent: false }
          handleUserMessage(ws, message, activeTurn).catch((err) => {
            const sessionId = ws.data.sessionId
            void diagnosticsService.recordEvent({
              type: 'ws_user_message_failed',
              severity: 'error',
              sessionId,
              summary: err instanceof Error ? err.message : String(err),
              details: err,
            })
            console.error(`[WS] Unhandled error in handleUserMessage:`, err)
            // A queued/newer turn may have replaced this handler while an
            // earlier await was pending. Only the handler that still owns the
            // active-turn token may terminate the desktop state.
            if (
              activeUserTurns.get(sessionId) === activeTurn &&
              !activeTurn.cancelled
            ) {
              failSessionChatActivity(sessionId)
              clearActiveUserTurn(sessionId, activeTurn)
              const titleState = sessionTitleState.get(sessionId)
              if (titleState) titleState.activeTurn = undefined
              sendMessage(ws, {
                type: 'error',
                message: 'The request could not be started. Please retry.',
                code: 'USER_TURN_FAILED',
                retryable: true,
              })
              sendMessage(ws, { type: 'status', state: 'idle' })
            }
          })
          break
        }

        case 'permission_response':
          handlePermissionResponse(ws, message)
          break

        case 'computer_use_permission_response':
          handleComputerUsePermissionResponse(ws, message)
          break

        case 'set_permission_mode':
          void handleSetPermissionMode(ws, message)
          break

        case 'set_runtime_config':
          void handleSetRuntimeConfig(ws, message)
          break

        case 'prewarm_session':
          void handlePrewarmSession(ws)
          break

        case 'sync_state':
          sendMessage(ws, {
            type: 'session_state',
            turnState: hasLiveUserTurnForClient(ws.data.sessionId)
              ? 'running'
              : 'idle',
            activeBackgroundTaskIds: [
              ...(activeBackgroundTaskIds.get(ws.data.sessionId) ?? []),
            ],
          })
          break

        case 'stop_generation':
          handleStopGeneration(ws)
          break

        case 'stop_background_task':
          void handleStopBackgroundTask(ws, message)
          break

        case 'ping':
          sendMessage(ws, { type: 'pong' })
          break

        default:
          sendError(ws, `Unknown message type: ${(message as any).type}`, 'UNKNOWN_TYPE')
      }
    } catch (error) {
      sendError(ws, `Invalid message format: ${error}`, 'PARSE_ERROR')
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const { sessionId, channel } = ws.data

    if (channel === 'sdk') {
      console.log(`[WS] SDK disconnected from session: ${sessionId} (${code}: ${reason})`)
      conversationService.detachSdkConnection(sessionId, ws)
      return
    }

    if (activePetClient === ws) activePetClient = null

    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    if (!removeActiveClient(sessionId, ws)) {
      console.log(`[WS] Ignoring stale client disconnect for session: ${sessionId}`)
      return
    }
    removeClientOutputCallback(ws)

    if (hasActiveClients(sessionId)) {
      return
    }

    // No clients left. A foreground turn or background task that is still
    // running must finish (issue #764) — never kill it just because a renderer
    // closed. Defer cleanup until all active work completes, then apply the
    // idle grace period. Sessions that are already idle go straight to the timer.
    if (hasActiveSessionWork(sessionId)) {
      // A turn blocked on permission cannot finish without user input. Keep the
      // completion watcher for early cleanup, but also enforce the existing
      // pending-permission maximum so an abandoned prompt cannot pin the CLI.
      if (conversationService.getPendingPermissionRequests(sessionId).length > 0) {
        scheduleDisconnectCleanup(sessionId)
      }
      console.log(`[WS] Session ${sessionId} still running after disconnect; keeping CLI alive until active work finishes`)
      watchTurnCompletionForCleanup(sessionId)
      return
    }

    scheduleDisconnectCleanup(sessionId)
    watchTurnCompletionForCleanup(sessionId)
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure handling - called when the socket is ready to receive more data
  },
}

// ============================================================================
// Message handlers
// ============================================================================

async function handleUserMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'user_message' }>,
  activeTurn: ActiveUserTurnState,
) {
  const { sessionId } = ws.data

  const desktopSlashCommand = getDesktopSlashCommand(message.content)
  if (desktopSlashCommand?.commandName === 'clear' && desktopSlashCommand.args.trim()) {
    sendMessage(ws, {
      type: 'error',
      message: 'The /clear command does not accept arguments.',
      code: 'INVALID_SLASH_COMMAND_ARGS',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  if (desktopSlashCommand?.commandName === 'clear') {
    await handleDesktopClearCommand(ws)
    return
  }

  // Keep a stopped-turn fence until the replacement replay proves that later
  // output belongs to this turn, while allowing validated input to start its
  // own activity lifecycle.
  beginSessionChatActivity(sessionId)
  clearPrewarmState(sessionId)

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  activeTurn.expectedReplayUuid = crypto.randomUUID()
  activeTurn.expectedLocalCommand = desktopSlashCommand ?? undefined
  activeTurn.replacementAfterStop =
    sessionStopRequested.has(sessionId) || agentStopRequestedSessions.has(sessionId)
  activeUserTurns.set(sessionId, activeTurn)

  const initialRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (
    !initialRuntimeTransition.ok ||
    activeUserTurns.get(sessionId) !== activeTurn ||
    activeTurn.cancelled
  ) {
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }
  if (initialRuntimeTransition.waited) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })
  }

  // Track and emit the first placeholder title before CLI startup/streaming.
  let titleState = sessionTitleState.get(sessionId)
  if (!titleState) {
    const hasCustomTitle = !!(await sessionService.getCustomTitle(sessionId))
    const launchInfo = hasCustomTitle
      ? null
      : await sessionService.getSessionLaunchInfo(sessionId)
    if (activeUserTurns.get(sessionId) !== activeTurn || activeTurn.cancelled) return
    titleState = {
      userMessageCount: 0,
      hasCustomTitle,
      hasExistingTranscript: (launchInfo?.transcriptMessageCount ?? 0) > 0,
      firstUserMessage: '',
      completedTurns: [],
      startedGenerationKeys: new Set<string>(),
      generationSeq: 0,
    }
    sessionTitleState.set(sessionId, titleState)
  }
  const titleInput = getTitleInputForUserMessage(message.content, desktopSlashCommand)
  let titleTurnNumber: number | null = null
  if (titleInput) {
    titleState.userMessageCount++
    titleTurnNumber = titleState.userMessageCount
    titleState.activeTurn = {
      count: titleTurnNumber,
      userText: titleInput,
      assistantText: '',
    }
    if (titleState.userMessageCount === 1) {
      titleState.firstUserMessage = titleInput
    }
    triggerTitleGeneration(ws, sessionId, 'user-message')
  }

  // 启动 CLI 子进程（如果还没有）
  try {
    await ensureCliSessionStarted(ws, sessionId, 'user_message')
  } catch (err) {
    if (activeUserTurns.get(sessionId) !== activeTurn || activeTurn.cancelled) return
    const errMsg = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof ConversationStartupError ? err.code : 'CLI_START_FAILED'
    console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
    const diagnosticMessage = await buildSessionStartupDiagnosticMessage(sessionId, errMsg)
    if (activeUserTurns.get(sessionId) !== activeTurn || activeTurn.cancelled) return
    sendMessage(ws, {
      type: 'error',
      message: diagnosticMessage,
      code,
      retryable:
        err instanceof ConversationStartupError ? err.retryable : false,
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    failSessionChatActivity(sessionId)
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }

  if (activeUserTurns.get(sessionId) !== activeTurn || activeTurn.cancelled) {
    stopRuntimeStartedByCancelledAdmission(sessionId, activeTurn)
    return
  }

  const startupRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (
    startupRuntimeTransition.ok &&
    activeUserTurns.get(sessionId) === activeTurn &&
    !activeTurn.cancelled
  ) {
    if (startupRuntimeTransition.waited) {
      sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })
    }
  } else {
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }

  // Register the callback before sending the turn so startup errors are not lost.
  // Keep output muted until the current user turn is enqueued to avoid forwarding
  // any pre-turn SDK chatter as fresh chat history.
  let userMessageSent = false
  const shouldForwardCurrentTurnLocalCommand =
    createCurrentTurnLocalCommandForwarder(desktopSlashCommand)
  const removeTitleOutputCallback = titleTurnNumber === null
    ? null
    : bindTitleSessionOutput(ws, sessionId, activeTurn, () => userMessageSent)

  bindAllClientSessionOutputs(sessionId, {
    shouldForward: (cliMsg) => {
      if (
        userMessageSent ||
        (cliMsg.type === 'result' && cliMsg.is_error) ||
        isAgentRunMessageFrame(cliMsg)
      ) {
        return true
      }
      return shouldForwardCurrentTurnLocalCommand(cliMsg)
    },
  })
  const removeActiveTurnOutputCallback = bindActiveUserTurnCompletion(ws, sessionId, activeTurn)

  // The renderer may have left while the CLI was still starting, before this
  // turn could flip messageSent=true. The disconnect handler cannot attach an
  // effective output watcher until the ConversationService session exists, so
  // refresh it here, immediately before sending the turn, to observe a
  // permission request that arrives after the disconnect.
  refreshDisconnectedTurnCleanupWatcher(sessionId)

  activeTurn.sendStarted = true
  const sent = await conversationService.sendMessage(
    sessionId,
    message.content,
    message.attachments,
    {
      canSend: () =>
        activeUserTurns.get(sessionId) === activeTurn && !activeTurn.cancelled,
      messageUuid: activeTurn.expectedReplayUuid,
      onCommitted: () => {
        activeTurn.messageSent = true
      },
    },
  )
  if (activeUserTurns.get(sessionId) !== activeTurn || activeTurn.cancelled) {
    // Once onCommitted has run the SDK owns this turn and will still emit its
    // terminal result. Keep the completion callback long enough to consume
    // that boundary; only an admission revoked before the socket write is safe
    // to detach immediately.
    if (!activeTurn.messageSent) removeActiveTurnOutputCallback()
    removeTitleOutputCallback?.()
    discardActiveTitleTurn(sessionId, titleTurnNumber)
    if (!activeTurn.messageSent) {
      stopRuntimeStartedByCancelledAdmission(sessionId, activeTurn)
    }
    return
  }
  if (!sent) {
    removeActiveTurnOutputCallback()
    clearActiveUserTurn(sessionId, activeTurn)
    removeTitleOutputCallback?.()
    discardActiveTitleTurn(sessionId, titleTurnNumber)
    sendMessage(ws, {
      type: 'error',
      message: 'CLI process is not running. The session may have ended or the process crashed.',
      code: 'CLI_NOT_RUNNING',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    failSessionChatActivity(sessionId)
    return
  }

  userMessageSent = true
  activeTurn.messageSent = true
}

function clearActiveUserTurn(sessionId: string, activeTurn: ActiveUserTurnState): void {
  if (activeUserTurns.get(sessionId) === activeTurn) {
    activeUserTurns.delete(sessionId)
  }
}

function matchesActiveTurnReplay(activeTurn: ActiveUserTurnState, cliMsg: any): boolean {
  return cliMsg?.type === 'user' &&
    cliMsg.isReplay === true &&
    typeof cliMsg.uuid === 'string' &&
    cliMsg.uuid === activeTurn.expectedReplayUuid
}

function matchesActiveTurnLocalCommand(
  activeTurn: ActiveUserTurnState,
  cliMsg: any,
): boolean {
  return Boolean(
    activeTurn.expectedLocalCommand &&
    isMatchingCurrentTurnLocalCommand(cliMsg, activeTurn.expectedLocalCommand),
  )
}

function addPendingInterruptedTurnResult(sessionId: string): void {
  pendingInterruptedTurnResults.set(
    sessionId,
    (pendingInterruptedTurnResults.get(sessionId) ?? 0) + 1,
  )
}

function removePendingInterruptedTurnResult(sessionId: string): void {
  const count = pendingInterruptedTurnResults.get(sessionId) ?? 0
  if (count <= 1) {
    pendingInterruptedTurnResults.delete(sessionId)
    return
  }
  pendingInterruptedTurnResults.set(sessionId, count - 1)
}

function forceStopSharedRuntimeForAgentCancellation(sessionId: string): void {
  // A killed runtime cannot emit the foreground turn's interrupted result.
  // Remove that boundary before admitting a replacement (including a local
  // slash command), otherwise its result can be consumed as the dead turn's.
  pendingInterruptedTurnResults.delete(sessionId)
  runtimeExitStoppedSessions.add(sessionId)
  conversationService.stopSession(sessionId)
  const stoppedTurn = activeUserTurns.get(sessionId)
  if (
    stoppedTurn?.cancelled &&
    stoppedTurn.replacementAfterStop !== true
  ) {
    clearActiveUserTurn(sessionId, stoppedTurn)
  }
  void emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)
}

function consumeInterruptedTurnResult(sessionId: string, cliMsg: any): boolean {
  if (!cliMsg || typeof cliMsg !== 'object' || cliMsg.type !== 'result') return false
  if (interruptedTurnResultMessages.get(cliMsg) === sessionId) return true
  if (!pendingInterruptedTurnResults.has(sessionId)) return false
  removePendingInterruptedTurnResult(sessionId)
  interruptedTurnResultMessages.set(cliMsg, sessionId)
  return true
}

function acknowledgeActiveTurnReplay(sessionId: string, cliMsg: any): boolean {
  const activeTurn = activeUserTurns.get(sessionId)
  const replayMatches = activeTurn
    ? matchesActiveTurnReplay(activeTurn, cliMsg)
    : false
  const localCommandMatches = activeTurn && !pendingInterruptedTurnResults.has(sessionId)
    ? matchesActiveTurnLocalCommand(activeTurn, cliMsg)
    : false
  if (
    !activeTurn ||
    activeTurn.cancelled ||
    activeTurn.replacementAfterStop !== true ||
    activeTurn.sendStarted !== true ||
    (!replayMatches && !localCommandMatches)
  ) {
    return false
  }

  // The SDK preserves the outbound user-message UUID on normal replays. Pure
  // local slash commands instead expose their parsed command marker after the
  // interrupted result boundary. Either signal proves output now belongs to
  // this replacement turn.
  activeTurn.replacementAfterStop = false
  activeTurn.messageSent = true
  pendingInterruptedTurnResults.delete(sessionId)
  sessionStopRequested.delete(sessionId)
  agentStopRequestedSessions.delete(sessionId)
  runtimeExitStoppedSessions.delete(sessionId)
  return true
}

function stopRuntimeStartedByCancelledAdmission(
  sessionId: string,
  activeTurn: ActiveUserTurnState,
): void {
  if (
    activeTurn.cancelled &&
    !activeUserTurns.has(sessionId) &&
    conversationService.hasSession(sessionId)
  ) {
    conversationService.stopSession(sessionId)
  }
}

function bindActiveUserTurnCompletion(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  activeTurn: ActiveUserTurnState,
): () => void {
  const callback = (cliMsg: any) => {
    const interruptedResult = consumeInterruptedTurnResult(sessionId, cliMsg)
    if (activeTurn.cancelled) {
      if (cliMsg?.type === 'result') {
        const stillOwnsTurn = activeUserTurns.get(sessionId) === activeTurn
        if (
          stillOwnsTurn &&
          interruptedResult &&
          pendingInterruptedTurnResults.has(sessionId)
        ) {
          return
        }
        conversationService.removeOutputCallback(sessionId, callback)
        if (stillOwnsTurn) {
          settleSessionChatActivity(sessionId, cliMsg)
          clearActiveUserTurn(sessionId, activeTurn)
        }
      }
      return
    }

    acknowledgeActiveTurnReplay(sessionId, cliMsg)
    if (activeTurn.replacementAfterStop || interruptedResult) return
    if (
      cliMsg?.type !== 'result' ||
      (!activeTurn.messageSent && !cliMsg.is_error)
    ) return

    settleSessionChatActivity(sessionId, cliMsg)
    conversationService.removeOutputCallback(sessionId, callback)
    clearActiveUserTurn(sessionId, activeTurn)
    // Structurally disarm any prewarm idle timer that a concurrent
    // prewarm_session/user_message flush may have armed on this session: once a
    // turn completes the session is firmly user-owned, so no prewarm reaper
    // should survive — regardless of the order in which the two raced.
    clearPrewarmState(sessionId)
    applyDeferredPermissionModeAfterActiveTurn(ws, sessionId)
    applyDeferredRuntimeRestartAfterActiveTurn(ws, sessionId)
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

function shouldDeferRuntimeRestartForActiveTurn(sessionId: string): boolean {
  return activeUserTurns.get(sessionId)?.messageSent === true
}

function applyDeferredPermissionModeAfterActiveTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  const deferredMode = deferredPermissionModes.get(sessionId)
  if (!deferredMode) return

  deferredPermissionModes.delete(sessionId)
  void enqueueRuntimeTransition(sessionId, async () => {
    if (!conversationService.hasSession(sessionId)) return
    await applyPermissionModeToActiveSession(ws, sessionId, deferredMode)
  })
}

function applyDeferredRuntimeRestartAfterActiveTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  const deferred = deferredRuntimeRestarts.get(sessionId)
  if (!deferred) return

  deferredRuntimeRestarts.delete(sessionId)
  void enqueueRuntimeTransition(sessionId, async () => {
    const currentOverride = runtimeOverrides.get(sessionId)
    if (
      !currentOverride ||
      currentOverride.providerId !== deferred.providerId ||
      currentOverride.modelId !== deferred.modelId ||
      currentOverride.effort !== deferred.effort ||
      !conversationService.hasSession(sessionId)
    ) {
      return
    }
    await restartSessionWithRuntimeConfig(ws, sessionId)
  })
}

async function handleDesktopClearCommand(
  ws: ServerWebSocket<WebSocketData>,
) {
  const turnToCancel = activeUserTurns.get(ws.data.sessionId)
  if (turnToCancel) turnToCancel.cancelled = true
  await enqueueRuntimeTransition(ws.data.sessionId, () =>
    performDesktopClearCommand(ws, turnToCancel),
  )
}

async function performDesktopClearCommand(
  ws: ServerWebSocket<WebSocketData>,
  turnToCancel: ActiveUserTurnState | undefined,
) {
  const { sessionId } = ws.data

  const workDir = conversationService.getSessionWorkDir(sessionId)
  const permissionMode = conversationService.hasSession(sessionId)
    ? conversationService.getSessionPermissionMode(sessionId)
    : undefined
  const agentTasks = [...(activeAgentTasks.get(sessionId)?.values() ?? [])]
  markActiveAgentsStopping(sessionId)
  sessionClearInProgress.add(sessionId)
  if (turnToCancel) clearActiveUserTurn(sessionId, turnToCancel)
  const activeTitleState = sessionTitleState.get(sessionId)
  if (activeTitleState) activeTitleState.activeTurn = undefined
  const pendingStartup = sessionStartupPromises.get(sessionId)
  conversationService.stopSession(sessionId)
  pendingInterruptedTurnResults.delete(sessionId)
  // Clearing replaces the transcript, so do not enqueue terminal bookends that
  // could finish after the replacement write and repopulate the cleared file.
  // Detach callbacks before clearing, then archive the captured remote handles
  // on an independent bounded retry path after the transcript replacement.
  conversationService.clearOutputCallbacks(sessionId)
  clearPrewarmState(sessionId)

  if (pendingStartup) {
    await pendingStartup.catch(() => undefined)
    // The startup may have created a runtime after the first stopSession call.
    // Keep the clear transition locked until that stale admission is drained.
    conversationService.stopSession(sessionId)
    conversationService.clearOutputCallbacks(sessionId)
    clearPrewarmState(sessionId)
  }

  try {
    await sessionService.clearSessionTranscript(sessionId, workDir || undefined, permissionMode)
  } catch (err) {
    sessionClearInProgress.delete(sessionId)
    resumeAgentFinalizationAfterFailedClear(sessionId, agentTasks)
    runtimeExitStoppedSessions.add(sessionId)
    await emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)
    const errMsg = err instanceof Error ? err.message : String(err)
    sendToSession(sessionId, {
      type: 'error',
      message: errMsg,
      code: 'SESSION_CLEAR_FAILED',
    })
    sendToSession(sessionId, { type: 'status', state: 'idle' })
    return
  }

  sessionTranscriptEpochs.set(
    sessionId,
    (sessionTranscriptEpochs.get(sessionId) ?? 0) + 1,
  )

  clearAgentRuntimeState(sessionId)
  taskNotificationPersistence.delete(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  cleanupStreamState(sessionId)
  sessionClearInProgress.delete(sessionId)

  sendToSession(sessionId, {
    type: 'system_notification',
    subtype: 'session_cleared',
    message: 'Conversation cleared',
  })
  sendToSession(sessionId, {
    type: 'message_complete',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
  void stopAgentsForSessionClear(sessionId, agentTasks).then((agentStopResults) => {
    agentStopResults.forEach((stopped, index) => {
      if (stopped) return
      const task = agentTasks[index]
      if (!task) return
      sendToSession(sessionId, {
        type: 'background_task_stop_failed',
        taskId: task.taskId,
        message: 'Conversation cleared, but one or more background Agents could not be fully stopped.',
      })
    })
  })
}

async function handlePrewarmSession(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  if (conversationService.hasSession(sessionId) || sessionStartupPromises.has(sessionId)) {
    return
  }

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)

  // Re-check after async gap: a user_message may have arrived during the await
  // and already started (or is starting) the CLI session. If so, skip prewarm
  // entirely — the user turn owns this session now, and calling markPrewarmed()
  // would arm an idle timer that later kills the active conversation.
  if (conversationService.hasSession(sessionId) || sessionStartupPromises.has(sessionId)) {
    return
  }

  if (launchInfo?.repository) {
    console.log(`[WS] Skipping prewarm for pending repository launch session ${sessionId}`)
    return
  }

  prewarmPendingSessions.add(sessionId)
  void ensureCliSessionStarted(ws, sessionId, 'prewarm_session')
    .then(() => {
      const stillPending = prewarmPendingSessions.delete(sessionId)
      if (!stillPending) return
      // Safety: if a user message arrived and claimed this session while we
      // were waiting for startup, do NOT arm the prewarm idle timer — the
      // session is now owned by the user conversation, not prewarm. Use the
      // turn-registered check (not messageSent) so the CLI-startup window is
      // covered: in the concurrent race the turn is registered but messageSent
      // is still false when this .then runs, which made the old guard dead code.
      if (hasPendingOrActiveUserTurn(sessionId)) {
        return
      }
      bindPrewarmMetadataCapture(sessionId)
      markPrewarmed(sessionId)
    })
    .catch((err) => {
      prewarmPendingSessions.delete(sessionId)
      console.warn(
        `[WS] Prewarm failed for ${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
}

function handlePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'permission_response' }>
) {
  const { sessionId } = ws.data
  const resolved = conversationService.respondToPermission(
    sessionId,
    message.requestId,
    message.allowed,
    message.rule,
    message.updatedInput,
    message.denyMessage,
    message.permissionUpdates,
  )
  if (resolved) {
    sendToSession(sessionId, {
      type: 'permission_resolved',
      requestId: message.requestId,
      permissionType: 'tool',
      allowed: message.allowed,
    })
  }
  console.log(`[WS] Permission response for ${message.requestId}: ${message.allowed}`)
}

function handleComputerUsePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'computer_use_permission_response' }>
) {
  const { sessionId } = ws.data
  const ok = computerUseApprovalService.resolveApproval(
    message.requestId,
    message.response,
  )
  if (!ok) {
    console.warn(
      `[WS] Ignored Computer Use permission response for unknown request ${message.requestId} from ${sessionId}`
    )
    return
  }
  sendToSession(sessionId, {
    type: 'permission_resolved',
    requestId: message.requestId,
    permissionType: 'computer_use',
    allowed: message.response.userConsented !== false,
  })
}

async function handleSetPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_permission_mode' }>
): Promise<void> {
  const { sessionId } = ws.data
  if (!isPermissionMode(message.mode)) {
    sendMessage(ws, {
      type: 'error',
      message: 'Permission mode is invalid.',
      code: 'PERMISSION_MODE_INVALID',
    })
    return
  }
  const pendingStartup = sessionStartupPromises.get(sessionId)

  if (pendingStartup) {
    await enqueueRuntimeTransition(sessionId, async () => {
      await pendingStartup.catch(() => undefined)
      if (!conversationService.hasSession(sessionId)) return
      await applyPermissionModeToActiveSession(ws, sessionId, message.mode)
    })
    return
  }

  if (!conversationService.hasSession(sessionId)) {
    if (await persistSessionPermissionMode(sessionId, message.mode)) {
      sendMessage(ws, { type: 'permission_mode_changed', mode: message.mode })
    }
    return
  }

  await enqueueRuntimeTransition(sessionId, () =>
    applyPermissionModeToActiveSession(ws, sessionId, message.mode),
  )
}

const BYPASS_CAPABILITY_UNAVAILABLE =
  'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'

/**
 * Sessions launched by this desktop build can switch into bypass in-process.
 * A session that was already running before an app update may lack that launch
 * capability, so retain the old restart path only for that exact CLI error.
 */
export function shouldFallbackToPermissionRestart(
  mode: PermissionMode,
  error: unknown,
): boolean {
  if (mode !== 'bypassPermissions') return false
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(BYPASS_CAPABILITY_UNAVAILABLE)
}

async function applyPermissionModeToActiveSession(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (shouldDeferRuntimeRestartForActiveTurn(sessionId)) {
    deferredPermissionModes.set(sessionId, mode)
    return
  }

  if (currentMode === mode) {
    sendToSession(sessionId, { type: 'permission_mode_changed', mode })
    return
  }
  try {
    const ok = await conversationService.setPermissionMode(sessionId, mode)
    if (!ok) {
      console.warn(`[WS] Ignored permission mode update for inactive session ${sessionId}`)
      return
    }
    await commitConfirmedPermissionMode(sessionId, mode)
  } catch (err) {
    if (shouldFallbackToPermissionRestart(mode, err)) {
      await restartSessionWithPermissionMode(ws, sessionId, mode)
      return
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[WS] Failed to set permission mode for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: `Failed to set permission mode: ${errMsg}`,
      code: 'PERMISSION_MODE_CHANGE_FAILED',
    })
  }
}

async function handleSetRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_runtime_config' }>
) {
  const { sessionId } = ws.data
  const requestedModelId = typeof message.modelId === 'string' ? message.modelId.trim() : ''
  if (!requestedModelId) {
    sendMessage(ws, {
      type: 'error',
      message: 'Runtime model selection is invalid.',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    return
  }
  const requestedEffort =
    typeof message.effortLevel === 'string' ? message.effortLevel.trim() : undefined

  // Register the transition before remote model-catalog or provider validation.
  // A user message arriving in that async admission window must wait for the
  // selected runtime instead of entering the previous provider's CLI process.
  await enqueueRuntimeTransition(sessionId, async () => {
    let modelId = requestedModelId
    if (isGrokOfficialProviderId(message.providerId)) {
      modelId = (await getGrokReasoningEfforts(modelId)).modelId
    }
    const effortResolution = requestedEffort === undefined
      ? { valid: true, effort: undefined }
      : await resolveRuntimeEffort(message.providerId, modelId, requestedEffort)
    if (!effortResolution.valid) {
      sendMessage(ws, {
        type: 'error',
        message: 'Runtime effort selection is invalid.',
        code: 'RUNTIME_CONFIG_INVALID',
      })
      return
    }

    const nextOverride = {
      providerId: message.providerId ?? null,
      modelId,
      ...(effortResolution.effort ? { effort: effortResolution.effort } : {}),
    }
    const prevOverride = runtimeOverrides.get(sessionId)
    if (
      prevOverride &&
      prevOverride.providerId === nextOverride.providerId &&
      prevOverride.modelId === nextOverride.modelId &&
      prevOverride.effort === nextOverride.effort
    ) {
      return
    }

    runtimeOverrides.set(sessionId, nextOverride)
    runtimeOverrideVersions.set(
      sessionId,
      (runtimeOverrideVersions.get(sessionId) ?? 0) + 1,
    )

    if (shouldDeferRuntimeRestartForActiveTurn(sessionId)) {
      deferredRuntimeRestarts.set(sessionId, nextOverride)
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      return
    }

    if (conversationService.hasSession(sessionId)) {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await restartSessionWithRuntimeConfig(ws, sessionId)
      return
    }

    const pendingStartup = sessionStartupPromises.get(sessionId)
    if (pendingStartup) {
      const startupRuntimeVersion = sessionStartupRuntimeVersions.get(sessionId) ?? 0
      const currentRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
      if (startupRuntimeVersion >= currentRuntimeVersion) {
        await persistSessionRuntimeConfig(sessionId, nextOverride)
        await pendingStartup
        broadcastAppliedRuntimeConfig(sessionId)
        return
      }

      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await pendingStartup.catch(() => undefined)
      const currentOverride = runtimeOverrides.get(sessionId)
      if (
        currentOverride?.providerId !== nextOverride.providerId ||
        currentOverride.modelId !== nextOverride.modelId ||
        currentOverride.effort !== nextOverride.effort ||
        !conversationService.hasSession(sessionId)
      ) {
        return
      }
      await restartSessionWithRuntimeConfig(ws, sessionId)
      return
    }

    await persistSessionRuntimeConfig(sessionId, nextOverride)
    broadcastAppliedRuntimeConfig(sessionId)
  })
}

async function restartSessionWithPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: PermissionMode,
): Promise<void> {
  try {
    const workDir = conversationService.getSessionWorkDir(sessionId)
    markActiveAgentsStopping(sessionId)
    runtimeExitStoppedSessions.add(sessionId)
    conversationService.stopSession(sessionId)
    await emitAuthoritativeStoppedForActiveAgents(sessionId)
    await emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)

    // Launch with the requested mode in-memory. Persist it only after startup
    // succeeds so a failed bypass restart cannot leave dangerous metadata.
    const runtimeSettings = {
      ...await getRuntimeSettings(sessionId),
      permissionMode: mode,
    }
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)
    if (!agentStopRequestedSessions.has(sessionId)) {
      runtimeExitStoppedSessions.delete(sessionId)
    }

    await commitConfirmedPermissionMode(sessionId, mode, workDir)
    sendToSession(sessionId, { type: 'status', state: 'idle' })
    console.log(`[WS] Restarted CLI for ${sessionId} with permission mode: ${mode}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void diagnosticsService.recordEvent({
      type: 'permission_restart_failed',
      severity: 'error',
      sessionId,
      summary: errMsg,
      details: { mode, error: err },
    })
    console.error(`[WS] Failed to restart CLI for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(
        sessionId,
        `Failed to restart session with new permission mode: ${errMsg}`,
      ),
      code: 'CLI_RESTART_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

async function commitConfirmedPermissionMode(
  sessionId: string,
  mode: PermissionMode,
  knownWorkDir?: string | null,
): Promise<void> {
  const persisted = await persistSessionPermissionMode(sessionId, mode, knownWorkDir)
  if (!persisted) {
    throw new Error(`Unable to persist confirmed permission mode: ${mode}`)
  }
  conversationService.recordSessionPermissionMode(sessionId, mode)
  sendToSession(sessionId, { type: 'permission_mode_changed', mode })
}

async function persistSessionPermissionMode(
  sessionId: string,
  mode: string,
  knownWorkDir?: string | null,
): Promise<boolean> {
  const workDir =
    knownWorkDir ||
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return false

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    permissionMode: mode,
  })
  return true
}

async function persistSessionRuntimeConfig(
  sessionId: string,
  runtime: { providerId: string | null; modelId: string; effort?: string },
): Promise<void> {
  const workDir =
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    runtimeProviderId: runtime.providerId,
    runtimeModelId: runtime.modelId,
    ...(runtime.effort ? { effortLevel: runtime.effort } : {}),
  })
}

function broadcastAppliedRuntimeConfig(sessionId: string): void {
  const runtime = runtimeOverrides.get(sessionId)
  if (!runtime) return
  sendToSession(sessionId, {
    type: RUNTIME_CONFIG_APPLIED_EVENT,
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    ...(runtime.effort ? { effortLevel: runtime.effort } : {}),
  })
}

async function resolveRuntimeRestartWorkDir(sessionId: string): Promise<string> {
  const activeWorkDir = conversationService.getSessionWorkDir(sessionId)
  if (activeWorkDir) return activeWorkDir

  const persistedWorkDir = await sessionService.getSessionWorkDir(sessionId).catch(() => null)
  if (persistedWorkDir) return persistedWorkDir

  throw new Error(`Unable to resolve working directory for session: ${sessionId}`)
}

async function restartSessionWithRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  try {
    const workDir = await resolveRuntimeRestartWorkDir(sessionId)
    markActiveAgentsStopping(sessionId)
    runtimeExitStoppedSessions.add(sessionId)
    conversationService.stopSession(sessionId)
    await emitAuthoritativeStoppedForActiveAgents(sessionId)
    await emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)

    const runtimeSettings = await getRuntimeSettings(sessionId)
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)
    runtimeExitStoppedSessions.delete(sessionId)

    broadcastAppliedRuntimeConfig(sessionId)
    sendMessage(ws, { type: 'status', state: 'idle' })
    console.log(`[WS] Restarted CLI for ${sessionId} with runtime override`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    void diagnosticsService.recordEvent({
      type: 'runtime_config_restart_failed',
      severity: 'error',
      sessionId,
      summary: errMsg,
      details: { runtimeOverride: runtimeOverrides.get(sessionId), error: err },
    })
    console.error(`[WS] Failed to restart CLI for ${sessionId} after runtime override: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(
        sessionId,
        `Failed to switch provider/model: ${errMsg}`,
      ),
      code: 'CLI_RESTART_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

function handleStopGeneration(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  const stoppedTurn = activeUserTurns.get(sessionId)
  const agentTasks = [...(activeAgentTasks.get(sessionId)?.values() ?? [])]
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  if (stoppedTurn) {
    sessionStopRequested.add(sessionId)
  }
  if (stoppedTurn || agentTasks.length > 0) {
    const computerUseRequestIds = computerUseApprovalService
      .getPendingRequests(sessionId)
      .map((request) => request.requestId)
    computerUseApprovalService.cancelSession(sessionId)
    for (const requestId of computerUseRequestIds) {
      sendToSession(sessionId, {
        type: 'permission_resolved',
        requestId,
        permissionType: 'computer_use',
        allowed: false,
      })
    }
  }
  agentStopRequestedSessions.add(sessionId)
  legacyQueuedSessionChats.delete(sessionId)
  terminalSessionChatStates.delete(sessionId)
  interruptedSessionChats.add(sessionId)

  // A turn can be registered while title metadata, CLI startup, or the send
  // acknowledgement is still pending. Revoke that admission token so the
  // suspended handler cannot resume after Stop and enqueue work (or clear the
  // Agent stop latch) behind the user's explicit cancellation.
  if (stoppedTurn && !stoppedTurn.messageSent) {
    stoppedTurn.cancelled = true
    stoppedTurn.replacementAfterStop = false
    clearActiveUserTurn(sessionId, stoppedTurn)
  } else if (stoppedTurn) {
    stoppedTurn.cancelled = true
    stoppedTurn.replacementAfterStop = false
  }

  void Promise.allSettled(
    agentTasks.map((task) => requestStopTrackedAgentTask(sessionId, task, ws)),
  )

  if (
    stoppedTurn &&
    conversationService.hasSession(sessionId) &&
    (!stoppedTurn.messageSent || !stoppedTurn.interruptBoundaryPending)
  ) {
    // First try graceful interrupt via SDK control message
    if (stoppedTurn.messageSent) addPendingInterruptedTurnResult(sessionId)
    const interruptSent = conversationService.sendInterrupt(sessionId)
    if (stoppedTurn.messageSent) {
      if (interruptSent) {
        stoppedTurn.interruptBoundaryPending = true
      } else {
        removePendingInterruptedTurnResult(sessionId)
      }
    }
  }

  if ((stoppedTurn || agentTasks.length > 0) && conversationService.hasSession(sessionId)) {
    // Force-kill if still running after 3 seconds
    setTimeout(() => {
      const stoppedForegroundStillCurrent = Boolean(
        stoppedTurn &&
        stoppedTurn.cancelled &&
        (
          activeUserTurns.get(sessionId) === stoppedTurn ||
          (
            stoppedTurn.sendStarted === true &&
            !stoppedTurn.messageSent &&
            !activeUserTurns.has(sessionId)
          )
        ),
      )
      const stoppedAgentsStillActive =
        agentStopRequestedSessions.has(sessionId) &&
        activeUserTurns.get(sessionId)?.replacementAfterStop !== true &&
        [...(activeAgentTasks.get(sessionId)?.values() ?? [])].some(
          (task) => !task.localStopConfirmed,
        )
      if (
        (stoppedForegroundStillCurrent || stoppedAgentsStillActive) &&
        conversationService.hasSession(sessionId)
      ) {
        console.log(`[WS] Force-killing CLI subprocess for session: ${sessionId}`)
        forceStopSharedRuntimeForAgentCancellation(sessionId)
        void emitAuthoritativeStoppedForActiveAgents(sessionId)
      }
    }, 3_000)
  }

  sendToSession(sessionId, { type: 'status', state: 'idle' })
}

async function handleStopBackgroundTask(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'stop_background_task' }>,
): Promise<void> {
  const { sessionId } = ws.data
  const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : ''

  if (!taskId) {
    sendMessage(ws, {
      type: 'background_task_stop_failed',
      taskId,
      message: 'Background task id is required',
    })
    return
  }

  await requestStopBackgroundTask(ws, taskId)
}

async function requestStopBackgroundTask(
  ws: ServerWebSocket<WebSocketData>,
  taskId: string,
): Promise<void> {
  const { sessionId } = ws.data
  const trackedAgent = activeAgentTasks.get(sessionId)?.get(taskId)
  if (trackedAgent) {
    await requestStopTrackedAgentTask(sessionId, trackedAgent, ws)
    return
  }

  try {
    await conversationService.requestControl(sessionId, {
      subtype: 'stop_task',
      task_id: taskId,
    })
  } catch (error) {
    reportBackgroundTaskStopFailure(sessionId, ws, taskId, error)
  }
}

const AGENT_STOP_CONTROL_TIMEOUT_MS = 3_000
const AUTHORITATIVE_STOP_PERSIST_ATTEMPTS = 3
const AUTHORITATIVE_STOP_PERSIST_TIMEOUT_MS = 1_000
const AGENT_STOP_FINALIZATION_RETRY_DELAYS_MS = [250, 500] as const

async function requestStopTrackedAgentTask(
  sessionId: string,
  task: ActiveAgentTaskState,
  ws?: ServerWebSocket<WebSocketData>,
): Promise<void> {
  const current = activeAgentTasks.get(sessionId)?.get(task.taskId)
  if (!current) return
  current.stopIntent = true
  if (current.stopRequested) {
    if (!conversationService.hasSession(sessionId)) {
      current.localStopConfirmed = true
      await emitAuthoritativeAgentStopped(sessionId, current, ws)
    }
    return
  }

  clearAgentStopFinalizationRetry(current)
  current.finalizationRetryCount = 0
  current.stopFailureMessage = undefined
  current.stopRequested = true
  if (current.localStopConfirmed) {
    await emitAuthoritativeAgentStopped(sessionId, current, ws)
    return
  }

  // Start strict remote cancellation immediately instead of waiting for the
  // CLI control channel. The CLI stop closes the local poller; the archive
  // result remains the authority for whether a remote Agent is terminal.
  const remoteArchiveAttempt = current.taskType === 'remote_agent'
    ? ensureRemoteAgentArchive(sessionId, current)
    : undefined

  if (!conversationService.hasSession(sessionId)) {
    current.localStopConfirmed = true
    await emitAuthoritativeAgentStopped(sessionId, current, ws)
    return
  }

  let controlError: unknown
  try {
    await conversationService.requestControl(sessionId, {
      subtype: 'stop_task',
      task_id: current.taskId,
    }, AGENT_STOP_CONTROL_TIMEOUT_MS)
  } catch (error) {
    controlError = error
  }

  const latest = activeAgentTasks.get(sessionId)?.get(current.taskId)
  if (latest !== current) return
  if (controlError === undefined || !conversationService.hasSession(sessionId)) {
    current.localStopConfirmed = true
  }

  if (current.taskType === 'remote_agent') {
    // A force-kill or a newer retry may have replaced this archive attempt.
    if (current.remoteArchive !== remoteArchiveAttempt) return
    const finalized = await emitAuthoritativeAgentStopped(sessionId, current, ws)
    if (
      !finalized &&
      !current.localStopConfirmed &&
      shouldForceStopLatchedAgent(sessionId) &&
      activeAgentTasks.get(sessionId)?.get(current.taskId) === current &&
      conversationService.hasSession(sessionId)
    ) {
      forceStopSharedRuntimeForAgentCancellation(sessionId)
      current.localStopConfirmed = true
    }
    return
  }

  if (current.localStopConfirmed) {
    await emitAuthoritativeAgentStopped(sessionId, current, ws)
    return
  }

  if (
    shouldForceStopLatchedAgent(sessionId) &&
    conversationService.hasSession(sessionId)
  ) {
    forceStopSharedRuntimeForAgentCancellation(sessionId)
    current.localStopConfirmed = true
    await emitAuthoritativeAgentStopped(sessionId, current, ws)
    return
  }

  current.stopRequested = false
  reportAgentStopFailure(sessionId, ws, current, controlError)
}

function shouldForceStopLatchedAgent(sessionId: string): boolean {
  return agentStopRequestedSessions.has(sessionId) &&
    activeUserTurns.get(sessionId)?.replacementAfterStop !== true
}

function ensureRemoteAgentArchive(
  sessionId: string,
  task: ActiveAgentTaskState,
): Promise<boolean> {
  if (task.taskType !== 'remote_agent') return Promise.resolve(true)
  if (task.remoteArchive) return task.remoteArchive
  if (!task.remoteSessionId) {
    task.remoteArchiveError = 'Remote session id is missing'
    console.warn(`[WS] Cannot archive remote Agent ${task.taskId} for ${sessionId}: ${task.remoteArchiveError}`)
    task.remoteArchive = Promise.resolve(false)
    return task.remoteArchive
  }

  task.remoteArchiveError = undefined
  task.remoteArchive = archiveRemoteSession(task.remoteSessionId, { timeoutMs: 1_500 })
    .then(() => true)
    .catch((error) => {
      task.remoteArchiveError = error instanceof Error ? error.message : String(error)
      console.warn(
        `[WS] Failed to archive remote Agent ${task.taskId} for ${sessionId}: ${task.remoteArchiveError}`,
      )
      return false
    })
  return task.remoteArchive
}

function reportBackgroundTaskStopFailure(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData> | undefined,
  taskId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(
    `[WS] Failed to stop background task ${taskId} for ${sessionId}: ${message}`,
  )
  const payload: ServerMessage = {
    type: 'background_task_stop_failed',
    taskId,
    message,
  }
  if (ws && activeSessions.get(sessionId)?.has(ws)) {
    sendMessage(ws, payload)
    return
  }
  for (const client of activeSessions.get(sessionId) ?? []) {
    sendMessage(client, payload)
  }
}

function reportAgentStopFailure(
  sessionId: string,
  _ws: ServerWebSocket<WebSocketData> | undefined,
  task: ActiveAgentTaskState,
  error: unknown,
): void {
  task.stopFailureMessage = error instanceof Error ? error.message : String(error)
  // Every renderer that issued a concurrent Stop has optimistic local state.
  // Broadcast Agent failures session-wide so no secondary view remains stuck
  // in Stopping while the first request owns the shared finalization attempt.
  reportBackgroundTaskStopFailure(sessionId, undefined, task.taskId, error)
}

function replayAgentStopFailures(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  for (const task of activeAgentTasks.get(sessionId)?.values() ?? []) {
    if (!task.stopFailureMessage) continue
    sendMessage(ws, {
      type: 'background_task_stop_failed',
      taskId: task.taskId,
      message: task.stopFailureMessage,
    })
  }
}


function scheduleAgentStopFinalizationRetry(
  sessionId: string,
  task: ActiveAgentTaskState,
): void {
  if (!task.localStopConfirmed || task.finalizationRetryTimer !== undefined) return
  const delayMs = AGENT_STOP_FINALIZATION_RETRY_DELAYS_MS[task.finalizationRetryCount]
  if (delayMs !== undefined) {
    task.finalizationRetryCount += 1
    task.finalizationRetryTimer = setTimeout(() => {
      task.finalizationRetryTimer = undefined
      const current = activeAgentTasks.get(sessionId)?.get(task.taskId)
      if (
        current !== task ||
        !current.stopIntent ||
        !current.localStopConfirmed ||
        current.bookendPending
      ) {
        return
      }
      current.stopFailureMessage = undefined
      void emitAuthoritativeAgentStopped(sessionId, current)
    }, delayMs)
    if (typeof task.finalizationRetryTimer === 'object') {
      task.finalizationRetryTimer.unref?.()
    }
  }
  scheduleDisconnectedSessionCleanupIfIdle(sessionId)
}

function stopLateAgentTaskIfRequested(
  sessionId: string,
  lifecycle: CliBackgroundTaskLifecycle | null,
): void {
  if (
    !lifecycle?.running ||
    !isAgentTaskType(lifecycle.taskType) ||
    !agentStopRequestedSessions.has(sessionId)
  ) {
    return
  }
  const task = activeAgentTasks.get(sessionId)?.get(lifecycle.taskId)
  // The output callback that observes a late task is not necessarily the
  // client that clicked Stop. Omit a socket so failures broadcast to every
  // connected view and each renderer can clear its optimistic Stopping state.
  if (task) void requestStopTrackedAgentTask(sessionId, task)
}

function closeLateNonAgentTaskAfterRuntimeExit(
  sessionId: string,
  lifecycle: CliBackgroundTaskLifecycle | null,
): void {
  if (
    !lifecycle?.running ||
    isAgentTaskType(lifecycle.taskType) ||
    !runtimeExitStoppedSessions.has(sessionId)
  ) {
    return
  }
  void emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)
}

function emitAuthoritativeAgentStopped(
  sessionId: string,
  task: ActiveAgentTaskState,
  ws?: ServerWebSocket<WebSocketData>,
): Promise<boolean> {
  const current = activeAgentTasks.get(sessionId)?.get(task.taskId)
  if (!current) return Promise.resolve(false)
  if (sessionClearInProgress.has(sessionId)) return Promise.resolve(false)
  if (current.finalization) return current.finalization
  if (current.bookendPending) return Promise.resolve(false)
  current.bookendPending = true

  const finalization = (async (): Promise<boolean> => {
    const remoteArchiveAttempt = current.taskType === 'remote_agent'
      ? ensureRemoteAgentArchive(sessionId, current)
      : undefined
    const stopConfirmed = remoteArchiveAttempt
      ? await remoteArchiveAttempt
      : true

    if (activeAgentTasks.get(sessionId)?.get(current.taskId) !== current) return false
    if (
      remoteArchiveAttempt &&
      current.remoteArchive !== remoteArchiveAttempt
    ) {
      current.bookendPending = false
      return false
    }

    if (!stopConfirmed) {
      current.bookendPending = false
      current.stopRequested = false
      current.remoteArchive = undefined
      reportAgentStopFailure(
        sessionId,
        ws,
        current,
        new Error(current.remoteArchiveError ?? 'Remote Agent stop could not be confirmed'),
      )
      scheduleAgentStopFinalizationRetry(sessionId, current)
      return false
    }

    if (current.taskType === 'remote_agent') {
      current.localStopConfirmed = true
    }

    const cliMsg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: current.taskId,
      tool_use_id: current.toolUseId,
      task_type: current.taskType,
      ...(current.description ? { description: current.description } : {}),
      ...(current.ownerAgentId ? { owner_agent_id: current.ownerAgentId } : {}),
      status: 'stopped',
      summary: current.description
        ? `${current.description} stopped`
        : 'Background Agent stopped',
      timestamp: new Date().toISOString(),
    }

    let persisted = false
    for (let attempt = 0; attempt < AUTHORITATIVE_STOP_PERSIST_ATTEMPTS; attempt++) {
      if (
        sessionClearInProgress.has(sessionId) ||
        activeAgentTasks.get(sessionId)?.get(current.taskId) !== current
      ) {
        current.bookendPending = false
        return false
      }
      const persistence = persistCliTaskNotification(sessionId, cliMsg, {
        propagateFailure: true,
        timeoutMs: AUTHORITATIVE_STOP_PERSIST_TIMEOUT_MS,
      })
      if (!persistence) {
        persisted = true
        break
      }
      try {
        await persistence
        persisted = true
        break
      } catch {
        // The persistence cache drops rejected writes, so the next bounded
        // attempt performs a real retry rather than awaiting the same promise.
      }
    }

    if (activeAgentTasks.get(sessionId)?.get(current.taskId) !== current) return false
    if (!persisted) {
      current.bookendPending = false
      current.stopRequested = false
      reportAgentStopFailure(
        sessionId,
        ws,
        current,
        new Error('Agent stopped, but its terminal state could not be saved'),
      )
      scheduleAgentStopFinalizationRetry(sessionId, current)
      return false
    }

    current.stopFailureMessage = undefined
    markTaskAuthoritativelyStopped(sessionId, current.taskId)
    untrackCliBackgroundTask(sessionId, current.taskId)
    forwardCliMessageToSessionClients(sessionId, cliMsg)
    scheduleDisconnectedSessionCleanupIfIdle(sessionId)
    return true
  })().catch((error): boolean => {
    if (activeAgentTasks.get(sessionId)?.get(current.taskId) !== current) return false
    current.bookendPending = false
    current.stopRequested = false
    reportAgentStopFailure(sessionId, ws, current, error)
    scheduleAgentStopFinalizationRetry(sessionId, current)
    return false
  })

  current.finalization = finalization
  void finalization.then(() => {
    if (current.finalization === finalization) current.finalization = undefined
  })
  return finalization
}

function resumeAgentFinalizationAfterFailedClear(
  sessionId: string,
  tasks: ActiveAgentTaskState[],
): void {
  const pendingFinalizations = tasks.flatMap((task) =>
    task.finalization ? [task.finalization] : [])
  void Promise.allSettled(pendingFinalizations).then(() => {
    for (const task of tasks) {
      const current = activeAgentTasks.get(sessionId)?.get(task.taskId)
      if (current !== task) continue
      clearAgentStopFinalizationRetry(current)
      current.stopIntent = true
      current.stopRequested = true
      current.localStopConfirmed = true
      current.bookendPending = false
      current.stopFailureMessage = undefined
      void emitAuthoritativeAgentStopped(sessionId, current)
    }
  })
}

function emitAuthoritativeStoppedForActiveAgents(sessionId: string): Promise<boolean[]> {
  const tasks = [...(activeAgentTasks.get(sessionId)?.values() ?? [])]
  return Promise.all(tasks.map((task) => {
    task.stopIntent = true
    task.stopRequested = true
    task.localStopConfirmed = true
    return emitAuthoritativeAgentStopped(sessionId, task)
  }))
}

function emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId: string): Promise<void[]> {
  const tasks = [...(activeNonAgentTasks.get(sessionId)?.values() ?? [])]
  return Promise.all(tasks.map(async (task) => {
    if (activeNonAgentTasks.get(sessionId)?.get(task.taskId) !== task) return
    // Killing the shared CLI also terminates Bash/Dream/workflow work. Claim
    // each task before awaiting persistence so concurrent force-stop paths
    // cannot publish duplicate terminal bookends.
    markTaskAuthoritativelyStopped(sessionId, task.taskId)
    untrackCliBackgroundTask(sessionId, task.taskId)
    const cliMsg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: task.taskId,
      tool_use_id: task.toolUseId,
      ...(task.taskType ? { task_type: task.taskType } : {}),
      ...(task.description ? { description: task.description } : {}),
      ...(task.ownerAgentId ? { owner_agent_id: task.ownerAgentId } : {}),
      status: 'stopped',
      summary: `${task.description ?? task.taskId} stopped because the runtime exited`,
      timestamp: new Date().toISOString(),
    }
    await (persistCliTaskNotification(sessionId, cliMsg) ?? Promise.resolve())
    forwardCliMessageToSessionClients(sessionId, cliMsg)
  }))
}

async function stopAgentsForSessionClear(
  sessionId: string,
  tasks: ActiveAgentTaskState[],
): Promise<boolean[]> {
  return Promise.all(tasks.map(async (task) => {
    if (task.taskType === 'local_agent') return true
    if (!task.remoteSessionId) {
      console.warn(
        `[WS] Cannot archive remote Agent ${task.taskId} for ${sessionId}: Remote session id is missing`,
      )
      return false
    }

    for (let attempt = 0; attempt <= AGENT_STOP_FINALIZATION_RETRY_DELAYS_MS.length; attempt++) {
      const archived = await ensureRemoteAgentArchive(sessionId, task)
      if (archived) return true

      task.remoteArchive = undefined
      const retryDelayMs = AGENT_STOP_FINALIZATION_RETRY_DELAYS_MS[attempt]
      if (retryDelayMs === undefined) break
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs))
    }
    return false
  }))
}


function closeStoppedAgentsAfterRuntimeExit(sessionId: string, cliMsg: any): void {
  if (
    cliMsg?.type === 'result' &&
    cliMsg.is_error &&
    agentStopRequestedSessions.has(sessionId) &&
    !conversationService.hasSession(sessionId)
  ) {
    runtimeExitStoppedSessions.add(sessionId)
    void emitAuthoritativeStoppedForActiveAgents(sessionId)
    void emitStoppedForNonAgentTasksAfterRuntimeExit(sessionId)
  }
}

// ============================================================================
// Title generation
// ============================================================================

type TitleGenerationPhase = 'user-message' | 'turn-complete'

function triggerTitleGeneration(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  phase: TitleGenerationPhase,
  completedTurnCount?: number,
): void {
  const state = sessionTitleState.get(sessionId)
  if (!state || state.hasCustomTitle || state.hasExistingTranscript) return

  const count = phase === 'turn-complete'
    ? completedTurnCount ?? state.userMessageCount
    : state.userMessageCount

  if (phase === 'user-message') {
    if (count !== 1) return
    const key = 'placeholder:1'
    if (state.startedGenerationKeys.has(key)) return
    state.startedGenerationKeys.add(key)

    void (async () => {
      try {
        const text = state.firstUserMessage
        const placeholder = deriveTitle(text)
        if (placeholder) {
          const saved = await saveAiTitle(sessionId, placeholder)
          if (!saved) {
            state.hasCustomTitle = true
            return
          }
          sendSessionTitleUpdated(ws, sessionId, placeholder)
        }
      } catch (err) {
        console.error(`[Title] Failed to derive title for ${sessionId}:`, err)
      }
    })()
    return
  }

  // Generate polished titles after assistant output completes on turn 1 and 3.
  if (count !== 1 && count !== 3) return
  const key = `complete:${count}`
  if (state.startedGenerationKeys.has(key)) return
  state.startedGenerationKeys.add(key)

  const text = buildConversationTitleInput(state.completedTurns)
  const runtimeProviderId = runtimeOverrides.get(sessionId)?.providerId
  const generationSeq = ++state.generationSeq

  void (async () => {
    try {
      const responseLanguage = await getResponseLanguageSetting()
      const titleLanguagePreference = resolveTitleLanguagePreference(
        state.firstUserMessage,
        responseLanguage,
      )
      const aiTitle = await generateTitle(
        text,
        runtimeProviderId,
        titleLanguagePreference,
      )
      if (generationSeq !== state.generationSeq) return
      if (aiTitle) {
        const saved = await saveAiTitle(sessionId, aiTitle)
        if (!saved) {
          state.hasCustomTitle = true
          return
        }
        sendSessionTitleUpdated(ws, sessionId, aiTitle)
      }
    } catch (err) {
      console.error(`[Title] Failed to generate title for ${sessionId}:`, err)
    }
  })()
}

async function getResponseLanguageSetting(): Promise<string | undefined> {
  const userSettings = await settingsService.getUserSettings().catch(() => ({}))
  return typeof userSettings.language === 'string'
    ? userSettings.language
    : undefined
}

function sendSessionTitleUpdated(
  fallbackWs: ServerWebSocket<WebSocketData>,
  sessionId: string,
  title: string,
): void {
  const payload: ServerMessage = { type: 'session_title_updated', sessionId, title }
  const clients = activeSessions.get(sessionId)
  if (!clients?.size) {
    sendMessage(fallbackWs, payload)
    return
  }
  for (const client of clients) {
    sendMessage(client, payload)
  }
}

function bindTitleSessionOutput(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  activeTurn: ActiveUserTurnState,
  shouldProcess: () => boolean,
): () => void {
  const callback = (cliMsg: any) => {
    const interruptedResult = consumeInterruptedTurnResult(sessionId, cliMsg)
    acknowledgeActiveTurnReplay(sessionId, cliMsg)
    if (
      activeUserTurns.get(sessionId) !== activeTurn ||
      activeTurn.cancelled
    ) {
      if (cliMsg?.type === 'result') {
        const stillOwnsTurn = activeUserTurns.get(sessionId) === activeTurn
        if (
          !stillOwnsTurn ||
          !interruptedResult ||
          !pendingInterruptedTurnResults.has(sessionId)
        ) {
          conversationService.removeOutputCallback(sessionId, callback)
        }
      }
      return
    }
    if (activeTurn.replacementAfterStop || interruptedResult) return
    if (!shouldProcess() && !(cliMsg?.type === 'result' && cliMsg?.is_error)) {
      return
    }

    appendAssistantTextForTitle(sessionId, cliMsg)

    if (cliMsg?.type === 'result') {
      conversationService.removeOutputCallback(sessionId, callback)
      const completedTurnCount = completeActiveTitleTurn(sessionId)
      if (!cliMsg.is_error) {
        triggerTitleGeneration(ws, sessionId, 'turn-complete', completedTurnCount ?? undefined)
      }
    }
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

function appendAssistantTextForTitle(sessionId: string, cliMsg: any): void {
  const activeTurn = sessionTitleState.get(sessionId)?.activeTurn
  if (!activeTurn) return

  const streamText = extractAssistantStreamTextForTitle(cliMsg)
  if (streamText) {
    activeTurn.assistantText = `${activeTurn.assistantText ?? ''}${streamText}`
    return
  }

  const assistantText = extractAssistantMessageTextForTitle(cliMsg)
  if (assistantText) {
    activeTurn.assistantText = activeTurn.assistantText
      ? `${activeTurn.assistantText}\n${assistantText}`
      : assistantText
    return
  }

  if (
    cliMsg?.type === 'result' &&
    !cliMsg.is_error &&
    !activeTurn.assistantText &&
    typeof cliMsg.result === 'string'
  ) {
    activeTurn.assistantText = cliMsg.result
  }
}



function completeActiveTitleTurn(sessionId: string): number | null {
  const state = sessionTitleState.get(sessionId)
  const activeTurn = state?.activeTurn
  if (!state || !activeTurn) return null

  state.completedTurns.push({
    userText: activeTurn.userText,
    assistantText: activeTurn.assistantText?.trim(),
  })
  state.activeTurn = undefined
  return activeTurn.count
}

function discardActiveTitleTurn(sessionId: string, count: number | null): void {
  if (count === null) return
  const state = sessionTitleState.get(sessionId)
  if (state?.activeTurn?.count === count) {
    state.activeTurn = undefined
  }
}

// ============================================================================
// CLI message translation
// ============================================================================


/** Per-session state for correlating raw stream events with buffered messages. */

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      streamedAssistantMessageIds: new Set(),
      unidentifiedStreamScopes: new Set(),
      activeMessageIdsByScope: new Map(),
      activeBlockScopesByIndex: new Map(),
      activeBlockTypes: new Map(),
      activeToolBlocks: new Map(),
      pendingLocalCommand: undefined,
      pendingToolBlocks: new Map(),
      toolParentUseIds: new Map(),
      lastApiError: undefined,
    }
    sessionStreamStates.set(sessionId, state)
  }
  return state
}

function isAgentRunStreamMessage(
  message: ServerMessage,
): message is AgentRunStreamMessage {
  return message.type === 'content_start' ||
    message.type === 'content_delta' ||
    message.type === 'tool_use_complete' ||
    message.type === 'tool_result' ||
    message.type === 'thinking' ||
    message.type === 'status' ||
    message.type === 'api_retry' ||
    message.type === 'streaming_fallback' ||
    message.type === 'error'
}

function translateAgentRunMessage(
  cliMsg: any,
  sessionId: string,
): ServerMessage[] {
  const runAgentId = typeof cliMsg.run_agent_id === 'string'
    ? cliMsg.run_agent_id.trim()
    : ''
  const streamId = typeof cliMsg.stream_id === 'string'
    ? cliMsg.stream_id.trim()
    : ''
  const targetAgentId = typeof cliMsg.target_agent_id === 'string'
    ? cliMsg.target_agent_id.trim()
    : ''
  const targetAgentScopeId = typeof cliMsg.target_agent_scope_id === 'string'
    ? cliMsg.target_agent_scope_id.trim()
    : ''
  if (!runAgentId || !streamId || !targetAgentId) return []

  const route = {
    runAgentId,
    streamId,
    targetAgentId,
    ...(targetAgentScopeId ? { targetAgentScopeId } : {}),
  }
  const streamSessionId = `${sessionId}\u0000agent-run:${streamId}`

  if (cliMsg.event_kind === 'complete') {
    sessionStreamStates.delete(streamSessionId)
    return [{
      type: 'agent_run_event',
      ...route,
      event: { type: 'status', state: 'idle' },
    }]
  }
  if (cliMsg.event_kind === 'cancelled') {
    sessionStreamStates.delete(streamSessionId)
    return [
      {
        type: 'agent_run_event',
        ...route,
        event: { type: 'streaming_fallback', cause: 'stream_retry' },
      },
      {
        type: 'agent_run_event',
        ...route,
        event: { type: 'status', state: 'idle' },
      },
    ]
  }
  if (cliMsg.event_kind === 'error') {
    sessionStreamStates.delete(streamSessionId)
    return [{
      type: 'agent_run_event',
      ...route,
      event: {
        type: 'error',
        message: typeof cliMsg.error === 'string' ? cliMsg.error : 'Agent run failed',
        code: 'AGENT_RUN_ERROR',
      },
    }]
  }
  if (cliMsg.event_kind !== 'message' || !cliMsg.message) return []

  return translateCliMessage(cliMsg.message, streamSessionId)
    .filter(isAgentRunStreamMessage)
    .map(event => ({ type: 'agent_run_event', ...route, event }))
}

/** Clean up stream state when session disconnects */
function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
  const agentPrefix = `${sessionId}\u0000agent-run:`
  for (const key of sessionStreamStates.keys()) {
    if (key.startsWith(agentPrefix)) sessionStreamStates.delete(key)
  }
}

function cleanupSessionRuntimeState(
  sessionId: string,
  options?: { preserveRetryableAgentStops?: boolean },
) {
  cancelSessionDisconnectWatcher(sessionId)
  clearAgentRuntimeState(sessionId, {
    preserveRetryableStops: options?.preserveRetryableAgentStops,
  })
  cleanupStreamState(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  runtimeOverrides.delete(sessionId)
  activeUserTurns.delete(sessionId)
  activeCliRuns.delete(sessionId)
  sessionStopRequested.delete(sessionId)
  pendingInterruptedTurnResults.delete(sessionId)
  terminalSessionChatStates.delete(sessionId)
  legacyQueuedSessionChats.delete(sessionId)
  interruptedSessionChats.delete(sessionId)
  deferredRuntimeRestarts.delete(sessionId)
  deferredPermissionModes.delete(sessionId)
  runtimeTransitionPromises.delete(sessionId)
  sessionStartupPromises.delete(sessionId)
  lastResolvedStartupWorkDirs.delete(sessionId)
  taskNotificationPersistence.delete(sessionId)
  clearPrewarmState(sessionId)
}

function getPrewarmIdleTimeoutMs(): number {
  const raw = process.env.CC_HAHA_PREWARM_IDLE_TIMEOUT_MS
  if (!raw) return DEFAULT_PREWARM_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_PREWARM_IDLE_TIMEOUT_MS
}

function clearPrewarmState(sessionId: string) {
  prewarmPendingSessions.delete(sessionId)
  prewarmedSessions.delete(sessionId)
  const timer = prewarmIdleTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    prewarmIdleTimers.delete(sessionId)
  }
}

function markPrewarmed(sessionId: string) {
  prewarmedSessions.add(sessionId)
  const timeoutMs = getPrewarmIdleTimeoutMs()
  if (timeoutMs === 0) return

  const existingTimer = prewarmIdleTimers.get(sessionId)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(() => {
    prewarmIdleTimers.delete(sessionId)
    if (!prewarmedSessions.has(sessionId)) return
    const turnActive = hasPendingOrActiveUserTurn(sessionId)
    const hasClients = hasActiveClients(sessionId)
    // Safety guard: never kill a session that has a registered user turn or
    // connected clients. The turn-registered check (not messageSent) covers the
    // CLI-startup window, so a turn racing through startup is protected even if
    // the client has briefly disconnected. The prewarm idle timer is only meant
    // to reclaim truly idle prewarmed sessions — not to interrupt a conversation.
    if (turnActive || hasClients) {
      prewarmedSessions.delete(sessionId)
      return
    }
    console.log(`[WS] Prewarmed session ${sessionId} idle for ${timeoutMs}ms, stopping CLI subprocess`)
    conversationService.stopSession(sessionId)
    prewarmedSessions.delete(sessionId)
  }, timeoutMs)
  prewarmIdleTimers.set(sessionId, timer)
}

function cacheSessionInitMetadata(sessionId: string, cliMsg: any) {
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'init') return
  if (typeof cliMsg.cwd === 'string' && cliMsg.cwd.trim()) {
    conversationService.updateSessionWorkDir(sessionId, cliMsg.cwd)
    void (async () => {
      await sessionService.appendSessionMetadata(sessionId, {
        workDir: cliMsg.cwd,
      })
      await sessionService.deletePlaceholderSessionFiles(sessionId, cliMsg.cwd)
    })()
  }
  if (cliMsg.slash_commands && Array.isArray(cliMsg.slash_commands)) {
    updateSessionSlashCommands(sessionId, cliMsg.slash_commands, { notifyClient: false })
  }
}




function isDuplicateOfLastApiError(
  lastApiError: SessionStreamState['lastApiError'],
  resultMessage: string,
): boolean {
  if (!lastApiError?.message) return false
  if (resultMessage === lastApiError.message) return true
  return (
    resultMessage.includes(lastApiError.message) &&
    /CLI (?:process exited unexpectedly|exited during startup)/i.test(resultMessage)
  )
}


function bindPrewarmMetadataCapture(sessionId: string) {
  for (const msg of conversationService.getRecentSdkMessages(sessionId)) {
    cacheSessionInitMetadata(sessionId, msg)
  }
  if (!conversationService.hasSession(sessionId)) return

  conversationService.clearOutputCallbacks(sessionId)
  conversationService.onOutput(sessionId, (cliMsg) => {
    cacheSessionInitMetadata(sessionId, cliMsg)
  })
}

async function resolveSessionWorkDir(sessionId: string, fallback = os.homedir()): Promise<string> {
  let workDir = fallback
  try {
    const resolved = await sessionService.getSessionWorkDir(sessionId)
    if (resolved) workDir = resolved
    console.log(
      `[WS] resolveSessionWorkDir: sessionId=${sessionId}, resolved workDir=${JSON.stringify(
        resolved,
      )}, will spawn CLI with workDir=${workDir}`,
    )
  } catch (resolveErr) {
    console.warn(
      `[WS] resolveSessionWorkDir: failed to resolve workDir for ${sessionId}, using fallback=${workDir}: ${
        resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
      }`,
    )
  }
  return workDir
}

async function ensureCliSessionStarted(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  reason: 'user_message' | 'prewarm_session',
): Promise<void> {
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await pendingStartup
    return
  }

  if (conversationService.hasSession(sessionId)) return

  const startupRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
  sessionStartupRuntimeVersions.set(sessionId, startupRuntimeVersion)

  const startup = (async () => {
    const workDir = await resolveSessionWorkDir(sessionId)
    lastResolvedStartupWorkDirs.set(sessionId, workDir)
    const runtimeSettings = await getRuntimeSettings(sessionId)
    const startupSettings = reason === 'prewarm_session'
      ? { ...runtimeSettings, resumeInterruptedTurn: false }
      : runtimeSettings
    const sdkUrl = buildSdkWebSocketUrl(ws, sessionId)
    await sendRepositoryStartupStatus(ws, sessionId, reason)
    console.log(`[WS] Starting CLI for ${sessionId} due to ${reason}`)
    await conversationService.startSession(sessionId, workDir, sdkUrl, startupSettings)
    runtimeExitStoppedSessions.delete(sessionId)
  })()

  sessionStartupPromises.set(sessionId, startup)
  try {
    await startup
  } finally {
    if (sessionStartupPromises.get(sessionId) === startup) {
      sessionStartupPromises.delete(sessionId)
      sessionStartupRuntimeVersions.delete(sessionId)
    }
  }
}

export async function ensureCliSessionStartedForControl(
  sessionId: string,
  requestUrl: URL,
): Promise<void> {
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await pendingStartup
    return
  }

  if (conversationService.hasSession(sessionId)) return

  const startupRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
  sessionStartupRuntimeVersions.set(sessionId, startupRuntimeVersion)

  const startup = (async () => {
    const workDir = await resolveSessionWorkDir(sessionId)
    lastResolvedStartupWorkDirs.set(sessionId, workDir)
    const runtimeSettings = await getRuntimeSettings(sessionId)
    const protocol = requestUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const authority = requestUrl.hostname === '0.0.0.0'
      ? `127.0.0.1${requestUrl.port ? `:${requestUrl.port}` : ''}`
      : requestUrl.host
    const sdkUrl = new URL(
      `${protocol}//${authority}/sdk/${encodeURIComponent(sessionId)}`,
    )
    sdkUrl.searchParams.set('token', crypto.randomUUID())

    console.log(`[WS] Starting CLI for ${sessionId} due to agent_message`)
    await conversationService.startSession(
      sessionId,
      workDir,
      sdkUrl.toString(),
      { ...runtimeSettings, resumeInterruptedTurn: false },
    )
    runtimeExitStoppedSessions.delete(sessionId)
  })()

  sessionStartupPromises.set(sessionId, startup)
  try {
    await startup
  } finally {
    if (sessionStartupPromises.get(sessionId) === startup) {
      sessionStartupPromises.delete(sessionId)
      sessionStartupRuntimeVersions.delete(sessionId)
    }
  }
}

export function translateCliMessage(cliMsg: any, sessionId: string): ServerMessage[] {
  if (isAgentRunMessageFrame(cliMsg)) {
    return translateAgentRunMessage(cliMsg, sessionId)
  }
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error || cliMsg.isApiErrorMessage) {
        // If the user requested stop, suppress API errors caused by the
        // stream being interrupted (e.g. "Stream ended without receiving
        // any events"). The result message handler also checks this flag,
        // but the assistant error arrives first and would leak to the UI.
        if (sessionStopRequested.has(sessionId)) {
          return []
        }
        const message = extractAssistantText(cliMsg) || cliMsg.error || 'Unknown API error'
        const fallbackCode = typeof cliMsg.error === 'string' ? cliMsg.error : 'API_ERROR'
        const code = classifyRuntimeErrorCode(message, fallbackCode)
        streamState.lastApiError = { message, code }
        return [{
          type: 'error',
          message,
          code,
          ...(typeof cliMsg.businessErrorCode === 'string'
            ? { businessErrorCode: cliMsg.businessErrorCode }
            : {}),
        }]
      }

      // Raw stream events and the buffered assistant carry the same message ID.
      // Deduplicate that exact API message rather than the whole session or
      // parent Agent lifetime, where unrelated subagent progress can interleave.
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []
        const parentToolUseId = cliParentToolUseId(cliMsg)
        const streamScope = cliStreamScope(cliMsg)
        const messageId = typeof cliMsg.message.id === 'string'
          ? cliMsg.message.id
          : undefined
        const receivedMatchingStream = messageId
          ? streamState.streamedAssistantMessageIds.has(messageId)
          : streamState.unidentifiedStreamScopes.delete(streamScope)
        if (messageId) streamState.unidentifiedStreamScopes.delete(streamScope)
        if (
          messageId &&
          streamState.activeMessageIdsByScope.get(streamScope) === messageId
        ) {
          streamState.activeMessageIdsByScope.delete(streamScope)
        }

        for (const block of cliMsg.message.content) {
          if (receivedMatchingStream) {
            // Stream events handled most blocks — but any tool_use whose
            // input JSON failed to parse in content_block_stop was deferred.
            // Emit those now with the complete input from the assistant message.
            const pendingKey = block.type === 'tool_use'
              ? pendingToolBlockKey(parentToolUseId, block.id)
              : undefined
            if (pendingKey && streamState.pendingToolBlocks.has(pendingKey)) {
              const pending = streamState.pendingToolBlocks.get(pendingKey)!
              streamState.pendingToolBlocks.delete(pendingKey)
              rememberToolParentUseId(streamState, block.id, pending.parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: pending.toolName || block.name,
                toolUseId: scopedToolUseId(pending.parentToolUseId, block.id),
                ...(pending.parentToolUseId ? { originalToolUseId: block.id } : {}),
                input: block.input,
                parentToolUseId: pending.parentToolUseId,
              })
            }
          } else if (block.type === 'tool_use') {
            rememberToolParentUseId(streamState, block.id, parentToolUseId)
            messages.push({
              type: 'tool_use_complete',
              toolName: block.name,
              toolUseId: scopedToolUseId(parentToolUseId, block.id),
              ...(parentToolUseId ? { originalToolUseId: block.id } : {}),
              input: block.input,
              parentToolUseId,
            })
          } else if (!parentToolUseId && block.type === 'thinking' && block.thinking) {
            messages.push({ type: 'thinking', text: block.thinking, complete: true })
          } else if (!parentToolUseId && block.type === 'text' && block.text) {
            messages.push({ type: 'content_start', blockType: 'text' })
            messages.push({ type: 'content_delta', text: block.text })
          }
        }

        return messages
      }
      return []
    }

    case 'user': {
      // Bug #1: 处理 tool_result 消息
      // CLI 发送 type:'user' 消息，其中 content 包含 tool_result 块
      const messages: ServerMessage[] = []

      if (isCompactSummaryMessageContent(cliMsg.message?.content)) {
        messages.push({
          type: 'system_notification',
          subtype: 'compact_summary',
          message: cliMsg.message.content,
          data: {
            isSynthetic: cliMsg.isSynthetic,
          },
        })
      }

      const localCommandOutput = extractLocalCommandOutput(
        cliMsg.message?.content,
      )
      if (localCommandOutput) {
        const pendingLocalCommand = streamState.pendingLocalCommand
        streamState.pendingLocalCommand = undefined
        if (!isCompactLocalCommandOutput(localCommandOutput)) {
          const goalEvent = extractGoalEvent(
            localCommandOutput,
            pendingLocalCommand,
          )
          if (goalEvent) {
            messages.push({
              type: 'system_notification',
              subtype: 'goal_event',
              message: goalEvent.message,
              data: goalEvent,
            })
          } else {
            messages.push({ type: 'content_start', blockType: 'text' })
            messages.push({ type: 'content_delta', text: localCommandOutput })
          }
        }
      }

      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        for (const block of cliMsg.message.content) {
          if (block.type === 'tool_result') {
            const directParentToolUseId = cliParentToolUseId(cliMsg)
            const parentToolUseId = directParentToolUseId ??
              consumeToolParentUseId(streamState, block.tool_use_id)
            forgetToolParentUseId(
              streamState,
              block.tool_use_id,
              directParentToolUseId,
            )
            messages.push({
              type: 'tool_result',
              toolUseId: scopedToolUseId(parentToolUseId, block.tool_use_id),
              ...(parentToolUseId ? { originalToolUseId: block.tool_use_id } : {}),
              content: normalizeAskUserQuestionToolResult(block.content, cliMsg.toolUseResult),
              isError: !!block.is_error,
              parentToolUseId,
            })
          }
        }
      }

      const replayText = extractReplayUserText(cliMsg)
      if (replayText) {
        messages.push({
          type: 'user_message_replay',
          content: replayText,
        })
      }

      return messages
    }

    case 'stream_event': {
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          const scope = cliStreamScope(cliMsg)
          const messageId = typeof event.message?.id === 'string'
            ? event.message.id
            : undefined
          if (messageId) {
            streamState.streamedAssistantMessageIds.add(messageId)
            streamState.activeMessageIdsByScope.set(scope, messageId)
            streamState.unidentifiedStreamScopes.delete(scope)
          } else {
            streamState.unidentifiedStreamScopes.add(scope)
          }
          return [{ type: 'status', state: 'thinking', attemptStart: true }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const scope = cliStreamScope(cliMsg)
          if (!streamState.activeMessageIdsByScope.has(scope)) {
            streamState.unidentifiedStreamScopes.add(scope)
          }
          const index = event.index ?? 0
          const blockKey = streamBlockKey(scope, index)
          rememberActiveBlockScope(streamState, index, scope)

          if (contentBlock.type === 'tool_use') {
            const parentToolUseId = cliParentToolUseId(cliMsg) ?? (
              scope === ROOT_STREAM_SCOPE ? undefined : scope
            )
            streamState.activeBlockTypes.set(blockKey, 'tool_use')
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(blockKey, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
              parentToolUseId,
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: scopedToolUseId(parentToolUseId, contentBlock.id || ''),
              ...(parentToolUseId ? { originalToolUseId: contentBlock.id } : {}),
              parentToolUseId,
            }]
          }

          if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
            streamState.activeBlockTypes.set(blockKey, 'thinking')
            return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
          }

          streamState.activeBlockTypes.set(blockKey, 'text')
          return [{ type: 'content_start', blockType: 'text' }]
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (!delta) return []

          if (delta.type === 'text_delta' && delta.text) {
            return [{ type: 'content_delta', text: delta.text }]
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON
            const index = event.index ?? 0
            const activeBlock = resolveActiveBlockKey(streamState, cliMsg, index)
            const toolBlock = activeBlock
              ? streamState.activeToolBlocks.get(activeBlock.key)
              : undefined
            if (!toolBlock) return []
            toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const activeBlock = resolveActiveBlockKey(streamState, cliMsg, index)
          if (!activeBlock) return []
          const blockType = streamState.activeBlockTypes.get(activeBlock.key)
          streamState.activeBlockTypes.delete(activeBlock.key)
          forgetActiveBlockScope(streamState, index, activeBlock.scope)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(activeBlock.key)
            streamState.activeToolBlocks.delete(activeBlock.key)
            if (toolBlock) {
              const parentToolUseId =
                cliParentToolUseId(cliMsg) ?? toolBlock.parentToolUseId
              let parsedInput = null
              try { parsedInput = JSON.parse(toolBlock.inputJson) } catch {}

              if (parsedInput !== null) {
                rememberToolParentUseId(streamState, toolBlock.toolUseId, parentToolUseId)
                return [{
                  type: 'tool_use_complete',
                  toolName: toolBlock.toolName,
                  toolUseId: scopedToolUseId(parentToolUseId, toolBlock.toolUseId),
                  ...(parentToolUseId ? { originalToolUseId: toolBlock.toolUseId } : {}),
                  input: parsedInput,
                  parentToolUseId,
                }]
              }

              // JSON parse failed — defer to the assistant message which
              // carries the complete, already-parsed tool input. This is the
              // normal streaming partial-input case, not a fault: keep it at
              // debug so it doesn't surface as a diagnostics warning.
              console.debug(
                `[WS] Tool input JSON parse failed for ${toolBlock.toolName} (${toolBlock.toolUseId}), deferring to assistant message`,
              )
              streamState.pendingToolBlocks.set(
                pendingToolBlockKey(parentToolUseId, toolBlock.toolUseId),
                {
                  toolName: toolBlock.toolName,
                  toolUseId: toolBlock.toolUseId,
                  parentToolUseId,
                },
              )
            }
          }
          return []
        }

        case 'message_stop': {
          // message_stop is handled by the 'result' message
          return []
        }

        case 'message_delta': {
          // message_delta may contain stop_reason or usage updates
          return []
        }

        default:
          return []
      }
    }

    case 'control_request': {
      // 权限请求 — CLI 需要用户授权才能执行工具
      if (cliMsg.request?.subtype === 'can_use_tool') {
        return [{
          type: 'permission_request',
          requestId: cliMsg.request_id,
          toolName: cliMsg.request.tool_name || 'Unknown',
          toolUseId:
            typeof cliMsg.request.tool_use_id === 'string'
              ? cliMsg.request.tool_use_id
              : undefined,
          input: cliMsg.request.input || {},
          description: cliMsg.request.description,
        }]
      }
      return []
    }

    case 'control_cancel_request':
      return typeof cliMsg.request_id === 'string'
        ? [{
            type: 'permission_resolved',
            requestId: cliMsg.request_id,
            permissionType: 'tool',
          }]
        : []

    case 'control_response': {
      const requestId = typeof cliMsg.response?.request_id === 'string'
        ? cliMsg.response.request_id
        : typeof cliMsg.request_id === 'string'
          ? cliMsg.request_id
          : null
      if (!requestId) return []
      const behavior = cliMsg.response?.response?.behavior
      return [{
        type: 'permission_resolved',
        requestId,
        permissionType: 'tool',
        ...(behavior === 'allow' || behavior === 'deny'
          ? { allowed: behavior === 'allow' }
          : {}),
      }]
    }

    case 'result': {
      // 对话结果（成功或错误）
      const usage = translateCliUsage(cliMsg.usage)
      // Buffered assistant blocks can arrive as a batch after all raw events
      // for one provider message. Keep deduplication active across the entire
      // batch, then clear it only at the terminal result boundary.
      resetCurrentStreamAttempt(streamState)

      if (cliMsg.is_error) {
        // If the user requested stop, this "error" is just the interrupt
        // result — don't show it as an error in the chat UI.
        if (
          interruptedTurnResultMessages.get(cliMsg) === sessionId ||
          sessionStopRequested.has(sessionId)
        ) {
          return [{ type: 'message_complete', usage }]
        }

        const resultMessage =
          (typeof cliMsg.result === 'string' && cliMsg.result) ||
          (Array.isArray(cliMsg.errors) && cliMsg.errors.length > 0
            ? cliMsg.errors.join('\n')
            : 'Unknown error')
        if (isDuplicateOfLastApiError(streamState.lastApiError, resultMessage)) {
          streamState.lastApiError = undefined
          return [{ type: 'message_complete', usage }]
        }
        // 错误和完成消息都发送
        return [
          {
            type: 'error',
            message: resultMessage,
            code: classifyRuntimeErrorCode(resultMessage, 'CLI_ERROR'),
          },
          { type: 'message_complete', usage },
        ]
      }

      streamState.lastApiError = undefined
      return [{ type: 'message_complete', usage }]
    }

    case 'system': {
      // 区分不同的 system 子类型
      const subtype = cliMsg.subtype
      if (subtype === 'api_retry') {
        const apiRetryMessage = toApiRetryServerMessage(cliMsg)
        return apiRetryMessage ? [apiRetryMessage] : []
      }
      if (subtype === 'streaming_fallback') {
        // The next attempt is a new stream or a full non-streaming response;
        // neither should inherit raw-event dedup/tool JSON from the failed one.
        resetCurrentStreamAttempt(streamState)
        return [toStreamingFallbackServerMessage(cliMsg)]
      }
      if (subtype === 'init') {
        // CLI 初始化完成 — 缓存 slash commands 并发送模型信息
        // NOTE: Do NOT send status:idle here — the CLI init fires while
        // processing the first user message, and sending idle would reset
        // the frontend's streaming state prematurely.
        cacheSessionInitMetadata(sessionId, cliMsg)
        const messages: ServerMessage[] = [
          // Send model info as a system notification, not a status change
          { type: 'system_notification', subtype: 'init', message: `Model: ${cliMsg.model || 'unknown'}`, data: { model: cliMsg.model } },
        ]
        // Send slash commands to frontend
        const cmds = sessionSlashCommands.get(sessionId)
        if (cmds && cmds.length > 0) {
          messages.push({
            type: 'system_notification',
            subtype: 'slash_commands',
            data: cmds,
          })
        }
        return messages
      }
      if (subtype === 'memory_saved') {
        return [{
          type: 'system_notification',
          subtype: 'memory_saved',
          message: cliMsg.message,
          data: {
            writtenPaths: Array.isArray(cliMsg.writtenPaths) ? cliMsg.writtenPaths : [],
            teamCount: typeof cliMsg.teamCount === 'number' ? cliMsg.teamCount : undefined,
            verb: typeof cliMsg.verb === 'string' ? cliMsg.verb : undefined,
          },
        }]
      }
      if (subtype === 'status') {
        if (cliMsg.status === 'compacting') {
          return [{
            type: 'status',
            state: 'compacting',
            verb: 'Compacting conversation',
          }]
        }
        // CLI 在权限模式变化时也会 enqueue 一条 status 事件（status:null +
        // permissionMode），用于把恢复后的真实权限（如 ExitPlanMode 退出 plan、
        // Shift+Tab）广播给前端。它带 status:null 但**不是** thinking 信号，
        // 必须在下面的 null→thinking 兜底之前拦截，否则字段会被丢弃，桌面端
        // 选择器就会一直卡在"计划模式"。
        if (isPermissionMode(cliMsg.permissionMode)) {
          return [{ type: 'permission_mode_changed', mode: cliMsg.permissionMode }]
        }
        if (cliMsg.status == null) {
          return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
        }
        return []
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hook 执行中 — 不转发给前端
        return []
      }
      if (subtype === 'local_command' || subtype === 'local_command_output') {
        const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
        if (localCommand) {
          streamState.pendingLocalCommand = localCommand
          return []
        }

        const localCommandOutput = extractLocalCommandOutput(
          cliMsg.content ?? cliMsg.message,
          { allowUntagged: subtype === 'local_command_output' },
        )
        if (!localCommandOutput) return []
        const goalEvent = extractGoalEvent(
          localCommandOutput,
          streamState.pendingLocalCommand,
        )
        streamState.pendingLocalCommand = undefined
        if (goalEvent) {
          return [{
            type: 'system_notification',
            subtype: 'goal_event',
            message: goalEvent.message,
            data: goalEvent,
          }]
        }
        return [
          { type: 'content_start', blockType: 'text' },
          { type: 'content_delta', text: localCommandOutput },
        ]
      }
      // Bug #7: 处理 task/team system 消息
      if (subtype === 'task_notification') {
        return [{
          type: 'system_notification',
          subtype: 'task_notification',
          message: cliMsg.message || cliMsg.title,
          data: cliMsg,
        }]
      }
      if (subtype === 'task_started') {
        const notification: ServerMessage = {
          type: 'system_notification',
          subtype: 'task_started',
          message: cliMsg.message || cliMsg.description || 'Task started',
          data: cliMsg,
        }
        // AutoDream is detached maintenance work. Keep it visible in Activity,
        // but do not revive the already-completed foreground turn. A late Agent
        // spawned after Stop is also visible until its stop bookend arrives.
        // The same applies to independent non-Agent task lifecycle after Stop:
        // Activity still needs the event, but chat must remain idle.
        if (
          cliMsg.owner_agent_id ||
          cliMsg.task_type === 'dream' ||
          sessionStopRequested.has(sessionId) ||
          agentStopRequestedSessions.has(sessionId) ||
          !hasLiveUserTurnForClient(sessionId)
        ) {
          return [notification]
        }
        return [
          notification,
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.description || 'Task started',
          },
        ]
      }
      if (subtype === 'task_progress') {
        const notification: ServerMessage = {
          type: 'system_notification',
          subtype: 'task_progress',
          message: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
          data: cliMsg,
        }
        if (cliMsg.owner_agent_id || !hasLiveUserTurnForClient(sessionId)) return [notification]
        return [
          notification,
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
          },
        ]
      }
      if (subtype === 'agent_tool_activity') {
        // Nested Agents belong to their immediate owning run. Their tool
        // cards must not be flattened into the root session transcript.
        if (typeof cliMsg.owner_agent_id === 'string' && cliMsg.owner_agent_id.trim()) {
          return []
        }
        // Tool activity streamed from a background (async) agent. Re-emit as a
        // normal tool_use_complete / tool_result carrying the parent Agent
        // tool_use_id, so the desktop groups it under the agent card exactly
        // like a synchronous subagent (childToolCallsByParent).
        const activity = cliMsg.activity
        const parentToolUseId =
          typeof cliMsg.tool_use_id === 'string' ? cliMsg.tool_use_id : undefined
        if (activity?.kind === 'tool_use') {
          return [{
            type: 'tool_use_complete',
            toolName: activity.tool_name,
            toolUseId: scopedToolUseId(parentToolUseId, activity.tool_use_id),
            originalToolUseId: activity.tool_use_id,
            input: activity.input,
            parentToolUseId,
          }]
        }
        if (activity?.kind === 'tool_result') {
          return [{
            type: 'tool_result',
            toolUseId: scopedToolUseId(parentToolUseId, activity.tool_use_id),
            originalToolUseId: activity.tool_use_id,
            content: activity.content,
            isError: activity.is_error === true,
            parentToolUseId,
          }]
        }
        return []
      }
      if (subtype === 'session_state_changed') {
        return [{
          type: 'system_notification',
          subtype: 'session_state_changed',
          message: cliMsg.message,
          data: cliMsg,
        }]
      }
      if (subtype === 'compact_boundary') {
        return [{
          type: 'system_notification',
          subtype: 'compact_boundary',
          message: getCompactBoundaryMessage(cliMsg),
          data: cliMsg.compact_metadata ?? cliMsg,
        }]
      }
      // 其他 system 消息
      return []
    }

    default:
      // 未知类型 — 调试输出但不转发
      console.log(`[WS] Unknown CLI message type: ${cliMsg.type}`, JSON.stringify(cliMsg).substring(0, 200))
      return []
  }
}

// ============================================================================
// Helpers
// ============================================================================








function sendMessage(ws: ServerWebSocket<WebSocketData>, message: ServerMessage) {
  const outgoing = ws.data.clientKind === 'pet'
    ? toPetServerMessage(message)
    : message
  if (outgoing) ws.send(JSON.stringify(outgoing))
}

function sendError(ws: ServerWebSocket<WebSocketData>, message: string, code: string) {
  sendMessage(ws, { type: 'error', message, code })
}

/**
 * Idle disconnect cleanup delay. A session waiting on a pending permission
 * keeps the long 30-minute window so a transient renderer disconnect does not
 * abort a prompt the user is about to answer. Otherwise we honor the
 * user-configured grace period (issue #764).
 */
function getDisconnectCleanupDelayMs(sessionId: string): number {
  return conversationService.getPendingPermissionRequests(sessionId).length > 0
    ? PENDING_PERMISSION_DISCONNECT_CLEANUP_MS
    : getDisconnectGraceMs()
}

/**
 * Whether a user turn has been registered for this session and not yet settled,
 * INCLUDING the CLI-startup window before messageSent flips true. handleUserMessage
 * registers the turn in its synchronous prefix (activeUserTurns.set), well before
 * the message is actually sent. Checking the registration is not blind to that
 * window, so the prewarm idle timer can neither arm on nor fire against a
 * session a user turn has already claimed — even when a concurrent
 * prewarm_session/user_message flush inverts their ordering.
 */
function hasPendingOrActiveUserTurn(sessionId: string): boolean {
  return activeUserTurns.has(sessionId)
}

function hasLiveUserTurnForClient(sessionId: string): boolean {
  const activeTurn = activeUserTurns.get(sessionId)
  return Boolean(activeTurn && !activeTurn.cancelled)
}

/**
 * Start the idle grace timer for a disconnected, idle session. If no client
 * reconnects before it fires, the CLI subprocess is stopped.
 */
function scheduleDisconnectCleanup(sessionId: string): void {
  computerUseApprovalService.cancelSession(sessionId)

  const existing = sessionCleanupTimers.get(sessionId)
  if (existing) clearTimeout(existing)

  const cleanupDelayMs = getDisconnectCleanupDelayMs(sessionId)
  const cleanupTimer = setTimeout(() => {
    sessionCleanupTimers.delete(sessionId)
    if (hasActiveClients(sessionId)) return

    const permissionBoundExpired = conversationService
      .getPendingPermissionRequests(sessionId).length > 0
    if (
      !permissionBoundExpired &&
      hasActiveSessionWork(sessionId)
    ) {
      console.log(`[WS] Session ${sessionId} became active during its idle grace period; keeping CLI alive`)
      watchTurnCompletionForCleanup(sessionId)
      return
    }

    console.log(`[WS] Session ${sessionId} not reconnected after ${cleanupDelayMs}ms, stopping CLI subprocess`)
    conversationService.stopSession(sessionId)
    cleanupSessionRuntimeState(sessionId, { preserveRetryableAgentStops: true })
  }, cleanupDelayMs)
  sessionCleanupTimers.set(sessionId, cleanupTimer)
}

function scheduleDisconnectedSessionCleanupIfIdle(sessionId: string): void {
  if (
    hasActiveClients(sessionId) ||
    hasActiveSessionWork(sessionId)
  ) {
    return
  }

  cancelSessionDisconnectWatcher(sessionId)
  scheduleDisconnectCleanup(sessionId)
  watchTurnCompletionForCleanup(sessionId)
}

/**
 * Keep a session with active foreground/background work alive after the last
 * client leaves, and start the idle grace timer only once all work completes
 * (issue #764). If a client reconnects first, the watcher is torn down.
 */
function watchTurnCompletionForCleanup(sessionId: string): void {
  cancelSessionDisconnectWatcher(sessionId)

  const onComplete = (cliMsg: any) => {
    const cliRunState = trackCliRunState(sessionId, cliMsg)
    const taskLifecycle = trackCliBackgroundTaskLifecycle(sessionId, cliMsg)
    stopLateAgentTaskIfRequested(sessionId, taskLifecycle)
    closeLateNonAgentTaskAfterRuntimeExit(sessionId, taskLifecycle)
    closeStoppedAgentsAfterRuntimeExit(sessionId, cliMsg)
    if (
      (cliRunState === 'running' || taskLifecycle?.running) &&
      !hasActiveClients(sessionId)
    ) {
      // A pending permission uses a hard 30-minute disconnect bound. A late
      // background task may outlive (or never emit) its terminal notification,
      // so it must not turn that bound into an unbounded watcher. Ordinary idle
      // grace timers are still cancelled while observed work is running.
      if (conversationService.getPendingPermissionRequests(sessionId).length === 0) {
        const cleanupTimer = sessionCleanupTimers.get(sessionId)
        if (cleanupTimer) clearTimeout(cleanupTimer)
        sessionCleanupTimers.delete(sessionId)
      }
      return
    }
    if (
      cliMsg?.type === 'control_request' &&
      cliMsg.request?.subtype === 'can_use_tool' &&
      !hasActiveClients(sessionId)
    ) {
      // The permission request may arrive after the renderer disconnected.
      // ConversationService records it before notifying this callback, so the
      // cleanup delay resolves to the bounded pending-permission window.
      scheduleDisconnectCleanup(sessionId)
      return
    }

    const foregroundTurnCompleted = cliMsg?.type === 'result'
    const cliRunCompleted = cliRunState === 'idle'
    const backgroundTaskCompleted = taskLifecycle?.running === false
    if (!foregroundTurnCompleted && !cliRunCompleted && !backgroundTaskCompleted) return
    if (hasActiveCliRun(sessionId)) return
    if (hasActiveBackgroundTasks(sessionId)) return
    if (
      !foregroundTurnCompleted &&
      !cliRunCompleted &&
      hasPendingOrActiveUserTurn(sessionId)
    ) return

    cancelSessionDisconnectWatcher(sessionId)
    // All observed work finished while still disconnected — fall back to the
    // bounded idle timer rather than stopping the CLI immediately.
    if (!hasActiveClients(sessionId)) {
      scheduleDisconnectCleanup(sessionId)
    }
  }

  conversationService.onOutput(sessionId, onComplete)
  sessionDisconnectWatchers.set(sessionId, () => {
    conversationService.removeOutputCallback(sessionId, onComplete)
  })
}

/**
 * Re-arm the disconnect watcher once CLI startup has completed. A client can
 * leave during the startup window, when the user turn is registered but the
 * ConversationService session (and therefore its output callback list) does
 * not exist yet.
 */
function refreshDisconnectedTurnCleanupWatcher(sessionId: string): void {
  if (
    hasActiveClients(sessionId) ||
    !hasActiveSessionWork(sessionId)
  ) return

  const pendingTimer = sessionCleanupTimers.get(sessionId)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    sessionCleanupTimers.delete(sessionId)
  }
  watchTurnCompletionForCleanup(sessionId)
}

/** Remove any pending active-work completion watcher for a session. */
function cancelSessionDisconnectWatcher(sessionId: string): void {
  const remove = sessionDisconnectWatchers.get(sessionId)
  if (remove) {
    remove()
    sessionDisconnectWatchers.delete(sessionId)
  }
}

function replayPendingPermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string[] {
  const requests = conversationService.getPendingPermissionRequests(sessionId)
  for (const request of requests) {
    sendMessage(ws, {
      type: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    })
  }
  return requests.map((request) => request.requestId)
}

function replayPendingComputerUsePermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): string[] {
  const requests = computerUseApprovalService.getPendingRequests(sessionId)
  for (const request of requests) {
    sendMessage(ws, {
      type: 'computer_use_permission_request',
      requestId: request.requestId,
      request,
    })
  }
  return requests.map((request) => request.requestId)
}

function getDesktopSlashCommand(content: string): ReturnType<typeof parseSlashCommand> {
  const parsed = parseSlashCommand(content.trim())
  if (!parsed || parsed.isMcp) return null
  return parsed
}

function getTitleInputForUserMessage(
  content: string,
  command: ReturnType<typeof parseSlashCommand>,
): string | null {
  if (command?.commandName === 'compact') return null
  if (command?.commandName !== 'goal') return content

  const args = command.args.trim()
  if (!args || args === 'clear') return null
  return args
}

export function createCurrentTurnLocalCommandForwarder(
  command: ReturnType<typeof parseSlashCommand>,
): (cliMsg: any) => boolean {
  let awaitingCurrentTurnLocalCommandOutput = false

  return (cliMsg: any) => {
    if (command && isMatchingCurrentTurnLocalCommand(cliMsg, command)) {
      awaitingCurrentTurnLocalCommandOutput = true
      return true
    }
    if (command?.commandName === 'goal' && isLocalCommandOutputMessage(cliMsg)) {
      const output = extractLocalCommandOutput(
        cliMsg.content ?? cliMsg.message,
        { allowUntagged: cliMsg.subtype === 'local_command_output' },
      )
      if (output && looksLikeGoalCommandOutput(output)) {
        awaitingCurrentTurnLocalCommandOutput = false
        return true
      }
    }
    if (
      awaitingCurrentTurnLocalCommandOutput &&
      isLocalCommandOutputMessage(cliMsg)
    ) {
      awaitingCurrentTurnLocalCommandOutput = false
      return true
    }
    return false
  }
}

function isMatchingCurrentTurnLocalCommand(
  cliMsg: any,
  command: NonNullable<ReturnType<typeof parseSlashCommand>>,
): boolean {
  if (cliMsg?.type !== 'system' || cliMsg?.subtype !== 'local_command') {
    return false
  }
  const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
  if (!localCommand) return false
  return (
    localCommand.name === command.commandName &&
    localCommand.args.trim() === command.args.trim()
  )
}

function isLocalCommandOutputMessage(cliMsg: any): boolean {
  if (
    cliMsg?.type !== 'system' ||
    (cliMsg?.subtype !== 'local_command' &&
      cliMsg?.subtype !== 'local_command_output')
  ) {
    return false
  }
  return extractLocalCommandOutput(
    cliMsg.content ?? cliMsg.message,
    { allowUntagged: cliMsg.subtype === 'local_command_output' },
  ) !== null
}












function addActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  let clients = activeSessions.get(sessionId)
  if (!clients) {
    clients = new Set()
    activeSessions.set(sessionId, clients)
  }
  clients.add(ws)
}

function removeActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients?.has(ws)) return false
  clients.delete(ws)
  if (clients.size === 0) {
    activeSessions.delete(sessionId)
  }
  return true
}

function hasActiveClients(sessionId: string): boolean {
  return (activeSessions.get(sessionId)?.size ?? 0) > 0
}

function removeClientOutputCallback(ws: ServerWebSocket<WebSocketData>): void {
  const entry = clientOutputCallbacks.get(ws)
  if (!entry) return
  conversationService.removeOutputCallback(entry.sessionId, entry.callback)
  clientOutputCallbacks.delete(ws)
}


function boundTaskNotificationPersistence(
  persistence: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out saving task notification after ${timeoutMs}ms`))
    }, timeoutMs)
    if (typeof timer === 'object') timer.unref?.()

    persistence.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function persistCliTaskNotification(
  sessionId: string,
  cliMsg: any,
  options?: { propagateFailure?: boolean; timeoutMs?: number },
): Promise<void> | null {
  const notification = normalizeCliTaskNotification(cliMsg)
  if (!notification) return null

  let sessionWrites = taskNotificationPersistence.get(sessionId)
  if (!sessionWrites) {
    sessionWrites = new Map()
    taskNotificationPersistence.set(sessionId, sessionWrites)
  }
  const eventKey = typeof cliMsg.uuid === 'string' && cliMsg.uuid
    ? cliMsg.uuid
    : JSON.stringify(notification)
  const existing = sessionWrites.get(eventKey)
  if (existing) return existing

  const persistence = sessionService.appendSessionTaskNotification(sessionId, notification)
  const boundedPersistence = options?.timeoutMs === undefined
    ? persistence
    : boundTaskNotificationPersistence(persistence, options.timeoutMs)
  const write = boundedPersistence
    .catch((error) => {
      sessionWrites?.delete(eventKey)
      console.warn(
        `[WS] Failed to persist task notification for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      if (options?.propagateFailure) throw error
    })
  sessionWrites.set(eventKey, write)
  return write
}

export const __persistCliTaskNotificationForTests = persistCliTaskNotification

function persistThenForwardCliMessage(
  sessionId: string,
  cliMsg: any,
  forward: () => void,
): void {
  const persistence = persistCliTaskNotification(sessionId, cliMsg)
  if (!persistence) {
    forward()
    return
  }

  void persistence
    .then(forward)
    .catch((error) => {
      console.warn(
        `[WS] Failed to forward persisted task notification for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
}

function forwardCliMessageToClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
  cliMsg: any,
): void {
  handleCliPermissionModeBroadcast(sessionId, cliMsg)
  const serverMsgs = translateCliMessage(cliMsg, sessionId)
  for (const msg of serverMsgs) sendMessage(ws, msg)
}

function forwardCliMessageToSessionClients(sessionId: string, cliMsg: any): void {
  const clients = activeSessions.get(sessionId)
  if (!clients || clients.size === 0) return
  handleCliPermissionModeBroadcast(sessionId, cliMsg)
  const serverMsgs = translateCliMessage(cliMsg, sessionId)
  for (const ws of clients) {
    for (const msg of serverMsgs) sendMessage(ws, msg)
  }
}

function bindAllClientSessionOutputs(
  sessionId: string,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
): void {
  const clients = activeSessions.get(sessionId)
  if (!clients) return
  for (const ws of clients) {
    bindClientSessionOutput(sessionId, ws, options)
  }
}

function bindClientSessionOutput(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
) {
  if (!conversationService.hasSession(sessionId)) return

  removeClientOutputCallback(ws)

  const callback = (cliMsg: any) => {
    consumeInterruptedTurnResult(sessionId, cliMsg)
    acknowledgeActiveTurnReplay(sessionId, cliMsg)
    const transcriptEpoch = sessionTranscriptEpochs.get(sessionId) ?? 0
    trackCliRunState(sessionId, cliMsg)
    const taskLifecycle = trackCliBackgroundTaskLifecycle(sessionId, cliMsg)
    stopLateAgentTaskIfRequested(sessionId, taskLifecycle)
    closeLateNonAgentTaskAfterRuntimeExit(sessionId, taskLifecycle)
    closeStoppedAgentsAfterRuntimeExit(sessionId, cliMsg)
    if (taskLifecycle?.suppressForward) return
    const replacementAwaitingBoundary =
      activeUserTurns.get(sessionId)?.replacementAfterStop === true
    const stoppedTurnTerminalResult =
      cliMsg?.type === 'result' &&
      sessionStopRequested.has(sessionId) &&
      !replacementAwaitingBoundary &&
      !pendingInterruptedTurnResults.has(sessionId)
    if (
      shouldSuppressCliOutputDuringStop(sessionId, cliMsg, taskLifecycle) &&
      !stoppedTurnTerminalResult
    ) {
      // Until the interrupted result and the replacement's own replay establish
      // an ordering boundary, unscoped output may still belong to the old
      // generation. Once that boundary settles, only its terminal result may
      // pass to every renderer. Task lifecycle must pass so Stop can close
      // Agents, and permission resolutions must pass so open prompts can close.
      return
    }
    if (options?.shouldForward && !options.shouldForward(cliMsg)) {
      return
    }

    const cliPermissionMode = getCliPermissionModeBroadcast(cliMsg)
    if (
      cliPermissionMode &&
      conversationService.isPermissionModeChangePending(sessionId, cliPermissionMode)
    ) {
      return
    }

    const forward = () => {
      if ((sessionTranscriptEpochs.get(sessionId) ?? 0) !== transcriptEpoch) return
      if (!activeSessions.get(sessionId)?.has(ws)) return
      forwardCliMessageToClient(sessionId, ws, cliMsg)
    }

    persistThenForwardCliMessage(sessionId, cliMsg, forward)
  }

  clientOutputCallbacks.set(ws, { sessionId, callback })
  conversationService.onOutput(sessionId, callback)
}

function hasStoppedTurnBoundary(sessionId: string): boolean {
  return sessionStopRequested.has(sessionId) ||
    activeUserTurns.get(sessionId)?.replacementAfterStop === true
}

function isAgentRunMessageFrame(cliMsg: any): boolean {
  return cliMsg?.type === 'system' && cliMsg.subtype === 'agent_run_message'
}

function isAgentScopedPermissionRequest(cliMsg: any): boolean {
  return cliMsg?.type === 'control_request' &&
    cliMsg.request?.subtype === 'can_use_tool' &&
    typeof cliMsg.request.agent_id === 'string' &&
    cliMsg.request.agent_id.trim().length > 0
}

function canAcceptPermissionRequestDuringStop(sessionId: string, cliMsg: any): boolean {
  if (hasStoppedTurnBoundary(sessionId)) return false
  if (!agentStopRequestedSessions.has(sessionId)) return true
  return !isAgentScopedPermissionRequest(cliMsg)
}

function shouldSuppressCliOutputDuringStop(
  sessionId: string,
  cliMsg: any,
  taskLifecycle: CliBackgroundTaskLifecycle | null,
): boolean {
  if (taskLifecycle !== null) return false
  if (isAgentRunMessageFrame(cliMsg)) {
    return agentStopRequestedSessions.has(sessionId) && cliMsg.event_kind === 'message'
  }
  if (cliMsg?.type === 'control_cancel_request' || cliMsg?.type === 'control_response') {
    return false
  }
  if (hasStoppedTurnBoundary(sessionId)) return true
  if (!agentStopRequestedSessions.has(sessionId)) return false
  if (cliMsg?.type === 'control_request') {
    return isAgentScopedPermissionRequest(cliMsg)
  }
  if (cliMsg?.type === 'system' && cliMsg.subtype === 'task_progress') {
    const taskId = typeof cliMsg.task_id === 'string' ? cliMsg.task_id.trim() : ''
    return isAgentTaskType(cliMsg.task_type) ||
      Boolean(taskId && activeAgentTasks.get(sessionId)?.has(taskId))
  }
  return true
}

function getCliPermissionModeBroadcast(cliMsg: any): PermissionMode | null {
  if (
    cliMsg?.type === 'system' &&
    cliMsg.subtype === 'status' &&
    isPermissionMode(cliMsg.permissionMode)
  ) {
    return cliMsg.permissionMode
  }
  return null
}

function handleCliPermissionModeBroadcast(sessionId: string, cliMsg: any): void {
  const mode = getCliPermissionModeBroadcast(cliMsg)
  if (!mode) return

  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (currentMode === mode) return

  if (!conversationService.recordSessionPermissionMode(sessionId, mode)) return
  void persistSessionPermissionMode(sessionId, mode).catch((err) => {
    console.warn(`[WS] Failed to persist CLI permission mode broadcast for ${sessionId}:`, err)
  })
}

type RuntimeSettings = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'disabled'
  providerId?: string | null
}

async function getDefaultOpenAIReasoningEffort(modelId: string): Promise<string> {
  const catalog = await getOpenAICodexModelCatalog()
  return getOpenAIModelCatalogEntry(modelId, catalog)?.defaultReasoningEffort ?? 'medium'
}

async function getGrokReasoningEfforts(modelId: string): Promise<{
  modelId: string
  defaultEffort?: string
  supportedEfforts: string[]
}> {
  const tokens = await hahaGrokOAuthService.ensureFreshTokens()
  const catalog = await getGrokModelCatalog({
    ...(tokens?.accessToken ? { accessToken: tokens.accessToken } : {}),
    accountKey: tokens?.email ?? (tokens ? 'authenticated-default' : 'logged-out'),
  })
  const model = catalog.find((entry) => entry.value === modelId)
    ?? catalog.find((entry) => entry.value === GROK_DEFAULT_MAIN_MODEL)
    ?? catalog[0]
  return {
    modelId: model?.value ?? GROK_DEFAULT_MAIN_MODEL,
    ...(model?.reasoningEffort ? { defaultEffort: model.reasoningEffort } : {}),
    supportedEfforts: model?.reasoningEfforts ?? [],
  }
}

async function resolveRuntimeEffort(
  providerId: string | null | undefined,
  modelId: string,
  effort: string,
): Promise<{ valid: boolean; effort?: string }> {
  if (isGrokOfficialProviderId(providerId)) {
    const { supportedEfforts } = await getGrokReasoningEfforts(modelId)
    return supportedEfforts.includes(effort)
      ? { valid: true, effort }
      : { valid: false }
  }
  if (providerId === null || providerId === undefined) {
    return VALID_CLAUDE_EFFORT_LEVELS.has(effort)
      ? { valid: true, effort }
      : { valid: false }
  }
  if (isOpenAIOfficialProviderId(providerId)) {
    if (!isOpenAIReasoningEffort(effort)) {
      return { valid: false }
    }

    const catalog = await getOpenAICodexModelCatalog()
    const model = getOpenAIModelCatalogEntry(modelId, catalog)
    return !model || model.supportedReasoningEfforts.includes(effort)
      ? { valid: true, effort }
      : { valid: false }
  }

  if (!isModelReasoningEffort(effort)) return { valid: false }
  const provider = await providerService.getProvider(providerId).catch(() => null)
  if (!provider) return { valid: false }
  const normalizedEffort = normalizeModelReasoningEffort(
    modelId,
    effort,
    provider.apiFormat ?? 'anthropic',
    getModelReasoningCapabilityOverride(
      modelId,
      provider.models,
      getPresetDefaultEnv(provider.presetId),
    ),
  )
  return {
    valid: true,
    ...(normalizedEffort ? { effort: normalizedEffort } : {}),
  }
}

function isKnownRuntimeProviderId(
  providerId: string,
  providers: Array<{ id: string }>,
): boolean {
  return (
    isOpenAIOfficialProviderId(providerId) ||
    isGrokOfficialProviderId(providerId) ||
    providers.some((provider) => provider.id === providerId)
  )
}

async function getRuntimeSettings(sessionId?: string): Promise<RuntimeSettings> {
  const launchInfo = sessionId
    ? await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
    : null
  const sessionPermissionMode = sessionId
    ? launchInfo?.permissionMode ?? await getSessionPermissionMode(sessionId)
    : undefined
  const persistedRuntimeOverride =
    launchInfo?.runtimeModelId
      ? {
          providerId: launchInfo.runtimeProviderId ?? null,
          modelId: launchInfo.runtimeModelId,
          ...(launchInfo.effortLevel ? { effort: launchInfo.effortLevel } : {}),
        }
      : undefined
  const runtimeOverride = sessionId
    ? runtimeOverrides.get(sessionId) ?? persistedRuntimeOverride
    : undefined
  if (runtimeOverride) {
    if (typeof runtimeOverride.providerId === 'string') {
      const { providers } = await providerService.listProviders()
      const providerExists = isKnownRuntimeProviderId(runtimeOverride.providerId, providers)
      if (!providerExists) {
        console.warn(
          `[WS] Ignoring stale runtime provider id for ${sessionId}: ${runtimeOverride.providerId}`,
        )
        runtimeOverrides.delete(sessionId!)
        const defaults = await getDefaultRuntimeSettings()
        return {
          ...defaults,
          permissionMode: sessionPermissionMode ?? defaults.permissionMode,
        }
      }
    }

    const userSettings = await settingsService.getUserSettings()
    const thinking = resolveDesktopThinkingMode(
      userSettings,
      runtimeOverride.providerId,
    )
    let effort = runtimeOverride.effort
    if (isOpenAIOfficialProviderId(runtimeOverride.providerId)) {
      effort = effort ?? await getDefaultOpenAIReasoningEffort(runtimeOverride.modelId)
    } else if (isGrokOfficialProviderId(runtimeOverride.providerId)) {
      const grokEffort = await getGrokReasoningEfforts(runtimeOverride.modelId)
      runtimeOverride.modelId = grokEffort.modelId
      effort = effort && grokEffort.supportedEfforts.includes(effort)
        ? effort
        : grokEffort.defaultEffort
    } else if (runtimeOverride.providerId === null) {
      runtimeOverride.modelId = await resolveClaudeOfficialRuntimeModel(
        runtimeOverride.modelId,
      ) ?? runtimeOverride.modelId
    }

    return {
      permissionMode: sessionPermissionMode ?? await settingsService.getPermissionMode().catch(() => undefined),
      model: runtimeOverride.modelId,
      effort,
      thinking,
      providerId: runtimeOverride.providerId,
    }
  }

  const defaults = await getDefaultRuntimeSettings()
  return {
    ...defaults,
    permissionMode: sessionPermissionMode ?? defaults.permissionMode,
    effort: launchInfo?.effortLevel ?? defaults.effort,
  }
}

async function getSessionPermissionMode(sessionId: string): Promise<string | undefined> {
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  return launchInfo?.permissionMode
}

async function getDefaultRuntimeSettings(): Promise<RuntimeSettings> {
  // Check if a custom provider is active
  const { providers, activeId } = await providerService.listProviders()
  let resolvedActiveId = activeId
  if (activeId && !isKnownRuntimeProviderId(activeId, providers)) {
    console.warn(`[WS] Active provider id is stale, falling back to official provider: ${activeId}`)
    resolvedActiveId = null
    await providerService.activateOfficial()
  }

  const userSettings = await settingsService.getUserSettings()
  const providerSettings = resolvedActiveId
    ? await providerService.getManagedSettings()
    : undefined
  const modelSettings = providerSettings ?? userSettings
  const modelContext =
    typeof modelSettings.modelContext === 'string' && modelSettings.modelContext.trim()
      ? modelSettings.modelContext
      : undefined
  let effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined
  const thinking = resolveDesktopThinkingMode(userSettings, resolvedActiveId)

  let model: string | undefined
  if (resolvedActiveId) {
    // Provider is active — only consult provider-managed cc-haha settings.
    // Global ~/.claude/settings.json model values must not bleed into provider mode.
    const baseModel =
      typeof modelSettings.model === 'string' && modelSettings.model.trim()
        ? modelSettings.model
        : ''
    if (baseModel) {
      model = baseModel
      if (modelContext) model += `:${modelContext}`
    }
    if (isOpenAIOfficialProviderId(resolvedActiveId)) {
      model = model || OPENAI_DEFAULT_MAIN_MODEL
      effort = await getDefaultOpenAIReasoningEffort(model)
    } else if (isGrokOfficialProviderId(resolvedActiveId)) {
      model = model || GROK_DEFAULT_MAIN_MODEL
      effort = (await getGrokReasoningEfforts(model)).defaultEffort
    }
  } else {
    // Claude Official is represented by a null provider id. Only a valid
    // desktop-managed Claude OAuth token activates the subscription-aware
    // resolver; API-key/PAYG and original third-party settings keep the old path.
    const baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    const claudeOfficialModel = await resolveClaudeOfficialRuntimeModel(baseModel)
    model = claudeOfficialModel
      ?? (baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined)
  }

  return {
    permissionMode: await settingsService.getPermissionMode().catch(() => undefined),
    model,
    effort,
    thinking,
    providerId: resolvedActiveId,
  }
}

function resolveDesktopThinkingMode(
  settings: Record<string, unknown>,
  providerId?: string | null,
): 'disabled' | undefined {
  if (isOpenAIOfficialProviderId(providerId)) return undefined
  return settings.alwaysThinkingEnabled === false ? 'disabled' : undefined
}

async function buildSessionStartupDiagnosticMessage(
  sessionId: string,
  cause: string,
): Promise<string> {
  const lines = [
    cause,
    '',
    'Desktop service diagnostics:',
    `- sessionId: ${sessionId}`,
  ]

  try {
    const recentWorkDir = lastResolvedStartupWorkDirs.get(sessionId)
    const workDir =
      recentWorkDir ||
      conversationService.getSessionWorkDir(sessionId) ||
      await sessionService.getSessionWorkDir(sessionId)
    lines.push(`- workDir: ${workDir ?? '(unknown)'}`)
  } catch (err) {
    lines.push(`- workDir: failed to resolve (${err instanceof Error ? err.message : String(err)})`)
  }

  const runtimeOverride = runtimeOverrides.get(sessionId)
  if (runtimeOverride) {
    lines.push(`- runtimeOverride.providerId: ${runtimeOverride.providerId ?? '(official)'}`)
    lines.push(`- runtimeOverride.modelId: ${runtimeOverride.modelId}`)
    lines.push(`- runtimeOverride.effort: ${runtimeOverride.effort ?? '(auto)'}`)
  } else {
    lines.push('- runtimeOverride: (none)')
  }

  try {
    const { providers, activeId } = await providerService.listProviders()
    lines.push(`- activeProviderId: ${activeId ?? '(official)'}`)
    lines.push(`- configuredProviders: ${providers.length}`)
    if (providers.length > 0) {
      lines.push(
        `- providerIndex: ${providers
          .map((provider) => `${provider.name} (${provider.id})`)
          .join(', ')}`,
      )
    }
  } catch (err) {
    lines.push(`- providers: failed to read (${err instanceof Error ? err.message : String(err)})`)
  }

  return lines.join('\n')
}

function enqueueRuntimeTransition(
  sessionId: string,
  transition: () => Promise<void>,
): Promise<void> {
  const previous = runtimeTransitionPromises.get(sessionId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(transition)
    .finally(() => {
      if (runtimeTransitionPromises.get(sessionId) === next) {
        runtimeTransitionPromises.delete(sessionId)
      }
    })
  runtimeTransitionPromises.set(sessionId, next)
  return next
}

async function waitForRuntimeTransitionBeforeUserTurn(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<{ ok: boolean; waited: boolean }> {
  let waited = false
  let pendingRuntimeTransition = runtimeTransitionPromises.get(sessionId)
  while (pendingRuntimeTransition) {
    waited = true
    try {
      await pendingRuntimeTransition
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      void diagnosticsService.recordEvent({
        type: 'runtime_transition_failed',
        severity: 'error',
        sessionId,
        summary: errMsg,
        details: err,
      })
      console.error(`[WS] Runtime transition failed before handling user message for ${sessionId}: ${errMsg}`)
      sendMessage(ws, {
        type: 'error',
        message: `Failed to switch provider/model: ${errMsg}`,
        code: 'CLI_RESTART_FAILED',
      })
      sendMessage(ws, { type: 'status', state: 'idle' })
      failSessionChatActivity(sessionId)
      return { ok: false, waited }
    }

    const nextTransition = runtimeTransitionPromises.get(sessionId)
    pendingRuntimeTransition =
      nextTransition && nextTransition !== pendingRuntimeTransition
        ? nextTransition
        : undefined
  }

  return { ok: true, waited }
}

/**
 * Send a message to a specific session's WebSocket (for use by services)
 */
export function sendToSession(sessionId: string, message: ServerMessage): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients || clients.size === 0) return false
  for (const ws of clients) {
    sendMessage(ws, message)
  }
  return true
}

export function updateSessionSlashCommands(
  sessionId: string,
  commands: unknown[],
  options: { notifyClient?: boolean } = {},
): SessionSlashCommand[] {
  const normalized = commands
    .map(normalizeSessionSlashCommand)
    .filter((command): command is SessionSlashCommand => command !== null)

  sessionSlashCommands.set(sessionId, normalized)

  if (options.notifyClient !== false) {
    sendToSession(sessionId, {
      type: 'system_notification',
      subtype: 'slash_commands',
      data: normalized,
    })
  }

  return normalized
}

function normalizeSessionSlashCommand(command: unknown): SessionSlashCommand | null {
  if (typeof command === 'string') {
    return command.trim() ? { name: command, description: '' } : null
  }
  if (!command || typeof command !== 'object') return null

  const record = command as {
    name?: unknown
    command?: unknown
    description?: unknown
    argumentHint?: unknown
  }
  const name =
    typeof record.name === 'string'
      ? record.name
      : typeof record.command === 'string'
        ? record.command
        : ''
  if (!name.trim()) return null

  return {
    name,
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.argumentHint === 'string' ? { argumentHint: record.argumentHint } : {}),
  }
}

export function closeSessionConnection(sessionId: string, reason = 'session closed'): boolean {
  const cleanupTimer = sessionCleanupTimers.get(sessionId)
  if (cleanupTimer) {
    clearTimeout(cleanupTimer)
    sessionCleanupTimers.delete(sessionId)
  }
  computerUseApprovalService.cancelSession(sessionId)
  conversationService.clearOutputCallbacks(sessionId)
  cleanupSessionRuntimeState(sessionId)

  const clients = activeSessions.get(sessionId)
  if (!clients || clients.size === 0) return false

  activeSessions.delete(sessionId)
  for (const ws of clients) {
    if (activePetClient === ws) activePetClient = null
    clientOutputCallbacks.delete(ws)
    ws.close(1000, reason)
  }
  return true
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeSessions.keys())
}

export function __resetWebSocketHandlerStateForTests(): void {
  for (const timer of sessionCleanupTimers.values()) clearTimeout(timer)
  for (const timer of prewarmIdleTimers.values()) clearTimeout(timer)
  for (const remove of sessionDisconnectWatchers.values()) remove()
  for (const tasks of activeAgentTasks.values()) {
    for (const task of tasks.values()) clearAgentStopFinalizationRetry(task)
  }
  activeSessions.clear()
  activePetClient = null
  clientOutputCallbacks.clear()
  taskNotificationPersistence.clear()
  sessionTranscriptEpochs.clear()
  sessionCleanupTimers.clear()
  sessionDisconnectWatchers.clear()
  prewarmPendingSessions.clear()
  prewarmedSessions.clear()
  prewarmIdleTimers.clear()
  activeUserTurns.clear()
  activeCliRuns.clear()
  activeBackgroundTaskIds.clear()
  activeAgentTasks.clear()
  activeNonAgentTasks.clear()
  authoritativeStoppedTaskIds.clear()
  agentStopRequestedSessions.clear()
  runtimeExitStoppedSessions.clear()
  pendingInterruptedTurnResults.clear()
  sessionClearInProgress.clear()
  sessionStopRequested.clear()
  terminalSessionChatStates.clear()
  legacyQueuedSessionChats.clear()
  interruptedSessionChats.clear()
  runtimeTransitionPromises.clear()
  sessionStartupPromises.clear()
}

export function __markPrewarmPendingForTests(sessionId: string): void {
  prewarmPendingSessions.add(sessionId)
}

/** Test hook: mark a session as mid-turn so disconnect keeps the CLI alive. */
export function __markActiveTurnForTests(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  activeUserTurns.set(sessionId, { messageSent: true })
}

/**
 * Test hook: register a user turn still in the pre-send (messageSent:false)
 * window — i.e. the CLI-startup window before messageSent becomes true.
 */
export function __registerPendingUserTurnForTests(sessionId: string): void {
  beginSessionChatActivity(sessionId)
  activeUserTurns.set(sessionId, { messageSent: false })
}

/** Test hook: hold user admission in the shared CLI-startup seam. */
export function __registerPendingSessionStartupForTests(
  sessionId: string,
  startup: Promise<void>,
): void {
  sessionStartupPromises.set(sessionId, startup)
  const clearStartup = () => {
    if (sessionStartupPromises.get(sessionId) === startup) {
      sessionStartupPromises.delete(sessionId)
    }
  }
  void startup.then(clearStartup, clearStartup)
}

/** Test hook: put a deterministic barrier ahead of user/clear admission. */
export function __enqueueRuntimeTransitionForTests(
  sessionId: string,
  transition: Promise<void>,
): Promise<void> {
  return enqueueRuntimeTransition(sessionId, () => transition)
}

export function __resolveRuntimeRestartWorkDirForTests(sessionId: string): Promise<string> {
  return resolveRuntimeRestartWorkDir(sessionId)
}

/** Test hook: settle a registered turn through the same CLI-result seam. */
export function __settleActiveTurnForTests(sessionId: string, cliMsg: any): void {
  settleSessionChatActivity(sessionId, cliMsg)
  activeUserTurns.delete(sessionId)
}

/** Test hook: simulate CLI startup completing after the last client left. */
export function __refreshDisconnectedTurnCleanupWatcherForTests(sessionId: string): void {
  refreshDisconnectedTurnCleanupWatcher(sessionId)
}

/** Test hook: arm the prewarm idle timer for a session, as markPrewarmed does. */
export function __markPrewarmedForTests(sessionId: string): void {
  markPrewarmed(sessionId)
}
