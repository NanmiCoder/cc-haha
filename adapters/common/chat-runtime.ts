/**
 * Shared IM chat runtime.
 *
 * Telegram / Feishu / WeChat / DingTalk / WhatsApp each grew their own copy of
 * the same loop: pair the sender, route slash commands, restore or create the
 * session, forward the message, then translate the server's stream back into
 * platform messages. Every copy has independently regressed at least once.
 *
 * This module owns that loop once. A platform supplies a {@link ChatPort} —
 * how to say something, how to open a streaming reply, optionally how to send
 * an image — and keeps its transport, auth and media details to itself. The
 * runtime never imports a platform SDK, so it is testable with a fake port.
 *
 * The port, not the runtime, remembers per-chat reply context (a WeCom frame's
 * `req_id`, a QQ inbound `msgId`, a Slack `thread_ts`): those are platform
 * concepts with platform lifetimes.
 */

import * as path from 'node:path'
import { enqueue } from './chat-queue.js'
import {
  getConfiguredWorkDir,
  type AdapterConfig,
  type AdapterPlatformConfig,
} from './config.js'
import { formatImHelp, formatImStatus, formatPermissionRequest } from './format.js'
import type { AdapterHttpClient } from './http-client.js'
import { MessageBuffer } from './message-buffer.js'
import type { MessageDedup } from './message-dedup.js'
import { isAllowedUser, tryPair, type ImPlatform } from './pairing.js'
import {
  formatPermissionDecisionStatus,
  formatPermissionInstructions,
  parsePermissionCommand,
  type PermissionDecision,
} from './permission.js'
import { restoreStoredSessionBinding } from './session-recovery.js'
import { SessionSelectionController } from './session-selection.js'
import { syncImPermissionState } from './permission-sync.js'
import type { SessionStore } from './session-store.js'
import type { AttachmentRef, ServerMessage, WsBridge } from './ws-bridge.js'
import { ImageBlockWatcher } from './attachment/image-block-watcher.js'
import { loadSafeOutboundImage } from './attachment/outbound-image.js'
import type { PendingUpload } from './attachment/attachment-types.js'

export type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

/** One assistant turn's outbound presentation. */
export interface ResponseStream {
  /** Incremental text. Called in order; the runtime batches deltas first. */
  append(delta: string): Promise<void>
  /** Last call for this turn. Always called exactly once per stream. */
  finish(): Promise<void>
}

export type OutboundImage = {
  buffer: Buffer
  mime: string
  alt?: string
}

export interface ChatPort {
  platform: ImPlatform
  /** Log tag, e.g. `[WeCom]`. */
  logPrefix: string
  /** Human label used in pairing / authorization copy. */
  displayName?: string
  /** Out-of-band message: command output, permission prompt, error. */
  sendNotice(chatId: string, text: string): Promise<void>
  /** Open the presentation for one assistant turn. */
  createResponse(chatId: string): ResponseStream
  /** Optional: outbound image found in the Agent's markdown output. */
  sendImage?(chatId: string, image: OutboundImage): Promise<void>
  /** Optional: typing indicator / busy state. */
  setBusy?(chatId: string, busy: boolean): void
  /** Optional: platform teardown for a chat (e.g. drop cached reply context). */
  clearChat?(chatId: string): void
}

/** One inbound user message, already normalized by the platform adapter. */
export type InboundChatMessage = {
  chatId: string
  userId: string | number
  displayName: string
  /** Stable per-message identity used for replay dedup. */
  dedupKey: string
  text: string
  attachments?: AttachmentRef[]
  /**
   * Deferred attachment download.
   *
   * Called only after dedup and the pairing gate have passed, and from inside
   * the per-chat queue. Downloading before that lets an unpaired stranger make
   * the adapter fetch bytes and write them under `~/.claude/im-downloads/`, and
   * lets a slow attachment overtake a text message sent after it.
   */
  loadAttachments?: () => Promise<AttachmentRef[]>
  /** Whether attachments exist, known before they are downloaded. */
  hasAttachments?: boolean
}

export type ImChatRuntimeOptions = {
  port: ChatPort
  config: AdapterConfig
  platformConfig: AdapterPlatformConfig
  bridge: WsBridge
  sessionStore: SessionStore
  httpClient: AdapterHttpClient
  defaultWorkDir: string
  dedup: MessageDedup
  /** Buffer window for streamed text. Platforms with edit-in-place replies
   *  want a short window; platforms that post discrete messages want a long
   *  one so a turn does not arrive as twenty separate chat bubbles. */
  flushIntervalMs?: number
  flushCharThreshold?: number
}

