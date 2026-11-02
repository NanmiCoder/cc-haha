// @vitest-environment node
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { startCloudflareProxyTransport, type CloudflareProxyTransport } from './cloudflareProxy'

const servers: Array<net.Server | http.Server> = []
const transports: CloudflareProxyTransport[] = []
const sockets = new Set<Duplex>()

afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.stop()))
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (server.listening) server.close(() => resolve())
    else resolve()
  })))
})

describe('Cloudflare proxy transport', () => {
  it('routes all four edge listeners only to official port 7844 through the selected proxy', async () => {
    const echoPort = await createEcho()
    const targets: string[] = []
    const proxy = await createConnectProxy(echoPort, request => { targets.push(request.url!) })
    const transport = await start(proxy)

    expect(new Set(transport.edgeAddresses).size).toBe(4)
    for (const address of transport.edgeAddresses) {
      expect(address).toMatch(/^127\.0\.0\.1:\d+$/)
      expect(await echo(address, 'opaque-tls-bytes')).toBe('opaque-tls-bytes')
    }
    expect(targets).toEqual([
      'region1.v2.argotunnel.com:7844', 'region2.v2.argotunnel.com:7844',
      'region1.v2.argotunnel.com:7844', 'region2.v2.argotunnel.com:7844',
    ])
  })

  it('sends proxy credentials only in CONNECT and decodes percent-encoded username and password', async () => {
    const echoPort = await createEcho()
    const headers: http.IncomingHttpHeaders[] = []
    const proxy = await createConnectProxy(echoPort, request => { headers.push(request.headers) })
    const withCredentials = proxy.replace('http://', 'http://test%40user:p%3Ass%24word@')
    const transport = await start(withCredentials)

    expect(await echo(transport.edgeAddresses[0]!, 'payload')).toBe('payload')
    expect(headers[0]?.['proxy-authorization']).toBe(`Basic ${Buffer.from('test@user:p:ss$word').toString('base64')}`)
    expect(headers[0]?.host).toBe('region1.v2.argotunnel.com:7844')
  })

  it('supports HTTPS proxies while validating their TLS certificate', async () => {
    const echoPort = await createEcho()
    const proxy = https.createServer({ key: TEST_KEY, cert: TEST_CERT })
    proxy.on('connect', (_request, client, head) => {
      track(client)
      const upstream = track(net.connect(echoPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      }))
      client.once('close', () => upstream.destroy())
      upstream.once('error', () => client.destroy())
    })
    const proxyPort = await listen(proxy)
    const transport = await start(`https://127.0.0.1:${proxyPort}`, { ca: TEST_CERT })
    expect(await echo(transport.edgeAddresses[0]!, 'secure-proxy')).toBe('secure-proxy')
  })

  it('accepts fragmented CONNECT responses and preserves bytes received after their headers', async () => {
    const proxy = net.createServer(socket => {
      track(socket)
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection Est')
        setImmediate(() => {
          socket.write('ablished\r\n\r\nprefix-')
          socket.pipe(socket)
        })
      })
    })
    const proxyPort = await listen(proxy)
    const transport = await start(`http://127.0.0.1:${proxyPort}`)
    expect(await echo(transport.edgeAddresses[0]!, 'body', 11)).toBe('prefix-body')
  })

  it('forwards a large opaque stream with backpressure and without modifying its content', async () => {
    const echoPort = await createEcho()
    const proxy = await createConnectProxy(echoPort)
    const transport = await start(proxy)
    const payload = Buffer.alloc(2 * 1024 * 1024, 0xa5)
    const socket = connectAddress(transport.edgeAddresses[0]!, 1024)
    await once(socket, 'connect')
    socket.pause()
    expect(socket.isPaused()).toBe(true)
    const receiving = readBytes(socket, payload.length)
    // A runtime may flush the entire write immediately without emitting drain.
    const drained = socket.write(payload) ? undefined : once(socket, 'drain')
    const resuming = new Promise<void>(resolve => {
      setTimeout(() => {
        socket.resume()
        resolve()
      }, 10)
    })
    const [received] = await Promise.all([receiving, drained, resuming])
    // Vitest deep equality enumerates millions of Buffer entries and can
    // exhaust the test deadline. Native equality still checks every byte.
    expect(received.equals(payload)).toBe(true)
    socket.destroy()
  })

  it.each([407, 403, 502])('fails a refused CONNECT (%s) without dialing a direct destination', async status => {
    let requests = 0
    const proxy = http.createServer()
    proxy.on('connect', (_request, socket) => {
      track(socket)
      requests++
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\nsecret-provider-message`)
    })
    const port = await listen(proxy)
    const transport = await start(`http://127.0.0.1:${port}`)
    const socket = connectAddress(transport.edgeAddresses[0]!)
    let received = ''
    socket.on('data', chunk => { received += chunk.toString() })
    await once(socket, 'close')
    expect(requests).toBe(1)
    expect(received).toBe('')
  })

  it.each(['not-an-http-response\r\n\r\n', `HTTP/1.1 200 OK\r\nX-Large: ${'a'.repeat(33 * 1024)}\r\n\r\n`])('rejects malformed or oversized CONNECT response headers', async reply => {
    const proxy = net.createServer(socket => {
      track(socket)
      socket.once('data', () => socket.write(reply))
    })
    const proxyPort = await listen(proxy)
    const transport = await start(`http://127.0.0.1:${proxyPort}`)
    const socket = connectAddress(transport.edgeAddresses[0]!)
    await waitClosed(socket)
    expect(socket.destroyed).toBe(true)
  })

  it('terminates an edge attempt when the CONNECT proxy never responds', async () => {
    const proxy = net.createServer(track)
    const port = await listen(proxy)
    const transport = await start(`http://127.0.0.1:${port}`, { connectTimeoutMs: 40 })
    const socket = connectAddress(transport.edgeAddresses[0]!)
    await once(socket, 'close')
    expect(socket.destroyed).toBe(true)
  })

  // The desktop host runs Node. Bun 1.3 does not honor tls.connect({ socket })
  // when upgrading an existing CONNECT socket. These real TLS fixtures run in
  // the desktop Vitest lane (Node), while Bun still exercises the edge bridge.
  it.skipIf('Bun' in globalThis)('routes Quick provisioning through the same proxy with real TLS SNI and a fixed upstream path', async () => {
    const upstreamRequests: Array<{ url?: string, body: string, headers: http.IncomingHttpHeaders }> = []
    const servernames: Array<string | false | null> = []
    const origin = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      upstreamRequests.push({ url: request.url, body, headers: request.headers })
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: true, result: { hostname: 'test.trycloudflare.com' } }))
    })
    origin.on('secureConnection', socket => { servernames.push(socket.servername) })
    const originPort = await listen(origin)
    const targets: string[] = []
    const proxy = await createConnectProxy(originPort, request => { targets.push(request.url!) })
    const transport = await start(proxy, { ca: TEST_CERT })
    const result = await localRequest(`${transport.quickServiceUrl}/tunnel`, 'POST', '{}', {
      'User-Agent': 'cloudflared/test',
      Authorization: 'must-not-forward',
      'Proxy-Authorization': 'must-not-forward',
    })

    expect(targets).toEqual(['api.trycloudflare.com:443'])
    expect(servernames).toEqual(['api.trycloudflare.com'])
    expect(result.status).toBe(201)
    expect(JSON.parse(result.body).success).toBe(true)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]?.url).toBe('/tunnel')
    expect(upstreamRequests[0]?.body).toBe('{}')
    expect(upstreamRequests[0]?.headers['user-agent']).toBe('cloudflared/test')
    expect(upstreamRequests[0]?.headers.authorization).toBeUndefined()
    expect(upstreamRequests[0]?.headers['proxy-authorization']).toBeUndefined()
  })

  it('keeps the provisioning listener private and cannot be used as an arbitrary HTTP proxy', async () => {
    let connections = 0
    const proxy = http.createServer()
    proxy.on('connect', (_request, socket) => {
      connections++
      socket.destroy()
    })
    const proxyPort = await listen(proxy)
    const transport = await start(`http://127.0.0.1:${proxyPort}`)
    const base = new URL(transport.quickServiceUrl).origin

    expect((await localRequest(`${base}/tunnel`, 'POST')).status).toBe(404)
    expect((await localRequest(`${transport.quickServiceUrl}/tunnel`, 'GET')).status).toBe(404)
    expect((await localRequest(`${transport.quickServiceUrl}/tunnel`, 'POST', '', { Origin: 'https://hostile.example' })).status).toBe(404)
    expect((await localRequest(`${transport.quickServiceUrl}/tunnel?target=https://hostile.example`, 'POST')).status).toBe(404)
    expect(connections).toBe(0)
  })

  it.skipIf('Bun' in globalThis)('rejects an untrusted Quick API certificate without disabling certificate validation', async () => {
    let originRequests = 0
    const origin = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_request, response) => {
      originRequests++
      response.end('{}')
    })
    const originPort = await listen(origin)
    const proxy = await createConnectProxy(originPort)
    const transport = await start(proxy)
    const result = await localRequest(`${transport.quickServiceUrl}/tunnel`, 'POST')
    expect(result.status).toBe(502)
    expect(result.body).not.toContain('CERT_')
    expect(originRequests).toBe(0)
  })

  it.skipIf('Bun' in globalThis)('bounds the Quick API response before forwarding a provider payload', async () => {
    const origin = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_request, response) => {
      response.end('x'.repeat(1024 * 1024 + 1))
    })
    const originPort = await listen(origin)
    const proxy = await createConnectProxy(originPort)
    const transport = await start(proxy, { ca: TEST_CERT })
    const result = await localRequest(`${transport.quickServiceUrl}/tunnel`, 'POST')
    expect(result.status).toBe(502)
    expect(result.body.length).toBeLessThan(200)
  })

  it('returns a bounded, sanitized Quick API failure and cancels on shutdown', async () => {
    const proxy = net.createServer(track)
    const proxyPort = await listen(proxy)
    const transport = await start(`http://secret:credential@127.0.0.1:${proxyPort}`, {
      requestTimeoutMs: 40,
      connectTimeoutMs: 1000,
    })
    const result = await localRequest(`${transport.quickServiceUrl}/tunnel`, 'POST')
    expect(result.status).toBe(504)
    expect(result.body).not.toContain('secret')
    expect(result.body).not.toContain('credential')
    expect(result.body).not.toContain('127.0.0.1')

    const socket = connectAddress(transport.edgeAddresses[0]!)
    await once(socket, 'connect')
    const closed = waitClosed(socket)
    await transport.stop()
    await closed
    for (const address of transport.edgeAddresses) await expectConnectionRefused(address)
    await expectConnectionRefused(new URL(transport.quickServiceUrl).host)
    await transport.stop()
  })

  it('honors cancellation before startup and while connected', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(startCloudflareProxyTransport('http://127.0.0.1:1234', { signal: cancelled.signal }))
      .rejects.toThrow('cancelled')

    const echoPort = await createEcho()
    const proxy = await createConnectProxy(echoPort)
    const controller = new AbortController()
    const transport = await start(proxy, { signal: controller.signal })
    const socket = connectAddress(transport.edgeAddresses[0]!)
    await once(socket, 'connect')
    const closed = waitClosed(socket)
    controller.abort()
    await closed
    await transport.stop()
    await expectConnectionRefused(transport.edgeAddresses[0]!)
  })

  it.each(['socks5://127.0.0.1:1080', 'http://user:%invalid@127.0.0.1:1', 'garbage'])('rejects unsupported proxy configuration safely: %s', async proxy => {
    await expect(startCloudflareProxyTransport(proxy)).rejects.toThrow('valid HTTP or HTTPS proxy')
  })
})

