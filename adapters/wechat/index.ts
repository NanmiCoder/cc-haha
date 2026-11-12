import { adapterMigrationLifecycle, registerAdapterShutdown } from '../common/migration-lifecycle.js'
import * as path from 'node:path'
import * as os from 'node:os'
import { WsBridge, type ServerMessage, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { WechatTextBuffer } from './text-buffer.js'
import { loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  formatPermissionRequest,
  splitMessage,
} from '../common/format.js'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  parsePermissionCommand,
} from '../common/permission.js'
import { SessionStore } from '../common/session-store.js'
import { deliverImPermissionPrompt, syncImPermissionState } from '../common/permission-sync.js'
import { SessionSelectionController } from '../common/session-selection.js'
import { createAdapterClient } from '../common/adapter-client.js'
import { restoreStoredSessionBinding, SESSION_RECONNECT_NOTICE, type SessionRestoreResult } from '../common/session-recovery.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import { WechatTypingController } from './typing.js'
import {
  extractWechatText,
  getWechatConfig,
  getWechatUpdates,
  sendWechatTyping,
  sendWechatText,
  WECHAT_DEFAULT_BASE_URL,
  WechatApiError,
  isWechatAuthenticationError,
  type WechatMessage,
} from './protocol.js'
import { collectWechatMediaCandidates, WechatMediaService, wechatMediaFailureNotice, wechatMediaDownloadHost } from './media.js'
import { WechatMediaActions, WECHAT_MEDIA_HELP } from './media-actions.js'
import { sendWechatMedia } from './media-upload.js'
import { WechatRuntimeReporter } from './runtime-reporter.js'
import { WechatDeliveryStore, wechatBindingKey, DeliveryCapacityError, type OutboundDelivery } from './delivery-store.js'
import { WechatDeliveryRuntime, wechatMessageKey, isWechatStorageError } from './delivery-runtime.js'
import { WechatMediaPreferenceStore } from './media-preferences.js'
import { handleWechatJournalFull } from './recovery-control.js'

const WECHAT_TEXT_LIMIT = 3500
const GET_UPDATES_TIMEOUT_MS = 35_000

const config = loadConfig()
if (!config.wechat.botToken || !config.wechat.accountId) {
  console.error('[WeChat] Missing QR-bound account. Bind WeChat in Desktop Settings > IM.')
  process.exit(1)
}

const baseUrl = config.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL
const accountId = config.wechat.accountId
const botToken = config.wechat.botToken
const isWorker = import.meta.main || process.argv.includes('--wechat')
const configRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const bindingKey = wechatBindingKey(accountId, botToken)
let delivery: WechatDeliveryRuntime | undefined
const pollController = new AbortController()
const reporter = new WechatRuntimeReporter({ serverUrl: config.serverUrl, token: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
  onSuperseded: () => {
    stopped = true
    pollController.abort()
    for (const controller of inboundMediaControllers.values()) controller.abort()
    mediaActions.dispose()
    for (const buffer of blockBuffers.values()) buffer.dispose()
    typingController.destroy()
    bridge.destroy()
    dedup.destroy()
    if (isWorker) void adapterMigrationLifecycle.quiesce().then(() => process.exit(0), () => process.exit(1))
  },
})
const outboundQueues = new Map<string, Promise<void>>()
const outboundGenerations = new Map<string, number>()
const stoppedTurns = new Map<string, { sessionId: string | null; awaitingEnd: boolean }>()
const bridge = new WsBridge(config.serverUrl, 'wechat')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir, enqueue } = createAdapterClient(config, config.wechat)
const attachmentStore = new AttachmentStore()
const media = new WechatMediaService(attachmentStore)
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()
const blockBuffers = new Map<string, WechatTextBuffer>()
const contextTokens = new Map<string, string>()
const typingTickets = new Map<string, string>()
const pendingPermissions = new Map<string, Set<string>>()
const typingController = new WechatTypingController(sendTypingIndicator)
const inboundMediaControllers = new Map<string, AbortController>()
// Explicit cancellation also invalidates accepted work that has not started a
// media controller yet (FIFO queue, power lease, or session recovery).
const inboundGenerations = new Map<string, number>()
const mediaActions = new WechatMediaActions({
  ...(isWorker ? { preferences: new WechatMediaPreferenceStore(path.join(configRoot, 'wechat-media-preferences.json'), bindingKey) } : {}),
  session: (chatId) => sessionStore.get(chatId),
  allowed: (chatId) => isAllowedUser('wechat', chatId),
  notice: sendText,
  send: async (chatId, outgoing, signal, current) => {
    if (!isAllowedUser('wechat', chatId)) throw new Error('User authorization was revoked')
    const record = delivery?.store.stageMedia({ chatId, metadata: { name: outgoing.fileName, kind: outgoing.kind, size: outgoing.buffer.length } })
    let sending = false
    try {
      await serializeOutbound(chatId, async () => {
        signal.throwIfAborted()
        if (stopped || !current()) throw new Error('Session changed or user authorization was revoked; media not sent')
        await sendWechatMedia({ ...outgoing, baseUrl, token: botToken, to: chatId, contextToken: contextTokens.get(chatId), signal,
          clientId: record?.clientId,
          beforeSend: () => {
            if (stopped || !current()) throw new Error('Session changed or user authorization was revoked; media not sent')
            if (record && !delivery?.store.beginOutbound(record.replyId)) throw new Error('Attachment delivery was cancelled')
            sending = true
          },
        })
        if (record) delivery?.store.finishOutbound(record.replyId, 'sent')
        reporter.update({ lastSendAt: Date.now() })
      })
    } catch (error) {
      if (record) delivery?.store.finishOutbound(record.replyId, sending ? 'unknown' : 'failed')
      throw error
    }
  },
  transcribe: (wav, signal) => httpClient.transcribeAudio(wav, signal),
})

