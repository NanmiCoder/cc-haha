import type { ClientMessage, ServerMessage } from '../types/chat'
import { getAuthToken, getBaseUrl } from './client'

type MessageHandler = (msg: ServerMessage) => void
export type WebSocketConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
type ConnectionStateHandler = (state: WebSocketConnectionState) => void

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000

type Connection = {
  ws: WebSocket
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
    this.emitConnectionState(conn, conn.state)

    ws.onopen = () => {
      conn.reconnectAttempt = 0
      this.emitConnectionState(conn, 'connected')
      this.startPingLoop(sessionId, conn)
      while (conn.pendingMessages.length > 0) {
        const msg = conn.pendingMessages.shift()!
        ws.send(JSON.stringify(msg))
      }
      // Every renderer connection needs an authoritative snapshot. A full page
      // refresh/app relaunch creates a fresh WebSocketManager, so restricting
      // this to automatic reconnects leaves it unable to distinguish a live
      // turn from transcript history that ended while the renderer was away.
      // Keep it behind queued messages so the server observes those turns
      // before deciding whether the session is running or idle.
      ws.send(JSON.stringify({ type: 'sync_state' } satisfies ClientMessage))
    }

    ws.onmessage = (event) => {
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
    conn.pingInterval = setInterval(() => {
      if (
        this.connections.get(sessionId) !== conn ||
        conn.ws.readyState !== WebSocket.OPEN
      ) {
        return
      }

      try {
        conn.ws.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage))
      } catch {
        conn.ws.close()
        return
      }

      this.clearPongTimeout(conn)
      conn.pongTimeout = setTimeout(() => {
        conn.pongTimeout = null
        if (
          this.connections.get(sessionId) === conn &&
          conn.ws.readyState === WebSocket.OPEN
        ) {
          conn.ws.close()
        }
      }, HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
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

  return url.toString()
}

export const wsManager = new WebSocketManager()
