import { base64ToBytes, bytesToBase64 } from '../base64'
import type { FetchAdapter, FetchResponse } from '../client'
import type { SocketLike } from '../sessionTransport'
import { chunkText, decodeFrame, encodeFrame, P2P_CHUNK, type Body, type P2PChannel } from './frames'

/**
 * Provide the same HTTP and WebSocket on the direct data channel as on the Cloudflare path: 
 * ApiClient and SessionTransport need not know the path changed underneath. The computer turns these frames back into
 * requests to the same gateway entry, with auth, allowlist and rate limiting identical to Cloudflare.
 */
type Pending = {
  status?: number
  headers: Record<string, string>
  body: Body
  parts: string[]
  resolve(response: FetchResponse): void
  reject(error: Error): void
  url: string
  /** Body after response headers arrive: finished, channel dropped, or reset. */
  rest?: { done: Promise<string>; finish(text: string): void; fail(error: Error): void }
}
type TunnelSocket = SocketLike & { stream: number; parts: string[] }

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })
/** Request failed during the body phase: the response was already handed over, so the failure is only visible where the body is read. */
function failRequest(pending: Pending, error: Error) {
  if (pending.rest) pending.rest.fail(error)
  else pending.reject(error)
}

export class Tunnel {
  #next = 1
  #pending = new Map<number, Pending>()
  #sockets = new Map<number, TunnelSocket>()
  #closed = false

  constructor(private link: { send(channel: P2PChannel, text: string): boolean }) {}

  get closed() {
    return this.#closed
  }

