/**
 * Slack Adapter for Claude Code Desktop
 *
 * Runs the app in Socket Mode, so the desktop needs no public request URL —
 * the same property that makes the Feishu / WeCom / QQ adapters work from a
 * laptop. Credentials come from Desktop Settings → IM, or from
 * SLACK_BOT_TOKEN (`xoxb-…`) and SLACK_APP_TOKEN (`xapp-…`).
 *
 * 启动：SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... bun run slack/index.ts
 */

import { WsBridge, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { loadConfig } from '../common/config.js'
import { splitMessage } from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { createAdapterClient } from '../common/adapter-client.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import {
  attachmentKindForMime,
  imageExtensionForMime,
  inferMimeFromFileName,
} from '../common/attachment/mime.js'
import {
  ImChatRuntime,
  type ChatPort,
  type OutboundImage,
  type ResponseStream,
} from '../common/chat-runtime.js'
import { SlackApiClient } from './api.js'
import { SlackSocketMode } from './socket-mode.js'
import { extractSlackPayload, type SlackFile } from './extract-payload.js'

const SLACK_TEXT_LIMIT = 3_500
/** Slack rate-limits `chat.update` to roughly one call per second per channel. */
const SLACK_EDIT_INTERVAL_MS = 1_200

const config = loadConfig()
if (!config.slack.botToken || !config.slack.appToken) {
  console.error('[Slack] Missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN. Configure Slack in Desktop Settings > IM.')
  process.exit(1)
}

