/**
 * 企业微信 (Enterprise WeChat / WeCom) Adapter for Claude Code Desktop
 *
 * Uses the official 智能机器人 WebSocket channel (`@wecom/aibot-node-sdk`), so
 * no public callback URL is needed — the same shape as the Feishu adapter.
 * Credentials (`botId` / `secret`) come from the QR binding in Desktop
 * Settings → IM, or from WECOM_BOT_ID / WECOM_BOT_SECRET.
 *
 * 启动：WECOM_BOT_ID=xxx WECOM_BOT_SECRET=yyy bun run wecom/index.ts
 */

import * as crypto from 'node:crypto'
import { WSClient } from '@wecom/aibot-node-sdk'
import { WsBridge, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { loadConfig } from '../common/config.js'
import { splitMessageByBytes, utf8Length } from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { createAdapterClient } from '../common/adapter-client.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import { imageExtensionForMime } from '../common/attachment/mime.js'
import {
  ImChatRuntime,
  type ChatPort,
  type OutboundImage,
  type ResponseStream,
} from '../common/chat-runtime.js'
import { extractWecomPayload } from './extract-payload.js'
import { collectWecomMediaCandidates, WecomMediaService } from './media.js'

/** Platform cap is 20480 bytes per stream frame; leave room for the tail marker. */
const WECOM_STREAM_BYTE_LIMIT = 19_000
const WECOM_TEXT_BYTE_LIMIT = 4_000

const config = loadConfig()
if (!config.wecom.botId || !config.wecom.secret) {
  console.error('[WeCom] Missing WECOM_BOT_ID / WECOM_BOT_SECRET. Bind 企业微信 in Desktop Settings > IM.')
  process.exit(1)
}

const client = new WSClient({
  botId: config.wecom.botId,
  secret: config.wecom.secret,
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message: string, ...args: unknown[]) => console.warn('[WeCom][sdk]', message, ...args),
    error: (message: string, ...args: unknown[]) => console.error('[WeCom][sdk]', message, ...args),
  },
})

const bridge = new WsBridge(config.serverUrl, 'wecom')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir } = createAdapterClient(config, config.wecom)
const attachmentStore = new AttachmentStore()
const media = new WecomMediaService(attachmentStore, (url, aesKey) => client.downloadFile(url, aesKey))
attachmentStore.gc().catch((err) => {
  console.warn('[WeCom] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

/** Frames are the only way to reply *into* the message the user just sent.
 *  One per chat: a newer message supersedes the previous reply target. */
type ReplyFrame = { headers: { req_id: string; [key: string]: unknown } }
const replyFrames = new Map<string, ReplyFrame>()

async function sendMarkdown(chatId: string, text: string): Promise<void> {
  for (const chunk of splitMessageByBytes(text, WECOM_TEXT_BYTE_LIMIT)) {
    await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } })
  }
}

/**
 * One assistant turn rendered as a WeCom stream message.
 *
 * The platform updates a single bubble as long as every frame reuses the same
 * `streamId`, which is the closest thing WeCom has to Telegram's edit-in-place.
 * Two constraints shape this class: the reply must reference the inbound frame,
 * and one stream cannot exceed the per-frame byte cap — overflow continues as
 * ordinary proactive messages instead of being silently truncated.
 */
class WecomResponse implements ResponseStream {
  private readonly streamId = crypto.randomUUID().replace(/-/g, '')
  private readonly frame: ReplyFrame | undefined
  private streamed = ''
  private overflow = ''
  private streamStarted = false
  private streamClosed = false

  constructor(private readonly chatId: string) {
    this.frame = replyFrames.get(chatId)
  }

  async append(delta: string): Promise<void> {
    if (!delta) return
    if (this.streamClosed) {
      this.overflow += delta
      return
    }

    const next = this.streamed + delta
    if (utf8Length(next) > WECOM_STREAM_BYTE_LIMIT) {
      // Close the bubble at the last frame that fit, then keep going below it.
      await this.flushStream(true)
      this.streamClosed = true
      this.overflow += delta
      return
    }

    this.streamed = next
    // Skip an intermediate frame while the previous one is still unacked —
    // the SDK queues them, and a backlog turns streaming into a slideshow.
    if (this.frame && client.hasPendingReplyAck(this.frame)) return
    await this.flushStream(false)
  }

  async finish(): Promise<void> {
    if (!this.streamClosed) {
      await this.flushStream(true)
      this.streamClosed = true
    }
    const tail = this.overflow.trim()
    this.overflow = ''
    if (tail) await sendMarkdown(this.chatId, tail)
  }

