/**
 * One P2P peer's multiplexer: turns data-channel frames back into the same
 * HTTP requests and WebSocket connections the Cloudflare tunnel delivers, and
 * hands them to the same gateway entry point. Device auth, Origin, the route
 * allowlist and rate limits therefore run in exactly one place; the only thing
 * P2P changes is the socket underneath.
 */
import {
  chunkText,
  decodeFrame,
  encodeFrame,
  P2P_CHUNK,
  P2P_REQUEST_BODY_LIMIT,
  P2P_SOCKET_MESSAGE_LIMIT,
  rejectedOpening,
  type P2PChannel,
  type P2PHeader,
} from './protocol.js'

type SocketLike = { data: unknown; send(text: string): number; close(code?: number, reason?: string): void }
export type TunnelGateway = {
  /** The gateway's own request entry point (the one Cloudflare traffic reaches). */
  fetch(request: Request, server: { upgrade(request: Request, options: { data: unknown }): boolean }): Promise<Response | undefined>
  /** The gateway's WebSocket handlers, shared by Bun sockets and tunneled ones. */
  socketHandlers: {
    open(ws: SocketLike): void
    message(ws: SocketLike, message: string): void
    close(ws: SocketLike, code: number, reason: string): void
  }
  /** The paired device a request authenticates as, if any. */
  deviceIdFor(request: Request): string | undefined
  publicUrl(): string | null
}

/** Per-peer ceilings for request bodies the phone has started but not finished. */
export const P2P_MUX_LIMITS = {
  /** Requests whose body is still arriving. */
  pendingRequests: 32,
  /** Bytes buffered across those bodies. */
  pendingBytes: 32 * 1024 * 1024,
  /** Time one body may take to arrive in full. */
  assemblyMs: 60_000,
}
/**
 * Characters handed to the endpoint per event-loop turn. Its `flow` pause is a
 * message on the loopback link, read only between turns, so a large body must
 * never go out in one synchronous burst.
 */
const TURN_CHARS = 256 * 1024
/** Frames a response may have waiting in the queue before it reads more of its body. */
const QUEUE_FRAMES = 4
/** Body bytes per binary frame: 12 KiB is 16 KiB of base64 with no padding between frames. */
const BINARY_FRAME_BYTES = (P2P_CHUNK / 4) * 3
const CHANNELS: P2PChannel[] = ['ctl', 'bulk']

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'])

type PendingRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: 'none' | 'text' | 'b64'
  parts: string[]
  /** Body bytes received so far: the gateway caps bodies in bytes, not characters. */
  bytes: number
  controller: AbortController
  /** Gives up on a body that takes too long to arrive. */
  timer?: ReturnType<typeof setTimeout>
  /** The body is complete and the request is running. */
  dispatched?: boolean
}
type TunnelSocket = SocketLike & { stream: number; parts: string[]; size: number; closed: boolean }
type Queued = { stream?: number; text: string }

/** Bytes one body chunk carries; base64 counts what it decodes to. */
const bodyBytes = (body: PendingRequest['body'], payload: string) => body === 'b64'
  ? Math.max(0, Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0))
  : Buffer.byteLength(payload)

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.length + tail.length)
  joined.set(head)
  joined.set(tail, head.length)
  return joined
}

