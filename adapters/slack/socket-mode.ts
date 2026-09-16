/**
 * Slack Socket Mode connection.
 *
 * Socket Mode replaces the public HTTPS request URL a Slack app would normally
 * need: the app opens an outbound WebSocket and Slack pushes envelopes down it.
 * That is what makes a desktop-local bot possible at all, the same role the
 * long connection plays for Feishu, WeCom and QQ.
 *
 * The transport rules that matter here: every envelope must be acknowledged by
 * its `envelope_id` or Slack retries it, and Slack periodically asks the client
 * to reconnect (`type: "disconnect"`) so it can drain a server.
 */

import WebSocket from 'ws'

export type SocketEnvelope = {
  type?: string
  envelope_id?: string
  payload?: {
    event?: Record<string, any>
    [key: string]: unknown
  }
  reason?: string
  [key: string]: unknown
}

export type SocketModeOptions = {
  /** Resolves a fresh `wss://` URL. Called again for every reconnect. */
  openConnection: () => Promise<string>
  onEnvelope: (envelope: SocketEnvelope) => void
  createWebSocket?: (url: string) => WebSocket
  logPrefix?: string
}

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Keeps exactly one Socket Mode WebSocket alive.
 *
 * Reconnects are unconditional and unbounded on purpose: unlike a chat session,
 * there is nothing to fall back to — if this socket stays down, the bot is
 * simply deaf until the process restarts.
 */
export class SlackSocketMode {
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false
  private readonly logPrefix: string

  constructor(private readonly options: SocketModeOptions) {
    this.logPrefix = options.logPrefix ?? '[Slack]'
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.removeAllListeners()
    // Swallow a teardown-time transport error: without a listener attached,
    // `ws` re-raises it as an unhandled 'error' event and kills the process.
    socket.on('error', () => {})
    try {
      socket.close(1000, 'adapter stopped')
    } catch {
      // Already closing.
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let url: string
    try {
      url = await this.options.openConnection()
    } catch (err) {
      console.error(
        `${this.logPrefix} Failed to open Socket Mode connection:`,
        err instanceof Error ? err.message : err,
      )
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return

    const socket = (this.options.createWebSocket ?? ((target) => new WebSocket(target)))(url)
    this.socket = socket

    socket.on('open', () => {
      this.attempts = 0
      console.log(`${this.logPrefix} Socket Mode connected`)
    })

    socket.on('message', (raw) => {
      let envelope: SocketEnvelope
      try {
        envelope = JSON.parse(raw.toString())
      } catch (err) {
        console.error(`${this.logPrefix} Socket parse error:`, err)
        return
      }

      // Acknowledge before handling: Slack redelivers anything unacked within
      // three seconds, and handling can take much longer than that.
      if (envelope.envelope_id && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
      }

      if (envelope.type === 'disconnect') {
        console.log(`${this.logPrefix} Slack asked to reconnect (${envelope.reason ?? 'unknown'})`)
        try {
          socket.close(1000, 'slack requested reconnect')
        } catch {
          // The close handler below still schedules the reconnect.
        }
        return
      }
      if (envelope.type === 'hello') return

      try {
        this.options.onEnvelope(envelope)
      } catch (err) {
        console.error(`${this.logPrefix} Envelope handler error:`, err)
      }
    })

    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.stopped) return
      this.scheduleReconnect()
    })

    socket.on('error', (err: Error) => {
      console.error(`${this.logPrefix} Socket error:`, err.message)
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.attempts += 1
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempts - 1), RECONNECT_MAX_MS)
    console.log(`${this.logPrefix} Reconnecting Socket Mode in ${delay}ms (attempt ${this.attempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }
}
