import type {
  BrowserTargetKind,
  CdpEventListener,
  CdpSendOptions,
  CdpTransport,
} from './types'

interface PendingRequest {
  method: string
  sessionId?: string
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener?(type: string, listener: (event: unknown) => void): void
}

export type WebSocketConstructor = new (url: string) => WebSocketLike

export interface DirectCdpWebSocketTransportOptions {
  wsUrl: string
  kind?: BrowserTargetKind
  connectTimeoutMs?: number
  defaultCommandTimeoutMs?: number
  keepaliveIntervalMs?: number
  webSocketFactory?: (url: string) => WebSocketLike
}

const WS_OPEN = 1

export class DirectCdpWebSocketTransport implements CdpTransport {
  readonly kind: BrowserTargetKind
  readonly wsUrl: string

  private ws: WebSocketLike | null = null
  private connected = false
  private closed = false
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventListeners = new Set<CdpEventListener>()
  private readonly disconnectListeners = new Set<(reason: string) => void>()
  private readonly connectTimeoutMs: number
  private readonly defaultCommandTimeoutMs: number
  private readonly keepaliveIntervalMs: number
  private readonly webSocketFactory: (url: string) => WebSocketLike
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityAt = 0

  constructor(options: DirectCdpWebSocketTransportOptions) {
    this.wsUrl = options.wsUrl
    this.kind = options.kind ?? 'chrome'
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.defaultCommandTimeoutMs = options.defaultCommandTimeoutMs ?? 30_000
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 25_000
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url: string) => {
        const WsCtor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined
        if (!WsCtor) {
          throw new Error('Global WebSocket is not available in this runtime')
        }
        return new WsCtor(url)
      })
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) {
      return
    }
    if (this.closed) {
      throw new Error('CDP WebSocket transport is already closed')
    }
    if (signal?.aborted) {
      throw new Error('CDP WebSocket connect aborted')
    }

    const ws = this.webSocketFactory(this.wsUrl)
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const finishResolve = () => {
        if (settled) return
        settled = true
        cleanup()
        this.connected = true
        this.lastActivityAt = Date.now()
        this.startKeepalive()
        resolve()
      }

      const finishReject = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        this.connected = false
        try {
          ws.close()
        } catch {
          // Ignore close errors during failed connect
        }
        reject(err)
      }

      const timer = setTimeout(() => {
        finishReject(
          new Error(
            `Timed out connecting to CDP WebSocket after ${this.connectTimeoutMs}ms`,
          ),
        )
      }, this.connectTimeoutMs)

      const onAbort = () => {
        finishReject(new Error('CDP WebSocket connect aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      ws.addEventListener('open', () => {
        finishResolve()
      })

      ws.addEventListener('error', (event: unknown) => {
        const detail =
          typeof event === 'object' && event !== null && 'message' in event
            ? String((event as { message?: unknown }).message)
            : 'WebSocket connection error'
        if (!settled) {
          finishReject(new Error(detail))
        } else {
          this.handleDisconnect(detail)
        }
      })

      ws.addEventListener('close', (event: unknown) => {
        const reason =
          typeof event === 'object' && event !== null && 'reason' in event
            ? String((event as { reason?: unknown }).reason || 'socket closed')
            : 'socket closed'
        if (!settled) {
          finishReject(new Error(`CDP WebSocket closed before open: ${reason}`))
        } else {
          this.handleDisconnect(reason)
        }
      })

      ws.addEventListener('message', (event: unknown) => {
        this.handleMessage(event)
      })
    })
  }

  isConnected(): boolean {
    return (
      this.connected &&
      !this.closed &&
      this.ws !== null &&
      this.ws.readyState === WS_OPEN
    )
  }

  onEvent(listener: CdpEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options: CdpSendOptions = {},
  ): Promise<T> {
    if (!this.isConnected() || !this.ws) {
      throw new Error(`CDP transport not connected (cannot send ${method})`)
    }
    if (options.signal?.aborted) {
      throw new Error(`CDP command ${method} aborted`)
    }

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs
    const payload: Record<string, unknown> = {
      id,
      method,
      ...(params ? { params } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        sessionId: options.sessionId,
        resolve: result => resolve(result as T),
        reject,
      }

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          entry.abortCleanup?.()
          reject(
            new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`),
          )
        }, timeoutMs)
      }

      if (options.signal) {
        const onAbort = () => {
          this.pending.delete(id)
          if (entry.timer) {
            clearTimeout(entry.timer)
          }
          reject(new Error(`CDP command "${method}" aborted`))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        entry.abortCleanup = () => {
          options.signal?.removeEventListener('abort', onAbort)
        }
      }

      this.pending.set(id, entry)
      try {
        this.lastActivityAt = Date.now()
        this.ws!.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(id)
        if (entry.timer) {
          clearTimeout(entry.timer)
        }
        entry.abortCleanup?.()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.connected = false
    this.stopKeepalive()
    this.rejectAllPending(new Error('CDP transport closed'))

    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'normal closure')
      } catch {
        // Ignore close errors
      }
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    if (this.keepaliveIntervalMs <= 0) {
      return
    }
    const timer = setInterval(() => {
      if (!this.isConnected()) {
        this.stopKeepalive()
        return
      }
      if (Date.now() - this.lastActivityAt < this.keepaliveIntervalMs) {
        return
      }
      void this.send('Browser.getVersion', undefined, {
        timeoutMs: 5_000,
      }).catch(() => {
        // Keepalive failures are tolerated; socket close handles disconnects
      })
    }, this.keepaliveIntervalMs)
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref()
    }
    this.keepaliveTimer = timer
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private handleMessage(event: unknown): void {
    this.lastActivityAt = Date.now()
    const rawData =
      typeof event === 'object' && event !== null && 'data' in event
        ? (event as { data: unknown }).data
        : event

    let text: string
    if (typeof rawData === 'string') {
      text = rawData
    } else if (rawData instanceof ArrayBuffer) {
      text = new TextDecoder().decode(rawData)
    } else if (ArrayBuffer.isView(rawData)) {
      text = new TextDecoder().decode(rawData)
    } else {
      return
    }

    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) {
        return
      }
      msg = parsed as Record<string, unknown>
    } catch {
      return
    }

    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id)
      if (!entry) {
        return
      }
      this.pending.delete(msg.id)
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.abortCleanup?.()

      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as { code?: unknown; message?: unknown }
        const message =
          typeof errObj.message === 'string'
            ? errObj.message
            : JSON.stringify(msg.error)
        entry.reject(
          new Error(`CDP error (${entry.method}): ${message}`),
        )
      } else {
        entry.resolve(
          typeof msg.result === 'object' && msg.result !== null
            ? (msg.result as Record<string, unknown>)
            : {},
        )
      }
      return
    }

    if (typeof msg.method === 'string') {
      const params =
        typeof msg.params === 'object' && msg.params !== null
          ? (msg.params as Record<string, unknown>)
          : {}
      const sessionId =
        typeof msg.sessionId === 'string' ? msg.sessionId : undefined

      // Fail-fast pending commands belonging to a detached target session
      if (msg.method === 'Target.detachedFromTarget') {
        const detachedSessionId =
          typeof params.sessionId === 'string' ? params.sessionId : sessionId
        if (detachedSessionId) {
          this.rejectPendingForSession(
            detachedSessionId,
            new Error(
              `CDP target detached (sessionId=${detachedSessionId})`,
            ),
          )
        }
      }

      for (const listener of this.eventListeners) {
        try {
          listener(msg.method, params, sessionId)
        } catch {
          // Isolate listener errors
        }
      }
    }
  }

  private rejectPendingForSession(sessionId: string, err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      if (entry.sessionId === sessionId) {
        this.pending.delete(id)
        if (entry.timer) {
          clearTimeout(entry.timer)
        }
        entry.abortCleanup?.()
        entry.reject(err)
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id)
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.abortCleanup?.()
      entry.reject(err)
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this.connected && this.closed) {
      return
    }
    this.connected = false
    this.stopKeepalive()
    this.rejectAllPending(new Error(`CDP WebSocket disconnected: ${reason}`))
    for (const listener of this.disconnectListeners) {
      try {
        listener(reason)
      } catch {
        // Isolate disconnect listener errors
      }
    }
  }
}
