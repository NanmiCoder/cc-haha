import { adapterMigrationLifecycle } from './migration-lifecycle.js'
/**
 * WebSocket Bridge
 *
 * 封装与 Claude Code Desktop 服务端 /ws/:sessionId 的通信。
 * 管理 chatId → sessionId 映射，自动重连，心跳。
 */

import WebSocket from 'ws'
import { currentInboundPowerLease } from './inbound-power-activity.js'

/** Attachment reference — mirrors src/server/ws/events.ts AttachmentRef.
 *  The server will either (a) write base64 `data` to
 *  ~/.claude/uploads/{sessionId}/ and convert to ImageBlockParam, or
 *  (b) read `path` from disk and inject `@"path"` into the prompt. */
export type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string      // base64 payload (images)
  mimeType?: string
}

/** Server → Client message (mirrors src/server/ws/events.ts ServerMessage) */
export type ServerMessage = {
  type: string
  [key: string]: any
}

/** Callback for server messages */
export type MessageHandler = (msg: ServerMessage) => void

type Session = {
  sessionId: string
  /** Stable across transport reconnects, renewed by a logical reset/replacement. */
  deliveryGeneration: symbol
  ws: WebSocket
  reconnectAttempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  openedAt: number | null
  awaitingPongAt: number | null
  terminal: boolean
  /** Last traffic either way; heartbeats do not count. */
  lastActivityAt: number
  /** A user turn the server has not finished yet. */
  turnActive: boolean
  /**
   * The CLI's own run state (`session_state_changed`). It stays running while
   * background tasks run and through the replies their results trigger.
   */
  cliRunning: boolean
  /** Approval requests still waiting for the user. */
  pendingRequests: Set<string>
}

const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
const MAX_RECONNECT_ATTEMPTS = 10
/**
 * A chat's socket keeps its session's CLI — and the MCP servers under it —
 * alive on the desktop host for as long as it stays open (#1485). After this
 * long without any traffic, with nothing running and nothing waiting for an
 * approval, the socket is closed; the chat's next message reopens it through
 * restoreStoredSessionBinding, at the cost of one CLI start.
 */
export const IDLE_SESSION_RELEASE_MS = 30 * 60_000

export type WsBridgeOptions = {
  idleReleaseMs?: number
  heartbeatIntervalMs?: number
  reconnectBaseMs?: number
  maxReconnectAttempts?: number
  now?: () => number
}

export class WsBridge {
  private sessions = new Map<string, Session>()
  /** Single handler per chatId — separate from sessions so reconnect doesn't duplicate */
  private handlers = new Map<string, MessageHandler>()
  /** Per-chat FIFO queue of in-flight handler promises.
   *  Ensures an async handler for message N completes before handler for N+1
   *  starts, preventing state races at `await` points. */
  private handlerChains = new Map<string, Promise<void>>()
  private serverUrl: string
  private platform: string
  private localAccessToken: string | null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false
  private readonly idleReleaseMs: number
  private readonly heartbeatIntervalMs: number
  private readonly reconnectBaseMs: number
  private readonly maxReconnectAttempts: number
  private readonly now: () => number

  constructor(
    serverUrl: string,
    platform: string,
    localAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
    options: WsBridgeOptions = {},
  ) {
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.platform = platform
    this.localAccessToken = localAccessToken?.trim() || null
    this.idleReleaseMs = options.idleReleaseMs ?? IDLE_SESSION_RELEASE_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS
    this.now = options.now ?? Date.now
    this.startHeartbeat(this.heartbeatIntervalMs)
  }

  /** Connect to a session with a known sessionId. Returns false if already connected. */
  connectSession(chatId: string, sessionId: string): boolean {
    const existing = this.sessions.get(chatId)
    if (existing && this.isSessionOpen(chatId)) {
      return false
    }
    this.connect(chatId, sessionId)
    return true
  }

