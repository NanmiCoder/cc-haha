import { base64ToBytes, bytesToBase64 } from '../base64'
import type { FetchAdapter, FetchResponse } from '../client'
import type { SocketLike } from '../sessionTransport'
import { chunkText, decodeFrame, encodeFrame, P2P_CHUNK, type Body, type P2PChannel } from './frames'

/**
 * 在直连数据通道上提供和 Cloudflare 路径一样的 HTTP 与 WebSocket：
 * ApiClient 和 SessionTransport 不用知道底下换了路。电脑那边把这些帧还原成
 * 同一个网关入口的请求，鉴权、白名单、限流都和走 Cloudflare 时一样。
 */
type Pending = {
  status?: number
  headers: Record<string, string>
  body: Body
  parts: string[]
  resolve(response: FetchResponse): void
  reject(error: Error): void
  url: string
  /** 答复头到了之后的正文：收完、通道断了或被重置。 */
  rest?: { done: Promise<string>; finish(text: string): void; fail(error: Error): void }
}
type TunnelSocket = SocketLike & { stream: number; parts: string[] }

const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' })
/** 请求在正文阶段失败：答复已经交出去了，失败只能由读正文的地方看到。 */
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

  /** 一帧从电脑来。 */
  receive(text: unknown) {
    const frame = decodeFrame(text)
    if (!frame) return
    const { header, payload } = frame
    switch (header.t) {
      case 'res':
      case 'resb': {
        const socket = this.#sockets.get(header.s)
        if (socket && header.t === 'res') {
          // 电脑拒绝了套接字（未授权、限流）：当成一次握手失败。
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
          // 答复头一到就交出去：电脑显然在线，ApiClient 从这里起改按正文时限等，
          // 大的正文在慢直连上传得再久，也不算「电脑没答复」。
          let finish!: (text: string) => void
          let fail!: (error: Error) => void
          const done = new Promise<string>((resolve, reject) => {
            finish = resolve
            fail = reject
          })
          // 没人读正文时失败也不算未处理的拒绝。
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
          // 正文还在路上也一样：告诉电脑别再发，读正文的一方收到中止。
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

  /** 这个请求还没收到电脑的答复头：换路重试不会重复执行（只对 GET 有意义）。 */
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

  /** 通道断了：没答复的请求、没收完的正文都失败，套接字按网络断开处理（会话会经 Cloudflare 续上）。 */
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
      // 图片本来就是 base64 传过来的：要 data URI 时直接用原文，不解码再编码。
      base64: async () => (pending.body === 'b64' ? body() : bytesToBase64(await bytes())),
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    }
  }
}