const api = new SlackApiClient(config.slack.botToken)
const bridge = new WsBridge(config.serverUrl, 'slack')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const { httpClient, defaultWorkDir } = createAdapterClient(config, config.slack)
const attachmentStore = new AttachmentStore()
attachmentStore.gc().catch((err) => {
  console.warn('[Slack] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

let botUserId: string | undefined
/** Bounded: `resolveDisplayName` runs for unpaired senders too, so an unbounded
 *  map would grow with every stranger who messages the bot. */
const displayNames = new Map<string, string>()
const DISPLAY_NAME_CACHE_LIMIT = 500

/** The thread the user last wrote in, so answers land where they asked. */
const replyThreads = new Map<string, string | undefined>()

async function sendChunkedText(chatId: string, text: string): Promise<void> {
  const threadTs = replyThreads.get(chatId)
  for (const chunk of splitMessage(text, SLACK_TEXT_LIMIT)) {
    await api.postMessage(chatId, chunk, threadTs)
  }
}

/**
 * One assistant turn rendered as a Slack message that edits in place.
 *
 * The first flush posts a message; later flushes edit it, throttled so a fast
 * stream cannot burn the per-channel `chat.update` budget. Text beyond Slack's
 * practical message length continues in follow-up messages, and the editing
 * target moves to the newest one so the tail keeps streaming.
 */
class SlackResponse implements ResponseStream {
  private messageTs: string | null = null
  private current = ''
  private pending = ''
  private lastEditAt = 0

  constructor(private readonly chatId: string) {}

  async append(delta: string): Promise<void> {
    if (!delta) return
    this.pending += delta

    const now = Date.now()
    if (this.messageTs && now - this.lastEditAt < SLACK_EDIT_INTERVAL_MS) return
    await this.render(now)
  }

  async finish(): Promise<void> {
    // Everything already rendered is on screen; only unflushed text is owed.
    if (!this.pending) return
    await this.render(Date.now())
  }

  private async render(now: number): Promise<void> {
    // What the open message currently shows, so a failure can resume from it
    // instead of re-posting text the user is already looking at.
    const displayed = this.messageTs ? this.current : ''
    const next = this.current + this.pending
    if (!next.trim()) {
      this.pending = ''
      return
    }
    this.pending = ''

    try {
      const chunks = splitMessage(next, SLACK_TEXT_LIMIT)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!
        const isLast = i === chunks.length - 1
        if (i === 0 && this.messageTs) {
          await api.updateMessage(this.chatId, this.messageTs, chunk)
        } else {
          this.messageTs = await api.postMessage(this.chatId, chunk, replyThreads.get(this.chatId))
        }
        // A chunk that is not the last one is sealed at its length limit; the
        // remainder continues in a fresh message rather than editing this one.
        if (!isLast) this.messageTs = null
      }
      this.current = chunks[chunks.length - 1]!
      this.lastEditAt = now
    } catch (err) {
      console.error('[Slack] Failed to render response:', err instanceof Error ? err.message : err)
      // Drop the edit target — a stale ts would fail every later update too —
      // and keep only the text that never made it onto the screen, so the
      // retry continues the answer instead of repeating its visible prefix.
      this.messageTs = null
      this.current = ''
      this.pending = next.slice(displayed.length)
    }
  }
}

const port: ChatPort = {
  platform: 'slack',
  logPrefix: '[Slack]',
  async sendNotice(chatId, text) {
    await sendChunkedText(chatId, text)
  },
  createResponse(chatId) {
    return new SlackResponse(chatId)
  },
  async sendImage(chatId, image: OutboundImage) {
    const check = checkAttachmentLimit('image', image.buffer.length, image.mime)
    if (!check.ok) {
      console.warn('[Slack] Outbound image rejected:', check.hint)
      return
    }
    await api.uploadFile({
      channel: chatId,
      buffer: image.buffer,
      filename: `claude-${Date.now()}.${imageExtensionForMime(image.mime)}`,
      title: image.alt,
      threadTs: replyThreads.get(chatId),
    })
  },
  clearChat(chatId) {
    replyThreads.delete(chatId)
  },
}

const runtime = new ImChatRuntime({
  port,
  config,
  platformConfig: config.slack,
  bridge,
  sessionStore,
  httpClient,
  defaultWorkDir,
  dedup,
  flushIntervalMs: 900,
  flushCharThreshold: 240,
})

async function resolveDisplayName(userId: string): Promise<string> {
  const cached = displayNames.get(userId)
  if (cached) return cached
  try {
    const info = await api.get<{ user?: { real_name?: string; name?: string } }>('users.info', {
      user: userId,
    })
    const name = info.user?.real_name?.trim() || info.user?.name?.trim() || userId
    if (displayNames.size >= DISPLAY_NAME_CACHE_LIMIT) {
      const oldest = displayNames.keys().next().value
      if (oldest !== undefined) displayNames.delete(oldest)
    }
    displayNames.set(userId, name)
    return name
  } catch {
    // users:read may be missing on an app installed from an older manifest.
    return userId
  }
}

async function collectAttachments(chatId: string, files: SlackFile[]): Promise<AttachmentRef[]> {
  if (files.length === 0) return []
  const sessionId = sessionStore.get(chatId)?.sessionId ?? chatId
  const refs: AttachmentRef[] = []
  let failures = 0

  for (const file of files) {
    try {
      const buffer = await api.downloadFile(file.url_private_download ?? file.url_private)
      const name = file.name?.trim() || file.title?.trim() || `slack-file-${file.id ?? Date.now()}`
      const mimeType = file.mimetype?.split(';')[0]?.trim()
        || inferMimeFromFileName(name)
        || 'application/octet-stream'
      const kind = attachmentKindForMime(mimeType)
      const check = checkAttachmentLimit(kind, buffer.length, mimeType)
      if (!check.ok) {
        await port.sendNotice(chatId, check.hint)
        continue
      }
      if (kind === 'image') {
        refs.push({ type: 'image', name, data: buffer.toString('base64'), mimeType })
        continue
      }
      const target = attachmentStore.resolvePath('slack', sessionId, name)
      const path = await attachmentStore.write(target, buffer)
      refs.push({ type: 'file', name, path, mimeType })
    } catch (err) {
      failures += 1
      console.error('[Slack] file download failed:', err instanceof Error ? err.message : err)
    }
  }

  if (failures > 0) {
    await port.sendNotice(
      chatId,
      failures === files.length ? '附件下载失败，请稍后重试。' : `${failures} 个附件下载失败，已跳过。`,
    )
  }
  return refs
}

const socket = new SlackSocketMode({
  openConnection: () => api.openSocketConnection(config.slack.appToken),
  logPrefix: '[Slack]',
  onEnvelope: (envelope) => {
    if (envelope.type !== 'events_api') return
    const payload = extractSlackPayload(envelope.payload?.event, { botUserId })
    if (!payload) return

    replyThreads.set(payload.chatId, payload.threadTs)

    void (async () => {
      try {
        await runtime.handleInbound({
          chatId: payload.chatId,
          userId: payload.userId,
          displayName: await resolveDisplayName(payload.userId),
          dedupKey: payload.dedupKey,
          text: payload.text,
          hasAttachments: payload.files.length > 0,
          loadAttachments: () => collectAttachments(payload.chatId, payload.files),
        })
      } catch (err) {
        console.error('[Slack] Failed to prepare inbound message:', err)
      }
    })()
  },
})

console.log('[Slack] Starting adapter...')
console.log(`[Slack] Server: ${config.serverUrl}`)

void (async () => {
  try {
    const identity = await api.authTest()
    botUserId = identity.userId || undefined
    console.log(`[Slack] Authenticated as ${botUserId ?? 'unknown bot user'}`)
  } catch (err) {
    console.error('[Slack] auth.test failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
  await socket.start()
})()

process.on('SIGINT', () => {
  console.log('[Slack] Shutting down...')
  socket.stop()
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
