/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage } from './events.js'
import * as os from 'node:os'
import {
  ConversationStartupError,
  conversationService,
} from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import {
  formatHandoffSystemPrompt,
  getCachedSessionSummary,
  rebuildRecentRawForHandoff,
} from '../services/sessionSummaryService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { isOpenAIOfficialProviderId } from '../services/openaiOfficialProvider.js'
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
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { shouldCreateWorktreeForSessionLaunch } from '../services/repositoryLaunchService.js'

const settingsService = new SettingsService()
const providerService = new ProviderService()

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
const CLIENT_DISCONNECT_CLEANUP_MS = 30_000
const PENDING_PERMISSION_DISCONNECT_CLEANUP_MS = 30 * 60_000
const sessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Track sessions where user requested stop — suppress the CLI_ERROR that
 * follows an interrupt so the frontend doesn't show "处理过程中发生错误".
 */
const sessionStopRequested = new Set<string>()

/**
 * Track user message count and title state per session for auto-title generation.
 */
const sessionTitleState = new Map<string, {
  userMessageCount: number
  hasCustomTitle: boolean
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
  thinkingEnabled?: boolean
}

type ActiveUserTurnState = {
  messageSent: boolean
}

const runtimeOverrides = new Map<string, RuntimeOverride>()
const activeUserTurns = new Map<string, ActiveUserTurnState>()
const deferredRuntimeRestarts = new Map<string, RuntimeOverride>()
const deferredPermissionModes = new Map<string, string>()

// Per-session orchestration ("协调") mode. In-memory only: a transient session
// preference, not persisted across app restart / resume (v1). Read by
// getRuntimeSettings and threaded into the CLI as --append-system-prompt.
const coordinatorModeSessions = new Set<string>()

// Per-session Solo Pipeline mode. Same semantics as coordinatorModeSessions but
// drives a different prompt: a 5-stage solo-agent pipeline (planner → builder →
// tester → reviewer → integrator) instead of the multi-worker coordinator
// directive. Mutually exclusive with coordinator mode at the WS handler level
// (handleSetPipelineMode clears the coordinator flag, and vice versa) so the
// CLI subprocess never sees both --append-system-prompt addenda at once.
const soloPipelineModeSessions = new Set<string>()

// Per-session pending hand-off summary text. When set, the next CLI launch
// (or restart) appends this text via --append-system-prompt so the new
// session starts with context from the user's previous session in this
// project. In-memory only — applied once at startup. The cleanup-on-stop
// path drops it so a later restart for unrelated reasons doesn't re-attach.
const handoffSummarySessions = new Map<string, string>()

const runtimeTransitionPromises = new Map<string, Promise<void>>()
const sessionStartupPromises = new Map<string, Promise<void>>()
const runtimeOverrideVersions = new Map<string, number>()
const sessionStartupRuntimeVersions = new Map<string, number>()
const lastResolvedStartupWorkDirs = new Map<string, string>()
const prewarmPendingSessions = new Set<string>()
const prewarmedSessions = new Set<string>()
const prewarmIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEFAULT_PREWARM_IDLE_TIMEOUT_MS = 5 * 60_000
const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])

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

