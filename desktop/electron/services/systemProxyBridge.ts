import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { lookup } from 'node:dns/promises'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const SYSTEM_PROXY_BRIDGE_HOST = '127.0.0.1'
const CONNECT_TIMEOUT_MS = 10_000
const MAX_BUFFERED_REQUEST_BYTES = 32 * 1024 * 1024

export type SystemProxyRule = {
  type: 'direct' | 'http' | 'https' | 'socks4' | 'socks5'
  host?: string
  port?: number
}

export type SystemProxyBridgeLike = {
  start(): Promise<string>
  stop(): Promise<void>
}

type ProxyEndpoint = Required<Pick<SystemProxyRule, 'host' | 'port'>>
type OutgoingRequestOptions = http.RequestOptions & { servername?: string }

export function parseSystemProxyRules(rules: string | undefined): SystemProxyRule[] {
  if (!rules?.trim()) return [{ type: 'direct' }]

  const parsed: SystemProxyRule[] = []
  for (const rawRule of rules.split(';')) {
    const rule = rawRule.trim()
    if (!rule) continue
    if (/^DIRECT$/i.test(rule)) {
      parsed.push({ type: 'direct' })
      continue
    }

    const match = rule.match(/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i)
    if (!match) continue
    const endpoint = parseEndpoint(match[2]!)
    if (!endpoint) continue
    const kind = match[1]!.toUpperCase()
    parsed.push({
      type: kind === 'PROXY'
        ? 'http'
        : kind === 'HTTPS'
          ? 'https'
          : kind === 'SOCKS4'
            ? 'socks4'
            : kind === 'SOCKS5'
              ? 'socks5'
              : 'socks4',
      ...endpoint,
    })
  }
  return parsed
}

export class SystemProxyBridge implements SystemProxyBridgeLike {
  private server: http.Server | null = null
  private startPromise: Promise<string> | null = null
  private lifecycleGeneration = 0
  private readonly clientSockets = new Set<net.Socket>()
  private readonly outboundSockets = new Set<Duplex>()

  constructor(private readonly resolveSystemProxy: (url: string) => Promise<string>) {}

  start(): Promise<string> {
    if (this.startPromise) return this.startPromise
    const generation = ++this.lifecycleGeneration
    this.startPromise = this.startOnce(generation)
    return this.startPromise
  }

  async stop(): Promise<void> {
    ++this.lifecycleGeneration
    const startPromise = this.startPromise
    this.startPromise = null
    const server = this.server
    this.server = null
    for (const socket of this.clientSockets) socket.destroy()
    for (const socket of this.outboundSockets) socket.destroy()
    // Bun needs the HTTP connection registry drained before close() will
    // finish after an upgraded CONNECT socket. Calling this before listen
    // completes breaks the separate startup/stop race, so guard on listening.
    if (server?.listening) server.closeAllConnections()
    const closing = server?.listening
      ? new Promise<void>(resolve => server.close(() => resolve()))
      : Promise.resolve()
    await closing
    await startPromise?.catch(() => {})
  }

