/**
 * 终端 WebSocket 客户端（H5 终端桥接）
 *
 * 浏览器没有 Electron IPC，终端走独立 WS 通道 /ws/terminal（服务端见
 * src/server/ws/handler.ts 的 terminal 分支 + services/terminalService.ts）。
 * 不复用 wsManager——其 URL 绑定 /ws/<sessionId> 且按 chat ServerMessage 协议
 * 分发，终端帧（terminal_spawn/terminal_output/...）不在该 union 内。
 *
 * 协议帧（JSON）：
 *   客户端 → 服务端： terminal_spawn{requestId?,cols,rows,cwd?} / terminal_write{sessionId,data}
 *                    terminal_resize{sessionId,cols,rows} / terminal_kill{sessionId}
 *   服务端 → 客户端： terminal_spawned{requestId?,session_id,shell,cwd} / terminal_error{requestId?,message}
 *                    terminal_output{requestId?,session_id,data} /
 *                    terminal_exited{requestId?,session_id,code,signal} / terminal_sync{sessions}
 */

import { getBaseUrl, getAuthToken } from '../../api/client'

export type TerminalSpawnOptions = {
  requestId?: string
  cwd?: string
  cols: number
  rows: number
}

export type TerminalSession = {
  session_id: number
  shell: string
  cwd: string
}

export type TerminalOutputEvent = {
  requestId?: string
  session_id: number
  data: string
}

export type TerminalExitEvent = {
  requestId?: string
  session_id: number
  code: number
  signal?: string | null
}

export type TerminalSyncEvent = {
  sessions: Array<{ session_id: number; shell: string; cwd: string }>
}

type TerminalWsMessage =
  | { type: 'terminal_spawned'; requestId?: string; session_id: number; shell: string; cwd: string }
  | { type: 'terminal_error'; requestId?: string; message: string }
  | { type: 'terminal_output'; requestId?: string; session_id: number; data: string }
  | { type: 'terminal_exited'; requestId?: string; session_id: number; code: number; signal?: string | null }
  | { type: 'terminal_sync'; sessions: Array<{ session_id: number; shell: string; cwd: string }> }

const SPAWN_TIMEOUT_MS = 10_000
const MAX_RECONNECT_BACKOFF_MS = 30_000

export function buildTerminalWebSocketUrl(): string {
  const url = new URL(getBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  url.pathname = `${basePath}/ws/terminal`

  const token = getAuthToken()
  if (token) {
    url.searchParams.set('token', token)
  } else {
    url.searchParams.delete('token')
  }

  return url.toString()
}

export class TerminalWebSocketClient {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manuallyClosed = false
  private pending: string[] = []
  private outputHandlers = new Set<(event: TerminalOutputEvent) => void>()
  private exitHandlers = new Set<(event: TerminalExitEvent) => void>()
  private syncHandlers = new Set<(event: TerminalSyncEvent) => void>()
  // requestId → {resolve, reject}，等待 terminal_spawned / terminal_error 关联帧。
  private spawnWaiters = new Map<string, {
    resolve: (session: TerminalSession) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  private ensureOpen(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.openSocket()
  }

  private openSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(buildTerminalWebSocketUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      while (this.pending.length > 0) {
        const message = this.pending.shift()
        if (message) ws.send(message)
      }
    }

    ws.onmessage = event => {
      let parsed: TerminalWsMessage
      try {
        parsed = JSON.parse(String(event.data)) as TerminalWsMessage
      } catch {
        return
      }
      this.dispatch(parsed)
    }

    ws.onclose = () => {
      this.ws = null
      if (!this.manuallyClosed) this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose 会紧接着触发；这里不重复调度
    }
  }

  private dispatch(message: TerminalWsMessage): void {
    switch (message.type) {
      case 'terminal_spawned': {
        const waiter = message.requestId ? this.spawnWaiters.get(message.requestId) : undefined
        if (waiter) {
          clearTimeout(waiter.timer)
          this.spawnWaiters.delete(message.requestId!)
          waiter.resolve({ session_id: message.session_id, shell: message.shell, cwd: message.cwd })
        }
        return
      }
      case 'terminal_error': {
        if (message.requestId) {
          const waiter = this.spawnWaiters.get(message.requestId)
          if (waiter) {
            clearTimeout(waiter.timer)
            this.spawnWaiters.delete(message.requestId)
            waiter.reject(new Error(message.message))
            return
          }
        }
        return
      }
      case 'terminal_output': {
        for (const handler of this.outputHandlers) handler({
          requestId: message.requestId,
          session_id: message.session_id,
          data: message.data,
        })
        return
      }
      case 'terminal_exited': {
        for (const handler of this.exitHandlers) handler({
          requestId: message.requestId,
          session_id: message.session_id,
          code: message.code,
          signal: message.signal,
        })
        return
      }
      case 'terminal_sync': {
        for (const handler of this.syncHandlers) handler({ sessions: message.sessions })
        return
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return
    const backoff = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_BACKOFF_MS)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, backoff)
  }

  send(message: unknown): void {
    this.ensureOpen()
    const payload = JSON.stringify(message)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
    } else {
      this.pending.push(payload)
    }
  }

  spawn(options: TerminalSpawnOptions): Promise<TerminalSession> {
    this.ensureOpen()
    const requestId = options.requestId ?? `t-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const message: Record<string, unknown> = {
      type: 'terminal_spawn',
      requestId,
      cols: options.cols,
      rows: options.rows,
    }
    if (options.cwd) message.cwd = options.cwd
    this.send(message)

    return new Promise<TerminalSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.spawnWaiters.delete(requestId)
        reject(new Error('Terminal spawn timed out waiting for the server.'))
      }, SPAWN_TIMEOUT_MS)
      this.spawnWaiters.set(requestId, { resolve, reject, timer })
    })
  }

  write(sessionId: number, data: string): void {
    this.send({ type: 'terminal_write', sessionId, data })
  }

  resize(sessionId: number, cols: number, rows: number): void {
    this.send({ type: 'terminal_resize', sessionId, cols, rows })
  }

  kill(sessionId: number): void {
    this.send({ type: 'terminal_kill', sessionId })
  }

  onOutput(handler: (event: TerminalOutputEvent) => void): () => void {
    this.outputHandlers.add(handler)
    return () => { this.outputHandlers.delete(handler) }
  }

  onExit(handler: (event: TerminalExitEvent) => void): () => void {
    this.exitHandlers.add(handler)
    return () => { this.exitHandlers.delete(handler) }
  }

  onSync(handler: (event: TerminalSyncEvent) => void): () => void {
    this.syncHandlers.add(handler)
    return () => { this.syncHandlers.delete(handler) }
  }

  close(): void {
    this.manuallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const [, waiter] of this.spawnWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Terminal connection closed.'))
    }
    this.spawnWaiters.clear()
    this.pending = []
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
  }
}

let terminalWsClient: TerminalWebSocketClient | null = null

export function getTerminalWsClient(): TerminalWebSocketClient {
  if (!terminalWsClient) {
    terminalWsClient = new TerminalWebSocketClient()
  }
  return terminalWsClient
}
