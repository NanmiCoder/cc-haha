/**
 * WhatsApp Adapter for Claude Code Desktop
 *
 * Uses WhatsApp Web via Baileys. Link the account from Desktop Settings first,
 * then run: bun run whatsapp
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  normalizeMessageContent,
  type proto,
} from '@whiskeysockets/baileys'
import { WsBridge, type ServerMessage, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { getConfiguredWorkDir, loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  formatPermissionRequest,
} from '../common/format.js'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  parsePermissionCommand,
  type PermissionDecision,
} from '../common/permission.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { restoreStoredSessionBinding } from '../common/session-recovery.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import { ImageBlockWatcher } from '../common/attachment/image-block-watcher.js'
import type { PendingUpload } from '../common/attachment/attachment-types.js'
import {
  closeWhatsAppSocket,
  createWhatsAppSocket,
  hasWhatsAppAuth,
  isWhatsAppLoggedOut,
  type WhatsAppSocket,
} from './session.js'
import { WhatsAppMediaService } from './media.js'
import {
  buildWhatsAppThinkingPreview,
  formatWhatsAppOutboundText,
  splitWhatsAppText,
} from './format.js'

const WHATSAPP_TEXT_LIMIT = 4000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

const config = loadConfig()
const authDir = config.whatsapp.authDir
if (!hasWhatsAppAuth(authDir)) {
  console.error('[WhatsApp] No linked WhatsApp account found. Bind with QR in Desktop Settings first.')
  process.exit(1)
}

const bridge = new WsBridge(config.serverUrl, 'whatsapp')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const defaultWorkDir = getConfiguredWorkDir(config, config.whatsapp)
const httpClient = new AdapterHttpClient(config.serverUrl, { allowedProjectRoots: [defaultWorkDir] })
const attachmentStore = new AttachmentStore()
attachmentStore.gc().catch((err) => {
  console.warn('[WhatsApp] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

let sock: WhatsAppSocket
let media: WhatsAppMediaService
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let shuttingDown = false

const accumulatedText = new Map<string, string>()
const accumulatedThinkingText = new Map<string, string>()
const thinkingNotices = new Set<string>()
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()
const pendingPermissions = new Map<string, Set<string>>()
const imageWatchers = new Map<string, ImageBlockWatcher>()

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

function getImageWatcher(chatId: string): ImageBlockWatcher {
  let watcher = imageWatchers.get(chatId)
  if (!watcher) {
    watcher = new ImageBlockWatcher()
    imageWatchers.set(chatId, watcher)
  }
  return watcher
}

function clearTransientChatState(chatId: string): void {
  accumulatedText.delete(chatId)
  accumulatedThinkingText.delete(chatId)
  thinkingNotices.delete(chatId)
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
  pendingPermissions.delete(chatId)
  imageWatchers.delete(chatId)
}

async function sendWhatsAppText(jid: string, text: string): Promise<void> {
  const chunks = splitWhatsAppText(text, WHATSAPP_TEXT_LIMIT)
  for (const chunk of chunks) {
    await sock.sendMessage(jid, { text: chunk })
  }
}

async function sendHelp(jid: string): Promise<void> {
  await sendWhatsAppText(jid, `Claude Code WhatsApp 已就绪。\n\n${formatImHelp()}`)
}

async function handlePermissionDecision(chatId: string, decision: PermissionDecision): Promise<void> {
  const pending = pendingPermissions.get(chatId)
  if (!pending?.has(decision.requestId)) {
    await sendWhatsAppText(chatId, `未找到待确认的权限请求：${decision.requestId}`)
    return
  }

  const sent = bridge.sendPermissionResponse(chatId, decision.requestId, decision.allowed, decision.rule)
  if (sent) {
    pending.delete(decision.requestId)
    const runtime = getRuntimeState(chatId)
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
  }
  await sendWhatsAppText(
    chatId,
    sent ? `${formatPermissionDecisionStatus(decision)}。` : '权限响应发送失败，请检查会话状态。',
  )
}

async function ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
  return await restoreStoredSessionBinding({
    chatId,
    bridge,
    sessionStore,
    httpClient,
    onServerMessage: (msg) => handleServerMessage(chatId, msg),
    logPrefix: '[WhatsApp]',
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
    // best-effort status
  }

  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
  })
}

async function ensureSession(chatId: string): Promise<boolean> {
  const stored = await ensureExistingSession(chatId)
  if (stored) return true

  const workDir = defaultWorkDir
  if (workDir) {
    return await createSessionForChat(chatId, workDir)
  }

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    bridge.resetSession(chatId)
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendWhatsAppText(chatId, '连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendWhatsAppText(chatId, `无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendWhatsAppText(
        chatId,
        `没有找到最近的项目。发送 /new 会使用默认工作目录：${defaultWorkDir}\n也可以发送 /new /path/to/project 指定项目。`,
      )
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`,
    )
    pendingProjectSelection.set(chatId, true)
    await sendWhatsAppText(
      chatId,
      `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n下次可直接 /new <编号、名称或绝对路径> 快速新建会话`,
    )
  } catch (err) {
    await sendWhatsAppText(chatId, `无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function dispatchOutboundMedia(chatId: string, pending: PendingUpload): Promise<void> {
  try {
    let buffer: Buffer
    let mime = 'image/png'
    switch (pending.source.kind) {
      case 'base64':
        buffer = Buffer.from(pending.source.data, 'base64')
        mime = pending.source.mime
        break
      case 'path':
        buffer = await fs.readFile(pending.source.path)
        mime = pending.source.mime ?? 'image/png'
        break
      case 'url': {
        const resp = await fetch(pending.source.url)
        if (!resp.ok) throw new Error(`fetch ${pending.source.url} -> ${resp.status}`)
        buffer = Buffer.from(await resp.arrayBuffer())
        mime = pending.source.mime ?? resp.headers.get('content-type') ?? 'image/png'
        break
      }
    }
    const check = checkAttachmentLimit('image', buffer.length, mime)
    if (!check.ok) {
      console.warn('[WhatsApp] Outbound image rejected:', check.hint)
      return
    }
    await media.sendMedia(chatId, buffer, mime, pending.alt)
  } catch (err) {
    console.error('[WhatsApp] dispatchOutboundMedia failed:', err instanceof Error ? err.message : err)
  }
}

async function flushAccumulatedText(chatId: string): Promise<void> {
  const text = accumulatedText.get(chatId)
  if (!text?.trim()) {
    accumulatedText.delete(chatId)
    return
  }
  await sendWhatsAppText(chatId, formatWhatsAppOutboundText(text))
  accumulatedText.delete(chatId)
}

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const runtime = getRuntimeState(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      if (msg.state === 'thinking' && !thinkingNotices.has(chatId)) {
        thinkingNotices.add(chatId)
        await sendWhatsAppText(chatId, '思考中...')
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        accumulatedThinkingText.delete(chatId)
      }
      break

    case 'content_delta':
      if (msg.text) {
        accumulatedThinkingText.delete(chatId)
        accumulatedText.set(chatId, (accumulatedText.get(chatId) ?? '') + msg.text)
        const newUploads = getImageWatcher(chatId).feed(msg.text)
        for (const pending of newUploads) {
          void dispatchOutboundMedia(chatId, pending)
        }
      }
      break

    case 'thinking': {
      const update = buildWhatsAppThinkingPreview(
        accumulatedThinkingText.get(chatId) ?? '',
        msg.text ?? '',
      )
      accumulatedThinkingText.set(chatId, update.fullText)
      break
    }

    case 'permission_request': {
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      const pending = pendingPermissions.get(chatId) ?? new Set<string>()
      pending.add(msg.requestId)
      pendingPermissions.set(chatId, pending)
      const text = `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n${formatPermissionInstructions(msg.requestId)}`
      await sendWhatsAppText(chatId, text)
      break
    }

    case 'message_complete':
      runtime.state = 'idle'
      runtime.verb = undefined
      thinkingNotices.delete(chatId)
      accumulatedThinkingText.delete(chatId)
      await flushAccumulatedText(chatId)
      break

    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      thinkingNotices.delete(chatId)
      accumulatedThinkingText.delete(chatId)
      if (msg.message && /Invalid.*signature.*thinking/i.test(msg.message)) {
        const stored = sessionStore.get(chatId)
        const workDir = stored?.workDir || defaultWorkDir
        if (workDir) {
          await sendWhatsAppText(chatId, '会话上下文已失效，正在自动重建...')
          clearTransientChatState(chatId)
          bridge.resetSession(chatId)
          sessionStore.delete(chatId)
          const ok = await createSessionForChat(chatId, workDir)
          await sendWhatsAppText(chatId, ok ? '已重建会话，请重新发送消息。' : '重建会话失败，请发送 /new 手动新建。')
        } else {
          await sendWhatsAppText(chatId, '会话上下文已失效，请发送 /new 新建会话。')
        }
      } else {
        await sendWhatsAppText(chatId, `错误: ${msg.message}`)
      }
      break

    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) {
          runtime.model = model
        }
      }
      break
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  accumulatedText.delete(chatId)
  accumulatedThinkingText.delete(chatId)
  thinkingNotices.delete(chatId)
  pendingProjectSelection.delete(chatId)
  pendingPermissions.delete(chatId)
  runtimeStates.delete(chatId)
  imageWatchers.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) {
          await sendWhatsAppText(chatId, `已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} - ${p.realPath}`).join('\n')
        await sendWhatsAppText(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await sendWhatsAppText(chatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await sendWhatsAppText(chatId, `错误: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const workDir = defaultWorkDir
    if (workDir) {
      const ok = await createSessionForChat(chatId, workDir)
      if (ok) await sendWhatsAppText(chatId, '已新建会话，可以开始对话了。')
    } else {
      await showProjectPicker(chatId)
    }
  }
}

async function routeUserMessage(
  chatId: string,
  userId: string,
  displayName: string,
  text: string,
  attachments: AttachmentRef[],
): Promise<void> {
  if (!isAllowedUser('whatsapp', userId)) {
    const success = attachments.length === 0
      ? tryPair(text.trim(), { userId, displayName }, 'whatsapp')
      : false
    await sendWhatsAppText(
      chatId,
      success
        ? '配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。'
        : '未授权。请在 Claude Code 桌面端生成配对码后发送给我。',
    )
    return
  }

  enqueue(chatId, async () => {
    const command = text.trim()
    if (command === '/start' || command === '/help') {
      await sendHelp(chatId)
      return
    }
    if (command.startsWith('/new')) {
      await startNewSession(chatId, command.slice('/new'.length).trim() || undefined)
      return
    }
    if (command === '/projects') {
      await showProjectPicker(chatId)
      return
    }
    if (command === '/stop') {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendWhatsAppText(chatId, formatImStatus(null))
        return
      }
      bridge.sendStopGeneration(chatId)
      await sendWhatsAppText(chatId, '已发送停止信号。')
      return
    }
    if (command === '/status') {
      await sendWhatsAppText(chatId, await buildStatusText(chatId))
      return
    }
    if (command === '/clear') {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendWhatsAppText(chatId, formatImStatus(null))
        return
      }
      clearTransientChatState(chatId)
      const sent = bridge.sendUserMessage(chatId, '/clear')
      await sendWhatsAppText(chatId, sent ? '已清空当前会话上下文。' : '无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }

    const permissionDecision = attachments.length === 0
      ? parsePermissionCommand(text, pendingPermissions.get(chatId))
      : null
    if (permissionDecision) {
      await handlePermissionDecision(chatId, permissionDecision)
      return
    }

    if (pendingProjectSelection.has(chatId)) {
      if (text.trim()) await startNewSession(chatId, text.trim())
      return
    }

    const ready = await ensureSession(chatId)
    if (!ready) return
    const effective = text || (attachments.length > 0 ? '(用户发送了附件)' : '')
    if (!effective && attachments.length === 0) return
    const sent = bridge.sendUserMessage(chatId, effective, attachments.length ? attachments : undefined)
    if (!sent) {
      await sendWhatsAppText(chatId, '消息发送失败，连接可能已断开。请发送 /new 重新开始。')
    }
  })
}

async function collectAttachments(
  message: proto.IWebMessageInfo,
  chatId: string,
): Promise<{ attachments: AttachmentRef[]; rejections: string[] }> {
  const sessionId = sessionStore.get(chatId)?.sessionId ?? chatId
  const attachments: AttachmentRef[] = []
  const rejections: string[] = []
  try {
    const local = await media.downloadMessageMedia(message, sessionId)
    if (!local) return { attachments, rejections }
    const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
    if (!check.ok) {
      rejections.push(check.hint)
      return { attachments, rejections }
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
  } catch (err) {
    console.error('[WhatsApp] download media failed:', err instanceof Error ? err.message : err)
    rejections.push('附件下载失败，请稍后重试。')
  }
  return { attachments, rejections }
}

function extractText(raw: proto.IMessage | undefined): string {
  const msg = normalizeMessageContent(raw)
  if (!msg) return ''
  return msg.conversation
    ?? msg.extendedTextMessage?.text
    ?? msg.imageMessage?.caption
    ?? msg.videoMessage?.caption
    ?? msg.documentMessage?.caption
    ?? ''
}

function isDirectChat(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
}

async function handleIncomingMessage(message: proto.IWebMessageInfo): Promise<void> {
  const key = message.key
  if (!key) return
  const chatId = key.remoteJid
  const messageId = key.id
  if (!chatId || !messageId || key.fromMe) return
  if (chatId === 'status@broadcast' || chatId.endsWith('@broadcast') || !isDirectChat(chatId)) return
  if (!dedup.tryRecord(`${chatId}:${messageId}`)) return

  const text = extractText(message.message as proto.IMessage | undefined)
  const { attachments, rejections } = await collectAttachments(message, chatId)
  for (const rejection of rejections) {
    await sendWhatsAppText(chatId, rejection).catch(() => {})
  }
  if (!text.trim() && attachments.length === 0) return

  await sock.readMessages([{ remoteJid: chatId, id: messageId, fromMe: false }]).catch(() => {})
  await sock.sendPresenceUpdate('composing', chatId).catch(() => {})
  await routeUserMessage(
    chatId,
    chatId,
    message.pushName || chatId,
    text,
    attachments,
  )
}

async function startSocket(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  sock = await createWhatsAppSocket({ authDir })
  media = new WhatsAppMediaService(sock, attachmentStore)

  sock.ev.on('messages.upsert', ({ type, messages }) => {
    if (type !== 'notify') return
    for (const message of messages) {
      void handleIncomingMessage(message)
    }
  })

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      reconnectAttempts = 0
      const connectedId = sock.user?.id ?? config.whatsapp.accountJid ?? 'unknown'
      console.log(`[WhatsApp] Connected as ${connectedId}`)
      return
    }
    if (update.connection !== 'close' || shuttingDown) return
    if (isWhatsAppLoggedOut(update.lastDisconnect?.error)) {
      console.error('[WhatsApp] Account logged out. Rebind with QR in Desktop Settings.')
      process.exit(1)
    }
    scheduleReconnect()
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
  reconnectAttempts += 1
  console.warn(`[WhatsApp] Connection closed. Reconnecting in ${delay}ms...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startSocket().catch((err) => {
      console.error('[WhatsApp] Reconnect failed:', err instanceof Error ? err.message : err)
      scheduleReconnect()
    })
  }, delay)
}

console.log('[WhatsApp] Starting adapter...')
console.log(`[WhatsApp] Server: ${config.serverUrl}`)
console.log(`[WhatsApp] Auth dir: ${authDir}`)
console.log(`[WhatsApp] Allowed users: ${config.whatsapp.allowedUsers.length === 0 ? 'paired users only' : config.whatsapp.allowedUsers.join(', ')}`)

await startSocket()

process.on('SIGINT', () => {
  console.log('[WhatsApp] Shutting down...')
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  closeWhatsAppSocket(sock, 'SIGINT')
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
