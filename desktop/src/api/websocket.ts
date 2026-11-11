import type { ClientMessage, ServerMessage } from '../types/chat'
import { getAuthToken, getBaseUrl } from './client'
import { isTouchH5Document } from '../lib/touchH5'

type MessageHandler = (msg: ServerMessage) => void
export type WebSocketConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
type ConnectionStateHandler = (state: WebSocketConnectionState) => void

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000
const HANDSHAKE_RESUME_GRACE_MS = 10_000

type Connection = {
  ws: WebSocket
  connectionStartedAt: number
  handlers: Set<MessageHandler>
  stateHandlers: Set<ConnectionStateHandler>
  state: WebSocketConnectionState
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
  pongTimeout: ReturnType<typeof setTimeout> | null
  intentionalClose: boolean
  pendingMessages: ClientMessage[]
}

class WebSocketManager {
  private connections = new Map<string, Connection>()
  private listeningForLifecycle = false
  private wasHidden = false
  private networkWasOffline = false

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      this.wasHidden = true
      return
    }
    if (!this.wasHidden || document.visibilityState !== 'visible') return
    this.wasHidden = false
    if (navigator.onLine === false) return
    this.recoverConnections(this.networkWasOffline)
    this.networkWasOffline = false
  }

  private onOffline = () => {
    this.networkWasOffline = true
    for (const conn of this.connections.values()) {
      if (conn.intentionalClose) continue
      this.emitConnectionState(conn, 'reconnecting')
      // Stop sending into a socket that still reports OPEN after the network
      // disappears. New user messages remain in the existing unsent queue.
      conn.ws.close()
    }
  }

  private onOnline = () => {
    this.networkWasOffline = false
    this.recoverConnections(true)
  }

  private onNativeResume = () => {
    if (navigator.onLine !== false) this.recoverConnections(false)
  }

  private listenForLifecycle() {
    if (this.listeningForLifecycle || typeof window === 'undefined' || typeof document === 'undefined') return
    this.listeningForLifecycle = true
    this.wasHidden = document.visibilityState === 'hidden'
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('offline', this.onOffline)
    window.addEventListener('online', this.onOnline)
    window.addEventListener('cc-haha:resume', this.onNativeResume)
  }

  private stopListeningForLifecycle() {
    if (!this.listeningForLifecycle) return
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('offline', this.onOffline)
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('cc-haha:resume', this.onNativeResume)
    this.listeningForLifecycle = false
    this.wasHidden = false
    this.networkWasOffline = false
  }

  private recoverConnections(networkChanged: boolean) {
    for (const [sessionId, conn] of this.connections) {
      if (conn.intentionalClose) continue
      if (!networkChanged && conn.ws.readyState === WebSocket.OPEN) {
        // Foregrounding a healthy stream must not interrupt it. Probe now,
        // rather than waiting for a background-throttled heartbeat interval.
        this.sendPing(sessionId, conn)
        continue
      }
      if (!networkChanged && conn.ws.readyState === WebSocket.CONNECTING &&
        Date.now() - conn.connectionStartedAt < HANDSHAKE_RESUME_GRACE_MS) {
        // Android resume and visibility may arrive together while the TLS/WS
        // handshake is still in flight. Let it finish instead of repeatedly
        // replacing it. A changed network or a stalled handshake still recovers.
        continue
      }
      this.stopPingLoopForConnection(conn)
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer)
        conn.reconnectTimer = null
      }
      conn.intentionalClose = true
      conn.reconnectAttempt = Math.max(1, conn.reconnectAttempt)
      this.emitConnectionState(conn, 'reconnecting')
      conn.ws.close()
      // connect preserves subscriptions and unsent messages. Messages already
      // sent are never queued again; sync_state recovers authoritative state.
      if (this.connections.get(sessionId) === conn) this.connect(sessionId)
    }
  }

  isConnected(sessionId: string): boolean {
    const conn = this.connections.get(sessionId)
    return conn?.ws.readyState === WebSocket.OPEN
  }

  getConnectedSessionIds(): string[] {
    return [...this.connections.keys()]
  }

  connect(sessionId: string) {
    const existing = this.connections.get(sessionId)
    if (
      existing &&
      !existing.intentionalClose &&
      (
        existing.ws.readyState === WebSocket.OPEN ||
        existing.ws.readyState === WebSocket.CONNECTING ||
        existing.reconnectTimer !== null
      )
    ) {
      return
    }

    const ws = new WebSocket(buildSessionWebSocketUrl(sessionId))

    const conn: Connection = {
      ws,
      connectionStartedAt: Date.now(),
      handlers: existing?.handlers ?? new Set(),
      stateHandlers: existing?.stateHandlers ?? new Set(),
      state: existing && existing.reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      reconnectTimer: null,
      reconnectAttempt: existing?.reconnectAttempt ?? 0,
      pingInterval: null,
      pongTimeout: null,
      intentionalClose: false,
      pendingMessages: existing?.pendingMessages ?? [],
    }
    this.connections.set(sessionId, conn)
    this.listenForLifecycle()
    this.emitConnectionState(conn, conn.state)

    ws.onopen = () => {
      if (this.connections.get(sessionId) !== conn || conn.intentionalClose) return
      const isReconnect = conn.reconnectAttempt > 0
      conn.reconnectAttempt = 0
      this.emitConnectionState(conn, 'connected')
      this.startPingLoop(sessionId, conn)
      while (conn.pendingMessages.length > 0) {
        const msg = conn.pendingMessages.shift()!
        ws.send(JSON.stringify(msg))
      }
      // Ask for authoritative turn state only on an automatic reconnect. This
      // is deliberately queued after pending user messages so the server sees
      // those turns before deciding whether the session is running or idle.
      if (isReconnect) {
        ws.send(JSON.stringify({ type: 'sync_state' } satisfies ClientMessage))
      }
    }

    ws.onmessage = (event) => {
      if (this.connections.get(sessionId) !== conn || conn.intentionalClose) return
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        if (msg.type === 'pong') {
          this.clearPongTimeout(conn)
        }
        for (const handler of conn.handlers) {
          handler(msg)
        }
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = () => {
      this.stopPingLoopForConnection(conn)
      if (!conn.intentionalClose && this.connections.get(sessionId) === conn) {
        this.emitConnectionState(conn, 'reconnecting')
        this.scheduleReconnect(sessionId, conn)
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  disconnect(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (!conn) return

    conn.intentionalClose = true
    this.stopPingLoopForConnection(conn)
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    conn.pendingMessages = []
    this.emitConnectionState(conn, 'disconnected')

    conn.ws.close()
    this.connections.delete(sessionId)
    if (this.connections.size === 0) this.stopListeningForLifecycle()
  }

  disconnectAll() {
    for (const sessionId of [...this.connections.keys()]) {
      this.disconnect(sessionId)
    }
  }

  send(sessionId: string, message: ClientMessage) {
    let conn = this.connections.get(sessionId)
    if (!conn) {
      this.connect(sessionId)
      conn = this.connections.get(sessionId)
      if (!conn) return
    }

    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message))
      return
    }

    conn.pendingMessages.push(message)

    if (
      conn.ws.readyState === WebSocket.CLOSED ||
      conn.ws.readyState === WebSocket.CLOSING
    ) {
      if (!conn.intentionalClose && !conn.reconnectTimer) {
        this.scheduleReconnect(sessionId, conn)
      }
    }
  }

  onMessage(sessionId: string, handler: MessageHandler): () => void {
    const conn = this.connections.get(sessionId)
    if (!conn) return () => {}
    conn.handlers.add(handler)
    return () => { conn.handlers.delete(handler) }
  }

  onConnectionState(sessionId: string, handler: ConnectionStateHandler): () => void {
    const conn = this.connections.get(sessionId)
    if (!conn) return () => {}
    conn.stateHandlers.add(handler)
    handler(conn.state)
    return () => { conn.stateHandlers.delete(handler) }
  }

  clearHandlers(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn) {
      conn.handlers.clear()
      conn.stateHandlers.clear()
    }
  }

  private emitConnectionState(conn: Connection, state: WebSocketConnectionState) {
    conn.state = state
    for (const handler of conn.stateHandlers) handler(state)
  }

  private startPingLoop(sessionId: string, conn: Connection) {
    this.stopPingLoopForConnection(conn)
    if (this.connections.get(sessionId) !== conn) return
    conn.pingInterval = setInterval(() => this.sendPing(sessionId, conn), HEARTBEAT_INTERVAL_MS)
  }

  private sendPing(sessionId: string, conn: Connection) {
    if (this.connections.get(sessionId) !== conn || conn.ws.readyState !== WebSocket.OPEN) return
    try {
      conn.ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
    } catch {
      conn.ws.close()
      return
    }
    this.clearPongTimeout(conn)
    conn.pongTimeout = setTimeout(() => {
      conn.pongTimeout = null
      if (this.connections.get(sessionId) === conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close()
      }
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private stopPingLoopForConnection(conn: Connection) {
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval)
      conn.pingInterval = null
    }
    this.clearPongTimeout(conn)
  }

  private clearPongTimeout(conn: Connection) {
    if (conn.pongTimeout) {
      clearTimeout(conn.pongTimeout)
      conn.pongTimeout = null
    }
  }

  private scheduleReconnect(sessionId: string, conn: Connection) {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
    }

    const delay = Math.min(1000 * 2 ** conn.reconnectAttempt, 30_000)
    conn.reconnectAttempt++

    conn.reconnectTimer = setTimeout(() => {
      if (this.connections.get(sessionId) === conn && !conn.intentionalClose) {
        conn.reconnectTimer = null
        this.connect(sessionId)
      }
    }, delay)
  }
}

export function buildSessionWebSocketUrl(sessionId: string) {
  const url = new URL(getBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  url.pathname = `${basePath}/ws/${encodeURIComponent(sessionId)}`

  const token = getAuthToken()
  if (token) {
    url.searchParams.set('token', token)
  } else {
    url.searchParams.delete('token')
  }
  // Tells the server this composer can show next-prompt suggestions. The
  // touch composer has no Tab key, so it never opts in to the extra request.
  if (isTouchH5Document()) {
    url.searchParams.delete('suggestions')
  } else {
    url.searchParams.set('suggestions', '1')
  }

  return url.toString()
}

export const wsManager = new WebSocketManager()
