import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { recordPublicAccessDiagnostic, type PublicAccessDiagnosticWriter } from './publicAccessDiagnostics'

const LOOPBACK_HOST = '127.0.0.1'
const EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com'] as const
const QUICK_SERVICE_HOST = 'api.trycloudflare.com'
const CONNECT_TIMEOUT_MS = 10_000
const QUICK_REQUEST_TIMEOUT_MS = 15_000
const MAX_QUICK_REQUEST_BYTES = 4096
const MAX_QUICK_RESPONSE_BYTES = 1024 * 1024
const MAX_CONNECT_HEADER_BYTES = 32 * 1024

export type CloudflareProxyTransport = {
  edgeAddresses: string[]
  quickServiceUrl: string
  stop(): Promise<void>
}

export type CloudflareProxyOptions = {
  signal?: AbortSignal
  connectTimeoutMs?: number
  requestTimeoutMs?: number
  /** Additional trust for deterministic local TLS fixtures or enterprise CAs. */
  ca?: tls.ConnectionOptions['ca']
  onDiagnostic?: PublicAccessDiagnosticWriter
}

/**
 * cloudflared 2026.10.6 dials edge TCP sockets directly, and its Quick Tunnel
 * provisioning transport also ignores HTTP(S)_PROXY. Keep both paths on the
 * user's selected proxy with --edge and --quick-service loopback endpoints.
 * Edge TLS remains in cloudflared (SNI h2.cftunnel.com); this bridge only pipes
 * bytes. Targets are fixed here rather than accepted from a local client.
 */
