import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { PassThrough, type Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSystemProxyRules,
  sanitizeProxyRequestHeaders,
  SystemProxyBridge,
} from './systemProxyBridge'

const servers: Array<http.Server | net.Server> = []
const bridges: SystemProxyBridge[] = []
const sockets = new Set<Duplex>()

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => closeServer(server)))
})

describe('SystemProxyBridge', () => {
  it('preserves Chromium proxy fallback order and supported rule types', () => {
    expect(parseSystemProxyRules(
      'HTTPS secure.example:8443; PROXY plain.example:8080; SOCKS4 old.example:1080; SOCKS5 socks.example:1081; DIRECT',
    )).toEqual([
      { type: 'https', host: 'secure.example', port: 8443 },
      { type: 'http', host: 'plain.example', port: 8080 },
      { type: 'socks4', host: 'old.example', port: 1080 },
      { type: 'socks5', host: 'socks.example', port: 1081 },
      { type: 'direct' },
    ])
    expect(parseSystemProxyRules('SOCKS socks.example:1080; DIRECT')[0]?.type).toBe('socks4')
    expect(parseSystemProxyRules('')).toEqual([{ type: 'direct' }])
    expect(parseSystemProxyRules('INVALID proxy.example:1234')).toEqual([])
  })

  it('removes proxy credentials and declared hop-by-hop headers', () => {
    expect(sanitizeProxyRequestHeaders({
      connection: 'keep-alive, x-remove-me',
      'proxy-authorization': 'Basic secret',
      'proxy-connection': 'keep-alive',
      'x-remove-me': 'private-hop',
    })).toEqual({})
  })

  it('resolves PAC rules per target and observes runtime changes without restart', async () => {
    const firstProxy = await createProxyServer('first')
    const secondProxy = await createProxyServer('second')
    let selectedPort = firstProxy
    const resolver = vi.fn(async () => `PROXY 127.0.0.1:${selectedPort}; DIRECT`)
    const bridge = await startBridge(resolver)

    expect(await requestThroughProxy(bridge, 'http://foreign.example/one')).toBe('first')
    selectedPort = secondProxy
    expect(await requestThroughProxy(bridge, 'http://foreign.example/two')).toBe('second')

    expect(resolver).toHaveBeenNthCalledWith(1, 'http://foreign.example/one')
    expect(resolver).toHaveBeenNthCalledWith(2, 'http://foreign.example/two')
  })

  it('falls back to the next PAC route when the preferred proxy cannot connect', async () => {
    const unavailablePort = await reserveClosedPort()
    const workingProxy = await createProxyServer('fallback')
    const bridge = await startBridge(async () => (
      `PROXY 127.0.0.1:${unavailablePort}; PROXY 127.0.0.1:${workingProxy}; DIRECT`
    ))

    expect(await requestThroughProxy(bridge, 'http://fallback.example/value')).toBe('fallback')
  })

  it('falls back when a connected proxy drops the request before responding', async () => {
    const droppingProxy = net.createServer(socket => {
      socket.once('data', () => socket.destroy())
    })
    servers.push(droppingProxy)
    const droppingPort = await listen(droppingProxy)
    const workingProxy = await createProxyServer('request-fallback')
    const bridge = await startBridge(async () => (
      `PROXY 127.0.0.1:${droppingPort}; PROXY 127.0.0.1:${workingProxy}; DIRECT`
    ))

    expect(await requestThroughProxy(bridge, 'http://fallback.example/after-drop'))
      .toBe('request-fallback')
  })

  it('terminates the downstream response when a selected proxy resets after sending headers', async () => {
    const resettingProxy = net.createServer(socket => {
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\npartial',
          () => setTimeout(() => socket.resetAndDestroy(), 25),
        )
      })
    })
    servers.push(resettingProxy)
    const resettingPort = await listen(resettingProxy)
    const bridge = await startBridge(async () => `PROXY 127.0.0.1:${resettingPort}`)

    const outcome = await Promise.race([
      requestOutcomeThroughProxy(bridge, 'http://foreign.example/after-reset'),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 500)),
    ])

    expect(outcome).not.toBe('timed-out')
    expect(outcome).not.toBe('end')
  })

  it('does not replay a non-idempotent request after its selected proxy drops it', async () => {
    let firstProxyRequests = 0
    const droppingProxy = net.createServer(socket => {
      socket.once('data', () => {
        firstProxyRequests++
        socket.destroy()
      })
    })
    servers.push(droppingProxy)
    const droppingPort = await listen(droppingProxy)
    let fallbackRequests = 0
    const fallbackProxy = http.createServer((_request, response) => {
      fallbackRequests++
      response.end('must-not-replay')
    })
    servers.push(fallbackProxy)
    const fallbackPort = await listen(fallbackProxy)
    const bridge = await startBridge(async () => (
      `PROXY 127.0.0.1:${droppingPort}; PROXY 127.0.0.1:${fallbackPort}; DIRECT`
    ))

    await expect(requestThroughProxy(bridge, 'http://foreign.example/model', 'POST', 'prompt'))
      .rejects.toThrow('HTTP 502')
    expect(firstProxyRequests).toBe(1)
    expect(fallbackRequests).toBe(0)
  })

  it('removes proxy credentials and hop-by-hop headers before forwarding', async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {}
    const proxy = http.createServer((request, response) => {
      receivedHeaders = request.headers
      response.end('sanitized')
    })
    servers.push(proxy)
    const proxyPort = await listen(proxy)
    const bridge = await startBridge(async () => `PROXY 127.0.0.1:${proxyPort}`)

    expect(await requestThroughProxy(
      bridge,
      'http://foreign.example/value',
      'GET',
      undefined,
      {
        Connection: 'keep-alive, x-remove-me',
        'Proxy-Authorization': 'Basic secret',
        'Proxy-Connection': 'keep-alive',
        'X-Remove-Me': 'private-hop',
      },
    )).toBe('sanitized')
    expect(receivedHeaders['proxy-authorization']).toBeUndefined()
    expect(receivedHeaders['x-remove-me']).toBeUndefined()
  })

  it('preserves fallback order for CONNECT tunnels', async () => {
    const echoServer = net.createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.pipe(socket)
    })
    servers.push(echoServer)
    const echoPort = await listen(echoServer)
    const tunnelProxy = http.createServer()
    tunnelProxy.on('connect', (_request, clientSocket, head) => {
      const targetSocket = net.connect({ host: '127.0.0.1', port: echoPort }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) targetSocket.write(head)
        targetSocket.pipe(clientSocket)
        clientSocket.pipe(targetSocket)
      })
      targetSocket.on('error', () => clientSocket.destroy())
    })
    servers.push(tunnelProxy)
    const proxyPort = await listen(tunnelProxy)
    const unavailablePort = await reserveClosedPort()
    const resolver = vi.fn(async () => (
      `PROXY 127.0.0.1:${unavailablePort}; PROXY 127.0.0.1:${proxyPort}; DIRECT`
    ))
    const bridge = await startBridge(resolver)

    await expect(connectAndEcho(bridge, 'foreign.example:443', 'tunnel-ok'))
      .resolves.toBe('tunnel-ok')
    expect(resolver).toHaveBeenCalledWith('https://foreign.example/')
  })

  it('surfaces proxy authentication requirements without falling through to DIRECT', async () => {
    const authProxy = http.createServer()
    authProxy.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n')
    })
    servers.push(authProxy)
    const proxyPort = await listen(authProxy)
    const bridge = await startBridge(async () => `PROXY 127.0.0.1:${proxyPort}; DIRECT`)

    await expect(connectAndEcho(bridge, 'foreign.example:443', 'unused'))
      .rejects.toThrow('407 Proxy Authentication Required')
  })

  it('handles a client reset while CONNECT proxy resolution is pending', async () => {
    let markResolverStarted!: () => void
    const resolverStarted = new Promise<void>(resolve => { markResolverStarted = resolve })
    let releaseResolver!: () => void
    const resolverReleased = new Promise<void>(resolve => { releaseResolver = resolve })
    const bridge = new SystemProxyBridge(async () => {
      markResolverStarted()
      await resolverReleased
      return 'INVALID'
    })
    bridges.push(bridge)
    const clientSocket = new PassThrough()

    const handling = invokeConnect(bridge, 'foreign.example:443', clientSocket)
    await resolverStarted

    expect(() => clientSocket.emit(
      'error',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    )).not.toThrow()
    releaseResolver()

    await expect(handling).resolves.toBeUndefined()
    expect(clientSocket.destroyed).toBe(true)
  })

  it('handles a graceful client end while CONNECT proxy resolution is pending', async () => {
    let markResolverStarted!: () => void
    const resolverStarted = new Promise<void>(resolve => { markResolverStarted = resolve })
    let releaseResolver!: () => void
    const resolverReleased = new Promise<void>(resolve => { releaseResolver = resolve })
    const bridge = new SystemProxyBridge(async () => {
      markResolverStarted()
      await resolverReleased
      return 'INVALID'
    })
    bridges.push(bridge)
    const clientSocket = new PassThrough()
    const end = vi.spyOn(clientSocket, 'end')

    const handling = invokeConnect(bridge, 'foreign.example:443', clientSocket)
    await resolverStarted
    clientSocket.emit('end')
    releaseResolver()

    await expect(handling).resolves.toBeUndefined()
    expect(clientSocket.destroyed).toBe(true)
    expect(end).not.toHaveBeenCalled()
  })

  it('does not send a CONNECT failure response after the client is closed', async () => {
    const bridge = new SystemProxyBridge(async () => 'DIRECT')
    bridges.push(bridge)
    const clientSocket = new PassThrough()
    const end = vi.spyOn(clientSocket, 'end')
    clientSocket.destroy()

    await expect(invokeConnect(bridge, 'invalid target', clientSocket)).resolves.toBeUndefined()

    expect(end).not.toHaveBeenCalled()
  })

  it('destroys a CONNECT route that finishes after the client closes', async () => {
    let markProxyAccepted!: () => void
    const proxyAccepted = new Promise<void>(resolve => { markProxyAccepted = resolve })
    let releaseProxyResponse!: () => void
    const proxyResponseReleased = new Promise<void>(resolve => { releaseProxyResponse = resolve })
    const tunnelProxy = http.createServer()
    tunnelProxy.on('connect', (_request, socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      markProxyAccepted()
      void proxyResponseReleased.then(() => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      })
    })
    servers.push(tunnelProxy)
    const proxyPort = await listen(tunnelProxy)
    const bridge = new SystemProxyBridge(async () => `PROXY 127.0.0.1:${proxyPort}`)
    bridges.push(bridge)
    const trackedRoutes = vi.spyOn(bridge as unknown as {
      trackOutboundSocket(socket: Duplex): void
    }, 'trackOutboundSocket')
    const clientSocket = new PassThrough()

    const handling = invokeConnect(bridge, 'foreign.example:443', clientSocket)
    await proxyAccepted
    clientSocket.emit('close')
    releaseProxyResponse()

    await expect(handling).resolves.toBeUndefined()
    expect(trackedRoutes).toHaveBeenCalledOnce()
    expect(trackedRoutes.mock.calls[0]?.[0].destroyed).toBe(true)
  })

  it('always bypasses system proxy resolution for loopback targets', async () => {
    const target = http.createServer((_request, response) => response.end('loopback'))
    servers.push(target)
    const targetPort = await listen(target)
    const resolver = vi.fn(async () => 'PROXY unreachable.example:8080')
    const bridge = await startBridge(resolver)

    await expect(requestThroughProxy(bridge, `http://127.0.0.1:${targetPort}/health`))
      .resolves.toBe('loopback')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('binds the bridge only to IPv4 loopback', async () => {
    const bridgeUrl = await startBridge(async () => 'DIRECT')
    expect(new URL(bridgeUrl).hostname).toBe('127.0.0.1')
  })

  it('does not publish a listener when stop races with startup', async () => {
    const bridge = new SystemProxyBridge(async () => 'DIRECT')
    bridges.push(bridge)

    const startup = bridge.start()
    await bridge.stop()
    await expect(startup).rejects.toThrow('startup was stopped')

    const restartedUrl = await bridge.start()
    expect(new URL(restartedUrl).hostname).toBe('127.0.0.1')
  })

  it('waits for the listen callback before closing a pending listener', async () => {
    const pending = createPendingProxyServer(41001)
    const createServer = vi.spyOn(http, 'createServer').mockReturnValueOnce(pending.server)
    const bridge = new SystemProxyBridge(async () => 'DIRECT')
    bridges.push(bridge)
    const startup = bridge.start()
    const startupResult = startup.catch(error => error)
    const stopping = bridge.stop()

    try {
      expect(pending.server.listening).toBe(true)
      expect(pending.server.closeAllConnections).not.toHaveBeenCalled()
      expect(pending.server.close).not.toHaveBeenCalled()
      pending.finishListening()
      await stopping
      expect(await startupResult).toEqual(new Error('System proxy bridge startup was stopped'))
      expect(pending.server.close).toHaveBeenCalledTimes(1)
    } finally {
      pending.finishListening()
      await stopping
      createServer.mockRestore()
    }
  })

  it('keeps a newer listener active when an older pending startup is stopped', async () => {
    const first = createPendingProxyServer(41001)
    const second = createPendingProxyServer(41002)
    const createServer = vi.spyOn(http, 'createServer')
      .mockReturnValueOnce(first.server)
      .mockReturnValueOnce(second.server)
    const bridge = new SystemProxyBridge(async () => 'DIRECT')
    bridges.push(bridge)
    const firstStartup = bridge.start().catch(error => error)
    const stopping = bridge.stop()
    const secondStartup = bridge.start()

    try {
      second.finishListening()
      expect(await secondStartup).toBe('http://127.0.0.1:41002')
      first.finishListening()
      await stopping
      expect(await firstStartup).toEqual(new Error('System proxy bridge startup was stopped'))
      expect(second.server.listening).toBe(true)
      expect(second.server.closeAllConnections).not.toHaveBeenCalled()
      expect(second.server.close).not.toHaveBeenCalled()
      expect(await bridge.start()).toBe('http://127.0.0.1:41002')
    } finally {
      first.finishListening()
      second.finishListening()
      await stopping
      createServer.mockRestore()
    }
  })

  it('closes active CONNECT clients and outbound routes during stop', async () => {
    let acceptTarget!: () => void
    const targetAccepted = new Promise<void>(resolve => { acceptTarget = resolve })
    let closeTarget!: () => void
    const targetClosed = new Promise<void>(resolve => { closeTarget = resolve })
    const target = net.createServer(socket => {
      acceptTarget()
      socket.once('close', closeTarget)
    })
    servers.push(target)
    const targetPort = await listen(target)
    const bridge = new SystemProxyBridge(async () => 'DIRECT')
    bridges.push(bridge)
    const bridgeUrl = await bridge.start()
    const client = await openConnectTunnel(bridgeUrl, `127.0.0.1:${targetPort}`)
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    await targetAccepted

    await expect(Promise.race([
      bridge.stop().then(() => 'stopped'),
      new Promise<string>(resolve => setTimeout(() => resolve('timed out'), 500)),
    ])).resolves.toBe('stopped')
    await expect(Promise.race([
      targetClosed.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(() => resolve('timed out'), 500)),
    ])).resolves.toBe('closed')
  })
})