const HELP_ALIASES = new Set(['/help', '帮助'])
const STATUS_ALIASES = new Set(['/status', '状态'])
const PROJECTS_ALIASES = new Set(['/projects', '项目列表'])
const NEW_ALIASES = new Set(['/new', '新会话'])
const STOP_ALIASES = new Set(['/stop', '停止'])
const CLEAR_ALIASES = new Set(['/clear', '清空'])

/**
 * Drives one IM platform's chats against the desktop server.
 *
 * Instances are long-lived: one per adapter process, shared by every chat.
 */
export class ImChatRuntime {
  private readonly port: ChatPort
  private readonly config: AdapterConfig
  private readonly platformConfig: AdapterPlatformConfig
  private readonly bridge: WsBridge
  private readonly sessionStore: SessionStore
  private readonly httpClient: AdapterHttpClient
  private readonly defaultWorkDir: string
  private readonly dedup: MessageDedup
  private readonly flushIntervalMs: number
  private readonly flushCharThreshold: number

  private readonly runtimeStates = new Map<string, ChatRuntimeState>()
  private readonly buffers = new Map<string, MessageBuffer>()
  private readonly responses = new Map<string, ResponseStream>()
  private readonly pendingPermissions = new Map<string, Set<string>>()
  private readonly pendingProjectSelection = new Set<string>()
  private readonly imageWatchers = new Map<string, ImageBlockWatcher>()
  private readonly sessionSelection: SessionSelectionController

  constructor(options: ImChatRuntimeOptions) {
    this.port = options.port
    this.config = options.config
    this.platformConfig = options.platformConfig
    this.bridge = options.bridge
    this.sessionStore = options.sessionStore
    this.httpClient = options.httpClient
    this.defaultWorkDir = options.defaultWorkDir
    this.dedup = options.dedup
    this.flushIntervalMs = options.flushIntervalMs ?? 800
    this.flushCharThreshold = options.flushCharThreshold ?? 320
    this.sessionSelection = new SessionSelectionController({
      httpClient: this.httpClient,
      bridge: this.bridge,
      sessionStore: this.sessionStore,
      sendNotice: (chatId, text) => this.port.sendNotice(chatId, text),
      onServerMessage: (chatId, message) => this.handleServerMessage(chatId, message),
      clearTransientState: (chatId) => this.clearTransientChatState(chatId),
      clearProjectSelection: (chatId) => { this.pendingProjectSelection.delete(chatId) },
      isBusy: (chatId) => this.getRuntimeState(chatId).state !== 'idle'
        || Boolean(this.pendingPermissions.get(chatId)?.size),
    })
  }

  /** The work dir a `/new` with no argument would use. Exposed for adapters
   *  that print it at startup. */
  get configuredWorkDir(): string {
    return this.defaultWorkDir || getConfiguredWorkDir(this.config, this.platformConfig)
  }

  // ---------- inbound ----------