  /** A frame from the computer. */
  receive(text: unknown) {
    const frame = decodeFrame(text)
    if (!frame) return
    const { header, payload } = frame
    switch (header.t) {
      case 'res':
      case 'resb': {
        const socket = this.#sockets.get(header.s)
        if (socket && header.t === 'res') {
          // The computer rejected the socket (unauthorized, rate limited): treat as a handshake failure.
          this.#closeSocket(socket, header.st === 401 ? 1008 : 1006, 'Rejected')
          return
        }
        const pending = this.#pending.get(header.s)
        if (!pending) return
        pending.parts.push(payload)
        if (header.t === 'res' && !pending.rest) {
          pending.status = header.st
          pending.headers = header.h
          pending.body = header.b
          // Hand over as soon as response headers arrive: the computer is clearly online, so ApiClient switches to the body timeout from here, 
          // and however long a large body takes on a slow direct path it does not count as "the computer did not respond".
          let finish!: (text: string) => void
          let fail!: (error: Error) => void
          const done = new Promise<string>((resolve, reject) => {
            finish = resolve
            fail = reject
          })
          // A failure with nobody reading the body does not count as an unhandled rejection.
          done.catch(() => {})
          pending.rest = { done, finish, fail }
          pending.resolve(this.#response(pending))
        }
        if (header.fin) {
          this.#pending.delete(header.s)
          pending.rest?.finish(pending.parts.join(''))
        }
        return
      }
      case 'rst': {
        const pending = this.#pending.get(header.s)
        this.#pending.delete(header.s)
        if (pending) failRequest(pending, new Error('Direct connection reset'))
        return
      }
      case 'wsa': {
        const socket = this.#sockets.get(header.s)
        if (!socket || socket.readyState !== 0) return
        socket.readyState = 1
        socket.onopen?.()
        return
      }
      case 'wsm': {
        const socket = this.#sockets.get(header.s)
        if (!socket) return
        socket.parts.push(payload)
        if (!header.fin) return
        const data = socket.parts.join('')
        socket.parts = []
        socket.onmessage?.({ data })
        return
      }
      case 'wsc': {
        const socket = this.#sockets.get(header.s)
        if (socket) this.#closeSocket(socket, header.code, header.reason)
        return
      }
      default:
        return
    }
  }

  fetch: FetchAdapter = (input, init) =>
    new Promise<FetchResponse>((resolve, reject) => {
      if (this.#closed) return reject(new Error('Direct connection closed'))
      if (init.signal.aborted) return reject(abortError())
      const url = new URL(input)
      const stream = this.#next++
      const pending: Pending = { headers: {}, body: 'none', parts: [], resolve, reject, url: input }
      this.#pending.set(stream, pending)
      init.signal.addEventListener(
        'abort',
        () => {
          // Same while the body is still in flight: tell the computer to stop sending, and the body reader gets an abort.
          if (!this.#pending.delete(stream)) return
          this.link.send('ctl', encodeFrame({ t: 'rst', s: stream, code: 'aborted' }))
          failRequest(pending, abortError())
        },
        { once: true }
      )
      const binary = init.body instanceof ArrayBuffer
      const text =
        init.body === undefined ? '' : binary ? bytesToBase64(new Uint8Array(init.body as ArrayBuffer)) : String(init.body)
      const chunks = text ? chunkText(text, binary ? P2P_CHUNK - (P2P_CHUNK % 4) : P2P_CHUNK) : ['']
      const body: Body = init.body === undefined ? 'none' : binary ? 'b64' : 'text'
      const sent = chunks.every((chunk, index) =>
        this.link.send(
          'bulk',
          index === 0
            ? encodeFrame({ t: 'req', s: stream, m: init.method, p: url.pathname + url.search, h: init.headers, b: body, fin: chunks.length === 1 }, chunk)
            : encodeFrame({ t: 'reqb', s: stream, fin: index === chunks.length - 1 }, chunk)
        )
      )
      if (!sent) {
        this.#pending.delete(stream)
        reject(new Error('Direct connection closed'))
      }
    })

  /** This request has not received response headers from the computer: rerouting and retrying will not execute twice (only meaningful for GET). */
  socket(url: string, headers: Record<string, string> = {}): SocketLike {
    const target = new URL(url)
    const stream = this.#next++
    const socket: TunnelSocket = {
      stream,
      parts: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data: string) => {
        if (socket.readyState !== 1) throw new Error('Socket closed')
        const chunks = chunkText(data)
        chunks.forEach((chunk, index) => {
          if (!this.link.send('ctl', encodeFrame({ t: 'wsm', s: stream, fin: index === chunks.length - 1 }, chunk)))
            throw new Error('Socket closed')
        })
      },
      close: (code = 1000, reason = '') => {
        if (socket.readyState === 3) return
        socket.readyState = 3
        this.#sockets.delete(stream)
        this.link.send('ctl', encodeFrame({ t: 'wsc', s: stream, code, reason: reason.slice(0, 256) }))
      },
    }
    this.#sockets.set(stream, socket)
    if (this.#closed || !this.link.send('ctl', encodeFrame({ t: 'wso', s: stream, p: target.pathname + target.search, h: headers }))) {
      queueMicrotask(() => this.#closeSocket(socket, 1006, 'Direct connection closed'))
    }
    return socket
  }

  /** Channel dropped: unanswered requests and unfinished bodies fail, and sockets are treated as network disconnects (sessions resume via Cloudflare). */
  close() {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) failRequest(pending, new Error('Direct connection closed'))
    this.#pending.clear()
    for (const socket of [...this.#sockets.values()]) this.#closeSocket(socket, 1006, 'Direct connection closed')
  }

  #closeSocket(socket: TunnelSocket, code: number, reason: string) {
    this.#sockets.delete(socket.stream)
    if (socket.readyState === 3) return
    socket.readyState = 3
    socket.onclose?.({ code, reason })
  }

  #response(pending: Pending): FetchResponse {
    const status = pending.status ?? 502
    const lower = Object.fromEntries(Object.entries(pending.headers).map(([key, value]) => [key.toLowerCase(), value]))
    const body = () => pending.rest!.done
    const bytes = async () => {
      const joined = await body()
      return pending.body === 'b64' ? base64ToBytes(joined) : new TextEncoder().encode(joined)
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      url: pending.url,
      redirected: false,
      text: async () => (pending.body === 'b64' ? new TextDecoder().decode(await bytes()) : body()),
      arrayBuffer: async () => {
        const data = await bytes()
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      },
      // Images arrive as base64 already: when a data URI is wanted use the original text directly instead of decoding and re-encoding.
      base64: async () => (pending.body === 'b64' ? body() : bytesToBase64(await bytes())),
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    }
  }
}