async function start(proxy: string, options: Parameters<typeof startCloudflareProxyTransport>[1] = {}) {
  const transport = await startCloudflareProxyTransport(proxy, options)
  transports.push(transport)
  return transport
}

function track<T extends Duplex>(socket: T): T {
  sockets.add(socket)
  socket.once('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  return socket
}

function listen(server: net.Server): Promise<number> {
  servers.push(server)
  server.on('connection', track)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('Missing test port'))
      else resolve(address.port)
    })
  })
}

async function createEcho(): Promise<number> {
  return await listen(net.createServer(socket => { socket.pipe(socket) }))
}

async function createConnectProxy(targetPort: number, onConnect: (request: http.IncomingMessage) => void = () => {}): Promise<string> {
  const proxy = http.createServer()
  proxy.on('connect', (request, client, head) => {
    track(client)
    onConnect(request)
    const upstream = track(net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    }))
    client.once('close', () => upstream.destroy())
    upstream.once('error', () => client.destroy())
  })
  return `http://127.0.0.1:${await listen(proxy)}`
}

function connectAddress(address: string, highWaterMark?: number): net.Socket {
  const [host, port] = address.split(':')
  const options = { port: Number(port), host, highWaterMark }
  return track(net.connect(options))
}

async function echo(address: string, message: string, responseBytes = Buffer.byteLength(message)): Promise<string> {
  const socket = connectAddress(address)
  const result = readBytes(socket, responseBytes)
  socket.write(message)
  const received = await result
  socket.destroy()
  return received.toString()
}