  /**
   * Full inbound pipeline for one user message.
   *
   * Work runs on the per-chat FIFO so two fast messages cannot interleave
   * their session mutations. The returned promise settles when this message
   * has been handled; adapters normally ignore it, tests await it.
   */
  handleInbound(message: InboundChatMessage): Promise<void> {
    const { chatId, dedupKey } = message
    if (!chatId) return Promise.resolve()
    if (dedupKey && !this.dedup.tryRecord(`${this.port.platform}:${dedupKey}`)) {
      return Promise.resolve()
    }

    const text = message.text.trim()
    const hasAttachments = message.hasAttachments
      ?? ((message.attachments?.length ?? 0) > 0 || Boolean(message.loadAttachments))
    if (!text && !hasAttachments) return Promise.resolve()

    return enqueue(chatId, async () => {
      try {
        await this.routeInbound({ ...message, text }, hasAttachments)
      } catch (err) {
        this.port.setBusy?.(chatId, false)
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`${this.port.logPrefix} Failed to handle message for ${chatId}:`, err)
        await this.notifySafely(chatId, `处理消息失败：${detail}`)
      }
    })
  }

  private async routeInbound(
    message: InboundChatMessage,
    hasAttachments: boolean,
  ): Promise<void> {
    const { chatId, userId, displayName, text } = message

    if (!isAllowedUser(this.port.platform, userId)) {
      const paired = text
        ? tryPair(text, { userId, displayName }, this.port.platform)
        : false
      await this.port.sendNotice(
        chatId,
        paired
          ? '配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话，发送 /help 查看可用命令。'
          : '未授权。请在 Claude Code 桌面端生成配对码后发送给我。',
      )
      return
    }

    if (!hasAttachments && (await this.tryHandleCommand(chatId, text))) return

    const decision = hasAttachments
      ? null
      : parsePermissionCommand(text, this.pendingPermissions.get(chatId))
    if (decision) {
      await this.applyPermissionDecision(chatId, decision)
      return
    }

    if (!hasAttachments && await this.sessionSelection.handleInput(chatId, text)) return

    if (!hasAttachments && this.pendingProjectSelection.has(chatId)) {
      if (text) await this.startNewSession(chatId, text)
      return
    }

    const ready = await this.ensureSession(chatId)
    if (!ready) return

    // Only now — sender authorized, session bound, still inside this chat's
    // queue — is it safe to pull the bytes down.
    const attachments = message.attachments
      ?? (message.loadAttachments ? await message.loadAttachments() : [])

    const effective = text || (attachments.length > 0 ? '(用户发送了附件)' : '')
    if (!effective && attachments.length === 0) return

    this.port.setBusy?.(chatId, true)
    this.getRuntimeState(chatId).state = 'thinking'
    const sent = this.bridge.sendUserMessage(
      chatId,
      effective,
      attachments.length > 0 ? attachments : undefined,
    )
    if (!sent) {
      this.port.setBusy?.(chatId, false)
      this.getRuntimeState(chatId).state = 'idle'
      await this.port.sendNotice(chatId, '消息发送失败，连接可能已断开。请发送 /new 重新开始。')
    }
  }

  /** Returns true when `text` was a command and has been fully handled. */
  private async tryHandleCommand(chatId: string, text: string): Promise<boolean> {
    if (HELP_ALIASES.has(text)) {
      await this.port.sendNotice(chatId, formatImHelp())
      return true
    }
    if (STATUS_ALIASES.has(text)) {
      await this.port.sendNotice(chatId, await this.buildStatusText(chatId))
      return true
    }
    if (PROJECTS_ALIASES.has(text)) {
      await this.showProjectPicker(chatId)
      return true
    }
    if (NEW_ALIASES.has(text) || text.startsWith('/new ') || text.startsWith('新会话 ')) {
      const arg = text.startsWith('/new ')
        ? text.slice('/new '.length).trim()
        : text.startsWith('新会话 ')
          ? text.slice('新会话 '.length).trim()
          : ''
      await this.startNewSession(chatId, arg || undefined)
      return true
    }
    if (STOP_ALIASES.has(text)) {
      const stored = await this.ensureExistingSession(chatId)
      if (!stored) {
        await this.port.sendNotice(chatId, formatImStatus(null))
        return true
      }
      this.bridge.sendStopGeneration(chatId)
      await this.port.sendNotice(chatId, '已发送停止信号。')
      return true
    }
    if (CLEAR_ALIASES.has(text)) {
      const stored = await this.ensureExistingSession(chatId)
      if (!stored) {
        await this.port.sendNotice(chatId, formatImStatus(null))
        return true
      }
      this.clearTransientChatState(chatId)
      const sent = this.bridge.sendUserMessage(chatId, '/clear')
      if (sent) this.getRuntimeState(chatId).state = 'thinking'
      await this.port.sendNotice(
        chatId,
        sent ? '已清空当前会话上下文。' : '无法发送 /clear，请先发送 /new 重新连接会话。',
      )
      return true
    }
    return false
  }

  private async applyPermissionDecision(
    chatId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(chatId)
    if (!pending?.has(decision.requestId)) {
      await this.port.sendNotice(chatId, `未找到待确认的权限请求：${decision.requestId}`)
      return
    }
    const sent = this.bridge.sendPermissionResponse(
      chatId,
      decision.requestId,
      decision.allowed,
      decision.rule,
    )
    if (sent) {
      pending.delete(decision.requestId)
      const runtime = this.getRuntimeState(chatId)
      runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    }
    await this.port.sendNotice(
      chatId,
      sent ? `${formatPermissionDecisionStatus(decision)}。` : '权限响应发送失败，请检查会话状态。',
    )
  }

  // ---------- server stream ----------

  async handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
    const runtime = this.getRuntimeState(chatId)
    if (syncImPermissionState(chatId, msg, runtime, this.pendingPermissions)) return

    switch (msg.type) {
      case 'connected':
        break

      case 'status':
        runtime.state = msg.state
        runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
        if (msg.state === 'thinking' || msg.state === 'tool_executing') {
          this.port.setBusy?.(chatId, true)
        } else if (msg.state === 'idle') {
          this.port.setBusy?.(chatId, false)
        }
        break

      case 'content_start':
        if (msg.blockType === 'text') {
          runtime.state = 'streaming'
        } else if (msg.blockType === 'tool_use') {
          runtime.state = 'tool_executing'
          runtime.verb = typeof msg.toolName === 'string' ? msg.toolName : runtime.verb
          this.port.setBusy?.(chatId, true)
        }
        break

      case 'content_delta':
        if (typeof msg.text === 'string' && msg.text) {
          this.getBuffer(chatId).append(msg.text)
          if (this.port.sendImage) {
            for (const pending of this.getImageWatcher(chatId).feed(msg.text)) {
              void this.dispatchOutboundImage(chatId, pending)
            }
          }
        }
        break

      case 'tool_use_complete':
        runtime.state = 'tool_executing'
        runtime.verb = typeof msg.toolName === 'string' ? msg.toolName : runtime.verb
        this.port.setBusy?.(chatId, true)
        break

      case 'tool_result':
        runtime.state = 'thinking'
        runtime.verb = undefined
        this.port.setBusy?.(chatId, true)
        break

      case 'permission_request': {
        runtime.pendingPermissionCount += 1
        runtime.state = 'permission_pending'
        let pending = this.pendingPermissions.get(chatId)
        if (!pending) {
          pending = new Set()
          this.pendingPermissions.set(chatId, pending)
        }
        pending.add(msg.requestId)
        this.port.setBusy?.(chatId, false)
        // Close the in-flight reply first: the approval prompt is a separate
        // message and must not be swallowed by an editing stream.
        await this.finishResponse(chatId)
        await this.port.sendNotice(
          chatId,
          `${formatPermissionRequest(msg.toolName, msg.input, msg.requestId)}\n\n${formatPermissionInstructions(msg.requestId)}`,
        )
        break
      }

      case 'message_complete':
        runtime.state = 'idle'
        runtime.verb = undefined
        this.port.setBusy?.(chatId, false)
        await this.finishResponse(chatId)
        break

      case 'error': {
        runtime.state = 'idle'
        runtime.verb = undefined
        this.port.setBusy?.(chatId, false)
        this.buffers.get(chatId)?.reset()
        this.buffers.delete(chatId)
        await this.finishResponse(chatId, { discardBuffer: true })
        await this.handleServerError(chatId, msg)
        break
      }

      case 'system_notification':
        if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
          const model = (msg.data as Record<string, unknown>).model
          if (typeof model === 'string' && model.trim()) runtime.model = model
        }
        break
    }
  }

  private async handleServerError(chatId: string, msg: ServerMessage): Promise<void> {
    // A session created under a different provider carries thinking blocks the
    // current one cannot verify. Rebuilding is the only recovery, and doing it
    // silently is better than telling the user to run /new themselves.
    if (typeof msg.message === 'string' && /Invalid.*signature.*thinking/i.test(msg.message)) {
      const stored = this.sessionStore.get(chatId)
      const workDir = stored?.workDir || this.defaultWorkDir
      if (workDir) {
        await this.port.sendNotice(chatId, '会话上下文已失效，正在自动重建...')
        this.clearTransientChatState(chatId)
        this.bridge.resetSession(chatId)
        this.sessionStore.delete(chatId)
        const ok = await this.createSessionForChat(chatId, workDir)
        await this.port.sendNotice(
          chatId,
          ok ? '已重建会话，请重新发送消息。' : '重建会话失败，请发送 /new 手动新建。',
        )
        return
      }
      await this.port.sendNotice(chatId, '会话上下文已失效，请发送 /new 新建会话。')
      return
    }
    await this.port.sendNotice(chatId, `错误: ${msg.message}`)
  }

  private async dispatchOutboundImage(chatId: string, pending: PendingUpload): Promise<void> {
    const send = this.port.sendImage
    if (!send) return
    try {
      const loaded = await loadSafeOutboundImage(pending, this.sessionStore.get(chatId)?.workDir)
      if (!loaded.ok) {
        console.warn(`${this.port.logPrefix} Outbound image rejected:`, loaded.reason)
        return
      }
      await send.call(this.port, chatId, {
        buffer: loaded.buffer,
        mime: loaded.mime,
        alt: pending.alt,
      })
    } catch (err) {
      console.error(
        `${this.port.logPrefix} dispatchOutboundImage failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---------- sessions ----------

  async ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
    return await restoreStoredSessionBinding({
      chatId,
      bridge: this.bridge,
      sessionStore: this.sessionStore,
      httpClient: this.httpClient,
      onServerMessage: (msg) => this.handleServerMessage(chatId, msg),
      logPrefix: this.port.logPrefix,
      clearTransientState: () => this.clearTransientChatState(chatId),
    })
  }

  private async ensureSession(chatId: string): Promise<boolean> {
    const stored = await this.ensureExistingSession(chatId)
    if (stored) return true

    if (this.defaultWorkDir) {
      return await this.createSessionForChat(chatId, this.defaultWorkDir)
    }
    await this.showProjectPicker(chatId)
    return false
  }

  private async createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
    try {
      // Always tear the old socket down first: connectSession() short-circuits
      // on an OPEN connection, which would leave messages on the stale session.
      this.bridge.resetSession(chatId)
      this.clearTransientChatState(chatId)
      const sessionId = await this.httpClient.createSession(workDir)
      this.sessionStore.set(chatId, sessionId, workDir)
      this.bridge.connectSession(chatId, sessionId)
      this.bridge.onServerMessage(chatId, (msg) => this.handleServerMessage(chatId, msg))
      const opened = await this.bridge.waitForOpen(chatId)
      if (!opened) {
        await this.port.sendNotice(chatId, '连接服务器超时，请重试。')
        return false
      }
      return true
    } catch (err) {
      await this.port.sendNotice(
        chatId,
        `无法创建会话: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  async showProjectPicker(chatId: string): Promise<void> {
    this.sessionSelection.clear(chatId)
    try {
      const projects = await this.httpClient.listRecentProjects()
      if (projects.length === 0) {
        await this.port.sendNotice(
          chatId,
          `没有找到最近的项目。发送 /new 会使用默认工作目录：${this.defaultWorkDir}\n也可以发送 /new /path/to/project 指定项目。`,
        )
        return
      }
      const lines = projects.slice(0, 10).map((project, index) =>
        `${index + 1}. ${project.projectName}${project.branch ? ` (${project.branch})` : ''}\n   ${project.realPath}`,
      )
      this.pendingProjectSelection.add(chatId)
      await this.port.sendNotice(
        chatId,
        `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n下次可直接 /new <编号、名称或绝对路径> 快速新建会话`,
      )
    } catch (err) {
      await this.port.sendNotice(
        chatId,
        `无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async startNewSession(chatId: string, query?: string): Promise<void> {
    this.sessionSelection.clear(chatId)
    this.bridge.resetSession(chatId)
    this.sessionStore.delete(chatId)
    this.clearTransientChatState(chatId)
    this.pendingProjectSelection.delete(chatId)

    if (!query) {
      if (this.defaultWorkDir) {
        const ok = await this.createSessionForChat(chatId, this.defaultWorkDir)
        if (ok) await this.port.sendNotice(chatId, '已新建会话，可以开始对话了。')
      } else {
        await this.showProjectPicker(chatId)
      }
      return
    }

    try {
      const { project, ambiguous } = await this.httpClient.matchProject(query)
      if (project) {
        const ok = await this.createSessionForChat(chatId, project.realPath)
        if (ok) {
          await this.port.sendNotice(
            chatId,
            `已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
          )
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} - ${p.realPath}`).join('\n')
        await this.port.sendNotice(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await this.port.sendNotice(
        chatId,
        `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`,
      )
    } catch (err) {
      await this.port.sendNotice(chatId, err instanceof Error ? err.message : String(err))
    }
  }

  async buildStatusText(chatId: string): Promise<string> {
    const stored = await this.ensureExistingSession(chatId)
    if (!stored) return formatImStatus(null)

    const runtime = this.getRuntimeState(chatId)
    let projectName = path.basename(stored.workDir) || stored.workDir
    let branch: string | null = null

    try {
      const gitInfo = await this.httpClient.getGitInfo(stored.sessionId)
      projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
      branch = gitInfo.branch
    } catch {
      // Status stays best-effort; a git lookup failure must not hide the rest.
    }

    let taskCounts:
      | { total: number; pending: number; inProgress: number; completed: number }
      | undefined
    try {
      const tasks = await this.httpClient.getTasksForSession(stored.sessionId)
      if (tasks.length > 0) {
        taskCounts = {
          total: tasks.length,
          pending: tasks.filter((task) => task.status === 'pending').length,
          inProgress: tasks.filter((task) => task.status === 'in_progress').length,
          completed: tasks.filter((task) => task.status === 'completed').length,
        }
      }
    } catch {
      // Same: task counts are a nicety, not a precondition.
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

  // ---------- per-chat state ----------

  getRuntimeState(chatId: string): ChatRuntimeState {
    let state = this.runtimeStates.get(chatId)
    if (!state) {
      state = { state: 'idle', pendingPermissionCount: 0 }
      this.runtimeStates.set(chatId, state)
    }
    return state
  }

  clearTransientChatState(chatId: string): void {
    this.buffers.get(chatId)?.reset()
    this.buffers.delete(chatId)
    // Abandoning a turn still has to close its presentation. Dropping the
    // reference instead leaves a WeCom bubble stuck mid-generation forever and
    // a QQ StreamSession holding a live timer that can fire into a dead stream.
    // Unflushed buffered text is deliberately not sent — this is an abandon,
    // not a completion — so `finish()` only seals what the user already saw.
    this.closeResponse(chatId)
    this.pendingPermissions.delete(chatId)
    this.imageWatchers.delete(chatId)
    this.port.setBusy?.(chatId, false)
    this.port.clearChat?.(chatId)
    const runtime = this.getRuntimeState(chatId)
    runtime.state = 'idle'
    runtime.verb = undefined
    runtime.pendingPermissionCount = 0
  }

  private getBuffer(chatId: string): MessageBuffer {
    let buffer = this.buffers.get(chatId)
    if (!buffer) {
      buffer = new MessageBuffer(
        async (text) => {
          if (!text) return
          await this.getResponse(chatId).append(text)
        },
        this.flushIntervalMs,
        this.flushCharThreshold,
      )
      this.buffers.set(chatId, buffer)
    }
    return buffer
  }

  private getResponse(chatId: string): ResponseStream {
    let response = this.responses.get(chatId)
    if (!response) {
      response = this.port.createResponse(chatId)
      this.responses.set(chatId, response)
    }
    return response
  }

  private getImageWatcher(chatId: string): ImageBlockWatcher {
    let watcher = this.imageWatchers.get(chatId)
    if (!watcher) {
      watcher = new ImageBlockWatcher()
      this.imageWatchers.set(chatId, watcher)
    }
    return watcher
  }

  /** Flush what is buffered and close the turn's presentation, if any. */
  private async finishResponse(
    chatId: string,
    options: { discardBuffer?: boolean } = {},
  ): Promise<void> {
    if (options.discardBuffer) {
      this.buffers.get(chatId)?.reset()
    } else {
      await this.buffers.get(chatId)?.complete()
    }
    this.buffers.delete(chatId)

    await this.closeResponse(chatId)
  }

  /**
   * Close the turn's presentation exactly once, if one is open.
   *
   * Returns a promise so `finishResponse` can await it, but callers on the
   * synchronous teardown path may ignore it: the failure mode we care about is
   * a stream that is never closed at all, not one closed a tick late.
   */
  private closeResponse(chatId: string): Promise<void> {
    const response = this.responses.get(chatId)
    if (!response) return Promise.resolve()
    this.responses.delete(chatId)
    return Promise.resolve()
      .then(() => response.finish())
      .catch((err) => {
        console.error(
          `${this.port.logPrefix} Failed to finish response:`,
          err instanceof Error ? err.message : err,
        )
      })
  }

  private async notifySafely(chatId: string, text: string): Promise<void> {
    try {
      await this.port.sendNotice(chatId, text)
    } catch (err) {
      console.error(
        `${this.port.logPrefix} Failed to deliver notice:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}