export type WebSocketData = {
  sessionId: string
  connectedAt: number
  channel: 'client' | 'sdk'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket clients, grouped by session. Desktop, H5, and IM adapters can
// legitimately watch the same running session at the same time.
const activeSessions = new Map<string, Set<ServerWebSocket<WebSocketData>>>()
const clientOutputCallbacks = new Map<
  ServerWebSocket<WebSocketData>,
  {
    sessionId: string
    callback: (cliMsg: any) => void
  }
>()

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

    console.log(`[WS] Client connected for session: ${sessionId}`)

    // Cancel pending cleanup timer if client reconnects
    const pendingTimer = sessionCleanupTimers.get(sessionId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      sessionCleanupTimers.delete(sessionId)
    }

    addActiveClient(sessionId, ws)
    if (prewarmPendingSessions.has(sessionId) || prewarmedSessions.has(sessionId)) {
      bindPrewarmMetadataCapture(sessionId)
    } else {
      bindClientSessionOutput(sessionId, ws)
    }

    const msg: ServerMessage = { type: 'connected', sessionId }
    ws.send(JSON.stringify(msg))
    replayPendingPermissionRequests(ws, sessionId)
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(ws.data.sessionId, payload)
      return
    }

    try {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as ClientMessage

      switch (message.type) {
        case 'user_message':
          handleUserMessage(ws, message).catch((err) => {
            void diagnosticsService.recordEvent({
              type: 'ws_user_message_failed',
              severity: 'error',
              sessionId: ws.data.sessionId,
              summary: err instanceof Error ? err.message : String(err),
              details: err,
            })
            console.error(`[WS] Unhandled error in handleUserMessage:`, err)
          })
          break

        case 'permission_response':
          handlePermissionResponse(ws, message)
          break

        case 'computer_use_permission_response':
          handleComputerUsePermissionResponse(ws, message)
          break

        case 'set_permission_mode':
          void handleSetPermissionMode(ws, message)
          break

        case 'set_coordinator_mode':
          void handleSetCoordinatorMode(ws, message)
          break

        case 'set_pipeline_mode':
          void handleSetPipelineMode(ws, message)
          break

        case 'set_handoff_summary':
          void handleSetHandoffSummary(ws, message)
          break

        case 'set_runtime_config':
          void handleSetRuntimeConfig(ws, message)
          break

        case 'prewarm_session':
          void handlePrewarmSession(ws)
          break

        case 'stop_generation':
          handleStopGeneration(ws)
          break

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage))
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
      conversationService.detachSdkConnection(sessionId)
      return
    }

    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    if (!removeActiveClient(sessionId, ws)) {
      console.log(`[WS] Ignoring stale client disconnect for session: ${sessionId}`)
      return
    }
    removeClientOutputCallback(ws)

    if (hasActiveClients(sessionId)) {
      return
    }

    computerUseApprovalService.cancelSession(sessionId)

    // Schedule delayed cleanup. Sessions waiting on user input need a longer
    // grace period so transient renderer disconnects do not abort the prompt.
    const cleanupDelayMs = getDisconnectCleanupDelayMs(sessionId)
    const cleanupTimer = setTimeout(() => {
      sessionCleanupTimers.delete(sessionId)
      if (!hasActiveClients(sessionId)) {
        console.log(`[WS] Session ${sessionId} not reconnected after ${cleanupDelayMs}ms, stopping CLI subprocess`)
        conversationService.stopSession(sessionId)
        cleanupSessionRuntimeState(sessionId)
      }
    }, cleanupDelayMs)
    sessionCleanupTimers.set(sessionId, cleanupTimer)
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
  message: Extract<ClientMessage, { type: 'user_message' }>
) {
  const { sessionId } = ws.data

  // Clear any stale stop flag from a previous turn
  sessionStopRequested.delete(sessionId)
  clearPrewarmState(sessionId)

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

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  const activeTurn: ActiveUserTurnState = { messageSent: false }
  activeUserTurns.set(sessionId, activeTurn)

  const initialRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (!initialRuntimeTransition.ok) {
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }
  if (initialRuntimeTransition.waited) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })
  }

  // Track and emit the first placeholder title before CLI startup/streaming.
  let titleState = sessionTitleState.get(sessionId)
  if (!titleState) {
    titleState = {
      userMessageCount: 0,
      hasCustomTitle: !!(await sessionService.getCustomTitle(sessionId)),
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
    const errMsg = err instanceof Error ? err.message : String(err)
    const code =
      err instanceof ConversationStartupError ? err.code : 'CLI_START_FAILED'
    console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: await buildSessionStartupDiagnosticMessage(sessionId, errMsg),
      code,
      retryable:
        err instanceof ConversationStartupError ? err.retryable : false,
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }

  const startupRuntimeTransition = await waitForRuntimeTransitionBeforeUserTurn(ws, sessionId)
  if (startupRuntimeTransition.ok) {
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
    : bindTitleSessionOutput(ws, sessionId, () => userMessageSent)

  bindAllClientSessionOutputs(sessionId, {
    shouldForward: (cliMsg) => {
      if (userMessageSent || (cliMsg.type === 'result' && cliMsg.is_error)) {
        return true
      }
      return shouldForwardCurrentTurnLocalCommand(cliMsg)
    },
  })
  const removeActiveTurnOutputCallback = bindActiveUserTurnCompletion(ws, sessionId, activeTurn)

  const sent = await conversationService.sendMessage(
    sessionId,
    message.content,
    message.attachments
  )
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

function bindActiveUserTurnCompletion(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  activeTurn: ActiveUserTurnState,
): () => void {
  const callback = (cliMsg: any) => {
    if (!activeTurn.messageSent || cliMsg?.type !== 'result') return

    conversationService.removeOutputCallback(sessionId, callback)
    clearActiveUserTurn(sessionId, activeTurn)
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
  const { sessionId } = ws.data

  const workDir = conversationService.getSessionWorkDir(sessionId)
  conversationService.stopSession(sessionId)
  conversationService.clearOutputCallbacks(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  cleanupStreamState(sessionId)

  try {
    await sessionService.clearSessionTranscript(sessionId, workDir || undefined)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    sendMessage(ws, {
      type: 'error',
      message: errMsg,
      code: 'SESSION_CLEAR_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  sendMessage(ws, {
    type: 'system_notification',
    subtype: 'session_cleared',
    message: 'Conversation cleared',
  })
  sendMessage(ws, {
    type: 'message_complete',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
}

async function handlePrewarmSession(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  if (conversationService.hasSession(sessionId) || sessionStartupPromises.has(sessionId)) {
    return
  }

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  if (launchInfo?.repository) {
    console.log(`[WS] Skipping prewarm for pending repository launch session ${sessionId}`)
    return
  }

  prewarmPendingSessions.add(sessionId)
  void ensureCliSessionStarted(ws, sessionId, 'prewarm_session')
    .then(() => {
      if (!prewarmPendingSessions.delete(sessionId)) return
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
  conversationService.respondToPermission(
    sessionId,
    message.requestId,
    message.allowed,
    message.rule,
    message.updatedInput,
  )
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
  }
}

async function handleSetPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_permission_mode' }>
): Promise<void> {
  const { sessionId } = ws.data
  const pendingStartup = sessionStartupPromises.get(sessionId)

  if (pendingStartup) {
    await persistSessionPermissionMode(sessionId, message.mode)
    await enqueueRuntimeTransition(sessionId, async () => {
      await pendingStartup.catch(() => undefined)
      if (!conversationService.hasSession(sessionId)) return
      await applyPermissionModeToActiveSession(ws, sessionId, message.mode)
    })
    return
  }

  if (!conversationService.hasSession(sessionId)) {
    await persistSessionPermissionMode(sessionId, message.mode)
    return
  }

  await applyPermissionModeToActiveSession(ws, sessionId, message.mode)
}

/**
 * 决定一次权限模式切换是否需要重启 CLI 子进程。
 *
 * 只有"进入 bypassPermissions"才需要重启：CLI 必须带 --dangerously-skip-permissions
 * 启动，否则运行时的 set_permission_mode → bypassPermissions 会被拒绝，所以重启子进程
 * 带上该 flag。
 *
 * 反过来"从 bypassPermissions 切到更严格的模式"**不要**重启：此时进程已带 flag，运行时
 * 降级即可。更关键的是——重启会把进程内的 prePlanMode 记忆冲掉：若 bypass→plan 走重启，
 * 新 CLI 直接以 plan 启动、prePlanMode 为空，ExitPlanMode 只能恢复成 default 而非进入前的
 * bypassPermissions。保持进程不变、走 setPermissionMode 做进程内 transition，CLI 才会像 TUI
 * 一样栈存 prePlanMode='bypassPermissions'，退出 plan 时正确恢复 bypass。
 */
export function shouldRestartForPermissionMode(
  currentMode: string,
  mode: string,
): boolean {
  if (currentMode === mode) return false
  return mode === 'bypassPermissions'
}

async function applyPermissionModeToActiveSession(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: string,
): Promise<void> {
  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (shouldDeferRuntimeRestartForActiveTurn(sessionId)) {
    deferredPermissionModes.set(sessionId, mode)
    await persistSessionPermissionMode(sessionId, mode)
    return
  }

  if (currentMode === mode) return
  const needsRestart = shouldRestartForPermissionMode(currentMode, mode)

  if (needsRestart) {
    void enqueueRuntimeTransition(sessionId, () =>
      restartSessionWithPermissionMode(ws, sessionId, mode),
    )
    return
  }

  const ok = conversationService.setPermissionMode(sessionId, mode)
  if (!ok) {
    console.warn(`[WS] Ignored permission mode update for inactive session ${sessionId}`)
    return
  }
  await persistSessionPermissionMode(sessionId, mode)
}

async function handleSetCoordinatorMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_coordinator_mode' }>,
): Promise<void> {
  const { sessionId } = ws.data
  const enabled = message.enabled === true
  const was = coordinatorModeSessions.has(sessionId)
  if (was === enabled) return

  if (enabled) coordinatorModeSessions.add(sessionId)
  else coordinatorModeSessions.delete(sessionId)

  // Orchestration mode is applied via --append-system-prompt at CLI launch, so
  // an active session must restart to pick up (or drop) the directive. Defer
  // until idle so we never interrupt an in-progress turn; reuses the same
  // restart path as runtime-config changes (which re-reads getRuntimeSettings).
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await enqueueRuntimeTransition(sessionId, async () => {
      await pendingStartup.catch(() => undefined)
      if (!conversationService.hasSession(sessionId)) return
      await scheduleRestartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  if (!conversationService.hasSession(sessionId)) {
    // No live process yet — the flag is recorded and applied on next start.
    return
  }

  await enqueueRuntimeTransition(sessionId, () =>
    scheduleRestartSessionWithRuntimeConfig(ws, sessionId),
  )
}

/**
 * Solo Pipeline mode toggle. Sibling of `handleSetCoordinatorMode` —
 * the two modes are mutually exclusive (enabling Solo clears the
 * coordinator flag for the same session), so a single CLI subprocess
 * launches with at most one mode-specific `--append-system-prompt`.
 *
 * `flavor: 'solo'` enables the Solo pipeline; `flavor: 'normal'` clears
 * it. Like coordinator mode, this is an in-memory per-session preference
 * applied at next CLI launch (or via deferred restart of an active
 * session).
 */
async function handleSetPipelineMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_pipeline_mode' }>,
): Promise<void> {
  const { sessionId } = ws.data
  const enabled = message.flavor === 'solo'
  const was = soloPipelineModeSessions.has(sessionId)
  // Mutual exclusion: enabling Solo clears any coordinator flag for the
  // same session. The two modes ship different system-prompt addenda and
  // assume distinct top-of-loop semantics; running them simultaneously
  // would feed contradictory directives to the same CLI subprocess.
  const willClearCoordinator =
    enabled && coordinatorModeSessions.has(sessionId)
  if (was === enabled && !willClearCoordinator) return

  if (enabled) {
    soloPipelineModeSessions.add(sessionId)
    coordinatorModeSessions.delete(sessionId)
  } else {
    soloPipelineModeSessions.delete(sessionId)
  }

  // Same restart geometry as handleSetCoordinatorMode — the addendum is
  // applied via --append-system-prompt at CLI launch, so an active session
  // must restart to pick up (or drop) the directive. Defer until idle so
  // we never interrupt an in-progress turn.
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await enqueueRuntimeTransition(sessionId, async () => {
      await pendingStartup.catch(() => undefined)
      if (!conversationService.hasSession(sessionId)) return
      await scheduleRestartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  if (!conversationService.hasSession(sessionId)) {
    // No live process yet — the flag is recorded and applied on next start.
    return
  }

  await enqueueRuntimeTransition(sessionId, () =>
    scheduleRestartSessionWithRuntimeConfig(ws, sessionId),
  )
}

/**
 * Stage a hand-off summary from the user's previous session as the system
 * prompt addendum on this session's CLI launch. Frontend dispatches this
 * before the first user message after clicking "Continue from here".
 *
 * Cache-only: the frontend's "Continue from here" path always calls the
 * HTTP `POST /api/sessions/:id/summary` endpoint first (which performs
 * the LLM call if needed), and ONLY dispatches this WS message after the
 * HTTP returned a successful summary. So we should always find a cached
 * summary on disk here. If we somehow don't, fail fast and silently — the
 * frontend has already committed to its auto-handoff path; injecting a
 * silent retry through the LLM here would block the WS handler for tens
 * of seconds and double-charge the user. Better to leave the new session
 * without hand-off context (the trigger message will simply read as a
 * normal "continue" prompt with no system-prompt addendum) than to hang.
 */
async function handleSetHandoffSummary(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_handoff_summary' }>,
): Promise<void> {
  const { sessionId } = ws.data
  const previousSessionId = message.previousSessionId
  if (!previousSessionId || previousSessionId === sessionId) return

  let summaryText: string | undefined
  try {
    const summary = await getCachedSessionSummary(previousSessionId)
    if (summary) {
      // Deep handoff: rebuild the verbatim tail with enlarged sizing
      // (~12k tokens vs ~4k default) from the live JSONL. Keeps the
      // cached LLM-generated main/recent so there's no extra LLM cost —
      // we only enlarge the verbatim slice, which is pure text slicing.
      let formattedSummary = summary
      if (message.deep === true) {
        const deepRaw = await rebuildRecentRawForHandoff(previousSessionId)
        if (deepRaw) {
          formattedSummary = { ...summary, recentRaw: deepRaw }
        }
      }
      summaryText = formatHandoffSystemPrompt(formattedSummary)
    } else {
      console.warn(
        `[WS] Hand-off staging: no cached summary for ${previousSessionId}; ` +
          `the frontend should have generated it via HTTP before sending this WS message. ` +
          `Skipping system-prompt staging — the new session will start without hand-off context.`,
      )
    }
  } catch (error) {
    console.warn(
      `[WS] Hand-off summary read failed for ${previousSessionId}; continuing without context. Error:`,
      error,
    )
  }

  if (!summaryText) return

  // Stash it. The next CLI launch / restart will append it via
  // --append-system-prompt. Restart only if a CLI is already live for this
  // session (otherwise it'll be picked up on the upcoming first start).
  handoffSummarySessions.set(sessionId, summaryText)

  if (!conversationService.hasSession(sessionId)) return
  await enqueueRuntimeTransition(sessionId, () =>
    scheduleRestartSessionWithRuntimeConfig(ws, sessionId),
  )
}

async function handleSetRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_runtime_config' }>
) {
  const { sessionId } = ws.data
  const modelId = typeof message.modelId === 'string' ? message.modelId.trim() : ''
  if (!modelId) {
    sendMessage(ws, {
      type: 'error',
      message: 'Runtime model selection is invalid.',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    return
  }
  const effortLevel =
    typeof message.effortLevel === 'string' ? message.effortLevel.trim() : undefined
  if (effortLevel !== undefined && !VALID_EFFORT_LEVELS.has(effortLevel)) {
    sendMessage(ws, {
      type: 'error',
      message: 'Runtime effort selection is invalid.',
      code: 'RUNTIME_CONFIG_INVALID',
    })
    return
  }
  // Per-session thinking override. `undefined` means "inherit from global user setting"
  // (which `resolveDesktopThinkingMode` reads in getRuntimeSettings); a concrete boolean
  // wins over the global toggle.
  const thinkingEnabled =
    typeof message.thinkingEnabled === 'boolean' ? message.thinkingEnabled : undefined

  const nextOverride = {
    providerId: message.providerId ?? null,
    modelId,
    ...(effortLevel ? { effort: effortLevel } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
  }
  const prevOverride = runtimeOverrides.get(sessionId)
  if (
    prevOverride &&
    prevOverride.providerId === nextOverride.providerId &&
    prevOverride.modelId === nextOverride.modelId &&
    prevOverride.effort === nextOverride.effort &&
    prevOverride.thinkingEnabled === nextOverride.thinkingEnabled
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
    await enqueueRuntimeTransition(sessionId, async () => {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await scheduleRestartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    const startupRuntimeVersion = sessionStartupRuntimeVersions.get(sessionId) ?? 0
    const currentRuntimeVersion = runtimeOverrideVersions.get(sessionId) ?? 0
    if (startupRuntimeVersion >= currentRuntimeVersion) {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      return
    }

    await enqueueRuntimeTransition(sessionId, async () => {
      await persistSessionRuntimeConfig(sessionId, nextOverride)
      await pendingStartup.catch(() => undefined)
      const currentOverride = runtimeOverrides.get(sessionId)
      if (
        currentOverride?.providerId !== nextOverride.providerId ||
        currentOverride.modelId !== nextOverride.modelId ||
        currentOverride.effort !== nextOverride.effort ||
        currentOverride.thinkingEnabled !== nextOverride.thinkingEnabled ||
        !conversationService.hasSession(sessionId)
      ) {
        return
      }
      await scheduleRestartSessionWithRuntimeConfig(ws, sessionId)
    })
    return
  }

  await persistSessionRuntimeConfig(sessionId, nextOverride)
}

async function restartSessionWithPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: string,
): Promise<void> {
  try {
    const workDir = conversationService.getSessionWorkDir(sessionId)
    await persistSessionPermissionMode(sessionId, mode, workDir)
    conversationService.stopSession(sessionId)

    // Rebuild runtime settings (will pick up the session-scoped mode)
    const runtimeSettings = await getRuntimeSettings(sessionId)
    const sdkUrl =
      `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
      `?token=${encodeURIComponent(crypto.randomUUID())}`
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)

    sendMessage(ws, { type: 'status', state: 'idle' })
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

async function persistSessionPermissionMode(
  sessionId: string,
  mode: string,
  knownWorkDir?: string | null,
): Promise<void> {
  const workDir =
    knownWorkDir ||
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    permissionMode: mode,
  })
}

async function persistSessionRuntimeConfig(
  sessionId: string,
  runtime: { providerId: string | null; modelId: string; effort?: string; thinkingEnabled?: boolean },
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
    ...(runtime.thinkingEnabled !== undefined ? { thinkingEnabled: runtime.thinkingEnabled } : {}),
  })
}

async function restartSessionWithRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  try {
    const workDir = conversationService.getSessionWorkDir(sessionId)
    conversationService.stopSession(sessionId)

    const runtimeSettings = await getRuntimeSettings(sessionId)
    const sdkUrl =
      `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
      `?token=${encodeURIComponent(crypto.randomUUID())}`
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)

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
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  sessionStopRequested.add(sessionId)

  if (conversationService.hasSession(sessionId)) {
    // First try graceful interrupt via SDK control message
    conversationService.sendInterrupt(sessionId)

    // Force-kill if still running after 3 seconds. Capture the exact process
    // instance now: if the user switches provider/model in the meantime, the
    // restart replaces this process with a new one, and we must not kill that
    // new process during its startup (which would surface as "CLI exited
    // during startup with code 143").
    const instanceId = conversationService.getActiveInstanceId(sessionId)
    if (instanceId) {
      setTimeout(() => {
        if (conversationService.stopSessionInstance(sessionId, instanceId)) {
          console.log(`[WS] Force-killing CLI subprocess for session: ${sessionId}`)
        }
      }, 3_000)
    }
  }

  sendMessage(ws, { type: 'status', state: 'idle' })
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
  if (!state || state.hasCustomTitle) return

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
  shouldProcess: () => boolean,
): () => void {
  const callback = (cliMsg: any) => {
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

function extractAssistantStreamTextForTitle(cliMsg: any): string | null {
  const event = cliMsg?.event
  if (
    cliMsg?.type !== 'stream_event' ||
    event?.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    typeof event.delta.text !== 'string'
  ) {
    return null
  }
  return event.delta.text
}

function extractAssistantMessageTextForTitle(cliMsg: any): string | null {
  if (cliMsg?.type !== 'assistant') return null
  const content = cliMsg.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const typedBlock = block as { type?: unknown; text?: unknown }
      return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
        ? [typedBlock.text]
        : []
    })
    .join('\n')
    .trim()
  return text || null
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

/**
 * Per-session streaming state to avoid cross-session interference.
 * Each session tracks its own dedup flag, active block types, and tool blocks.
 */
type SessionStreamState = {
  hasReceivedStreamEvents: boolean
  activeBlockTypes: Map<number, 'text' | 'tool_use' | 'thinking'>
  activeToolBlocks: Map<number, { toolName: string; toolUseId: string; inputJson: string; parentToolUseId?: string }>
  pendingLocalCommand?: { name: string; args: string }
  /** Tool blocks whose input JSON failed to parse in content_block_stop.
   *  The assistant message carries the complete input — defer to that. */
  pendingToolBlocks: Map<string, { toolName: string; toolUseId: string; parentToolUseId?: string }>
  toolParentUseIds: Map<string, string>
  lastApiError?: {
    message: string
    code: string
  }
}

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      hasReceivedStreamEvents: false,
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

function cliParentToolUseId(cliMsg: any): string | undefined {
  return typeof cliMsg.parent_tool_use_id === 'string' && cliMsg.parent_tool_use_id.length > 0
    ? cliMsg.parent_tool_use_id
    : undefined
}

function rememberToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  streamState.toolParentUseIds.set(toolUseId, parentToolUseId)
}

function consumeToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined
  const parentToolUseId = streamState.toolParentUseIds.get(toolUseId)
  streamState.toolParentUseIds.delete(toolUseId)
  return parentToolUseId
}

/** Clean up stream state when session disconnects */
function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
}

function cleanupSessionRuntimeState(sessionId: string) {
  cleanupStreamState(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  runtimeOverrides.delete(sessionId)
  coordinatorModeSessions.delete(sessionId)
  soloPipelineModeSessions.delete(sessionId)
  handoffSummarySessions.delete(sessionId)
  activeUserTurns.delete(sessionId)
  deferredRuntimeRestarts.delete(sessionId)
  deferredPermissionModes.delete(sessionId)
  runtimeTransitionPromises.delete(sessionId)
  sessionStartupPromises.delete(sessionId)
  lastResolvedStartupWorkDirs.delete(sessionId)
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

function extractAssistantText(cliMsg: any): string {
  const content = cliMsg?.message?.content
  if (!Array.isArray(content)) return ''
  const textBlock = content.find(
    (block: unknown): block is { type: string; text: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return textBlock?.text || ''
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeAskUserQuestionToolResult(content: unknown, toolUseResult: unknown): unknown {
  const result = readObject(toolUseResult)
  const answers = readObject(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
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

/**
 * True when the message looks like an API rejection caused by the
 * provider not being able to relay Anthropic's `thinking` field. The
 * canonical case is Bedrock proxies that wrap unknown Anthropic params
 * into AWS's `additionalModelRequestFields`, which Bedrock then rejects
 * for non-thinking-aware target models.
 *
 * We deliberately keep the patterns narrow — only fire on phrases that
 * unambiguously point at thinking. False positives here would
 * permanently disable thinking on the wrong provider until the user
 * edits its config.
 */
const THINKING_INCOMPAT_PATTERNS = [
  /additionalModelRequestFields/i,
  /\bthinking\b[^.]*\b(not supported|unsupported|invalid|disabled|rejected)\b/i,
  /unknown.{0,40}\bthinking\b/i,
] as const

export function detectThinkingIncompatMessage(message: string | undefined | null): boolean {
  if (!message) return false
  return THINKING_INCOMPAT_PATTERNS.some((rx) => rx.test(message))
}

/**
 * One-shot guard so we don't spam markThinkingIncompatible / sidecar
 * restart on a burst of identical errors from a single failed turn.
 * Keyed by (sessionId, providerId) — clears when the session is
 * destroyed or when an updateProvider re-arms the provider. Process-
 * local only; persisted state lives in providers.json.
 */
const recentThinkingIncompatNotifications = new Set<string>()

/**
 * If any of the just-emitted server messages is an `error` whose body
 * matches the thinking-incompat patterns, attribute it to the currently
 * active provider, sticky-mark the provider in providers.json, and
 * schedule a sidecar restart so the NEXT call goes out without the
 * thinking field. Best-effort and idempotent — repeated calls within
 * the same session for the same provider are de-duplicated by
 * `recentThinkingIncompatNotifications`.
 */
async function notifyThinkingIncompatIfMatches(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  serverMsgs: ReadonlyArray<ServerMessage>,
): Promise<void> {
  const errorMsg = serverMsgs.find(
    (msg): msg is Extract<ServerMessage, { type: 'error' }> => msg.type === 'error',
  )
  if (!errorMsg || !detectThinkingIncompatMessage(errorMsg.message)) return

  // Resolve the active provider id. Prefer the runtime override (the
  // session may be on a non-default provider via set_runtime_config);
  // fall back to the global active id.
  const runtimeOverride = runtimeOverrides.get(sessionId)
  let providerId: string | null =
    typeof runtimeOverride?.providerId === 'string'
      ? runtimeOverride.providerId
      : null
  if (!providerId) {
    const { activeId } = await providerService.listProviders()
    providerId = activeId
  }
  if (!providerId || isOpenAIOfficialProviderId(providerId)) return

  const dedupKey = `${sessionId}|${providerId}`
  if (recentThinkingIncompatNotifications.has(dedupKey)) return
  recentThinkingIncompatNotifications.add(dedupKey)

  try {
    const updated = await providerService.markThinkingIncompatible(
      providerId,
      errorMsg.message,
    )
    if (!updated) return

    sendMessage(ws, {
      type: 'provider_compat_event',
      providerId,
      kind: 'thinking_incompatible',
      reason: errorMsg.message.slice(0, 500),
    })

    // Schedule a sidecar restart so the next launch picks up
    // CLAUDE_CODE_DISABLE_THINKING=1. Uses the same enqueue path as
    // set_runtime_config so we don't tear down a streaming response
    // mid-flight; the restart applies on the next idle transition.
    if (conversationService.hasSession(sessionId)) {
      await enqueueRuntimeTransition(sessionId, () =>
        scheduleRestartSessionWithRuntimeConfig(ws, sessionId),
      )
    }
  } catch (err) {
    // De-dup so we don't retry endlessly on a permanent failure (e.g.
    // disk full). Operator can re-arm by editing the provider.
    console.warn(`[WS] markThinkingIncompatible failed for ${providerId}: ${err}`)
  }
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
    const sdkUrl =
      `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
      `?token=${encodeURIComponent(crypto.randomUUID())}`
    await sendRepositoryStartupStatus(ws, sessionId, reason)
    console.log(`[WS] Starting CLI for ${sessionId} due to ${reason}`)
    await conversationService.startSession(sessionId, workDir, sdkUrl, startupSettings)
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
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error || cliMsg.isApiErrorMessage) {
        const message = extractAssistantText(cliMsg) || cliMsg.error || 'Unknown API error'
        const code = typeof cliMsg.error === 'string' ? cliMsg.error : 'API_ERROR'
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

      // If we already received stream_events, text/thinking were already sent.
      // Only extract tool_use blocks (stream_event's content_block_stop lacks complete tool info).
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []

        for (const block of cliMsg.message.content) {
          if (streamState.hasReceivedStreamEvents) {
            // Stream events handled most blocks — but any tool_use whose
            // input JSON failed to parse in content_block_stop was deferred.
            // Emit those now with the complete input from the assistant message.
            if (block.type === 'tool_use' && streamState.pendingToolBlocks.has(block.id)) {
              const pending = streamState.pendingToolBlocks.get(block.id)!
              streamState.pendingToolBlocks.delete(block.id)
              rememberToolParentUseId(streamState, block.id, pending.parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: pending.toolName || block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId: pending.parentToolUseId,
              })
            }
          } else {
            // No stream events received — this is the only source, process everything
            if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', text: block.thinking })
            } else if (block.type === 'text' && block.text) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
            } else if (block.type === 'tool_use') {
              const parentToolUseId = cliParentToolUseId(cliMsg)
              rememberToolParentUseId(streamState, block.id, parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId,
              })
            }
          }
        }

        // Reset flags for next turn
        streamState.hasReceivedStreamEvents = false
        streamState.pendingToolBlocks.clear()
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
            const rememberedParentToolUseId = consumeToolParentUseId(streamState, block.tool_use_id)
            const parentToolUseId =
              cliParentToolUseId(cliMsg) ?? rememberedParentToolUseId
            messages.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: normalizeAskUserQuestionToolResult(block.content, cliMsg.toolUseResult),
              isError: !!block.is_error,
              parentToolUseId,
            })
          }
        }
      }

      return messages
    }

    case 'stream_event': {
      streamState.hasReceivedStreamEvents = true
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          return [{ type: 'status', state: 'thinking' }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const index = event.index ?? 0

          if (contentBlock.type === 'tool_use') {
            const parentToolUseId = cliParentToolUseId(cliMsg)
            streamState.activeBlockTypes.set(index, 'tool_use')
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(index, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
              parentToolUseId,
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: contentBlock.id,
              parentToolUseId,
            }]
          }

          if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
            streamState.activeBlockTypes.set(index, 'thinking')
            return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
          }

          streamState.activeBlockTypes.set(index, 'text')
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
            const toolBlock = streamState.activeToolBlocks.get(index)
            if (toolBlock) toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const blockType = streamState.activeBlockTypes.get(index)
          streamState.activeBlockTypes.delete(index)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(index)
            streamState.activeToolBlocks.delete(index)
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
                  toolUseId: toolBlock.toolUseId,
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
              streamState.pendingToolBlocks.set(toolBlock.toolUseId, {
                toolName: toolBlock.toolName,
                toolUseId: toolBlock.toolUseId,
                parentToolUseId,
              })
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

    case 'control_response':
      return []

    case 'result': {
      // 对话结果（成功或错误）
      const usage = {
        input_tokens: cliMsg.usage?.input_tokens || 0,
        output_tokens: cliMsg.usage?.output_tokens || 0,
      }

      if (cliMsg.is_error) {
        // If the user requested stop, this "error" is just the interrupt
        // result — don't show it as an error in the chat UI.
        if (sessionStopRequested.has(sessionId)) {
          sessionStopRequested.delete(sessionId)
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
            code: 'CLI_ERROR',
          },
          { type: 'message_complete', usage },
        ]
      }

      // Clear stop flag on successful completion too
      sessionStopRequested.delete(sessionId)
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
        if (typeof cliMsg.permissionMode === 'string') {
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
        return [
          {
            type: 'system_notification',
            subtype: 'task_started',
            message: cliMsg.message || cliMsg.description || 'Task started',
            data: cliMsg,
          },
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.description || 'Task started',
          },
        ]
      }
      if (subtype === 'task_progress') {
        return [
          {
            type: 'system_notification',
            subtype: 'task_progress',
            message: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
            data: cliMsg,
          },
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
          },
        ]
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRetryCount(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric === null) return null
  return Math.max(0, Math.trunc(numeric))
}

function readRetryErrorRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readRetryErrorString(value: unknown, keys: string[]): string | undefined {
  const record = readRetryErrorRecord(value)
  if (!record) return undefined
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function toApiRetryServerMessage(cliMsg: any): ServerMessage | null {
  const attempt = normalizeRetryCount(cliMsg.attempt)
  const maxRetries = normalizeRetryCount(cliMsg.max_retries)
  const retryDelayMs = normalizeRetryCount(cliMsg.retry_delay_ms)
  if (attempt === null || maxRetries === null || retryDelayMs === null) return null

  const embeddedError = readRetryErrorRecord(cliMsg.error)
  const embeddedStatus = embeddedError ? finiteNumber(embeddedError.status) : null
  const rawStatus = cliMsg.error_status === null
    ? null
    : finiteNumber(cliMsg.error_status) ?? embeddedStatus
  const errorType = typeof cliMsg.error === 'string' && cliMsg.error.trim()
    ? cliMsg.error.trim()
    : readRetryErrorString(cliMsg.error, ['type', 'code', 'name'])
  const errorMessage = readRetryErrorString(cliMsg.error, ['message', 'error'])

  return {
    type: 'api_retry',
    attempt,
    maxRetries,
    retryDelayMs,
    errorStatus: rawStatus === null ? null : Math.trunc(rawStatus),
    ...(errorType ? { errorType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }
}

function sendMessage(ws: ServerWebSocket<WebSocketData>, message: ServerMessage) {
  ws.send(JSON.stringify(message))
}

// Restart the CLI subprocess to apply a runtime-config change. The override
// values are already in `runtimeOverrides[sessionId]` (and persisted) before
// this is called, so getRuntimeSettings will read them at restart time.
//
// Mid-turn protection is handled upstream by the active-turn deferral
// (`shouldDeferRuntimeRestartForActiveTurn` + `deferredRuntimeRestarts`, drained
// by the turn's `result` callback in `bindActiveUserTurnCompletion`), which
// gates on the real turn lifecycle rather than on outbound status events.
async function scheduleRestartSessionWithRuntimeConfig(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  await restartSessionWithRuntimeConfig(ws, sessionId)
}

function sendError(ws: ServerWebSocket<WebSocketData>, message: string, code: string) {
  sendMessage(ws, { type: 'error', message, code })
}

function getDisconnectCleanupDelayMs(sessionId: string): number {
  return conversationService.getPendingPermissionRequests(sessionId).length > 0
    ? PENDING_PERMISSION_DISCONNECT_CLEANUP_MS
    : CLIENT_DISCONNECT_CLEANUP_MS
}

function replayPendingPermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  for (const request of conversationService.getPendingPermissionRequests(sessionId)) {
    sendMessage(ws, {
      type: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    })
  }
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

function extractLocalCommandOutput(
  content: unknown,
  options: { allowUntagged?: boolean } = {},
): string | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  if (!raw) return null

  const stdout = extractTaggedContent(raw, LOCAL_COMMAND_STDOUT_TAG)
  if (stdout !== null) return stdout

  const stderr = extractTaggedContent(raw, LOCAL_COMMAND_STDERR_TAG)
  if (stderr !== null) return stderr

  if (options.allowUntagged) {
    const normalized = raw.trim()
    return normalized || null
  }

  return null
}

function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

function extractTaggedContent(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim() ?? null
}

function extractLocalCommand(content: unknown): { name: string; args: string } | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  const name = extractTaggedContent(raw, COMMAND_NAME_TAG)
  if (!name) return null
  return {
    name: name.replace(/^\//, ''),
    args: extractTaggedContent(raw, 'command-args') ?? '',
  }
}

type GoalEventData = {
  action: 'created' | 'replaced' | 'status' | 'paused' | 'resumed' | 'completed' | 'cleared' | 'message'
  status?: string
  objective?: string
  budget?: string
  elapsed?: string
  continuations?: string
  message?: string
}

function extractGoalEvent(
  output: string,
  command?: { name: string; args: string },
): GoalEventData | null {
  if (command && command.name !== 'goal') return null

  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) {
    return { action: 'cleared', message: trimmed }
  }
  if (trimmed === 'Goal marked complete.') {
    return { action: 'completed', message: trimmed }
  }
  if (trimmed === 'No active goal.') {
    return { action: 'message', message: trimmed }
  }

  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

function looksLikeGoalCommandOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal cleared.' ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}

function getCompactBoundaryMessage(cliMsg: any): string {
  const message = typeof cliMsg?.message === 'string' ? cliMsg.message.trim() : ''
  if (message) return message

  const content = typeof cliMsg?.content === 'string' ? cliMsg.content.trim() : ''
  if (content) return content

  return 'Context compacted'
}

function isCompactSummaryMessageContent(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.trim().startsWith(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    )
  )
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
    if (options?.shouldForward && !options.shouldForward(cliMsg)) {
      return
    }

    const serverMsgs = translateCliMessage(cliMsg, sessionId)
    for (const msg of serverMsgs) {
      sendMessage(ws, msg)
    }

    // Provider-level compatibility detection: if any of the messages
    // we just translated is an `error` whose payload matches the
    // thinking-incompat patterns, mark the active provider so the
    // NEXT sidecar launch suppresses the `thinking` field. Fire the
    // sidecar restart in the background so we don't kill the current
    // error reporting flow — restart happens on the next idle.
    void notifyThinkingIncompatIfMatches(ws, sessionId, serverMsgs).catch(
      (err) => {
        console.warn(`[WS] thinking-incompat notification failed: ${err}`)
      },
    )
  }

  clientOutputCallbacks.set(ws, { sessionId, callback })
  conversationService.onOutput(sessionId, callback)
}

type RuntimeSettings = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'enabled' | 'disabled'
  providerId?: string | null
  coordinatorMode?: boolean
  /**
   * Solo Pipeline mode toggle. When true, the CLI is launched (or
   * restarted) with `--append-system-prompt` carrying the 5-stage Solo
   * prompt instead of the coordinator orchestration directive. Mutually
   * exclusive with `coordinatorMode` (handleSetPipelineMode enforces this).
   */
  soloPipelineMode?: boolean
  /**
   * Hand-off summary system prompt addendum. When present, the CLI is
   * launched (or restarted) with `--append-system-prompt` carrying this
   * text. Set by handleSetHandoffSummary and consumed exactly once at the
   * next CLI start; cleared after consumption to avoid re-attaching on
   * unrelated restarts.
   */
  handoffSystemPrompt?: string
}

function isKnownRuntimeProviderId(
  providerId: string,
  providers: Array<{ id: string }>,
): boolean {
  return (
    isOpenAIOfficialProviderId(providerId) ||
    providers.some((provider) => provider.id === providerId)
  )
}

async function getRuntimeSettings(sessionId?: string): Promise<RuntimeSettings> {
  const coordinatorMode = sessionId ? coordinatorModeSessions.has(sessionId) : false
  const soloPipelineMode = sessionId ? soloPipelineModeSessions.has(sessionId) : false
  // Hand-off summary is one-shot: read AND remove. The next CLI start will
  // pick it up; subsequent unrelated restarts won't re-attach a stale summary.
  const handoffSystemPrompt = sessionId ? handoffSummarySessions.get(sessionId) : undefined
  if (sessionId && handoffSystemPrompt) {
    handoffSummarySessions.delete(sessionId)
  }
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
          ...(launchInfo.thinkingEnabled !== undefined
            ? { thinkingEnabled: launchInfo.thinkingEnabled }
            : {}),
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
          coordinatorMode,
          soloPipelineMode,
          ...(handoffSystemPrompt ? { handoffSystemPrompt } : {}),
        }
      }
    }

    const userSettings = await settingsService.getUserSettings()
    const thinking = resolveDesktopThinkingMode(userSettings, runtimeOverride.thinkingEnabled)

    return {
      permissionMode: sessionPermissionMode ?? await settingsService.getPermissionMode().catch(() => undefined),
      model: runtimeOverride.modelId,
      effort: runtimeOverride.effort,
      thinking,
      providerId: runtimeOverride.providerId,
      coordinatorMode,
      soloPipelineMode,
      ...(handoffSystemPrompt ? { handoffSystemPrompt } : {}),
    }
  }

  const defaults = await getDefaultRuntimeSettings()
  return {
    ...defaults,
    permissionMode: sessionPermissionMode ?? defaults.permissionMode,
    effort: launchInfo?.effortLevel ?? defaults.effort,
    coordinatorMode,
    soloPipelineMode,
    ...(handoffSystemPrompt ? { handoffSystemPrompt } : {}),
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
  const effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined
  const thinking = resolveDesktopThinkingMode(userSettings)

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
  } else {
    // No provider — pass model normally
    const baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    model = baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined
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
  override?: boolean,
): 'enabled' | 'disabled' | undefined {
  // Per-session override wins over the global toggle. true → 'enabled' (force on),
  // false → 'disabled' (force off). Undefined falls back to user settings, where
  // alwaysThinkingEnabled === false explicitly maps to 'disabled' and any other
  // value (true / undefined / missing) lets the CLI default (adaptive) apply.
  if (override === true) return 'enabled'
  if (override === false) return 'disabled'
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
  const payload = JSON.stringify(message)
  for (const ws of clients) {
    ws.send(payload)
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
  activeSessions.clear()
  clientOutputCallbacks.clear()
  sessionCleanupTimers.clear()
  prewarmPendingSessions.clear()
  prewarmedSessions.clear()
  prewarmIdleTimers.clear()
}

export function __markPrewarmPendingForTests(sessionId: string): void {
  prewarmPendingSessions.add(sessionId)
}