export function createP2PMux(options: {
  deviceId: string
  gateway: TunnelGateway
  send(channel: P2PChannel, text: string): void
  limits?: Partial<typeof P2P_MUX_LIMITS>
}) {
  const limits = { ...P2P_MUX_LIMITS, ...options.limits }
  const requests = new Map<number, PendingRequest>()
  const sockets = new Map<number, TunnelSocket>()
  const queues: Record<P2PChannel, Queued[]> = { ctl: [], bulk: [] }
  const paused: Record<P2PChannel, boolean> = { ctl: false, bulk: false }
  /** Characters sent in the current event-loop turn, and whether the next turn is scheduled. */
  const turn: Record<P2PChannel, { chars: number; scheduled: boolean }> = { ctl: { chars: 0, scheduled: false }, bulk: { chars: 0, scheduled: false } }
  /** Responses waiting for room on a channel. */
  const waiting: Record<P2PChannel, Set<() => void>> = { ctl: new Set(), bulk: new Set() }
  let closed = false

  const out = (channel: P2PChannel, header: P2PHeader, payload = '') => {
    if (closed) return
    queues[channel].push({ stream: 's' in header ? header.s : undefined, text: encodeFrame(header, payload) })
    flush(channel)
  }
  const writable = (channel: P2PChannel) =>
    closed || (!paused[channel] && queues[channel].length < QUEUE_FRAMES && turn[channel].chars < TURN_CHARS)
  const wake = (channel: P2PChannel) => {
    if (writable(channel)) for (const resume of [...waiting[channel]]) resume()
  }
  const nextTurn = (channel: P2PChannel) => {
    if (turn[channel].scheduled) return
    turn[channel].scheduled = true
    setTimeout(() => {
      turn[channel].scheduled = false
      turn[channel].chars = 0
      flush(channel)
    }, 0)
  }
  const flush = (channel: P2PChannel) => {
    const queue = queues[channel]
    while (!closed && !paused[channel] && queue.length && turn[channel].chars < TURN_CHARS) {
      const frame = queue.shift()!
      turn[channel].chars += frame.text.length
      nextTurn(channel)
      options.send(channel, frame.text)
    }
    wake(channel)
  }
  /** Resolves once the channel has room again, the response is aborted, or the peer closes. */
  const room = (channel: P2PChannel, signal: AbortSignal) => new Promise<void>((resolve) => {
    if (writable(channel) || signal.aborted) return resolve()
    const resume = () => {
      waiting[channel].delete(resume)
      signal.removeEventListener('abort', resume)
      resolve()
    }
    waiting[channel].add(resume)
    signal.addEventListener('abort', resume, { once: true })
  })
  /** A reset stream's frames that have not left yet are dropped. */
  const purge = (stream: number) => {
    for (const channel of CHANNELS) {
      const queue = queues[channel]
      for (let index = queue.length - 1; index >= 0; index--) if (queue[index]!.stream === stream) queue.splice(index, 1)
      wake(channel)
    }
  }

  const reply = (stream: number, status: number, error: string) =>
    out('bulk', { t: 'res', s: stream, st: status, h: { 'content-type': 'application/json' }, b: 'text', fin: true }, JSON.stringify({ error }))
  const refuseSocket = (stream: number, status: number) => out('ctl', { t: 'res', s: stream, st: status, h: {}, b: 'none', fin: true })

  /**
   * Streams a response as `res` + `resb` frames, reading the body only while
   * the channel has room: a paused data channel stops it mid-body instead of
   * the whole body queueing here and then flooding the endpoint at once.
   */
  const respond = async (stream: number, response: Response, signal: AbortSignal) => {
    const type = response.headers.get('content-type') ?? ''
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase()) && Object.keys(headers).length < 32) headers[key] = value.slice(0, 8192)
    })
    const decoder = TEXT_TYPES.test(type) ? new TextDecoder() : null
    const reader = response.body?.getReader()
    // An abort must also end a read that is waiting on a slow body.
    const cancel = () => { reader?.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let started = false
    let total = 0
    const emit = async (payload: string, fin: boolean) => {
      await room('bulk', signal)
      if (signal.aborted || closed) return false
      if (started) out('bulk', { t: 'resb', s: stream, fin }, payload)
      else out('bulk', { t: 'res', s: stream, st: response.status, h: headers, b: !total ? 'none' : decoder ? 'text' : 'b64', fin }, payload)
      started = true
      return true
    }
    // Body not sent yet: decoded text for text types, raw bytes otherwise.
    let text = ''
    let bytes: Uint8Array = new Uint8Array(0)
    let finished = false
    try {
      for (;;) {
        const { done, value } = reader ? await reader.read() : { done: true, value: undefined }
        if (signal.aborted || closed) return
        if (value?.length) {
          total += value.length
          if (decoder) text += decoder.decode(value, { stream: true })
          else bytes = bytes.length ? concat(bytes, value) : value
        }
        if (done && decoder) text += decoder.decode()
        // Send each full frame known not to be the last.
        let offset = 0
        if (decoder) {
          while (text.length - offset > P2P_CHUNK) {
            let end = offset + P2P_CHUNK
            // A data channel sends UTF-8, where half a surrogate pair is corrupted.
            const last = text.charCodeAt(end - 1)
            if (last >= 0xd800 && last <= 0xdbff) end--
            if (!await emit(text.slice(offset, end), false)) return
            offset = end
          }
          text = text.slice(offset)
        } else {
          while (bytes.length - offset > BINARY_FRAME_BYTES) {
            if (!await emit(Buffer.from(bytes.subarray(offset, offset + BINARY_FRAME_BYTES)).toString('base64'), false)) return
            offset += BINARY_FRAME_BYTES
          }
          bytes = bytes.subarray(offset)
        }
        if (done) break
      }
      finished = await emit(decoder ? text : bytes.length ? Buffer.from(bytes).toString('base64') : '', true)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!finished) cancel()
    }
  }

  /** A Request for the gateway, or the status to refuse it with. */
  const build = (url: string, init: RequestInit): Request | number => {
    let request: Request
    // Frames carry only Request-safe headers; anything else that still fails
    // here (the public URL, say) is a bad request, never an unanswered one.
    try { request = new Request(url, init) } catch { return 400 }
    const owner = options.gateway.deviceIdFor(request)
    // Defense in depth: a peer only ever speaks for the device that opened it.
    if (owner !== undefined && owner !== options.deviceId) return 403
    return request
  }

  // In flight until the response is sent, so a reset from the phone can still abort it.
  const dispatch = async (stream: number, pending: PendingRequest) => {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = undefined
    pending.dispatched = true
    requests.set(stream, pending)
    try { await run(stream, pending) } finally { if (requests.get(stream) === pending) requests.delete(stream) }
  }
  const run = async (stream: number, pending: PendingRequest) => {
    const publicUrl = options.gateway.publicUrl()
    if (!publicUrl) return reply(stream, 503, 'Remote access unavailable')
    const text = pending.parts.join('')
    const body = pending.body === 'none' || pending.method === 'GET' || pending.method === 'HEAD' ? undefined
      : pending.body === 'b64' ? Buffer.from(text, 'base64') : text
    const built = build(publicUrl + pending.path, { method: pending.method, headers: pending.headers, body, signal: pending.controller.signal })
    if (typeof built === 'number') return reply(stream, built, built === 403 ? 'P2P peer belongs to another device' : 'Invalid request')
    try {
      const response = await options.gateway.fetch(built, { upgrade: () => false })
      if (pending.controller.signal.aborted) return
      await respond(stream, response ?? new Response('{"error":"Upgrade not available here"}', { status: 400 }), pending.controller.signal)
    } catch {
      if (!pending.controller.signal.aborted) out('bulk', { t: 'rst', s: stream, code: 'failed' })
    }
  }
  /** Drops a request whose body is still arriving and tells the phone why. */
  const refuse = (stream: number, pending: PendingRequest, status: number, error: string) => {
    if (pending.timer) clearTimeout(pending.timer)
    if (requests.get(stream) === pending) requests.delete(stream)
    reply(stream, status, error)
  }
  const assemblingBytes = () => {
    let total = 0
    for (const pending of requests.values()) if (!pending.dispatched) total += pending.bytes
    return total
  }

  const openSocket = async (stream: number, path: string, headers: Record<string, string>) => {
    const publicUrl = options.gateway.publicUrl()
    const built = publicUrl ? build(publicUrl + path, { headers }) : 503
    if (typeof built === 'number') return refuseSocket(stream, built)
    let socket: TunnelSocket | undefined
    let status = 400
    try {
      const response = await options.gateway.fetch(built, {
        upgrade: (_request, { data }) => {
          socket = {
            data, stream, parts: [], size: 0, closed: false,
            send: (text: string) => {
              if (socket!.closed) return 0
              const chunks = chunkText(String(text))
              chunks.forEach((chunk, index) => out('ctl', { t: 'wsm', s: stream, fin: index === chunks.length - 1 }, chunk))
              return text.length
            },
            // A server-initiated close: tell the phone, then report it to the
            // handlers asynchronously, as Bun does for a real socket.
            close: (code = 1000, reason = '') => {
              if (socket!.closed) return
              socket!.closed = true
              sockets.delete(stream)
              out('ctl', { t: 'wsc', s: stream, code, reason: reason.slice(0, 256) })
              queueMicrotask(() => options.gateway.socketHandlers.close(socket!, code, reason))
            },
          }
          return true
        },
      })
      status = response?.status ?? 400
    } catch { status = 500 }
    if (closed) return
    if (!socket) return refuseSocket(stream, status)
    sockets.set(stream, socket)
    out('ctl', { t: 'wsa', s: stream })
    options.gateway.socketHandlers.open(socket)
  }

  const clientClosed = (socket: TunnelSocket, code: number, reason: string) => {
    if (socket.closed) return
    socket.closed = true
    sockets.delete(socket.stream)
    options.gateway.socketHandlers.close(socket, code, reason)
  }

  return {
    receive(channel: P2PChannel, text: string) {
      if (closed) return
      const frame = decodeFrame(text)
      if (!frame) {
        // A malformed request or socket open is still answered, never left hanging.
        const opening = rejectedOpening(text)
        if (opening?.t === 'req' && channel === 'bulk' && !requests.has(opening.s)) reply(opening.s, 400, 'Invalid request frame')
        else if (opening?.t === 'wso' && !sockets.has(opening.s)) refuseSocket(opening.s, 400)
        return
      }
      const { header, payload } = frame
      switch (header.t) {
        case 'hello': return
        case 'ping': return out('ctl', { t: 'pong', n: header.n })
        case 'req': {
          if (requests.has(header.s) || channel !== 'bulk') return
          const pending: PendingRequest = { method: header.m, path: header.p, headers: header.h, body: header.b, parts: [payload], bytes: bodyBytes(header.b, payload), controller: new AbortController() }
          if (header.fin) { void dispatch(header.s, pending); return }
          // Unfinished bodies are held in memory: bound their number, size and age.
          let unfinished = 0
          for (const item of requests.values()) if (!item.dispatched) unfinished++
          if (unfinished >= limits.pendingRequests) return reply(header.s, 429, 'Too many unfinished requests')
          if (assemblingBytes() + pending.bytes > limits.pendingBytes) return reply(header.s, 429, 'Too many unfinished request bodies')
          pending.timer = setTimeout(() => {
            if (requests.get(header.s) === pending && !pending.dispatched) refuse(header.s, pending, 408, 'Request body timed out')
          }, limits.assemblyMs)
          requests.set(header.s, pending)
          return
        }
        case 'reqb': {
          const pending = requests.get(header.s)
          if (!pending || pending.dispatched) return
          pending.parts.push(payload)
          pending.bytes += bodyBytes(pending.body, payload)
          if (pending.bytes > P2P_REQUEST_BODY_LIMIT) return refuse(header.s, pending, 413, 'Request body too large')
          if (assemblingBytes() > limits.pendingBytes) return refuse(header.s, pending, 429, 'Too many unfinished request bodies')
          if (header.fin) void dispatch(header.s, pending)
          return
        }
        case 'rst': {
          const pending = requests.get(header.s)
          requests.delete(header.s)
          if (pending?.timer) clearTimeout(pending.timer)
          pending?.controller.abort()
          const socket = sockets.get(header.s)
          if (socket) clientClosed(socket, 1006, 'Stream reset')
          purge(header.s)
          return
        }
        case 'wso': {
          if (sockets.has(header.s)) return
          void openSocket(header.s, header.p, header.h)
          return
        }
        case 'wsm': {
          const socket = sockets.get(header.s)
          if (!socket) return
          socket.parts.push(payload)
          // UTF-8 bytes, as the gateway's own message limit counts them.
          socket.size += Buffer.byteLength(payload)
          if (socket.size > P2P_SOCKET_MESSAGE_LIMIT) {
            socket.close(1009, 'Remote message too large')
            return
          }
          if (!header.fin) return
          const message = socket.parts.join('')
          socket.parts = []
          socket.size = 0
          options.gateway.socketHandlers.message(socket, message)
          return
        }
        case 'wsc': {
          const socket = sockets.get(header.s)
          if (socket) clientClosed(socket, header.code, header.reason)
          return
        }
        default:
          return
      }
    },
    /** The endpoint's send buffer for this channel filled up (or drained). */
    setPaused(channel: P2PChannel, value: boolean) {
      paused[channel] = value
      if (!value) flush(channel)
    },
    /** The data channel is gone: abort requests and drop sockets like a network loss. */
    close() {
      if (closed) return
      closed = true
      for (const pending of requests.values()) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.controller.abort()
      }
      requests.clear()
      for (const socket of [...sockets.values()]) {
        socket.closed = true
        options.gateway.socketHandlers.close(socket, 1006, 'P2P path closed')
      }
      sockets.clear()
      for (const channel of CHANNELS) {
        queues[channel].length = 0
        wake(channel)
      }
    },
    get openSockets() { return sockets.size },
  }
}
export type P2PMux = ReturnType<typeof createP2PMux>
