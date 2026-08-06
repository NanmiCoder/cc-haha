import * as path from 'node:path'
import { WsBridge, type ServerMessage, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { MessageBuffer } from '../common/message-buffer.js'
import { enqueue } from '../common/chat-queue.js'
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
import { createAdapterClient } from '../common/adapter-client.js'
import { restoreStoredSessionBinding } from '../common/session-recovery.js'
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
  type WechatMessage,
} from './protocol.js'
import { collectWechatMediaCandidates, WechatMediaService } from './media.js'

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
const bridge = new WsBridge(config.serverUrl, 'wechat')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir } = createAdapterClient(config, config.wechat)
const attachmentStore = new AttachmentStore()
const media = new WechatMediaService(attachmentStore)
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()
const blockBuffers = new Map<string, MessageBuffer>()
const contextTokens = new Map<string, string>()
const typingTickets = new Map<string, string>()
const pendingPermissions = new Map<string, Set<string>>()
const typingController = new WechatTypingController(sendTypingIndicator)

let getUpdatesBuf = ''
let stopped = false

attachmentStore.gc().catch((err) => {
  console.warn('[WeChat] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
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

async function sendText(chatId: string, text: string): Promise<void> {
  const chunks = splitMessage(text, WECHAT_TEXT_LIMIT)
  const contextToken = contextTokens.get(chatId)
  for (const chunk of chunks) {
    try {
      await sendWechatText({
        baseUrl,
        token: botToken,
        to: chatId,
        text: chunk,
        contextToken,
      })
    } catch (err) {
      if (!contextToken) throw err
      console.warn('[WeChat] sendText with context token failed, retrying without context:', err instanceof Error ? err.message : err)
      await sendWechatText({
        baseUrl,
        token: botToken,
        to: chatId,
        text: chunk,
      })
    }
  }
  console.log(`[WeChat] Sent ${chunks.length} message chunk(s) to ${redactChatId(chatId)}`)
}

function getBlockBuffer(chatId: string): MessageBuffer {
  let buffer = blockBuffers.get(chatId)
  if (!buffer) {
    buffer = new MessageBuffer(
      async (text) => {
        if (text.trim()) await sendText(chatId, text)
      },
      3000,
      200,
    )
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
  blockBuffers.get(chatId)?.reset()
  blockBuffers.delete(chatId)
  pendingPermissions.delete(chatId)
  typingController.stop(chatId)
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
}

function enqueueWechat(chatId: string, task: () => Promise<void>): void {
  enqueue(chatId, async () => {
    try {
      await task()
    } catch (err) {
      typingController.stop(chatId)
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[WeChat] Failed to handle message for ${redactChatId(chatId)}:`, err)
      try {
        await sendText(chatId, `处理消息失败：${message}`)
      } catch (sendErr) {
        console.error(`[WeChat] Failed to report message handling error for ${redactChatId(chatId)}:`, sendErr)
      }
    }
  })
}

async function ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
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
  const stored = await ensureExistingSession(chatId)
  if (!stored) return formatImStatus(null)

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
  const stored = await ensureExistingSession(chatId)
  if (stored) return true

  const workDir = defaultWorkDir
  if (workDir) return await createSessionForChat(chatId, workDir)

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    bridge.resetSession(chatId)
    clearTransientChatState(chatId)
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, '连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(chatId, `没有找到最近的项目。发送 /new 会使用默认工作目录：${defaultWorkDir}\n也可以发送 /new /path/to/project 指定项目。`)
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await sendText(chatId, `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n下次可直接 /new <编号、名称或绝对路径> 快速新建会话`)
  } catch (err) {
    await sendText(chatId, `无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  clearTransientChatState(chatId)
  pendingProjectSelection.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) await sendText(chatId, `已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} - ${p.realPath}`).join('\n')
        await sendText(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await sendText(chatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await sendText(chatId, err instanceof Error ? err.message : String(err))
    }
    return
  }

  const workDir = defaultWorkDir
  if (workDir) {
    const ok = await createSessionForChat(chatId, workDir)
    if (ok) await sendText(chatId, '已新建会话，可以开始对话了。')
  } else {
    await showProjectPicker(chatId)
  }
}

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const runtime = getRuntimeState(chatId)

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
        getBlockBuffer(chatId).append(msg.text)
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
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      let pending = pendingPermissions.get(chatId)
      if (!pending) {
        pending = new Set()
        pendingPermissions.set(chatId, pending)
      }
      pending.add(msg.requestId)
      typingController.stop(chatId)
      await sendText(
        chatId,
        `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n${formatPermissionInstructions(msg.requestId)}`,
      )
      break
    }
    case 'message_complete': {
      runtime.state = 'idle'
      runtime.verb = undefined
      typingController.stop(chatId)
      await blockBuffers.get(chatId)?.complete()
      blockBuffers.delete(chatId)
      break
    }
    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      typingController.stop(chatId)
      blockBuffers.get(chatId)?.reset()
      blockBuffers.delete(chatId)
      await sendText(chatId, `错误: ${msg.message}`)
      break
    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) runtime.model = model
      }
      break
  }
}

async function routeUserMessage(message: WechatMessage): Promise<void> {
  const chatId = message.from_user_id
  if (!chatId) return
  const messageKey = `${message.message_id ?? ''}:${message.seq ?? ''}:${message.create_time_ms ?? ''}`
  if (!dedup.tryRecord(messageKey)) return
  if (message.context_token) contextTokens.set(chatId, message.context_token)

  const text = extractWechatText(message.item_list).trim()
  const mediaCandidates = collectWechatMediaCandidates(message.item_list)
  if (!text && mediaCandidates.length === 0) return
  console.log(`[WeChat] Received from ${redactChatId(chatId)}: ${text.slice(0, 80)}`)

  if (!isAllowedUser('wechat', chatId)) {
    const success = text
      ? tryPair(text, { userId: chatId, displayName: 'WeChat User' }, 'wechat')
      : false
    await sendText(
      chatId,
      success
        ? '配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。发送 /help 查看可用命令。'
        : '未授权。请先在 Claude Code 桌面端完成微信扫码绑定，再生成 IM 配对码后发送给我。',
    )
    return
  }

  enqueueWechat(chatId, async () => {
    const hasAttachments = mediaCandidates.length > 0
    if (!hasAttachments && (text === '/help' || text === '帮助')) {
      await sendText(chatId, formatImHelp())
      return
    }
    if (!hasAttachments && (text === '/status' || text === '状态')) {
      await sendText(chatId, await buildStatusText(chatId))
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
    if (!hasAttachments && (text === '/stop' || text === '停止')) {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      bridge.sendStopGeneration(chatId)
      await sendText(chatId, '已发送停止信号。')
      return
    }
    if (!hasAttachments && (text === '/clear' || text === '清空')) {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      clearTransientChatState(chatId)
      const sent = bridge.sendUserMessage(chatId, '/clear')
      await sendText(chatId, sent ? '已清空当前会话上下文。' : '无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }
    const permissionDecision = !hasAttachments ? parsePermissionCommand(text, pendingPermissions.get(chatId)) : null
    if (permissionDecision) {
      const { requestId, allowed, rule } = permissionDecision
      const pending = pendingPermissions.get(chatId)
      if (!pending?.has(requestId)) {
        await sendText(chatId, `未找到待确认的权限请求：${requestId}`)
        return
      }
      const sent = bridge.sendPermissionResponse(chatId, requestId, allowed, rule)
      const runtime = getRuntimeState(chatId)
      if (sent) {
        runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
        pending.delete(requestId)
      }
      await sendText(chatId, sent ? `${formatPermissionDecisionStatus(permissionDecision)}。` : '权限响应发送失败，请检查会话状态。')
      return
    }
    if (!hasAttachments && pendingProjectSelection.has(chatId)) {
      await startNewSession(chatId, text)
      return
    }

    const ready = await ensureSession(chatId)
    if (!ready) return
    const attachments = await collectAttachments(chatId, mediaCandidates)
    const effectiveText = text || (attachments.length > 0 ? '(用户发送了附件)' : '')
    if (!effectiveText && attachments.length === 0) return
    typingController.start(chatId)
    const sent = bridge.sendUserMessage(chatId, effectiveText, attachments.length ? attachments : undefined)
    if (!sent) await sendText(chatId, '消息发送失败，连接可能已断开。请发送 /new 重新开始。')
  })
}

async function collectAttachments(
  chatId: string,
  candidates: ReturnType<typeof collectWechatMediaCandidates>,
): Promise<AttachmentRef[]> {
  if (candidates.length === 0) return []
  const stored = sessionStore.get(chatId)
  const sessionId = stored?.sessionId ?? chatId
  const settled = await Promise.allSettled(candidates.map((candidate) => media.downloadCandidate(candidate, sessionId)))
  const attachments: AttachmentRef[] = []
  let failures = 0
  for (const result of settled) {
    if (result.status === 'rejected') {
      failures += 1
      console.error('[WeChat] media download failed:', result.reason)
      continue
    }
    const local = result.value
    const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
    if (!check.ok) {
      await sendText(chatId, check.hint)
      continue
    }
    if (local.kind === 'image') {
      attachments.push({
        type: 'image',
        name: local.name,
        data: local.buffer.toString('base64'),
        mimeType: local.mimeType,
      })
    } else {
      attachments.push({
        type: 'file',
        name: local.name,
        path: local.path,
        mimeType: local.mimeType,
      })
    }
  }
  if (failures > 0) {
    await sendText(
      chatId,
      failures === candidates.length ? '附件下载失败，请稍后重试。' : `${failures} 个附件下载失败，已跳过。`,
    )
  }
  return attachments
}

async function pollLoop(): Promise<void> {
  while (!stopped) {
    try {
      const resp = await getWechatUpdates({
        baseUrl,
        token: botToken,
        getUpdatesBuf,
        timeoutMs: GET_UPDATES_TIMEOUT_MS,
      })
      if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf
      const hasRetError = typeof resp.ret === 'number' && resp.ret !== 0
      const hasErrCode = typeof resp.errcode === 'number' && resp.errcode !== 0
      if (hasRetError || hasErrCode) {
        console.warn(`[WeChat] getupdates error: ${resp.errcode ?? resp.ret} ${resp.errmsg ?? ''}`)
        await sleep(3000)
        continue
      }
      for (const msg of resp.msgs ?? []) {
        await routeUserMessage(msg)
      }
    } catch (err) {
      console.error('[WeChat] poll loop error:', err instanceof Error ? err.message : err)
      await sleep(3000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redactChatId(chatId: string): string {
  if (chatId.length <= 12) return chatId
  return `${chatId.slice(0, 6)}...${chatId.slice(-6)}`
}

console.log('[WeChat] Starting adapter...')
console.log(`[WeChat] Account: ${accountId}`)
void pollLoop()

process.on('SIGINT', () => {
  console.log('[WeChat] Shutting down...')
  stopped = true
  typingController.destroy()
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