  private async startOnce(generation: number): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response)
    })
    server.on('connect', (request, clientSocket, head) => {
      void this.handleConnect(request, clientSocket, head)
    })
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    server.on('connection', socket => {
      this.clientSockets.add(socket)
      socket.once('close', () => this.clientSockets.delete(socket))
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, SYSTEM_PROXY_BRIDGE_HOST, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      if (this.server === server) this.server = null
      throw error
    }
    if (generation !== this.lifecycleGeneration || this.server !== server) {
      await closeServer(server)
      throw new Error('System proxy bridge startup was stopped')
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      if (this.server === server) this.server = null
      await closeServer(server)
      throw new Error('Could not resolve system proxy bridge port')
    }
    return `http://${SYSTEM_PROXY_BRIDGE_HOST}:${address.port}`
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      const target = resolveHttpTarget(request)
      if (target.protocol !== 'http:') {
        response.writeHead(400, { Connection: 'close' })
        response.end('HTTPS proxy requests must use CONNECT')
        return
      }
      const rules = await this.resolveRules(target)
      const method = request.method ?? 'GET'
      const headers = sanitizeProxyRequestHeaders(request.headers)
      const onSocket = (socket: Duplex) => this.trackOutboundSocket(socket)
      // Model calls are usually POSTs. Never replay them after bytes may have reached a provider;
      // only explicitly safe methods may retry a later PAC route before any response is received.
      const upstreamResponse = isReplaySafeMethod(method)
        ? await requestUsingRules(
            rules,
            target,
            method,
            headers,
            await readRequestBody(request),
            onSocket,
          )
        : await requestStreamingUsingRule(
            await selectReachableRule(rules, target),
            target,
            method,
            headers,
            request,
            onSocket,
          )
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers)
      await pipeline(upstreamResponse, response)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502, { Connection: 'close' })
      response.end(`System proxy bridge failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleConnect(
    request: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let routeSocket: Duplex | null = null
    let clientUnavailable = clientSocket.destroyed
      || !clientSocket.writable
      || clientSocket.writableEnded
      || clientSocket.writableFinished
    const isClientUnavailable = () => clientUnavailable
      || clientSocket.destroyed
      || !clientSocket.writable
      || clientSocket.writableEnded
      || clientSocket.writableFinished
    const closeRoute = () => {
      clientUnavailable = true
      routeSocket?.destroy()
      clientSocket.destroy()
    }
    clientSocket.on('error', closeRoute)
    clientSocket.once('end', closeRoute)
    clientSocket.once('close', closeRoute)

    try {
      const endpoint = parseEndpoint(request.url ?? '', 443)
      if (!endpoint) throw new Error('Invalid CONNECT target')
      const target = new URL(`https://${formatAuthority(endpoint.host, endpoint.port)}/`)
      const rules = await this.resolveRules(target)
      if (isClientUnavailable()) return
      const route = await connectTunnelUsingRules(rules, endpoint.host, endpoint.port)
      routeSocket = route.socket
      this.trackOutboundSocket(route.socket)
      const closeBoth = () => {
        route.socket.destroy()
        clientSocket.destroy()
      }
      route.socket.on('error', closeBoth)
      if (isClientUnavailable()) {
        route.socket.destroy()
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) route.socket.write(head)
      route.socket.pipe(clientSocket)
      clientSocket.pipe(route.socket)
    } catch (error) {
      if (isClientUnavailable()) {
        clientSocket.destroy()
        return
      }
      const authenticationRequired = error instanceof ProxyAuthenticationRequiredError
      clientSocket.end(`${authenticationRequired
        ? 'HTTP/1.1 407 Proxy Authentication Required'
        : 'HTTP/1.1 502 Bad Gateway'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async resolveRules(target: URL): Promise<SystemProxyRule[]> {
    if (isLoopbackHostname(target.hostname)) return [{ type: 'direct' }]
    return parseSystemProxyRules(await this.resolveSystemProxy(target.href))
  }

  private trackOutboundSocket(socket: Duplex): void {
    this.outboundSockets.add(socket)
    socket.once('close', () => this.outboundSockets.delete(socket))
  }
}

function resolveHttpTarget(request: http.IncomingMessage): URL {
  const rawUrl = request.url ?? ''
  if (/^https?:\/\//i.test(rawUrl)) return new URL(rawUrl)
  const host = request.headers.host
  if (!host) throw new Error('Proxy request is missing Host header')
  return new URL(rawUrl || '/', `http://${host}`)
}

export function sanitizeProxyRequestHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const sanitized = { ...headers }
  const connectionTokens = String(headers.connection ?? '')
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean)
  for (const name of [
    ...connectionTokens,
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    delete sanitized[name]
  }
  return sanitized
}

function isReplaySafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