let getUpdatesBuf = ''
let stopped = false

attachmentStore.gc().catch((err) => {
  console.warn('[WeChat] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

const sessionSelectionController = new SessionSelectionController({
  httpClient,
  bridge,
  sessionStore,
  sendNotice: async (chatId, text) => { await sendText(chatId, text) },
  onServerMessage: handleServerMessage,
  clearTransientState: clearTransientChatState,
  clearProjectSelection: (chatId) => { pendingProjectSelection.delete(chatId) },
  isBusy: (chatId) => {
    const runtime = getRuntimeState(chatId)
    return runtime.state !== 'idle' || runtime.pendingPermissionCount > 0
      || (pendingPermissions.get(chatId)?.size ?? 0) > 0
  },
})

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

function getRuntimeState(chatId: string): ChatRuntimeState {
  let state = runtimeStates.get(chatId)
  if (!state) {
    state = { state: 'idle', pendingPermissionCount: 0 }
    runtimeStates.set(chatId, state)
  }
  return state
}

function serializeOutbound(chatId: string, task: () => Promise<void>): Promise<void> {
  const previous = outboundQueues.get(chatId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  outboundQueues.set(chatId, next)
  void next.finally(() => { if (outboundQueues.get(chatId) === next) outboundQueues.delete(chatId) }).catch(() => {})
  return next
}

async function deliverTextRecord(chatId: string, chunk: string, record?: OutboundDelivery, control = false, generation?: number): Promise<void> {
  if (generation !== undefined && generation !== (outboundGenerations.get(chatId) ?? 0)) {
    if (record) delivery?.store.finishOutbound(record.replyId, 'cancelled')
    return
  }
  if (stopped || (!control && !isAllowedUser('wechat', chatId))) {
    if (record) delivery?.store.finishOutbound(record.replyId, 'cancelled')
    throw new Error('User authorization was revoked; reply not sent')
  }
  if (record && !delivery?.store.beginOutbound(record.replyId)) return
  try {
    await sendWechatText({ baseUrl, token: botToken, to: chatId, text: chunk,
      contextToken: contextTokens.get(chatId), clientId: record?.clientId })
    if (record) delivery?.store.finishOutbound(record.replyId, 'sent')
    reporter.update({ lastSendAt: Date.now() })
  } catch (error) {
    if (record) delivery?.store.finishOutbound(record.replyId, error instanceof WechatApiError ? 'failed' : 'unknown')
    throw error
  }
}

async function sendText(chatId: string, text: string, control = false): Promise<void> {
  await stageTextMessage(chatId, text, control)()
}

function stageTextMessage(chatId: string, text: string, control = false): () => Promise<void> {
  const chunks = splitMessage(text, WECHAT_TEXT_LIMIT)
  const generation = outboundGenerations.get(chatId) ?? 0
  // Persist each chunk before handing it to the async sending queue. A failed
  // socket response is not permission to silently send a second copy.
  const records = control ? [] : delivery?.store.stageTextBatch({ chatId, chunks }) ?? []
  return () => serializeOutbound(chatId, async () => {
    for (const [index, chunk] of chunks.entries()) await deliverTextRecord(chatId, chunk, records[index], control, generation)
    console.log(`[WeChat] Sent ${chunks.length} message chunk(s) to ${redactChatId(chatId)}`)
  })
}

function getBlockBuffer(chatId: string): WechatTextBuffer {
  let buffer = blockBuffers.get(chatId)
  if (!buffer) {
    buffer = new WechatTextBuffer(text => stageTextMessage(chatId, text), {
      intervalMs: 3000, charThreshold: 200,
      onError: (_error, phase) => {
        console.warn(`[WeChat] text delivery ${phase} failed; consult desktop result and /delivery`)
        if (phase !== 'send') {
          reporter.update({ state: 'error', errorCode: 'DELIVERY_STORE_FAILED' })
          bridge.sendStopGeneration(chatId)
        }
      },
    })
    blockBuffers.set(chatId, buffer)
  }
  return buffer
}

async function sendTypingIndicator(chatId: string, status: 'typing' | 'cancel'): Promise<void> {
  try {
    const typingTicket = await getTypingTicket(chatId, status)
    if (!typingTicket) return
    await sendWechatTyping({
      baseUrl,
      token: botToken,
      ilinkUserId: chatId,
      typingTicket,
      status,
    })
  } catch (err) {
    typingTickets.delete(chatId)
    if (status === 'typing') {
      try {
        const typingTicket = await getTypingTicket(chatId, status)
        if (!typingTicket) return
        await sendWechatTyping({
          baseUrl,
          token: botToken,
          ilinkUserId: chatId,
          typingTicket,
          status,
        })
        return
      } catch {
        // Fall through to the warning below with the original error.
      }
    }
    console.warn('[WeChat] sendTyping failed:', err instanceof Error ? err.message : err)
  }
}

async function getTypingTicket(chatId: string, status: 'typing' | 'cancel'): Promise<string | null> {
  let typingTicket = typingTickets.get(chatId)
  if (!typingTicket && status === 'typing') {
    const configResp = await getWechatConfig({
      baseUrl,
      token: botToken,
      ilinkUserId: chatId,
      contextToken: contextTokens.get(chatId),
    })
    if (typeof configResp.ret === 'number' && configResp.ret !== 0) {
      throw new Error(`getconfig returned ${configResp.ret}: ${configResp.errmsg ?? ''}`)
    }
    typingTicket = configResp.typing_ticket
    if (typingTicket) typingTickets.set(chatId, typingTicket)
  }
  return typingTicket || null
}

function clearTransientChatState(chatId: string): void {
  inboundMediaControllers.get(chatId)?.abort()
  mediaActions.reset(chatId)
  blockBuffers.get(chatId)?.dispose()
  blockBuffers.delete(chatId)
  pendingPermissions.delete(chatId)
  typingController.stop(chatId)
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
}

function enqueueWechat(chatId: string, task: () => Promise<void>): Promise<void> {
  return enqueue(chatId, async () => {
    try {
      await task()
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      delivery?.failedCurrent()
      typingController.stop(chatId)
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[WeChat] Failed to handle message for ${redactChatId(chatId)}:`, err)
      try {
        await sendText(chatId, `Failed to process message: ${message}`)
      } catch (sendErr) {
        console.error(`[WeChat] Failed to report message handling error for ${redactChatId(chatId)}:`, sendErr)
      }
      throw err
    }
  })
}

async function ensureExistingSession(chatId: string): Promise<SessionRestoreResult> {
  return await restoreStoredSessionBinding({
    chatId,
    bridge,
    sessionStore,
    httpClient,
    onServerMessage: (msg) => handleServerMessage(chatId, msg),
    logPrefix: '[WeChat]',
    clearTransientState: () => clearTransientChatState(chatId),
  })
}

async function buildStatusText(chatId: string): Promise<string> {
  const result = await ensureExistingSession(chatId)
  if (result.status === 'unavailable') return SESSION_RECONNECT_NOTICE
  if (result.status === 'missing') return formatImStatus(null)
  const stored = result.session

  const runtime = getRuntimeState(chatId)
  let projectName = path.basename(stored.workDir) || stored.workDir
  let branch: string | null = null

  try {
    const gitInfo = await httpClient.getGitInfo(stored.sessionId)
    projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
    branch = gitInfo.branch
  } catch {
    // Keep IM status best-effort.
  }

  let taskCounts:
    | {
        total: number
        pending: number
        inProgress: number
        completed: number
      }
    | undefined

  try {
    const tasks = await httpClient.getTasksForSession(stored.sessionId)
    if (tasks.length > 0) {
      taskCounts = {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === 'pending').length,
        inProgress: tasks.filter((task) => task.status === 'in_progress').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
      }
    }
  } catch {
    // Keep IM status best-effort.
  }

  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
    taskCounts,
  })
}

async function ensureSession(chatId: string): Promise<boolean> {
  const result = await ensureExistingSession(chatId)
  if (result.status === 'restored') return true
  if (result.status === 'unavailable') {
    await sendText(chatId, SESSION_RECONNECT_NOTICE)
    return false
  }

  const workDir = defaultWorkDir
  if (workDir) return await createSessionForChat(chatId, workDir)

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  sessionSelectionController.clear(chatId)
  try {
    bridge.resetSession(chatId)
    clearTransientChatState(chatId)
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, 'Timed out connecting to the server. Please try again.')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `Could not create session: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  sessionSelectionController.clear(chatId)
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(chatId, `No recent projects found. Sending /new will use the default working directory: ${defaultWorkDir}\nYou can also send /new /path/to/project to pick a project.`)
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await sendText(chatId, `Select a project (reply with its number):\n\n${lines.join('\n\n')}\n\nNext time you can send /new <number, name or absolute path> to create a session quickly`)
  } catch (err) {
    await sendText(chatId, `Could not fetch project list: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  sessionSelectionController.clear(chatId)
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  clearTransientChatState(chatId)
  pendingProjectSelection.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) await sendText(chatId, `New session created: ${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} - ${p.realPath}`).join('\n')
        await sendText(chatId, `Multiple projects matched, please be more specific:\n\n${list}`)
        return
      }
      await sendText(chatId, `No project matching "${query}" found. Send /projects to see the full list.`)
    } catch (err) {
      await sendText(chatId, err instanceof Error ? err.message : String(err))
    }
    return
  }

  const workDir = defaultWorkDir
  if (workDir) {
    const ok = await createSessionForChat(chatId, workDir)
    if (ok) await sendText(chatId, 'New session created. You can start chatting now.')
  } else {
    await showProjectPicker(chatId)
  }
}

/** Shared by the normal and journal-full stop paths. Suppression remains until
 * the old stream ends; a new session is a separate boundary. */
function cancelWechatTurn(chatId: string): void {
  const runtime = getRuntimeState(chatId)
  stoppedTurns.set(chatId, {
    sessionId: sessionStore.get(chatId)?.sessionId ?? null,
    awaitingEnd: runtime.state !== 'idle' || blockBuffers.has(chatId) || runtime.pendingPermissionCount > 0,
  })
  delivery?.cancel(chatId)
  inboundGenerations.set(chatId, (inboundGenerations.get(chatId) ?? 0) + 1)
  outboundGenerations.set(chatId, (outboundGenerations.get(chatId) ?? 0) + 1)
  inboundMediaControllers.get(chatId)?.abort()
  mediaActions.cancel(chatId)
  blockBuffers.get(chatId)?.dispose()
  blockBuffers.delete(chatId)
  pendingPermissions.delete(chatId)
  runtime.pendingPermissionCount = 0
  typingController.stop(chatId)
}

function stoppedTurnFor(chatId: string) {
  const turn = stoppedTurns.get(chatId)
  return turn?.sessionId === (sessionStore.get(chatId)?.sessionId ?? null) ? turn : undefined
}

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const runtime = getRuntimeState(chatId)
  const stoppedTurn = stoppedTurnFor(chatId)
  if (stoppedTurn && msg.type !== 'connected' && msg.type !== 'system_notification') {
    if (msg.type === 'message_complete' || msg.type === 'error' || (msg.type === 'status' && msg.state === 'idle')
      || (msg.type === 'permission_requests_snapshot' && msg.turnActive === false)) {
      stoppedTurn.awaitingEnd = false
      runtime.state = 'idle'
      runtime.verb = undefined
      typingController.stop(chatId)
    }
    return
  }
  if (syncImPermissionState(chatId, msg, runtime, pendingPermissions)) return

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      if (msg.state === 'thinking' || msg.state === 'tool_executing') {
        typingController.start(chatId)
      } else if (msg.state === 'idle') {
        typingController.stop(chatId)
      }
      break
    case 'content_start':
      if (msg.blockType === 'text') {
        runtime.state = 'streaming'
      } else if (msg.blockType === 'tool_use') {
        runtime.state = 'tool_executing'
        runtime.verb = typeof msg.toolName === 'string' ? msg.toolName : runtime.verb
        typingController.start(chatId)
      }
      break
    case 'content_delta':
      if (typeof msg.text === 'string' && msg.text) {
        try { getBlockBuffer(chatId).append(msg.text) } catch { break }
        mediaActions.append(chatId, msg.text)
      }
      break
    case 'tool_use_complete':
      runtime.state = 'tool_executing'
      runtime.verb = typeof msg.toolName === 'string' ? msg.toolName : runtime.verb
      typingController.start(chatId)
      break
    case 'tool_result':
      runtime.state = 'thinking'
      runtime.verb = undefined
      typingController.start(chatId)
      break
    case 'permission_request': {
      await deliverImPermissionPrompt(chatId, msg.requestId, runtime, pendingPermissions, async () => {
        typingController.stop(chatId)
        await sendText(
          chatId,
          `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n${formatPermissionInstructions(msg.requestId, { pendingCount: runtime.pendingPermissionCount })}`,
        )
      })
      break
    }
    case 'message_complete': {
      delivery?.completed(chatId, true)
      runtime.state = 'idle'
      runtime.verb = undefined
      typingController.stop(chatId)
      await blockBuffers.get(chatId)?.complete()
      blockBuffers.delete(chatId)
      // Do not hold the websocket event FIFO while TTS/upload runs: stop and
      // permission events must remain responsive. Lifecycle tracks teardown.
      const sessionId = sessionStore.get(chatId)?.sessionId
      void adapterMigrationLifecycle.track(mediaActions.finish(chatId).catch(async (error) => {
        if (error instanceof Error && error.name === 'AbortError') return
        if (isAllowedUser('wechat', chatId) && sessionStore.get(chatId)?.sessionId === sessionId) {
          await sendText(chatId, `Media reply did not finish; the text result was kept: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
      })).catch((error) => console.warn('[WeChat] media reply failed:', error instanceof Error ? error.message : 'unknown'))
      break
    }
    case 'error':
      delivery?.completed(chatId, false)
      mediaActions.cancel(chatId)
      runtime.state = 'idle'
      runtime.verb = undefined
      typingController.stop(chatId)
      await blockBuffers.get(chatId)?.complete()
      blockBuffers.delete(chatId)
      await sendText(chatId, `Error: ${msg.message}`)
      break
    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) runtime.model = model
      }
      break
  }
}

async function routeUserMessage(message: WechatMessage, awaitQueuedWork = false): Promise<void> {
  const chatId = message.from_user_id
  if (!chatId) return
  const messageKey = wechatMessageKey(message)
  if (!dedup.tryRecord(messageKey)) return
  if (message.context_token) contextTokens.set(chatId, message.context_token)

  const text = extractWechatText(message.item_list).trim()
  const mediaCandidates = collectWechatMediaCandidates(message.item_list)
  if (!text && mediaCandidates.length === 0) return
  console.log(`[WeChat] Received from ${redactChatId(chatId)}: ${text.length} text characters, ${mediaCandidates.length} attachment(s)`)

  if (!isAllowedUser('wechat', chatId)) {
    const success = text
      ? tryPair(text, { userId: chatId, displayName: 'WeChat User' }, 'wechat')
      : false
    await sendText(
      chatId,
      success
        ? 'Paired successfully! You can start chatting now.\n\nSend a message to talk to Claude. Send /help to see available commands.'
        : 'Not authorized. First bind WeChat by QR scan in the Claude Code desktop app, then generate an IM pairing code and send it to me.',
      true,
    )
    return
  }

  if (!mediaCandidates.length && (text === '/stop' || text === '停止')) {
    if (delivery && !delivery.beginCurrent()) return
    cancelWechatTurn(chatId)
    const result = await ensureExistingSession(chatId)
    if (result.status !== 'restored') {
      await sendText(chatId, result.status === 'unavailable' ? SESSION_RECONNECT_NOTICE : formatImStatus(null))
      return
    }
    bridge.sendStopGeneration(chatId)
    await sendText(chatId, 'Cancelled media processing and sent a stop signal. Messages already sent cannot be recalled.')
    return
  }
  if (!mediaCandidates.length && (text === '/voice off' || text === '/clear' || text === '清空' || text === '/new' || text.startsWith('/new ') || text === '新会话')) {
    if (text !== '/voice off') delivery?.cancel(chatId)
    inboundGenerations.set(chatId, (inboundGenerations.get(chatId) ?? 0) + 1)
    inboundMediaControllers.get(chatId)?.abort()
    mediaActions.cancel(chatId)
  }

  const generation = inboundGenerations.get(chatId) ?? 0
  const isCurrentInput = () => (inboundGenerations.get(chatId) ?? 0) === generation && isAllowedUser('wechat', chatId)
  const queued = enqueueWechat(chatId, async () => {
    if (!isCurrentInput()) return
    if (delivery && !delivery.beginCurrent()) return
    const hasAttachments = mediaCandidates.length > 0
    if (!hasAttachments && (text === '/help' || text === '帮助')) {
      await sendText(chatId, formatImHelp() + WECHAT_MEDIA_HELP + '\n/delivery — Show unfinished deliveries\n/retry <ID> — Resend one text reply after checking')
      return
    }
    if (!hasAttachments && text === '/delivery') {
      await sendText(chatId, delivery?.summary(chatId) ?? 'Delivery records are enabled in the WeChat channel run by the desktop app.')
      return
    }
    if (!hasAttachments && /^\/retry(?:\s|$)/.test(text)) {
      if (!delivery) { await sendText(chatId, 'Persistent delivery records are not enabled.'); return }
      const id = text.slice(6).trim()
      if (!id) { await sendText(chatId, 'First use /delivery to view records; after confirming your phone did not receive it, send /retry <ID>.'); return }
      const record = delivery.store.cloneTextForRetry(id, { chatId, contextToken: contextTokens.get(chatId) })
      await serializeOutbound(chatId, () => deliverTextRecord(chatId, record.text!, record))
      return
    }
    if (!hasAttachments && /^\/(send|speak|voice|transcode)(?:\s|$)/.test(text)) {
      if (text === '/voice off') { await mediaActions.command(chatId, text); return }
      if (!await ensureSession(chatId)) {
        delivery?.failedCurrent()
        return
      }
      if (isCurrentInput()) await mediaActions.command(chatId, text)
      return
    }
    if (!hasAttachments && (text === '/status' || text === '状态')) {
      await sendText(chatId, await buildStatusText(chatId) + (delivery ? `\n\n${delivery.summary(chatId)}` : ''))
      return
    }
    if (!hasAttachments && (text === '/projects' || text === '项目列表')) {
      await showProjectPicker(chatId)
      return
    }
    if (!hasAttachments && (text === '/new' || text === '新会话' || text.startsWith('/new '))) {
      const arg = text.startsWith('/new ') ? text.slice(5).trim() : ''
      await startNewSession(chatId, arg || undefined)
      return
    }
    if (!hasAttachments && (text === '/clear' || text === '清空')) {
      const result = await ensureExistingSession(chatId)
      if (result.status !== 'restored') {
        delivery?.failedCurrent()
        await sendText(chatId, result.status === 'unavailable' ? SESSION_RECONNECT_NOTICE : formatImStatus(null))
        return
      }
      clearTransientChatState(chatId)
      const sent = bridge.sendUserMessage(chatId, '/clear')
      if (sent) delivery?.submittedToServer(chatId)
      else delivery?.failedCurrent()
      if (sent) getRuntimeState(chatId).state = 'thinking'
      await sendText(chatId, sent ? 'Cleared the current session context.' : 'Could not send /clear. Send /new first to reconnect the session.')
      return
    }
    if (!hasAttachments && /^\/?[123]$/.test(text) && (pendingPermissions.get(chatId)?.size ?? 0) > 1) {
      await sendText(chatId, 'Multiple approval requests are pending, so it is unclear which one this number refers to. Use /allow, /always or /deny with the request ID from the matching approval message.')
      return
    }
    const permissionDecision = !hasAttachments ? parsePermissionCommand(text, pendingPermissions.get(chatId)) : null
    if (permissionDecision) {
      const { requestId, allowed, rule } = permissionDecision
      const pending = pendingPermissions.get(chatId)
      if (!pending?.has(requestId)) {
        await sendText(chatId, `No pending permission request found: ${requestId}`)
        return
      }
      const sent = bridge.sendPermissionResponse(chatId, requestId, allowed, rule)
      const runtime = getRuntimeState(chatId)
      if (sent) {
        runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
        pending.delete(requestId)
      } else delivery?.failedCurrent()
      await sendText(chatId, sent ? `${formatPermissionDecisionStatus(permissionDecision)}.` : 'Failed to send permission response. Please check the session status.')
      return
    }
    if (!hasAttachments && await sessionSelectionController.handleInput(chatId, text)) return

    if (!hasAttachments && pendingProjectSelection.has(chatId)) {
      await startNewSession(chatId, text)
      return
    }

    const ready = await ensureSession(chatId)
    if (!ready) {
      delivery?.failedCurrent()
      return
    }
    if (!isCurrentInput()) return
    if (stoppedTurnFor(chatId)?.awaitingEnd) {
      await sendText(chatId, 'The previous turn is still stopping and has not confirmed it finished. Resend later, or use /new to start a new session.')
      return
    }
    const expectedSession = sessionStore.get(chatId)?.sessionId
    const { attachments, context } = await collectAttachments(chatId, mediaCandidates)
    if (!isCurrentInput() || sessionStore.get(chatId)?.sessionId !== expectedSession) return
    const effectiveText = [text || (attachments.length > 0 ? '(user sent an attachment)' : ''), context].filter(Boolean).join('\n\n')
    if (!effectiveText && attachments.length === 0) return
    if (stoppedTurnFor(chatId)?.awaitingEnd) {
      await sendText(chatId, 'The previous turn is still stopping and has not confirmed it finished. Resend later, or use /new to start a new session.')
      return
    }
    typingController.start(chatId)
    const sent = bridge.sendUserMessage(chatId, effectiveText, attachments.length ? attachments : undefined)
    if (sent) stoppedTurns.delete(chatId)
    if (sent) delivery?.submittedToServer(chatId)
    if (sent) getRuntimeState(chatId).state = 'thinking'
    if (!sent) {
      delivery?.failedCurrent()
      await sendText(chatId, 'Failed to send message; the connection may be down. Send /new to start over.')
    }
  })
  if (awaitQueuedWork) await queued
  else void queued.catch(() => {})
}

async function collectAttachments(
  chatId: string,
  candidates: ReturnType<typeof collectWechatMediaCandidates>,
): Promise<{ attachments: AttachmentRef[]; context: string }> {
  if (candidates.length === 0) return { attachments: [], context: '' }
  if (candidates.length > 5) throw new Error('At most 5 attachments per message; please send them separately')
  const stored = sessionStore.get(chatId)
  const sessionId = stored?.sessionId ?? chatId
  const controller = new AbortController()
  inboundMediaControllers.set(chatId, controller)
  const attachments: AttachmentRef[] = []
  const notes: string[] = []
  let totalBytes = 0
  let videos = 0
  let failures = 0
  const failureHints = new Set<string>()
  try {
    for (const candidate of candidates) {
      controller.signal.throwIfAborted()
      if (!isAllowedUser('wechat', chatId)) throw new Error('User authorization was revoked')
      let local
      try {
        local = await media.downloadCandidate(candidate, sessionId, { signal: controller.signal })
      } catch (error) {
        controller.signal.throwIfAborted()
        failures += 1
        const hint = wechatMediaFailureNotice(error)
        failureHints.add(hint)
        console.warn(`[WeChat] media receive failed: kind=${candidate.kind} host=${wechatMediaDownloadHost(candidate)} reason=${hint}`)
        continue
      }
      totalBytes += local.size
      if (totalBytes > 30 * 1024 * 1024) throw new Error('Total attachment size in one message exceeds 30 MiB; please send them separately')
      const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
      if (!check.ok) {
        await sendText(chatId, check.hint)
        continue
      }
      if (local.kind === 'image') {
        attachments.push({
          type: 'image', name: local.name,
          data: local.buffer.toString('base64'), mimeType: local.mimeType,
        })
      } else {
        attachments.push({
          type: 'file', name: local.name, path: local.path, mimeType: local.mimeType,
        })
        if (local.mimeType.startsWith('video/')) {
          if (++videos > 1) { notes.push('Only the first video in this message is analyzed; other videos are received as attachments only.'); continue }
          await sendText(chatId, 'Extracting sampled video frames and audio track; send /stop to cancel.')
          controller.signal.throwIfAborted()
          try {
            const analysis = await mediaActions.analyzeVideo(chatId, local.path)
            attachments.push(...analysis.attachments)
            notes.push(analysis.context)
          } catch (error) {
            controller.signal.throwIfAborted()
            const hint = `Video received, but analysis did not finish: ${error instanceof Error ? error.message : 'Unknown error'}. Do not claim to have understood the video.`
            notes.push(hint)
            await sendText(chatId, hint)
          }
        }
      }
    }
    if (failures > 0) {
      await sendText(chatId, `${failures === candidates.length ? 'Received the attachment message, but could not read its content.' : `${failures} attachment(s) could not be read.`}\n${[...failureHints].join('\n')}\nPlease resend the attachment; authorizing search of the computer's image folder will not fix this transfer failure.`)
    }
    controller.signal.throwIfAborted()
    return { attachments, context: notes.join('\n\n') }
  } finally {
    if (inboundMediaControllers.get(chatId) === controller) inboundMediaControllers.delete(chatId)
  }
}

async function pollLoop(): Promise<void> {
  let failures = 0
  while (!stopped) {
    let receivedBatch: WechatMessage[] = []
    try {
      const resp = await getWechatUpdates({
        baseUrl,
        token: botToken,
        getUpdatesBuf,
        timeoutMs: GET_UPDATES_TIMEOUT_MS,
        signal: pollController.signal,
      })
      if (stopped) return
      const hasRetError = typeof resp.ret === 'number' && resp.ret !== 0
      const hasErrCode = typeof resp.errcode === 'number' && resp.errcode !== 0
      if (hasRetError || hasErrCode) {
        throw new WechatApiError('wechatGetUpdates rejected', undefined,
          resp.ret === -14 || resp.errcode === -14 ? -14 : resp.errcode || resp.ret)
      }
      receivedBatch = resp.msgs ?? []
      delivery?.store.prune()
      const messages = delivery ? delivery.ingest(resp.msgs ?? [], resp.get_updates_buf) : resp.msgs ?? []
      // Cursor advances only after validation and the inbox transaction succeeds.
      if (resp.get_updates_buf !== undefined) getUpdatesBuf = resp.get_updates_buf
      reporter.update({ state: 'online', lastPollOkAt: Date.now(), errorCode: undefined,
        ...(messages.length ? { lastReceiveAt: Date.now() } : {}) })
      failures = 0
      for (const msg of messages) dispatchMessage(msg)
    } catch (err) {
      if (stopped) return
      if (err instanceof DeliveryCapacityError) {
        reporter.update({ state: 'error', errorCode: 'JOURNAL_FULL' })
        try {
          await handleWechatJournalFull(receivedBatch, {
            allowed: chatId => isAllowedUser('wechat', chatId), first: key => dedup.tryRecord(key),
            context: (chatId, token) => { if (token) contextTokens.set(chatId, token) },
            summary: chatId => delivery!.summary(chatId), reply: (chatId, text) => sendText(chatId, text, true),
            stop: chatId => {
              cancelWechatTurn(chatId)
              bridge.sendStopGeneration(chatId)
            },
          })
        } catch { console.warn('[WeChat] capacity diagnostic could not be delivered') }
        await sleep(30_000)
        continue
      }
      if (isWechatStorageError(err)) {
        reporter.update({ state: 'error', errorCode: 'DELIVERY_STORE_FAILED' })
        console.warn('[WeChat] local delivery storage unavailable; cursor not advanced')
        await sleep(30_000)
        continue
      }
      // HTTP 401 is explicit authentication failure. Other undocumented platform
      // codes are not guessed to mean expired credentials.
      if (isWechatAuthenticationError(err)) {
        reporter.update({ state: 'auth_expired', errorCode: 'ACCOUNT_SESSION_INVALID' })
        await reporter.flush()
        return
      }
      reporter.update({ state: 'reconnecting', errorCode: 'POLL_FAILED' })
      console.warn('[WeChat] poll failed; retry scheduled (details omitted)')
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) + Math.floor(Math.random() * 500))
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    if (stopped) { resolve(); return }
    const done = () => { clearTimeout(timer); pollController.signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    pollController.signal.addEventListener('abort', done, { once: true })
  })
}

