import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createFeishuHttpClient } from '../../http-client.js'
import { FeishuProxyAgent } from '../../proxy-agent.js'

const proxyKeys = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy',
  'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NO_PROXY',
]

async function run(mode: string) {
  const saved = new Map(proxyKeys.map(key => [key, process.env[key]]))
  for (const key of proxyKeys) process.env[key] = ''
  const sockets = new Set<Socket>()
  const proxy = http.createServer()
  const controller = new AbortController()
  const authorities: string[] = []
  let deadline: ReturnType<typeof setTimeout> | undefined
  let connectCalls = 0
  const originalConnect = FeishuProxyAgent.prototype.connect
  FeishuProxyAgent.prototype.connect = function(request, options) {
    connectCalls++
    return originalConnect.call(this, request, options)
  }
  proxy.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (request, socket) => {
    authorities.push(request.url ?? '')
    // CONNECT upgrades to half-open mode. Complete our side after the client's
    // FIN so openSockets measures client cleanup rather than fixture policy.
    socket.resume()
    socket.on('end', () => socket.end())
    if (mode === 'abort') controller.abort()
  })
  try {
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const port = (proxy.address() as AddressInfo).port
    process.env.HTTPS_PROXY = `${mode === 'unsupported-proxy' ? 'unsupported' : 'http'}://127.0.0.1:${port}`
    const outcome = createFeishuHttpClient().get('https://127.0.0.1:1/', {
      timeout: 100, signal: controller.signal,
    }).then(
      () => ({ code: 'unexpected-success', message: '' }),
      error => ({ code: error.code, message: error.message }),
    )
    const result = await Promise.race([
      outcome,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Request did not settle')), 1000)
      }),
    ])
    const cleanupDeadline = Date.now() + 500
    while (sockets.size && Date.now() < cleanupDeadline) await delay(10)
    return { mode, ...result, authorities, connectCalls, openSockets: sockets.size }
  } finally {
    clearTimeout(deadline)
    controller.abort()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    FeishuProxyAgent.prototype.connect = originalConnect
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function main() {
  const results = []
  // Keep all three in one process: each request must read the new proxy rather
  // than reuse the previous case's closed listener or cancellation state.
  for (const mode of ['timeout', 'abort', 'unsupported-proxy']) results.push(await run(mode))
  console.log(JSON.stringify(results))
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