async function requestUsingRules(
  rules: SystemProxyRule[],
  target: URL,
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  onSocket: (socket: Duplex) => void,
): Promise<http.IncomingMessage> {
  const errors: string[] = []
  for (const rule of rules) {
    try {
      return await requestUsingRule(rule, target, method, headers, body, onSocket)
    } catch (error) {
      errors.push(`${rule.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`No system proxy route succeeded (${errors.join('; ')})`)
}

async function requestUsingRule(
  rule: SystemProxyRule,
  target: URL,
  method: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  onSocket: (socket: Duplex) => void,
): Promise<http.IncomingMessage> {
  const outgoing = await createRuleRequest(rule, target, method, headers, onSocket)
  return await performHttpRequest(outgoing.transport, outgoing.options, body, onSocket)
}

async function requestStreamingUsingRule(
  rule: SystemProxyRule,
  target: URL,
  method: string,
  headers: http.IncomingHttpHeaders,
  body: http.IncomingMessage,
  onSocket: (socket: Duplex) => void,
): Promise<http.IncomingMessage> {
  const outgoing = await createRuleRequest(rule, target, method, headers, onSocket)
  return await new Promise((resolve, reject) => {
    const request = outgoing.transport.request(outgoing.options, resolve)
    request.once('socket', onSocket)
    request.once('error', reject)
    body.once('error', error => request.destroy(error))
    body.pipe(request)
  })
}

async function createRuleRequest(
  rule: SystemProxyRule,
  target: URL,
  method: string,
  headers: http.IncomingHttpHeaders,
  onSocket: (socket: Duplex) => void,
): Promise<{ transport: typeof http | typeof https, options: OutgoingRequestOptions }> {
  const outgoingHeaders = { ...headers, connection: 'close' }
  if (rule.type === 'direct') {
    return {
      transport: http,
      options: {
        method,
        host: target.hostname,
        port: targetPort(target),
        path: `${target.pathname}${target.search}`,
        headers: outgoingHeaders,
        agent: false,
      },
    }
  }

  const endpoint = requireEndpoint(rule)
  if (rule.type === 'http' || rule.type === 'https') {
    return {
      transport: rule.type === 'https' ? https : http,
      options: {
        method,
        host: endpoint.host,
        port: endpoint.port,
        path: target.href,
        headers: outgoingHeaders,
        agent: false,
        servername: net.isIP(endpoint.host) ? undefined : endpoint.host,
      },
    }
  }

  const socket = rule.type === 'socks4'
    ? await connectSocks4(endpoint, target.hostname, targetPort(target))
    : await connectSocks5(endpoint, target.hostname, targetPort(target))
  onSocket(socket)
  return {
    transport: http,
    options: {
      method,
      host: target.hostname,
      port: targetPort(target),
      path: `${target.pathname}${target.search}`,
      headers: outgoingHeaders,
      agent: new SingleSocketAgent(socket),
    },
  }
}

async function selectReachableRule(rules: SystemProxyRule[], target: URL): Promise<SystemProxyRule> {
  const errors: string[] = []
  for (const rule of rules) {
    let socket: Duplex | null = null
    try {
      if (rule.type === 'direct') {
        socket = await connectTcp(target.hostname, targetPort(target))
      } else {
        const endpoint = requireEndpoint(rule)
        socket = rule.type === 'http' || rule.type === 'https'
          ? await connectProxyEndpoint(endpoint, rule.type === 'https')
          : rule.type === 'socks4'
            ? await connectSocks4(endpoint, target.hostname, targetPort(target))
            : await connectSocks5(endpoint, target.hostname, targetPort(target))
      }
      socket.destroy()
      return rule
    } catch (error) {
      socket?.destroy()
      errors.push(`${rule.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`No system proxy route succeeded (${errors.join('; ')})`)
}

function performHttpRequest(
  transport: typeof http | typeof https,
  options: OutgoingRequestOptions,
  body: Buffer,
  onSocket: (socket: Duplex) => void,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = transport.request(options, resolve)
    request.once('socket', onSocket)
    request.once('error', reject)
    request.end(body)
  })
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BUFFERED_REQUEST_BYTES) {
      throw new Error(`proxy request body exceeds ${MAX_BUFFERED_REQUEST_BYTES} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

class SingleSocketAgent extends http.Agent {
  private claimed = false

  constructor(private readonly socket: net.Socket) {
    super({ keepAlive: false })
  }

  override createConnection(): net.Socket {
    if (this.claimed) throw new Error('System proxy route socket was already claimed')
    this.claimed = true
    return this.socket
  }
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise(resolve => server.close(() => resolve()))
}

async function connectTunnelUsingRules(
  rules: SystemProxyRule[],
  targetHost: string,
  targetPortNumber: number,
): Promise<{ socket: Duplex }> {
  const errors: string[] = []
  for (const rule of rules) {
    try {
      if (rule.type === 'direct') {
        return { socket: await connectTcp(targetHost, targetPortNumber) }
      }
      const endpoint = requireEndpoint(rule)
      if (rule.type === 'http' || rule.type === 'https') {
        return {
          socket: await establishHttpProxyTunnel(
            endpoint,
            rule.type === 'https',
            targetHost,
            targetPortNumber,
          ),
        }
      }
      return {
        socket: rule.type === 'socks4'
          ? await connectSocks4(endpoint, targetHost, targetPortNumber)
          : await connectSocks5(endpoint, targetHost, targetPortNumber),
      }
    } catch (error) {
      if (error instanceof ProxyAuthenticationRequiredError) throw error
      errors.push(`${rule.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`No system proxy route succeeded (${errors.join('; ')})`)
}

async function establishHttpProxyTunnel(
  endpoint: ProxyEndpoint,
  secure: boolean,
  targetHost: string,
  targetPortNumber: number,
): Promise<Duplex> {
  const socket = await connectProxyEndpoint(endpoint, secure)
  try {
    const authority = formatAuthority(targetHost, targetPortNumber)
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    )
    const header = await readUntil(socket, Buffer.from('\r\n\r\n'), 64 * 1024)
    const statusLine = header.toString('latin1').split('\r\n', 1)[0] ?? ''
    const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i)?.[1])
    if (status === 407) {
      throw new ProxyAuthenticationRequiredError('HTTP proxy requires authentication')
    }
    if (status < 200 || status >= 300) {
      throw new Error(`HTTP proxy CONNECT returned ${Number.isFinite(status) ? status : 'an invalid response'}`)
    }
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function connectProxyEndpoint(endpoint: ProxyEndpoint, secure: boolean): Promise<Duplex> {
  return secure ? connectTls(endpoint.host, endpoint.port) : connectTcp(endpoint.host, endpoint.port)
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => socket.destroy(new Error('connection timed out')), CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function connectTls(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
    const timer = setTimeout(() => socket.destroy(new Error('connection timed out')), CONNECT_TIMEOUT_MS)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function connectSocks5(
  endpoint: ProxyEndpoint,
  targetHost: string,
  targetPortNumber: number,
): Promise<net.Socket> {
  const socket = await connectTcp(endpoint.host, endpoint.port)
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x00]))
    const greeting = await readExactly(socket, 2)
    if (greeting[0] !== 0x05 || greeting[1] !== 0x00) throw new Error('SOCKS5 proxy rejected no-authentication mode')

    const host = Buffer.from(targetHost)
    if (host.length > 255) throw new Error('SOCKS5 target hostname is too long')
    const port = Buffer.allocUnsafe(2)
    port.writeUInt16BE(targetPortNumber)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]))

    const response = await readExactly(socket, 4)
    if (response[0] !== 0x05 || response[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code ${response[1]}`)
    const addressLength = response[3] === 0x01
      ? 4
      : response[3] === 0x04
        ? 16
        : response[3] === 0x03
          ? (await readExactly(socket, 1))[0]!
          : 0
    if (!addressLength) throw new Error('SOCKS5 proxy returned an invalid address type')
    await readExactly(socket, addressLength + 2)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function connectSocks4(
  endpoint: ProxyEndpoint,
  targetHost: string,
  targetPortNumber: number,
): Promise<net.Socket> {
  const socket = await connectTcp(endpoint.host, endpoint.port)
  try {
    const port = Buffer.allocUnsafe(2)
    port.writeUInt16BE(targetPortNumber)
    const address = net.isIPv4(targetHost)
      ? targetHost
      : (await lookup(targetHost, { family: 4 })).address
    const octets = address.split('.').map(Number)
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      throw new Error('SOCKS4 target did not resolve to IPv4')
    }
    socket.write(Buffer.concat([
      Buffer.from([0x04, 0x01]),
      port,
      Buffer.from(octets),
      Buffer.from([0x00]),
    ]))
    const response = await readExactly(socket, 8)
    if (response[1] !== 0x5a) throw new Error(`SOCKS4 connect failed with code ${response[1]}`)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function readExactly(socket: net.Socket, length: number): Promise<Buffer> {
  return readFromSocket(socket, buffer => buffer.length >= length ? length : null)
}

function readUntil(socket: Duplex, marker: Buffer, maxBytes: number): Promise<Buffer> {
  return readFromSocket(socket, buffer => {
    const index = buffer.indexOf(marker)
    if (index >= 0) return index + marker.length
    if (buffer.length > maxBytes) throw new Error('proxy response headers are too large')
    return null
  })
}

function readFromSocket(
  socket: Duplex,
  completeLength: (buffer: Buffer) => number | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      clearTimeout(timer)
    }
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      let length: number | null
      try {
        length = completeLength(buffered)
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (length === null) return
      cleanup()
      if (buffered.length > length) socket.unshift(buffered.subarray(length))
      resolve(buffered.subarray(0, length))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('proxy connection closed during handshake'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('proxy handshake timed out'))
    }, CONNECT_TIMEOUT_MS)
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function parseEndpoint(value: string, defaultPort?: number): ProxyEndpoint | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(`tcp://${trimmed}`)
    const port = url.port ? Number(url.port) : defaultPort
    if (!url.hostname || !port || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host: stripIpv6Brackets(url.hostname), port }
  } catch {
    return null
  }
}

function requireEndpoint(rule: SystemProxyRule): ProxyEndpoint {
  if (!rule.host || !rule.port) throw new Error(`Invalid ${rule.type} proxy endpoint`)
  return { host: rule.host, port: rule.port }
}

function targetPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function formatAuthority(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

class ProxyAuthenticationRequiredError extends Error {}