export async function startCloudflareProxyTransport(
  proxyUrl: string,
  options: CloudflareProxyOptions = {},
): Promise<CloudflareProxyTransport> {
  const startedAt = Date.now()
  const diagnostic: PublicAccessDiagnosticWriter = event => recordPublicAccessDiagnostic(options.onDiagnostic, event, [proxyUrl])
  let proxy: URL
  try { proxy = parseProxyUrl(proxyUrl) }
  catch (error) {
    diagnostic({ stage: 'proxy_transport', outcome: 'failed', reason: 'invalid_proxy_url', error, durationMs: Date.now() - startedAt })
    throw error
  }
  const controller = new AbortController()
  const servers: Array<net.Server | http.Server> = []
  const sockets = new Set<Duplex>()
  const quickPath = `/${randomBytes(24).toString('hex')}`
  let stopping: Promise<void> | null = null
  let starting = true
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // Dialing sockets can fail after their requesting client has disconnected.
    // Every socket keeps an error listener even while shutdown is in progress.
    socket.on('error', () => {})
    return socket
  }
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    controller.abort()
    options.signal?.removeEventListener('abort', abort)
    for (const socket of sockets) socket.destroy()
    stopping = Promise.all(servers.map(closeServer)).then(() => {})
    return stopping
  }
  const abort = () => {
    controller.abort()
    // Finish a pending listen callback before closing it. Closing a listener
    // during startup can suppress its callback on Bun and strand startup.
    if (!starting) void stop()
  }
  options.signal?.addEventListener('abort', abort, { once: true })

  const connect = (host: string, port: number, signal: AbortSignal) => connectProxy(
    proxy,
    host,
    port,
    signal,
    options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    track,
    options.ca,
    diagnostic,
  )

  try {
    throwIfAborted(options.signal)
    const edgeAddresses: string[] = []
    // Distinct local addresses preserve the four connections of a named tunnel.
    // Quick Tunnel itself selects one connection. Both regions remain available
    // when cloudflared retries a failed edge, without allowing a direct fallback.
    for (let index = 0; index < 4; index++) {
      const edgeHost = EDGE_HOSTS[index % EDGE_HOSTS.length]!
      const server = net.createServer({ pauseOnConnect: true }, client => {
        track(client)
        const attempt = new AbortController()
        const cancel = () => attempt.abort()
        const signal = AbortSignal.any([controller.signal, attempt.signal])
        client.once('close', cancel)
        void connect(edgeHost, 7844, signal).then(upstream => {
          if (signal.aborted || client.destroyed) {
            upstream.destroy()
            client.destroy()
            return
          }
          client.once('error', () => upstream.destroy())
          client.once('close', () => upstream.destroy())
          upstream.once('error', () => client.destroy())
          upstream.once('close', () => {
            if (!upstream.readableEnded) client.destroy()
          })
          upstream.pipe(client)
          client.pipe(upstream)
          client.resume()
        }).catch(() => client.destroy())
      })
      servers.push(server)
      edgeAddresses.push(await listen(server))
      throwIfAborted(controller.signal)
    }

    const quickServer = http.createServer((request, response) => {
      void handleQuickRequest(request, response)
    })
    quickServer.headersTimeout = 5000
    quickServer.requestTimeout = 5000
    quickServer.on('connection', track)
    quickServer.on('clientError', (_error, socket) => socket.destroy())
    servers.push(quickServer)
    const quickAddress = await listen(quickServer)
    throwIfAborted(controller.signal)

    async function handleQuickRequest(request: http.IncomingMessage, response: http.ServerResponse) {
      if (request.method !== 'POST' || request.url !== `${quickPath}/tunnel`
        || request.headers.host !== quickAddress || request.headers.origin) {
        response.writeHead(404, { Connection: 'close' })
        response.end()
        return
      }
      const attempt = new AbortController()
      const requestStartedAt = Date.now()
      let timedOut = false
      const cancel = () => attempt.abort()
      const timeout = setTimeout(() => { timedOut = true; cancel() }, options.requestTimeoutMs ?? QUICK_REQUEST_TIMEOUT_MS)
      const signal = AbortSignal.any([controller.signal, attempt.signal])
      request.once('aborted', cancel)
      response.once('close', () => {
        if (!response.writableFinished) cancel()
      })
      let secureSocket: tls.TLSSocket | undefined
      let agent: http.Agent | undefined
      let step = 'read_request'
      try {
        const body = await readLimitedBody(request, MAX_QUICK_REQUEST_BYTES, signal)
        step = 'proxy_connect'
        const socket = await connect(QUICK_SERVICE_HOST, 443, signal)
        throwIfAborted(signal)
        step = 'quick_tls'
        secureSocket = track(tls.connect({
          socket,
          // Runtimes without socket-upgrade support must fail on loopback,
          // never silently reconnect to the public SNI outside the proxy.
          host: LOOPBACK_HOST,
          port: 1,
          servername: QUICK_SERVICE_HOST,
          rejectUnauthorized: true,
          ...(options.ca ? { ca: options.ca } : {}),
        }))
        secureSocket.once('secureConnect', () => { step = 'quick_request' })
        agent = new ConnectedHttpAgent(secureSocket)
        const result = await requestQuickService(agent, body, request.headers['user-agent'], signal)
        diagnostic({ stage: 'quick_provisioning', outcome: result.status >= 200 && result.status < 300 ? 'succeeded' : 'failed',
          reason: result.status >= 200 && result.status < 300 ? 'http_success' : 'http_status', durationMs: Date.now() - requestStartedAt,
          details: { status: result.status, targetHost: QUICK_SERVICE_HOST, targetPort: 443 } })
        if (response.destroyed) return
        response.writeHead(result.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Connection: 'close',
        })
        response.end(result.body)
      } catch (error) {
        diagnostic({ stage: 'quick_provisioning', outcome: signal.aborted && !timedOut ? 'cancelled' : 'failed',
          reason: timedOut ? 'request_timeout' : signal.aborted ? 'request_cancelled' : 'request_failed', error,
          durationMs: Date.now() - requestStartedAt,
          details: { step, timeoutMs: options.requestTimeoutMs ?? QUICK_REQUEST_TIMEOUT_MS, targetHost: QUICK_SERVICE_HOST, targetPort: 443 } })
        // Do not echo proxy URLs, credentials, provider responses or TLS errors.
        if (!response.destroyed) {
          response.writeHead(signal.aborted ? 504 : 502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Connection: 'close',
          })
          response.end(JSON.stringify({ success: false, errors: [{ message: 'Cloudflare proxy connection failed' }] }))
        }
      } finally {
        clearTimeout(timeout)
        request.off('aborted', cancel)
        agent?.destroy()
        secureSocket?.destroy()
      }
    }

    starting = false
    return { edgeAddresses, quickServiceUrl: `http://${quickAddress}${quickPath}`, stop }
  } catch (error) {
    diagnostic({ stage: 'proxy_transport', outcome: controller.signal.aborted ? 'cancelled' : 'failed', reason: 'listener_setup_failed', error, durationMs: Date.now() - startedAt })
    starting = false
    await stop()
    throw error
  }
}

function parseProxyUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash || url.search) throw new Error()
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return url
  } catch {
    throw new Error('Cloudflare requires a valid HTTP or HTTPS proxy')
  }
}