  private async flushStream(finished: boolean): Promise<void> {
    // An empty turn (tool-only) has nothing to show and no bubble to close.
    if (!this.streamStarted && !this.streamed.trim()) return
    if (!this.frame) {
      // No inbound frame to attach to (e.g. a reconnect replayed the stream).
      // Fall back to a proactive message at the end rather than dropping text.
      if (finished && this.streamed.trim()) await sendMarkdown(this.chatId, this.streamed)
      return
    }
    try {
      await client.replyStream(this.frame, this.streamId, this.streamed, finished)
      this.streamStarted = true
    } catch (err) {
      console.warn('[WeCom] replyStream failed:', err instanceof Error ? err.message : err)
      if (finished && this.streamed.trim()) {
        await sendMarkdown(this.chatId, this.streamed).catch((sendErr) => {
          console.error('[WeCom] stream fallback send failed:', sendErr)
        })
      }
    }
  }
}

const port: ChatPort = {
  platform: 'wecom',
  logPrefix: '[WeCom]',
  async sendNotice(chatId, text) {
    await sendMarkdown(chatId, text)
  },
  createResponse(chatId) {
    return new WecomResponse(chatId)
  },
  async sendImage(chatId, image: OutboundImage) {
    const check = checkAttachmentLimit('image', image.buffer.length, image.mime)
    if (!check.ok) {
      console.warn('[WeCom] Outbound image rejected:', check.hint)
      return
    }
    const filename = `claude-${Date.now()}.${imageExtensionForMime(image.mime)}`
    const uploaded = await client.uploadMedia(image.buffer, { type: 'image', filename })
    const mediaId = (uploaded as { media_id?: string })?.media_id
    if (!mediaId) throw new Error('Enterprise WeChat upload returned no media_id')
    await client.sendMediaMessage(chatId, 'image', mediaId)
  },
  clearChat(chatId) {
    replyFrames.delete(chatId)
  },
}

const runtime = new ImChatRuntime({
  port,
  config,
  platformConfig: config.wecom,
  bridge,
  sessionStore,
  httpClient,
  defaultWorkDir,
  dedup,
  // The bubble updates in place, so flushing often is cheap and looks live.
  flushIntervalMs: 500,
  flushCharThreshold: 160,
})

async function collectAttachments(
  chatId: string,
  candidates: ReturnType<typeof collectWecomMediaCandidates>,
): Promise<AttachmentRef[]> {
  if (candidates.length === 0) return []
  const sessionId = sessionStore.get(chatId)?.sessionId ?? chatId
  const settled = await Promise.allSettled(
    candidates.map((candidate) => media.downloadCandidate(candidate, sessionId)),
  )

  const attachments: AttachmentRef[] = []
  let failures = 0
  for (const result of settled) {
    if (result.status === 'rejected') {
      failures += 1
      console.error('[WeCom] media download failed:', result.reason)
      continue
    }
    const local = result.value
    const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
    if (!check.ok) {
      await port.sendNotice(chatId, check.hint)
      continue
    }
    attachments.push(
      local.kind === 'image'
        ? { type: 'image', name: local.name, data: local.buffer.toString('base64'), mimeType: local.mimeType }
        : { type: 'file', name: local.name, path: local.path, mimeType: local.mimeType },
    )
  }
  if (failures > 0) {
    await port.sendNotice(
      chatId,
      failures === candidates.length ? '附件下载失败，请稍后重试。' : `${failures} 个附件下载失败，已跳过。`,
    )
  }
  return attachments
}

client.on('message', (frame) => {
  const payload = extractWecomPayload(frame?.body)
  if (!payload) return

  replyFrames.set(payload.chatId, frame as ReplyFrame)
  const candidates = collectWecomMediaCandidates(frame?.body)

  void runtime.handleInbound({
    chatId: payload.chatId,
    userId: payload.userId,
    displayName: payload.userId,
    dedupKey: payload.dedupKey,
    text: payload.text,
    hasAttachments: candidates.length > 0,
    loadAttachments: () => collectAttachments(payload.chatId, candidates),
  })
})

client.on('authenticated', () => console.log('[WeCom] Authenticated, bot is running!'))
client.on('disconnected', (reason: string) => console.warn(`[WeCom] Disconnected: ${reason}`))
client.on('reconnecting', (attempt: number) => console.log(`[WeCom] Reconnecting (attempt ${attempt})`))
client.on('error', (err: Error) => console.error('[WeCom] Connection error:', err.message))

console.log('[WeCom] Starting adapter...')
console.log(`[WeCom] Server: ${config.serverUrl}`)
console.log(`[WeCom] Bot: ${config.wecom.botId}`)
client.connect()

process.on('SIGINT', () => {
  console.log('[WeCom] Shutting down...')
  try {
    client.disconnect()
  } catch {
    // Best-effort: the process is exiting either way.
  }
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
