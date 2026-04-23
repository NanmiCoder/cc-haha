/**
 * Telegram Adapter for Claude Code Desktop
 *
 * 基于 grammY 的轻量 Telegram Bot，直连服务端 /ws/:sessionId。
 * 启动：TELEGRAM_BOT_TOKEN=xxx bun run telegram/index.ts
 */

import { Bot, InlineKeyboard, type Context } from 'grammy'
import * as path from 'node:path'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageBuffer } from '../common/message-buffer.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  formatPermissionRequest,
  splitMessage,
} from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'
import { TelegramMediaService } from './media.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import type { AttachmentRef } from '../common/ws-bridge.js'
import { ImageBlockWatcher } from '../common/attachment/image-block-watcher.js'
import type { PendingUpload } from '../common/attachment/attachment-types.js'
import * as fs from 'node:fs/promises'

const TELEGRAM_TEXT_LIMIT = 4000 // leave margin below 4096

// ---------- init ----------

const config = loadConfig()
if (!config.telegram.botToken) {
  console.error('[Telegram] Missing TELEGRAM_BOT_TOKEN. Set env or ~/.claude/adapters.json')
  process.exit(1)
}

const bot = new Bot(config.telegram.botToken)
const bridge = new WsBridge(config.serverUrl, 'tg')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)
const attachmentStore = new AttachmentStore()
const media = new TelegramMediaService(bot, attachmentStore)
attachmentStore.gc().catch((err) => {
  console.warn('[Telegram] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

// Track placeholder messages for streaming updates
const placeholders = new Map<string, { chatId: string; messageId: number }>()
// Track accumulated text per chat for streaming
const accumulatedText = new Map<string, string>()
// Message buffers per chat
const buffers = new Map<string, MessageBuffer>()
// Track chats waiting for project selection
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()
/** Per-chat outbound image watcher for Agent-produced markdown images. */
const tgImageWatchers = new Map<string, ImageBlockWatcher>()

function getTgWatcher(chatId: string): ImageBlockWatcher {
  let w = tgImageWatchers.get(chatId)
  if (!w) {
    w = new ImageBlockWatcher()
    tgImageWatchers.set(chatId, w)
  }
  return w
}

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

// ---------- helpers ----------

function getBuffer(chatId: string): MessageBuffer {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = new MessageBuffer(async (text, isComplete) => {
      await flushToTelegram(chatId, text, isComplete)
    })
    buffers.set(chatId, buf)
  }
  return buf
}

function getRuntimeState(chatId: string): ChatRuntimeState {
  let state = runtimeStates.get(chatId)
  if (!state) {
    state = { state: 'idle', pendingPermissionCount: 0 }
    runtimeStates.set(chatId, state)
  }
  return state
}

function clearTransientChatState(chatId: string): void {
  placeholders.delete(chatId)
  accumulatedText.delete(chatId)
  buffers.get(chatId)?.reset()
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
  tgImageWatchers.delete(chatId)
}

async function ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
  const stored = sessionStore.get(chatId)
  if (!stored) return null

  if (!bridge.hasSession(chatId)) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) return null
  }

  return stored
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
    // Ignore git lookup failures and fall back to stored workDir
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
    // Ignore task lookup failures in IM status summary
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

async function flushToTelegram(chatId: string, newText: string, isComplete: boolean): Promise<void> {
  const numericChatId = Number(chatId)
  const prev = accumulatedText.get(chatId) ?? ''
  const fullText = prev + newText
  accumulatedText.set(chatId, fullText)

  const placeholder = placeholders.get(chatId)

  if (placeholder) {
    if (isComplete) {
      const chunks = splitMessage(fullText, TELEGRAM_TEXT_LIMIT)
      try {
        await bot.api.editMessageText(numericChatId, placeholder.messageId, chunks[0]!)
      } catch { /* ignore */ }
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(numericChatId, chunks[i]!)
      }
    } else {
      const displayText = fullText.slice(0, TELEGRAM_TEXT_LIMIT - 2) + ' ▍'
      try {
        await bot.api.editMessageText(numericChatId, placeholder.messageId, displayText)
      } catch { /* ignore */ }
    }
  } else if (isComplete && fullText.trim()) {
    const chunks = splitMessage(fullText, TELEGRAM_TEXT_LIMIT)
    for (const chunk of chunks) {
      await bot.api.sendMessage(numericChatId, chunk)
    }
  }

  if (isComplete) {
    placeholders.delete(chatId)
    accumulatedText.delete(chatId)
    buffers.get(chatId)?.reset()
  }
}

