import http from 'node:http'
import https from 'node:https'
import net, { type Socket } from 'node:net'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { ProxyAgent } from 'proxy-agent'
import { CancelToken } from 'axios'
import { createFeishuHttpClient } from '../../http-client.js'

const mode = process.argv[2]
const tls = {
  key: await Bun.file(new URL('./loopback-key.fixture', import.meta.url)).text(),
  cert: await Bun.file(new URL('./loopback-cert.fixture', import.meta.url)).text(),
}
const target = Bun.serve({
  hostname: '127.0.0.1', port: 0, tls,
  async fetch(request) {
    if (new URL(request.url).pathname === '/redirect') return Response.redirect('https://127.0.0.1:1/')
    await Bun.sleep(150)
    return Response.json({ healthy: true })
  },
})
const sockets = new Set<Socket>()
let connected!: () => void
const handshakeStarted = new Promise<void>(resolve => { connected = resolve })
const proxy = mode.startsWith('https-') ? https.createServer(tls) : http.createServer()
proxy.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
proxy.on('connect', (request, socket, head) => {
  if (request.url === '127.0.0.1:1') {
    // CONNECT sockets are half-open: observe the client's FIN and finish our
    // side too, so the connection count reflects cancellation, not server policy.
    socket.on('end', () => socket.end())
    socket.resume()
    connected()
    return
  }
  const upstream = net.connect(target.port!, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
process.env.HTTPS_PROXY = `${mode.startsWith('https-') ? 'https' : 'http'}://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`

const controller = new AbortController()
const cancellation = CancelToken.source()
if (mode === 'pre-abort') controller.abort()
const legacyAgent = new ProxyAgent()
const client = process.env.FEISHU_PROXY_UNBOUNDED === '1'
  ? { get: (url: string, options: object) => defaultHttpInstance.get(url, {
    ...options, proxy: false, httpAgent: legacyAgent, httpsAgent: legacyAgent,
  }) }
  : createFeishuHttpClient()
const url = mode.startsWith('redirect-') ? `https://127.0.0.1:${target.port}/redirect` : 'https://127.0.0.1:1/'
const outcome = client.get(url, {
  timeout: mode.endsWith('timeout') ? 100 : 0,
  signal: controller.signal,
  ...(mode === 'cancel-token' ? { cancelToken: cancellation.token } : {}),
  ...(mode === 'clarified-timeout' ? { timeoutErrorMessage: 'fixture deadline', transitional: { clarifyTimeoutError: true } } : {}),
}).then(() => ({ code: 'success' }), error => ({
  code: error.code,
  ...(mode === 'clarified-timeout' ? { message: error.message } : {}),
}))
const concurrent = mode.startsWith('concurrent-')
  ? client.get(`https://127.0.0.1:${target.port}/`, { timeout: 1000 })
  : Promise.resolve(undefined)
if ((mode.endsWith('abort') && mode !== 'pre-abort') || mode === 'cancel-token') {
  await handshakeStarted
  if (mode === 'cancel-token') cancellation.cancel()
  else controller.abort()
}
const result = await Promise.race([outcome, Bun.sleep(1000).then(() => ({ code: 'unsettled' }))])
const healthy = await concurrent
const deadline = Date.now() + 500
while (sockets.size && Date.now() < deadline) await Bun.sleep(10)
console.log(JSON.stringify({ ...result, openSockets: sockets.size, healthy }))
controller.abort()
for (const socket of sockets) socket.destroy()
proxy.close()
target.stop(true)
process.exit(0)