function createPendingProxyServer(port: number) {
  const server = new EventEmitter() as http.Server
  let listening = false
  let listenCallback: (() => void) | undefined
  Object.defineProperty(server, 'listening', { get: () => listening })
  server.listen = vi.fn((...args: unknown[]) => {
    listening = true
    listenCallback = args.at(-1) as () => void
    return server
  }) as typeof server.listen
  server.close = vi.fn((callback?: () => void) => {
    listening = false
    callback?.()
    return server
  }) as typeof server.close
  server.closeAllConnections = vi.fn()
  server.address = vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port }))
  return {
    server,
    finishListening() {
      const callback = listenCallback
      listenCallback = undefined
      callback?.()
    },
  }
}

async function startBridge(
  resolver: (url: string) => Promise<string>,
): Promise<string> {
  const bridge = new SystemProxyBridge(resolver)
  bridges.push(bridge)
  return await bridge.start()
}

function invokeConnect(
  bridge: SystemProxyBridge,
  url: string,
  clientSocket: Duplex,
): Promise<void> {
  return (bridge as unknown as {
    handleConnect(
      request: http.IncomingMessage,
      clientSocket: Duplex,
      head: Buffer,
    ): Promise<void>
  }).handleConnect({ url } as http.IncomingMessage, clientSocket, Buffer.alloc(0))
}

