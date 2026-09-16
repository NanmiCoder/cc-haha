/**
 * QQ Adapter for Claude Code Desktop
 *
 * Uses the official QQ Open Platform SDK (`@tencent-connect/qqbot-nodejs`) over
 * the WebSocket gateway, so no public callback URL is needed. Credentials
 * (`appId` / `appSecret`) come from the QR binding in Desktop Settings → IM,
 * or from QQ_APP_ID / QQ_APP_SECRET.
 *
 * 启动：QQ_APP_ID=xxx QQ_APP_SECRET=yyy bun run qq/index.ts
 */

import { MediaFileType, QQBot, type ReplyTarget, type StreamSession } from '@tencent-connect/qqbot-nodejs'
import { WsBridge, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { loadConfig } from '../common/config.js'
import { splitMessage } from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { createAdapterClient } from '../common/adapter-client.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import {
  ImChatRuntime,
  type ChatPort,
  type OutboundImage,
  type ResponseStream,
} from '../common/chat-runtime.js'
import { extractQqPayload, type QqInboundAttachment } from './extract-payload.js'
import { QqMediaService } from './media.js'

const QQ_TEXT_LIMIT = 1_500
/** QQ throttles stream frames; the SDK enforces a 300 ms floor of its own. */
const QQ_STREAM_THROTTLE_MS = 600
const TYPING_SECONDS = 30

const config = loadConfig()
if (!config.qq.appId || !config.qq.appSecret) {
  console.error('[QQ] Missing QQ_APP_ID / QQ_APP_SECRET. Bind QQ in Desktop Settings > IM.')
  process.exit(1)
}

const bot = new QQBot({
  appId: config.qq.appId,
  appSecret: config.qq.appSecret,
  accountId: config.qq.appId,
  transport: 'websocket',
  tokenPrefetch: 'sync',
  logger: {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => console.warn('[QQ][sdk]', ...args),
    error: (...args: unknown[]) => console.error('[QQ][sdk]', ...args),
  },
})

