import type { ClientMessage, ServerMessage } from '../types/chat'
import { getBaseUrl } from './client'

type MessageHandler = (msg: ServerMessage) => void

type Connection = {
  ws: WebSocket
  handlers: Set<MessageHandler>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
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
    if (existing && !existing.intentionalClose) return

    const wsUrl = getBaseUrl().replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    const conn: Connection = {
      ws,
      handlers: existing?.handlers ?? new Set(),
      reconnectTimer: null,
      reconnectAttempt: 0,
      pingInterval: null,
      intentionalClose: false,
      pendingMessages: [],
    }
    this.connections.set(sessionId, conn)

    ws.onopen = () => {
      conn.reconnectAttempt = 0
      this.startPingLoop(sessionId)
      while (conn.pendingMessages.length > 0) {
        const msg = conn.pendingMessages.shift()!
        ws.send(JSON.stringify(msg))
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        for (const handler of conn.handlers) {
          handler(msg)
        }
      } catch {
        // Ignore malformed messages
      }
    }

    ws.onclose = () => {
      this.stopPingLoop(sessionId)
      if (!conn.intentionalClose && this.connections.get(sessionId) === conn) {
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
    this.stopPingLoop(sessionId)
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    conn.pendingMessages = []

    conn.ws.close()
    this.connections.delete(sessionId)
  }

  disconnectAll() {
    for (const sessionId of [...this.connections.keys()]) {
      this.disconnect(sessionId)
    }
  }

  send(sessionId: string, message: ClientMessage) {
    const conn = this.connections.get(sessionId)
    if (!conn) return

    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message))
    } else if (conn.ws.readyState === WebSocket.CONNECTING) {
      conn.pendingMessages.push(message)
    }
  }

  onMessage(sessionId: string, handler: MessageHandler): () => void {
    const conn = this.connections.get(sessionId)
    if (!conn) return () => {}
    conn.handlers.add(handler)
    return () => { conn.handlers.delete(handler) }
  }

  clearHandlers(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn) conn.handlers.clear()
  }

  private startPingLoop(sessionId: string) {
    this.stopPingLoop(sessionId)
    const conn = this.connections.get(sessionId)
    if (!conn) return
    conn.pingInterval = setInterval(() => {
      this.send(sessionId, { type: 'ping' })
    }, 30_000)
  }

  private stopPingLoop(sessionId: string) {
    const conn = this.connections.get(sessionId)
    if (conn?.pingInterval) {
      clearInterval(conn.pingInterval)
      conn.pingInterval = null
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
        this.connections.delete(sessionId)
        this.connect(sessionId)
        // Migrate handlers to new connection
        const newConn = this.connections.get(sessionId)
        if (newConn) {
          for (const handler of conn.handlers) {
            newConn.handlers.add(handler)
          }
        }
      }
    }, delay)
  }
}

export const wsManager = new WebSocketManager()