function connectProxy(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  signal: AbortSignal,
  timeoutMs: number,
  track: <T extends Duplex>(socket: T) => T,
  ca: tls.ConnectionOptions['ca'],
  diagnostic: PublicAccessDiagnosticWriter,
): Promise<net.Socket> {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      diagnostic({ stage: 'proxy_connect', outcome: 'cancelled', reason: 'request_cancelled', durationMs: Date.now() - startedAt,
        details: { targetHost, targetPort } })
      reject(new Error('Cloudflare proxy connection cancelled'))
      return
    }
    const authority = `${targetHost}:${targetPort}`
    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: keep-alive']
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`)
    }
    const host = proxy.hostname.replace(/^\[|\]$/g, '')
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    const secure = proxy.protocol === 'https:'
    let step = secure ? 'proxy_tls' : 'proxy_tcp'
    let settled = false
    // Bun's node:http compatibility does not implement outgoing CONNECT. Use
    // the same bounded socket handshake as the existing system proxy bridge.
    const socket = track(secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}) })
      : net.connect({ host, port }))
    let buffered = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      socket.off('data', onData)
      socket.off('error', socketError)
      socket.off('end', socketClosed)
      socket.off('close', socketClosed)
    }
    const fail = (reason: string, error?: unknown, status?: number) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      diagnostic({ stage: 'proxy_connect', outcome: signal.aborted ? 'cancelled' : 'failed', reason, error,
        durationMs: Date.now() - startedAt,
        details: { step, targetHost, targetPort, proxyHost: host, proxyPort: port, proxyProtocol: proxy.protocol,
          timeoutMs, ...(status !== undefined ? { status } : {}) } })
      reject(new Error('Cloudflare proxy connection failed', error === undefined ? undefined : { cause: error }))
    }
    const socketError = (error: Error) => fail('proxy_socket_error', error)
    const socketClosed = () => fail('proxy_closed')
    const cancel = () => fail('request_cancelled')
    const timeout = setTimeout(() => fail('connect_timeout'), timeoutMs)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const marker = buffered.indexOf('\r\n\r\n')
      if (marker < 0) {
        if (buffered.length > MAX_CONNECT_HEADER_BYTES) fail('connect_headers_too_large')
        return
      }
      if (marker + 4 > MAX_CONNECT_HEADER_BYTES) {
        fail('connect_headers_too_large')
        return
      }
      const statusLine = buffered.toString('latin1', 0, marker).split('\r\n', 1)[0] ?? ''
      const status = Number(statusLine.match(/^HTTP\/1\.[01][ \t]+(\d{3})(?:[ \t]|$)/)?.[1])
      if (!Number.isFinite(status)) {
        fail('invalid_connect_response')
        return
      }
      if (status < 200 || status >= 300 || signal.aborted) {
        fail(signal.aborted ? 'request_cancelled' : 'http_connect_rejected', undefined, status)
        return
      }
      cleanup()
      settled = true
      diagnostic({ stage: 'proxy_connect', outcome: 'succeeded', reason: 'connect_established', durationMs: Date.now() - startedAt,
        details: { targetHost, targetPort, status } })
      socket.pause()
      const rest = buffered.subarray(marker + 4)
      if (rest.length) socket.unshift(rest)
      resolve(socket)
    }
    signal.addEventListener('abort', cancel, { once: true })
    socket.on('data', onData)
    socket.once('error', socketError)
    socket.once('end', socketClosed)
    socket.once('close', socketClosed)
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      step = 'http_connect'
      if (!signal.aborted && !socket.destroyed) socket.write(`${headers.join('\r\n')}\r\n\r\n`)
    })
  })
}

class ConnectedHttpAgent extends http.Agent {
  constructor(private readonly socket: tls.TLSSocket) { super({ keepAlive: false }) }
  override createConnection(): tls.TLSSocket { return this.socket }
}

function requestQuickService(
  agent: http.Agent,
  body: Buffer,
  userAgent: string | undefined,
  signal: AbortSignal,
): Promise<{ status: number, body: Buffer }> {
  return new Promise((resolve, reject) => {
    // TLS is already established through CONNECT. Never give a request client
    // an externally resolvable fallback: runtimes without custom-agent support
    // must fail locally instead of silently bypassing the selected proxy.
    const request = http.request({
      hostname: LOOPBACK_HOST,
      port: 1,
      path: '/tunnel',
      method: 'POST',
      headers: {
        Host: QUICK_SERVICE_HOST,
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
      },
      agent,
      signal,
    }, response => {
      void readLimitedBody(response, MAX_QUICK_RESPONSE_BYTES, signal).then(result => {
        resolve({ status: response.statusCode ?? 502, body: result })
      }, reject)
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function readLimitedBody(stream: http.IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const cancel = () => stream.destroy(new Error('Cloudflare proxy request cancelled'))
  signal.addEventListener('abort', cancel, { once: true })
  try {
    throwIfAborted(signal)
    let length = 0
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += data.length
      if (length > limit) throw new Error('Cloudflare proxy request exceeded maximum size')
      chunks.push(data)
    }
    return Buffer.concat(chunks, length)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

function listen(server: net.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Cloudflare proxy listener failed'))
      else resolve(`${LOOPBACK_HOST}:${address.port}`)
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  if (server instanceof http.Server) server.closeAllConnections()
  return new Promise(resolve => server.close(() => resolve()))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Cloudflare proxy connection cancelled')
}
