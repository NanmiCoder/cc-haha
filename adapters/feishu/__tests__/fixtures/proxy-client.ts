// Offline child process: only fixture credentials, loopback servers, and a
// disposable CA. The PEM key beside this file is public test data.
import * as Lark from '@larksuiteoapi/node-sdk'
import http from 'node:http'
import net from 'node:net'
import { SystemProxyBridge } from '../../../../desktop/electron/services/systemProxyBridge.js'
import { createFeishuHttpClient } from '../../http-client.js'

const requests: Array<{ path: string, authorization: string | null, body: string }> = []
let connected = false
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  tls: {
    key: Bun.file(process.env.FEISHU_FIXTURE_KEY ?? new URL('./loopback-key.fixture', import.meta.url)),
    cert: Bun.file(process.env.FEISHU_FIXTURE_CERT ?? new URL('./loopback-cert.fixture', import.meta.url)),
  },
  async fetch(request, currentServer) {
    const path = new URL(request.url).pathname
    if (path === '/events') {
      if (currentServer.upgrade(request)) return
      return new Response('upgrade required', { status: 400 })
    }
    requests.push({ path, authorization: request.headers.get('authorization'), body: await request.text() })
    if (path === '/redirect') {
      const hostname = new URL(request.url).hostname === 'localhost' ? '127.0.0.1' : 'localhost'
      return Response.redirect(`https://${hostname}:${server.port}/redirect-result`, 302)
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 })
    }
    if (path === '/open-apis/bot/v3/info') return Response.json({ code: 0, bot: { open_id: 'fixture-bot' } })
    if (path === '/callback/ws/endpoint') return Response.json({
      code: 0,
      data: {
        URL: `wss://127.0.0.1:${server.port}/events?device_id=fixture&service_id=1`,
        ClientConfig: { PingInterval: 3600, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 },
      },
    })
    if (path === '/download') return new Response('fixture-download', { headers: { 'x-fixture': 'download' } })
    return Response.json({ code: 0 })
  },
  websocket: {
    open() { connected = true },
    message() {},
  },
})
const bridge = new SystemProxyBridge(async () => { throw new Error('Only loopback targets are allowed') })
const proxyUrl = await bridge.start()
const mode = process.argv[2] ?? 'proxy'
const tunnels: string[] = []
const proxyAuthorizations: Array<string | undefined> = []
const routingProxy = http.createServer((_request, response) => { response.writeHead(400).end() })
routingProxy.on('connect', (request, socket, head) => {
  tunnels.push(request.url!)
  proxyAuthorizations.push(request.headers['proxy-authorization'])
  if (mode === 'proxy-auth-rejected') {
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    return
  }
  // No arbitrary host/port from an incoming request can escape this fixture.
  const upstream = net.connect(server.port!, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})
await new Promise<void>(resolve => routingProxy.listen(0, '127.0.0.1', resolve))
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  process.env[key] = mode.startsWith('redirect') || mode.startsWith('proxy-auth')
    ? `http://${mode === 'proxy-authenticated' ? 'fixture-user:fixture-pass@' : ''}127.0.0.1:${(routingProxy.address() as net.AddressInfo).port}`
    : mode === 'direct' ? '' : proxyUrl
}
process.env.NO_PROXY = process.env.no_proxy = mode === 'bypass' || mode.startsWith('redirect') ? '127.0.0.1' : ''
if (mode === 'bypass') await bridge.stop()
const transport = process.env.FEISHU_PROXY_BASELINE === '1' ? Lark.defaultHttpInstance : createFeishuHttpClient()
const domain = `https://127.0.0.1:${server.port}`
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} }
const client = new Lark.Client({
  appId: 'fixture-app', appSecret: 'fixture-secret', domain, httpInstance: transport, logger,
})
const wsClient = new Lark.WSClient({
  appId: 'fixture-app', appSecret: 'fixture-secret', domain, httpInstance: transport, logger, autoReconnect: false,
})
try {
  if (mode === 'proxy-auth-rejected') {
    await transport.get(`${domain}/private`, { headers: { Authorization: 'Bearer fixture-sensitive' } })
  } else if (mode.startsWith('redirect')) {
    const hostname = mode === 'redirect-to-bypass' ? 'localhost' : '127.0.0.1'
    const result = await transport.get(`https://${hostname}:${server.port}/redirect`, { timeout: 2000 })
    console.log(JSON.stringify({ result, tunnels, expectedTunnel: `localhost:${server.port}` }))
  } else {
    const info = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
    await transport.post(`${domain}/upload`, Buffer.from('fixture-upload'), { headers: { 'Content-Type': 'application/octet-stream' } })
    const download = await transport.get<{ data: AsyncIterable<Uint8Array>, headers: Record<string, string> }>(`${domain}/download`, {
      responseType: 'stream', $return_headers: true,
    })
    const chunks: Uint8Array[] = []
    for await (const chunk of download.data) chunks.push(chunk)
    await wsClient.start({ eventDispatcher: new Lark.EventDispatcher({}) })
    const deadline = Date.now() + 2000
    while (!connected && Date.now() < deadline) await Bun.sleep(10)
    console.log(JSON.stringify({ info, requests, connected, download: Buffer.concat(chunks).toString(), header: download.headers['x-fixture'], proxyAuthorizations }))
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), status: (error as { response?: { status?: number } }).response?.status, requests }))
} finally {
  wsClient.close({ force: true })
  await bridge.stop()
  routingProxy.closeAllConnections()
  routingProxy.close()
  server.stop(true)
}
// The SDK's shared token cache owns a referenced cleanup interval.
process.exit(0)