const bridge = new WsBridge(config.serverUrl, 'qq')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir } = createAdapterClient(config, config.qq)
const attachmentStore = new AttachmentStore()
const media = new QqMediaService(attachmentStore)
attachmentStore.gc().catch((err) => {
  console.warn('[QQ] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

/** Outbound QQ messages must name a peer, and a reply must also name the
 *  inbound message it answers. Both live in the last target we saw per chat. */
const replyTargets = new Map<string, ReplyTarget>()

function targetFor(chatId: string): ReplyTarget {
  return replyTargets.get(chatId) ?? { scope: 'c2c', targetId: chatId }
}

async function sendPlainText(chatId: string, text: string): Promise<void> {
  const target = targetFor(chatId)
  for (const chunk of splitMessage(text, QQ_TEXT_LIMIT)) {
    await bot.sendText(target, chunk)
  }
}

/**
 * One assistant turn rendered as a QQ C2C stream message.
 *
 * `stream_messages` is C2C-only and anchored to the inbound message id, so a
 * turn with no known reply anchor degrades to ordinary messages instead of
 * failing. `update()` takes the *full* text, so this class accumulates.
 */
class QqResponse implements ResponseStream {
  private session: StreamSession | null = null
  private accumulated = ''
  /** How much of `accumulated` the stream bubble already shows. */
  private streamed = 0
  private failed = false

  constructor(private readonly chatId: string) {
    const target = targetFor(chatId)
    if (target.scope !== 'c2c' || !target.msgId) return
    try {
      this.session = bot.openStream({ target, throttleMs: QQ_STREAM_THROTTLE_MS })
    } catch (err) {
      console.warn('[QQ] openStream failed:', err instanceof Error ? err.message : err)
    }
  }

  async append(delta: string): Promise<void> {
    if (!delta) return
    this.accumulated += delta
    if (!this.session || this.failed) return
    try {
      await this.session.update(this.accumulated)
      this.streamed = this.accumulated.length
    } catch (err) {
      // Fall back to discrete messages for the rest of the turn: retrying a
      // broken stream would drop the remaining text entirely.
      this.failed = true
      console.warn('[QQ] stream update failed:', err instanceof Error ? err.message : err)
    }
  }

  async finish(): Promise<void> {
    const session = this.session
    this.session = null

    if (session && !this.failed) {
      try {
        await session.complete()
        this.accumulated = ''
        return
      } catch (err) {
        console.warn('[QQ] stream complete failed:', err instanceof Error ? err.message : err)
      }
    }
    session?.cancel()
    // Only the tail the bubble never showed: re-sending the whole turn would
    // repeat everything the user already read above it.
    const remainder = this.accumulated.slice(this.streamed).trim()
    this.accumulated = ''
    if (remainder) await sendPlainText(this.chatId, remainder)
  }
}

const port: ChatPort = {
  platform: 'qq',
  logPrefix: '[QQ]',
  async sendNotice(chatId, text) {
    await sendPlainText(chatId, text)
  },
  createResponse(chatId) {
    return new QqResponse(chatId)
  },
  async sendImage(chatId, image: OutboundImage) {
    const check = checkAttachmentLimit('image', image.buffer.length, image.mime)
    if (!check.ok) {
      console.warn('[QQ] Outbound image rejected:', check.hint)
      return
    }
    await bot.sendMedia({
      target: targetFor(chatId),
      fileType: MediaFileType.IMAGE,
      buffer: image.buffer,
      content: image.alt,
    })
  },
  setBusy(chatId, busy) {
    if (!busy) return
    const target = targetFor(chatId)
    if (target.scope !== 'c2c') return
    // Typing is a courtesy signal; a failure must never surface to the user.
    void bot.sendTyping(target, TYPING_SECONDS).catch(() => {})
  },
  clearChat(chatId) {
    replyTargets.delete(chatId)
  },
}

const runtime = new ImChatRuntime({
  port,
  config,
  platformConfig: config.qq,
  bridge,
  sessionStore,
  httpClient,
  defaultWorkDir,
  dedup,
  flushIntervalMs: 600,
  flushCharThreshold: 200,
})

async function collectAttachments(
  chatId: string,
  attachments: QqInboundAttachment[],
  seed: string,
): Promise<AttachmentRef[]> {
  if (attachments.length === 0) return []
  const sessionId = sessionStore.get(chatId)?.sessionId ?? chatId
  const settled = await Promise.allSettled(
    attachments.map((attachment, index) =>
      media.downloadAttachment(attachment, sessionId, `${seed}-${index}`),
    ),
  )

  const refs: AttachmentRef[] = []
  let failures = 0
  for (const result of settled) {
    if (result.status === 'rejected') {
      failures += 1
      console.error('[QQ] attachment download failed:', result.reason)
      continue
    }
    const local = result.value
    const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
    if (!check.ok) {
      await port.sendNotice(chatId, check.hint)
      continue
    }
    refs.push(
      local.kind === 'image'
        ? { type: 'image', name: local.name, data: local.buffer.toString('base64'), mimeType: local.mimeType }
        : { type: 'file', name: local.name, path: local.path, mimeType: local.mimeType },
    )
  }
  if (failures > 0) {
    await port.sendNotice(
      chatId,
      failures === attachments.length ? '附件下载失败，请稍后重试。' : `${failures} 个附件下载失败，已跳过。`,
    )
  }
  return refs
}

bot.on('message', async (_ctx, message) => {
  const payload = extractQqPayload(message as never)
  if (!payload) return

  replyTargets.set(payload.chatId, {
    scope: 'c2c',
    targetId: payload.chatId,
    msgId: message.messageId,
  })

  await runtime.handleInbound({
    chatId: payload.chatId,
    userId: payload.userId,
    displayName: payload.displayName,
    dedupKey: payload.dedupKey,
    text: payload.text,
    hasAttachments: payload.attachments.length > 0,
    loadAttachments: () => collectAttachments(
      payload.chatId,
      payload.attachments,
      payload.dedupKey,
    ),
  })
})

bot.on('ready', () => console.log('[QQ] Gateway ready, bot is running!'))
bot.on('resumed', () => console.log('[QQ] Gateway session resumed'))
bot.on('error', (err: Error) => console.error('[QQ] Connection error:', err.message))

console.log('[QQ] Starting adapter...')
console.log(`[QQ] Server: ${config.serverUrl}`)
console.log(`[QQ] App: ${config.qq.appId}`)
void bot.start().catch((err) => {
  console.error('[QQ] Failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[QQ] Shutting down...')
  try {
    bot.stop()
  } catch {
    // Best-effort: the process is exiting either way.
  }
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