function dispatchMessage(message: WechatMessage): void {
  const task = delivery ? delivery.dispatch(message, () => routeUserMessage(message, true)) : routeUserMessage(message)
  void adapterMigrationLifecycle.track(task).catch(() => {
    console.warn('[WeChat] message processing incomplete; consult delivery journal')
  })
}

function redactChatId(chatId: string): string {
  if (chatId.length <= 12) return chatId
  return `${chatId.slice(0, 6)}...${chatId.slice(-6)}`
}

console.log('[WeChat] Starting adapter...')
if (isWorker) {
  const store = new WechatDeliveryStore({ path: path.join(configRoot, 'wechat-runtime.sqlite'), bindingKey })
  if (!store.acquireWorker()) {
    store.close()
    throw new Error('Another WeChat worker already owns this binding. Stop it before reconnecting.')
  }
  store.recoverInterrupted()
  store.prune()
  delivery = new WechatDeliveryRuntime(store, chatId => isAllowedUser('wechat', chatId))
  getUpdatesBuf = store.getCursor() ?? ''
  reporter.start()
  for (const message of delivery.pending()) dispatchMessage(message)
  void pollLoop()
}

if (isWorker) registerAdapterShutdown(async () => {
  console.log('[WeChat] Shutting down...')
  stopped = true
  pollController.abort()
  for (const controller of inboundMediaControllers.values()) controller.abort()
  mediaActions.dispose()
  typingController.destroy()
  bridge.destroy()
  dedup.destroy()
  await reporter.stop()
  // Keep the process lease until process exit. Pending callbacks may still be
  // recording their outcome while lifecycle quiesces; OS cleanup closes SQLite.
})

export { bridge, dedup, sessionStore, sessionSelectionController, handleServerMessage, getRuntimeState, clearTransientChatState, createSessionForChat, showProjectPicker, routeUserMessage, startNewSession, typingController, cancelWechatTurn }