// ---------- session management ----------

async function ensureSession(chatId: string): Promise<boolean> {
  if (bridge.hasSession(chatId)) return true

  const stored = sessionStore.get(chatId)
  if (stored) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    return await bridge.waitForOpen(chatId)
  }

  const workDir = config.defaultProjectDir
  if (workDir) {
    return await createSessionForChat(chatId, workDir)
  }

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  const numericChatId = Number(chatId)
  try {
    // Always tear down any stale WS connection before creating a new session.
    // Without this, bridge.connectSession() below would short-circuit when an
    // old OPEN connection still exists, leaving messages routed to the old session.
    bridge.resetSession(chatId)

    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await bot.api.sendMessage(numericChatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await bot.api.sendMessage(numericChatId,
      `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  const numericChatId = Number(chatId)
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await bot.api.sendMessage(numericChatId,
        '没有找到最近的项目。请先在 Desktop App 中打开一个项目，或在 Settings → IM 接入中配置默认项目。')
      return
    }

    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
    )
    pendingProjectSelection.set(chatId, true)
    await bot.api.sendMessage(numericChatId,
      `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n💡 下次可直接 /new <编号或名称> 快速新建会话`)
  } catch (err) {
    await bot.api.sendMessage(numericChatId,
      `❌ 无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------- outbound media dispatch ----------

/** Upload a PendingUpload found in streaming output and send it via
 *  bot.api.sendPhoto as an independent message. Runs fire-and-forget
 *  from the stream handler so streaming text isn't blocked. */
async function dispatchOutboundMedia(chatId: string, pending: PendingUpload): Promise<void> {
  const numericChatId = Number(chatId)
  try {
    let buffer: Buffer
    let mime = 'image/png'
    switch (pending.source.kind) {
      case 'base64': {
        buffer = Buffer.from(pending.source.data, 'base64')
        mime = pending.source.mime
        break
      }
      case 'path': {
        buffer = await fs.readFile(pending.source.path)
        mime = pending.source.mime ?? 'image/png'
        break
      }
      case 'url': {
        const resp = await fetch(pending.source.url)
        if (!resp.ok) {
          throw new Error(`fetch ${pending.source.url} -> ${resp.status}`)
        }
        buffer = Buffer.from(await resp.arrayBuffer())
        mime = pending.source.mime ?? resp.headers.get('content-type') ?? 'image/png'
        break
      }
    }
    const check = checkAttachmentLimit('image', buffer.length, mime)
    if (!check.ok) {
      console.warn('[Telegram] Outbound image rejected:', check.hint)
      return
    }
    await media.sendPhoto(numericChatId, buffer, pending.alt)
  } catch (err) {
    console.error(
      '[Telegram] dispatchOutboundMedia failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const numericChatId = Number(chatId)
  const buf = getBuffer(chatId)
  const runtime = getRuntimeState(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      if (msg.state === 'thinking' && !placeholders.has(chatId)) {
        const sent = await bot.api.sendMessage(numericChatId, '💭 思考中...')
        placeholders.set(chatId, { chatId, messageId: sent.message_id })
        accumulatedText.set(chatId, '')
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        if (!placeholders.has(chatId)) {
          const sent = await bot.api.sendMessage(numericChatId, '▍')
          placeholders.set(chatId, { chatId, messageId: sent.message_id })
          accumulatedText.set(chatId, '')
        }
      } else if (msg.blockType === 'tool_use') {
        // Finalize current text placeholder before tool calls,
        // so text after tools gets a fresh message
        await buf.complete()
        // If placeholder still exists (buffer was already empty), clean up directly
        if (placeholders.has(chatId)) {
          const text = accumulatedText.get(chatId)
          if (text?.trim()) {
            try {
              await bot.api.editMessageText(numericChatId, placeholders.get(chatId)!.messageId, text)
            } catch { /* ignore */ }
          }
          placeholders.delete(chatId)
          accumulatedText.delete(chatId)
          buffers.get(chatId)?.reset()
        }
      }
      break

    case 'content_delta':
      if (msg.text) {
        buf.append(msg.text)
        const newUploads = getTgWatcher(chatId).feed(msg.text)
        for (const pending of newUploads) {
          void dispatchOutboundMedia(chatId, pending)
        }
      }
      break

    case 'thinking':
      if (placeholders.has(chatId)) {
        try {
          await bot.api.editMessageText(
            numericChatId,
            placeholders.get(chatId)!.messageId,
            `💭 ${msg.text.slice(0, 200)}...`,
          )
        } catch { /* ignore */ }
      }
      break

    case 'tool_use_complete':
      // Tool details are noise for IM users; visible in Desktop if needed.
      break

    case 'tool_result':
      // Tool errors are handled internally by the AI (retries etc.)
      // No need to notify the user for every failed attempt.
      break

    case 'permission_request': {
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      const text = formatPermissionRequest(msg.toolName, msg.input, msg.requestId)
      const keyboard = new InlineKeyboard()
        .text('✅ 允许', `permit:${msg.requestId}:yes`)
        .text('❌ 拒绝', `permit:${msg.requestId}:no`)
      await bot.api.sendMessage(numericChatId, text, { reply_markup: keyboard })
      break
    }

    case 'message_complete':
      runtime.state = 'idle'
      runtime.verb = undefined
      await buf.complete()
      // Ensure placeholder is always cleaned up even if buffer was already empty
      if (placeholders.has(chatId)) {
        const text = accumulatedText.get(chatId)
        if (text?.trim()) {
          try {
            const chunks = splitMessage(text, TELEGRAM_TEXT_LIMIT)
            await bot.api.editMessageText(numericChatId, placeholders.get(chatId)!.messageId, chunks[0]!)
            for (let i = 1; i < chunks.length; i++) {
              await bot.api.sendMessage(numericChatId, chunks[i]!)
            }
          } catch { /* ignore */ }
        }
        placeholders.delete(chatId)
        accumulatedText.delete(chatId)
        buffers.get(chatId)?.reset()
      }
      break

    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      // Auto-recover from stale thinking block signatures by creating a fresh session.
      // This happens when the API key or provider changed since the session was created.
      if (msg.message && /Invalid.*signature.*thinking/i.test(msg.message)) {
        const stored = sessionStore.get(chatId)
        const workDir = stored?.workDir || config.defaultProjectDir
        if (workDir) {
          await bot.api.sendMessage(numericChatId, '⚠️ 会话上下文已失效，正在自动重建...')
          clearTransientChatState(chatId)
          bridge.resetSession(chatId)
          sessionStore.delete(chatId)
          const ok = await createSessionForChat(chatId, workDir)
          if (ok) {
            await bot.api.sendMessage(numericChatId, '✅ 已重建会话，请重新发送消息。')
          } else {
            await bot.api.sendMessage(numericChatId, '❌ 重建会话失败，请发送 /new 手动新建。')
          }
        } else {
          await bot.api.sendMessage(numericChatId, '⚠️ 会话上下文已失效，请发送 /new 新建会话。')
        }
      } else {
        await bot.api.sendMessage(numericChatId, `❌ ${msg.message}`)
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

// ---------- bot handlers ----------

async function sendHelp(ctx: Context): Promise<void> {
  await ctx.reply(`👋 Claude Code Bot 已就绪。\n\n${formatImHelp()}`)
}

bot.command('start', (ctx) => void sendHelp(ctx))
bot.command('help', (ctx) => void sendHelp(ctx))

/** Reset session state and start a new session for chatId.
 *  If `query` is provided, match a project by index or name;
 *  otherwise use defaultProjectDir or show the picker. */
async function startNewSession(chatId: string, query?: string): Promise<void> {
  const numericChatId = Number(chatId)

  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  placeholders.delete(chatId)
  accumulatedText.delete(chatId)
  buffers.get(chatId)?.reset()
  buffers.delete(chatId)
  pendingProjectSelection.delete(chatId)
  runtimeStates.delete(chatId)
  tgImageWatchers.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) {
          await bot.api.sendMessage(numericChatId,
            `✅ 已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`)
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} — ${p.realPath}`).join('\n')
        await bot.api.sendMessage(numericChatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await bot.api.sendMessage(numericChatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await bot.api.sendMessage(numericChatId,
        `❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const workDir = config.defaultProjectDir
    if (workDir) {
      const ok = await createSessionForChat(chatId, workDir)
      if (ok) {
        await bot.api.sendMessage(numericChatId, '✅ 已新建会话，可以开始对话了。')
      }
    } else {
      await showProjectPicker(chatId)
    }
  }
}

bot.command('new', async (ctx) => {
  const chatId = String(ctx.chat.id)
  await startNewSession(chatId, ctx.match?.trim() || undefined)
})

bot.command('projects', async (ctx) => {
  const chatId = String(ctx.chat.id)
  await showProjectPicker(chatId)
})

bot.command('stop', (ctx) => {
  const chatId = String(ctx.chat.id)
  void (async () => {
    const stored = await ensureExistingSession(chatId)
    if (!stored) {
      await ctx.reply(formatImStatus(null))
      return
    }
    bridge.sendStopGeneration(chatId)
    await ctx.reply('⏹ 已发送停止信号。')
  })()
})

bot.command('status', async (ctx) => {
  const chatId = String(ctx.chat.id)
  await ctx.reply(await buildStatusText(chatId))
})

bot.command('clear', (ctx) => {
  const chatId = String(ctx.chat.id)
  void (async () => {
    const stored = await ensureExistingSession(chatId)
    if (!stored) {
      await ctx.reply(formatImStatus(null))
      return
    }
    clearTransientChatState(chatId)
    const sent = bridge.sendUserMessage(chatId, '/clear')
    if (!sent) {
      await ctx.reply('⚠️ 无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }
    await ctx.reply('🧹 已清空当前会话上下文。')
  })()
})

/** Shared per-user-message pipeline: dedup, pairing check, project-pick
 *  routing, enqueue, ensureSession, sendUserMessage with attachments.
 *  Caller has already extracted text and attachments from the context. */
async function routeUserMessage(
  ctx: Context,
  text: string,
  attachments: AttachmentRef[],
): Promise<void> {
  if (!ctx.from || ctx.chat?.type !== 'private') return
  if (!dedup.tryRecord(String(ctx.message?.message_id))) return

  const chatId = String(ctx.chat.id)
  const userId = ctx.from.id

  if (!isAllowedUser('telegram', userId)) {
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    const success = tryPair(text.trim(), { userId, displayName }, 'telegram')
    if (success) {
      await ctx.reply('✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
    } else {
      await ctx.reply('🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
    }
    return
  }

  enqueue(chatId, async () => {
    if (pendingProjectSelection.has(chatId)) {
      if (text.trim()) await startNewSession(chatId, text.trim())
      return
    }
    const ready = await ensureSession(chatId)
    if (!ready) return
    const effective =
      text || (attachments.length > 0 ? '(用户发送了附件)' : '')
    if (!effective && attachments.length === 0) return
    const sent = bridge.sendUserMessage(chatId, effective, attachments.length ? attachments : undefined)
    if (!sent) {
      await bot.api.sendMessage(Number(chatId), '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
    }
  })
}

/** Scan ctx.message for photo/document/video/audio/voice, download
 *  each via TelegramMediaService, apply size/mime limits, and produce
 *  a ready-to-send AttachmentRef[] plus any rejection hints. */
async function collectAttachmentsFromCtx(
  ctx: Context,
): Promise<{ attachments: AttachmentRef[]; rejections: string[] }> {
  const msg = ctx.message
  if (!msg || !ctx.chat) return { attachments: [], rejections: [] }
  const sessionId = sessionStore.get(String(ctx.chat.id))?.sessionId ?? String(ctx.chat.id)
  const attachments: AttachmentRef[] = []
  const rejections: string[] = []

  const runOne = async (
    fileId: string,
    fileName?: string,
    mimeType?: string,
  ): Promise<void> => {
    try {
      const local = await media.downloadFile(fileId, sessionId, { fileName, mimeType })
      const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
      if (!check.ok) {
        rejections.push(check.hint)
        return
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
      console.error('[Telegram] downloadFile failed:', err)
      rejections.push('📎 附件下载失败,请稍后重试')
    }
  }

  // Photos: grammY exposes an array of sizes, largest last.
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!
    await runOne(largest.file_id, `photo-${largest.file_unique_id}.jpg`, 'image/jpeg')
  }
  if (msg.document) {
    await runOne(msg.document.file_id, msg.document.file_name, msg.document.mime_type)
  }
  if (msg.video) {
    await runOne(msg.video.file_id, msg.video.file_name, msg.video.mime_type)
  }
  if (msg.audio) {
    await runOne(msg.audio.file_id, msg.audio.file_name, msg.audio.mime_type)
  }
  if (msg.voice) {
    await runOne(
      msg.voice.file_id,
      `voice-${msg.voice.file_unique_id}.ogg`,
      msg.voice.mime_type ?? 'audio/ogg',
    )
  }

  return { attachments, rejections }
}

bot.on('message:text', async (ctx) => {
  await routeUserMessage(ctx, ctx.message.text, [])
})

bot.on(
  ['message:photo', 'message:document', 'message:video', 'message:audio', 'message:voice'],
  async (ctx) => {
    const caption = ctx.message.caption ?? ''
    const { attachments, rejections } = await collectAttachmentsFromCtx(ctx)
    for (const r of rejections) {
      await ctx.reply(r).catch(() => {})
    }
    if (attachments.length === 0 && !caption.trim()) return
    await routeUserMessage(ctx, caption, attachments)
  },
)

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data
  if (!data.startsWith('permit:')) return

  const parts = data.split(':')
  if (parts.length !== 3) return

  const requestId = parts[1]!
  const allowed = parts[2] === 'yes'
  const chatId = String(ctx.callbackQuery.message?.chat.id)

  bridge.sendPermissionResponse(chatId, requestId, allowed)
  const runtime = getRuntimeState(chatId)
  runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)

  const statusText = allowed ? '✅ 已允许' : '❌ 已拒绝'
  try {
    await ctx.editMessageText(
      ctx.callbackQuery.message?.text + `\n\n${statusText}`,
    )
  } catch { /* ignore */ }

  await ctx.answerCallbackQuery(statusText)
})

// ---------- start ----------

console.log('[Telegram] Starting bot...')
console.log(`[Telegram] Server: ${config.serverUrl}`)
console.log(`[Telegram] Allowed users: ${config.telegram.allowedUsers.length === 0 ? 'all' : config.telegram.allowedUsers.join(', ')}`)

bot.start({
  onStart: () => console.log('[Telegram] Bot is running!'),
})

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Telegram] Shutting down...')
  bot.stop()
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