function readBytes(socket: net.Socket, expected: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    socket.on('data', chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(data)
      length += data.length
      if (length >= expected) resolve(Buffer.concat(chunks))
    })
    socket.once('error', reject)
    socket.once('close', () => { if (length < expected) reject(new Error('Stream closed early')) })
  })
}

function waitClosed(socket: net.Socket): Promise<void> {
  return new Promise(resolve => socket.once('close', () => resolve()))
}

function localRequest(url: string, method: string, body = '', headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers, agent: false }, response => {
      let result = ''
      response.on('data', chunk => { result += chunk.toString() })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode!, body: result }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function expectConnectionRefused(address: string) {
  const socket = connectAddress(address)
  await new Promise<void>((resolve, reject) => {
    socket.once('error', () => resolve())
    socket.once('connect', () => reject(new Error('Listener remained open')))
  })
}

// Disposable self-signed fixture for the fixed upstream hostname. Its trust is
// supplied only to this transport instance, never to global/user TLS settings.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCyCWxpNAFIPt51
wH1mOBYDb92p7axPP5nCArOmn19l61Y662OdWiB7LuJF73QE6OLPNc4KO/rDSUJ+
BPsCLNfeOl7vV5K/qyl3HByNJ4+6Hfq/r1iSZhEGC/ubI3n0f8HzP6+7rMqrBNUt
L3NM0u9fOK9z4XsiC3lQ9Suqsf/upjy1Tk90P4LFeLPst6RJTpgNqiBVtDS4fQd5
mJ15AzM2DzqWbfNET3g0m14HK+CcBfPewWiMjQVYslVR1N42DJ1SaIRLb6pohPMY
q5//K9Yix+6B6VWVt3UAYK95lKodwFeBIuXqB0eQC43SjpuW5AJ5IhYcqvaGx35V
SWp6vN/FAgMBAAECggEAA35LIMWcGbAoZgIWiqtrxgNZHwhiesviLfdwCIxwJfnh
OsSW6iXYyb1osaAsivdDJJvZcnqs802TDKQb8r8Mprf+DwYNOk37imAfwwIjEngu
Q9692WIbK4yPpIKSVhl2ykdNIO8XqzoZsQE12Jpo9P5IrMHFFYhJGlHGWqRKMYMw
sOeDWtyO1IEUE0veEFEiddjnSU/6kXG8N8yNW9kF3W3yvTPih8m/eqHJI50iCyu7
/ey5YLJTum3goz2YFJMUACGKM4rp8LjdKwk360bbT1E9rwu+hmfrZtbcsfqeGN0t
LY0MSCB7lifYqgDy/TAoGscg6H+gyumeIV9ILKlknwKBgQDmxwcIWnWLd2PW4xx0
9Rmsi6pIc/0cEQOJaQNa6lCFWm5wulFy7S4P89kImYkutRiyHOJp0bM+NXk76ukD
YxfWCRHwRUbe0OIy7aaVSCboRRA/UhUen8KAbTHtHgAnTm8+4+InahXJ5QX+zQcw
FJTLPbq/UtZxg6PDaNYOiIJZ7wKBgQDFfsEP0x6Qf1CK4swhB5uINtT45l6EJKX/
KPV/OZn6xLNBRsrchYupY7rbYpM/0AUoDw5bqH6oZm73BfspnHLHpJt+GEftCe5k
yGKL3E5CBvWN/1qFc/EKYRrNSCLdb8aoVOoJTdY3pn+6l7cHi2jaTdt2xaDJYy8g
PfntMvGliwKBgQCL64oZB3eTOqze4c4kH2MUmY2B5klFFg+15WSyX7S4Va72TBEM
BD/UTj19mFFzbzts6lRgYlMx2YwKxw/GDPOrws4MhoREnhM3W52PjzJ/yzfhnGvP
qH9uDEakBHeFXWnXkKVSzmAti91Jspe0EBZy75dlXt1D79N/q/V01FFsIwKBgQC+
CvMMn0NSGLEQdJ2pSwDHWrwlpshcsEdr+aYC/xLE1HMJ5W1gNsHmBinQ4lJ/nVTY
72QJn2IB+k/dNMwzhnCM3EEkXYkY9+2G3ay2mRBVSQ0Rzx70PFU+f6Ki1z91hhHL
+aobueLhOj6+9y8Q+32yVClTaWkHYYH/rKPLNLKDcQKBgQC7UhTcVHIfHB3kqTC8
E3edlqp6urvU+cDqE4OpXddcgAfSHlPwHHzwg0Uq6Ll31ugHmPkJdVYe+Xrtxk0+
5WK4CTFelSquOV5/MhMl4NfKDw9zVUT2IQjxKTcpfWB1dVkliGx3cHqWn62Ian69
35sz4vwA53tZ8vkIruClQ536sQ==
-----END PRIVATE KEY-----`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIUVxF3k4swS425Udgfo8qodecgbXYwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVYXBpLnRyeWNsb3VkZmxhcmUuY29tMCAXDTI2MTAyOTE0
MDEzMloYDzIxMjYxMDA1MTQwMTMyWjAgMR4wHAYDVQQDDBVhcGkudHJ5Y2xvdWRm
bGFyZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCyCWxpNAFI
Pt51wH1mOBYDb92p7axPP5nCArOmn19l61Y662OdWiB7LuJF73QE6OLPNc4KO/rD
SUJ+BPsCLNfeOl7vV5K/qyl3HByNJ4+6Hfq/r1iSZhEGC/ubI3n0f8HzP6+7rMqr
BNUtL3NM0u9fOK9z4XsiC3lQ9Suqsf/upjy1Tk90P4LFeLPst6RJTpgNqiBVtDS4
fQd5mJ15AzM2DzqWbfNET3g0m14HK+CcBfPewWiMjQVYslVR1N42DJ1SaIRLb6po
hPMYq5//K9Yix+6B6VWVt3UAYK95lKodwFeBIuXqB0eQC43SjpuW5AJ5IhYcqvaG
x35VSWp6vN/FAgMBAAGjWjBYMB0GA1UdDgQWBBSpdL4EU73UvC+Y+k3sCaC3vGVl
yzAPBgNVHRMBAf8EBTADAQH/MCYGA1UdEQQfMB2CFWFwaS50cnljbG91ZGZsYXJl
LmNvbYcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAg1ySdBXF6lVRmNU7kmdMoS5W
7A0dElgOfGTpEOWDP5ZcH7XflOmxHCkiGYVbduiE/OUy7fwrl9D3ySdgvSM+Ypgu
dI/4e5AUmt2F2XO2+TXGs497mEXHA8v7tb/q4QXQOjHwWuZYtejcyDO4qw2tqw2o
0UzAOcv+oN/C6+RSYUsEoYxKkp+846jCYV5Ay5VyaME61sX/fo6HqDB42MwtGmUk
HMal5dCLDOFwZjIKPhfgbX3Q75FUgBYKVhNoAUnCS90nNV7sWPC//ThBfS9MLpwm
4jjt2vdBsDdkY359WA/hbhFWMi1wKg7AKe+6fUew2impKiNC02j5yuQQ+3RcQQ==
-----END CERTIFICATE-----`