async function createProxyServer(label: string): Promise<number> {
  const server = http.createServer((_request, response) => response.end(label))
  servers.push(server)
  return await listen(server)
}

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not resolve test server port'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise(resolve => {
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close(() => resolve())
  })
}

async function reserveClosedPort(): Promise<number> {
  const server = net.createServer()
  const port = await listen(server)
  await closeServer(server)
  const index = servers.indexOf(server)
  if (index >= 0) servers.splice(index, 1)
  return port
}

function requestThroughProxy(
  proxyUrl: string,
  targetUrl: string,
  method = 'GET',
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      path: targetUrl,
      method,
      headers: { Host: new URL(targetUrl).host, ...extraHeaders },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Proxy returned HTTP ${response.statusCode}: ${Buffer.concat(chunks).toString()}`))
          return
        }
        resolve(Buffer.concat(chunks).toString())
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function requestOutcomeThroughProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<'aborted' | 'response-error' | 'request-error' | 'end'> {
  const proxy = new URL(proxyUrl)
  return new Promise(resolve => {
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      path: targetUrl,
      headers: { Host: new URL(targetUrl).host },
    }, response => {
      response.resume()
      response.once('aborted', () => resolve('aborted'))
      response.once('error', () => resolve('response-error'))
      response.once('end', () => resolve('end'))
    })
    request.once('error', () => resolve('request-error'))
    request.end()
  })
}

function connectAndEcho(
  proxyUrl: string,
  authority: string,
  payload: string,
): Promise<string> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) })
    let connected = false
    let buffered = Buffer.alloc(0)
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (!connected) {
        const headerEnd = buffered.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const header = buffered.subarray(0, headerEnd).toString()
        if (!header.includes(' 200 ')) {
          socket.destroy()
          reject(new Error(`CONNECT failed: ${header}`))
          return
        }
        connected = true
        buffered = buffered.subarray(headerEnd + 4)
        socket.write(payload)
      }
      if (connected && buffered.length >= Buffer.byteLength(payload)) {
        const result = buffered.subarray(0, Buffer.byteLength(payload)).toString()
        socket.destroy()
        resolve(result)
      }
    })
    socket.once('error', reject)
  })
}

function openConnectTunnel(proxyUrl: string, authority: string): Promise<net.Socket> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) })
    let buffered = Buffer.alloc(0)
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      socket.off('data', onData)
      const header = buffered.subarray(0, headerEnd).toString()
      if (!header.includes(' 200 ')) {
        socket.destroy()
        reject(new Error(`CONNECT failed: ${header}`))
        return
      }
      resolve(socket)
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}