  /** Send a user message to the session bound to chatId. */
  sendUserMessage(
    chatId: string,
    content: string,
    attachments?: AttachmentRef[],
    powerActivityLeaseId?: string,
  ): boolean {
    const lease = currentInboundPowerLease(chatId)
    const payload: Record<string, unknown> = { type: 'user_message', content }
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments
    }
    const leaseId = powerActivityLeaseId ?? lease?.id
    if (leaseId) payload.powerActivityLeaseId = leaseId
    const sent = this.send(chatId, payload)
    if (sent && lease && leaseId === lease.id) lease.transferred = true
    return sent
  }

  /** Respond to a permission request.
   *
   * @param rule - optional rule name to make the permission persistent.
   *   Currently the server supports `'always'`, which uses the CLI's
   *   permission_suggestions to produce updatedPermissions so the same
   *   tool call won't prompt again in this session. Omit for one-shot allow. */
  sendPermissionResponse(
    chatId: string,
    requestId: string,
    allowed: boolean,
    rule?: string,
  ): boolean {
    const message: Record<string, unknown> = {
      type: 'permission_response',
      requestId,
      allowed,
    }
    if (rule) message.rule = rule
    return this.send(chatId, message)
  }

  /** Stop the current generation. */
  sendStopGeneration(chatId: string): boolean {
    return this.send(chatId, { type: 'stop_generation' })
  }

  /** Register (or replace) the handler for server messages on a specific chatId. */
  onServerMessage(chatId: string, handler: MessageHandler): void {
    this.handlers.set(chatId, handler)
  }

  getSessionId(chatId: string): string | null {
    return this.sessions.get(chatId)?.sessionId ?? null
  }

  isSessionOpen(chatId: string, sessionId?: string): boolean {
    const session = this.sessions.get(chatId)
    if (!session) return false
    if (sessionId && session.sessionId !== sessionId) return false
    if (session.terminal || session.ws.readyState !== WebSocket.OPEN) return false
    if (session.awaitingPongAt !== null && this.now() - session.awaitingPongAt >= this.heartbeatIntervalMs) {
      this.disconnectUnhealthySession(chatId, session)
      return false
    }
    return true
  }

  /** Reset session for a chatId (e.g. /new command). */
  resetSession(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (session) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      this.closeSocket(session.ws, 1000, 'session reset')
      this.sessions.delete(chatId)
    }
    this.handlers.delete(chatId)
    this.handlerChains.delete(chatId)
  }

  /** Has a session (connected or handler registered) for chatId. */
  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId) || this.handlers.has(chatId)
  }

  /** Destroy all sessions. */
  destroy(): void {
    this.destroyed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const [, session] of this.sessions) {
      if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
      this.closeSocket(session.ws, 1000, 'bridge destroyed')
    }
    this.sessions.clear()
    this.handlers.clear()
    this.handlerChains.clear()
  }

  // ------- internal -------

  private connect(chatId: string, sessionId: string): void {
    const url = new URL(`${this.serverUrl}/ws/${sessionId}`)
    if (this.localAccessToken) {
      url.searchParams.set('token', this.localAccessToken)
    }
    const ws = new WebSocket(url)

    // Cancel any pending reconnect timer for this chatId
    const prev = this.sessions.get(chatId)
    if (prev) {
      if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer)
      this.closeSocket(prev.ws, 1000, 'session replaced')
    }

    // A reconnect to the same session is not new activity; its snapshot on
    // open refreshes the turn and approval state.
    const carried = prev?.sessionId === sessionId && !prev.terminal ? prev : undefined
    const session: Session = {
      sessionId,
      deliveryGeneration: carried?.deliveryGeneration ?? Symbol(),
      ws,
      reconnectAttempts: carried?.reconnectAttempts ?? 0,
      reconnectTimer: null,
      openedAt: null,
      awaitingPongAt: null,
      terminal: false,
      lastActivityAt: carried?.lastActivityAt ?? this.now(),
      turnActive: carried?.turnActive ?? false,
      cliRunning: false,
      pendingRequests: carried?.pendingRequests ?? new Set(),
    }
    this.sessions.set(chatId, session)

    ws.on('open', () => {
      if (this.sessions.get(chatId) !== session) return
      console.log(`[WsBridge] Connected: ${sessionId}`)
      session.openedAt = this.now()
    })

    ws.on('message', (raw) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch (err) {
        console.error('[WsBridge] Parse error:', err)
        return
      }
      if (this.sessions.get(chatId) !== session) return
      if (msg.type === 'pong') {
        if (session.awaitingPongAt !== null) {
          session.awaitingPongAt = null
          // An open handshake alone is not recovery. Require a healthy round
          // trip after one heartbeat interval before replenishing the budget.
          if (session.openedAt !== null && this.now() - session.openedAt >= this.heartbeatIntervalMs) {
            session.reconnectAttempts = 0
          }
        }
        return
      }
      this.trackInbound(session, msg)
      void this.deliverMessage(chatId, session, msg)
    })

    ws.on('close', (code, reason) => {
      console.log(`[WsBridge] Disconnected: ${sessionId} (${code}: ${reason})`)
      if (this.sessions.get(chatId) !== session) return
      if (code === 1000) {
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
        this.sessions.delete(chatId)
        this.handlers.delete(chatId)
        this.handlerChains.delete(chatId)
        return
      }
      this.scheduleReconnect(chatId, sessionId)
    })

    ws.on('error', (err) => {
      console.error(`[WsBridge] Error on ${sessionId}:`, err.message)
    })
  }

  private deliverMessage(chatId: string, session: Session, msg: ServerMessage): Promise<void> {
    if (!this.handlers.has(chatId)) return Promise.resolve()
    // Already received frames belong to the logical session, not its socket.
    // A reconnect must drain them before its snapshot; only a reset/replacement
    // invalidates them. Terminal notifications use the same FIFO boundary.
    const prev = this.handlerChains.get(chatId) ?? Promise.resolve()
    const next = adapterMigrationLifecycle.track(prev
      .catch(() => {})
      .then(() => {
        if (this.sessions.get(chatId)?.deliveryGeneration !== session.deliveryGeneration) return
        return this.handlers.get(chatId)?.(msg)
      })
      .catch((err) => {
        console.error(`[WsBridge] Handler error on ${chatId}:`, err)
      }))
    this.handlerChains.set(chatId, next)
    return next
  }

  private closeSocket(ws: WebSocket, code: number, reason: string, terminate = false): void {
    ws.removeAllListeners()
    if (ws.readyState === WebSocket.CLOSED) return

    if (ws.readyState === WebSocket.CONNECTING) {
      // Bun's `ws` compatibility layer can remain stuck in CLOSING when a
      // handshake is aborted. Let the handshake settle, consuming its natural
      // error, and close normally if the connection opens first.
      const cleanup = () => {
        ws.removeListener('open', onOpen)
        ws.removeListener('error', onError)
        ws.removeListener('close', onClose)
      }
      const onOpen = () => {
        ws.removeListener('open', onOpen)
        ws.close(code, reason)
      }
      const onError = () => cleanup()
      const onClose = () => cleanup()

      ws.once('open', onOpen)
      ws.once('error', onError)
      ws.once('close', onClose)
      return
    }

    // Keep a temporary error sink after detaching the session listeners so a
    // close-time transport error cannot surface as an unhandled EventEmitter
    // error.
    const swallowTeardownError = () => {}
    ws.on('error', swallowTeardownError)
    ws.once('close', () => {
      ws.removeListener('error', swallowTeardownError)
    })
    if (terminate) ws.terminate()
    else ws.close(code, reason)
  }

  /** Wait until the WebSocket for chatId is open. Resolves false on timeout or error. */
  waitForOpen(chatId: string, timeoutMs = 10_000): Promise<boolean> {
    const session = this.sessions.get(chatId)
    if (!session) return Promise.resolve(false)
    if (session.terminal) return Promise.resolve(false)
    if (session.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.isSessionOpen(chatId))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      const onOpen = () => { cleanup(); resolve(true) }
      const onError = () => { cleanup(); resolve(false) }
      const onClose = () => { cleanup(); resolve(false) }
      const cleanup = () => {
        clearTimeout(timer)
        session.ws.removeListener('open', onOpen)
        session.ws.removeListener('error', onError)
        session.ws.removeListener('close', onClose)
      }
      session.ws.once('open', onOpen)
      session.ws.once('error', onError)
      session.ws.once('close', onClose)
    })
  }

  private send(chatId: string, message: Record<string, unknown>): boolean {
    const session = this.sessions.get(chatId)
    if (!session || !this.isSessionOpen(chatId)) {
      console.warn(`[WsBridge] Cannot send to ${chatId}: session not ready`)
      return false
    }
    try {
      session.ws.send(JSON.stringify(message))
    } catch (err) {
      console.warn(`[WsBridge] Send failed on ${chatId}:`, err)
      this.disconnectUnhealthySession(chatId, session)
      return false
    }
    session.lastActivityAt = this.now()
    if (message.type === 'user_message') session.turnActive = true
    if (message.type === 'permission_response' && typeof message.requestId === 'string') {
      session.pendingRequests.delete(message.requestId)
    }
    return true
  }

  private trackInbound(session: Session, msg: ServerMessage): void {
    session.lastActivityAt = this.now()
    switch (msg.type) {
      case 'status':
        session.turnActive = msg.state !== 'idle'
        break
      case 'message_complete':
        session.turnActive = false
        session.pendingRequests.clear()
        break
      case 'error':
        session.turnActive = false
        break
      case 'permission_request':
      case 'computer_use_permission_request':
        if (typeof msg.requestId === 'string') session.pendingRequests.add(msg.requestId)
        break
      case 'permission_resolved':
        if (typeof msg.requestId === 'string') session.pendingRequests.delete(msg.requestId)
        break
      case 'permission_requests_snapshot':
        session.turnActive = msg.turnActive === true
        session.pendingRequests = new Set(
          [...(msg.toolRequestIds ?? []), ...(msg.computerUseRequestIds ?? [])]
            .filter((id): id is string => typeof id === 'string'),
        )
        break
      case 'system_notification':
        if (msg.subtype === 'session_state_changed') {
          session.cliRunning = msg.data?.state === 'running'
        }
        break
    }
  }

  /**
   * Counts as activity for a chat whose socket is about to be used, so the
   * idle sweep cannot close it between a caller's check and its send.
   */
  markActive(chatId: string): void {
    const session = this.sessions.get(chatId)
    if (session) session.lastActivityAt = this.now()
  }

  /**
   * Closes the sockets of chats quiet for the idle period (see
   * IDLE_SESSION_RELEASE_MS). A chat whose turn runs, whose CLI still works on
   * background tasks, or that waits on an approval keeps its socket. The
   * chat's binding is the adapter's and stays, so its next message reconnects.
   */
  releaseIdleSessions(): string[] {
    const released: string[] = []
    const now = this.now()
    for (const [chatId, session] of this.sessions) {
      if (
        session.ws.readyState !== WebSocket.OPEN ||
        session.turnActive ||
        session.cliRunning ||
        session.pendingRequests.size > 0 ||
        now - session.lastActivityAt < this.idleReleaseMs
      ) continue
      console.log(`[WsBridge] Releasing idle session ${session.sessionId} (chat ${chatId})`)
      this.resetSession(chatId)
      released.push(chatId)
    }
    return released
  }

  private scheduleReconnect(chatId: string, sessionId: string): void {
    if (this.destroyed) return
    const session = this.sessions.get(chatId)
    if (!session || session.terminal || session.reconnectTimer) return
    if (session.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[WsBridge] Max reconnect attempts reached for ${sessionId}, giving up`)
      session.terminal = true
      // Clear local waiting indicators, then report the lost connection through
      // the adapters' existing error handling. The durable binding stays intact.
      void this.deliverMessage(chatId, session, {
        type: 'permission_requests_snapshot', turnActive: false,
        toolRequestIds: [], computerUseRequestIds: [],
      })
      const finished = this.deliverMessage(chatId, session, {
        type: 'error', code: 'ADAPTER_CONNECTION_LOST',
        message: '与桌面端的连接已中断，自动重连失败。请检查连接后重试，原会话已保留。',
      })
      void finished.then(() => {
        if (this.sessions.get(chatId) !== session) return
        this.sessions.delete(chatId)
        this.handlers.delete(chatId)
        this.handlerChains.delete(chatId)
      })
      return
    }

    session.reconnectAttempts++
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, session.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )
    console.log(`[WsBridge] Reconnecting ${sessionId} in ${delay}ms (attempt ${session.reconnectAttempts}/${this.maxReconnectAttempts})`)
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null
      if (this.destroyed) return
      if (this.sessions.get(chatId) === session) {
        this.connect(chatId, sessionId)
      }
    }, delay)
  }

  private disconnectUnhealthySession(chatId: string, session: Session): void {
    if (this.sessions.get(chatId) !== session || session.terminal || session.reconnectTimer) return
    // A half-open peer may never acknowledge a close handshake.
    this.closeSocket(session.ws, 4000, 'connection unresponsive', true)
    this.scheduleReconnect(chatId, session.sessionId)
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => {
      this.releaseIdleSessions()
      for (const [chatId, session] of this.sessions) {
        if (this.isSessionOpen(chatId) && session.awaitingPongAt === null) {
          session.awaitingPongAt = this.now()
          try {
            session.ws.send(JSON.stringify({ type: 'ping' }))
          } catch (err) {
            console.warn(`[WsBridge] Heartbeat failed on ${chatId}:`, err)
            this.disconnectUnhealthySession(chatId, session)
          }
        }
      }
    }, intervalMs)
  }
}
