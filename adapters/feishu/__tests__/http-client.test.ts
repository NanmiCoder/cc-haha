import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFeishuHttpClient } from '../http-client.js'

const fixture = fileURLToPath(new URL('./fixtures/proxy-client.ts', import.meta.url))
const certificate = fileURLToPath(new URL('./fixtures/loopback-cert.fixture', import.meta.url))

async function runFixture(mode: string, trustCertificate = true, fixturePath = fixture) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-proxy-'))
  try {
    const child = Bun.spawn([process.execPath, '--no-env-file', fixturePath, mode], {
      env: {
        PATH: globalThis.process.env.PATH ?? '',
        HOME: directory,
        CLAUDE_CONFIG_DIR: directory,
        NODE_EXTRA_CA_CERTS: trustCertificate ? certificate : '',
        FEISHU_PROXY_BASELINE: globalThis.process.env.FEISHU_PROXY_BASELINE ?? '',
        FEISHU_PROXY_UNBOUNDED: globalThis.process.env.FEISHU_PROXY_UNBOUNDED ?? '',
      },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    return JSON.parse(stdout.trim().split('\n').findLast(line => line.startsWith('{'))!)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Feishu SDK HTTP proxy transport', () => {
  it.each(['timeout', 'abort', 'https-timeout', 'https-abort', 'redirect-timeout', 'redirect-abort', 'concurrent-timeout', 'concurrent-abort', 'pre-abort', 'cancel-token', 'clarified-timeout'])('releases a stalled CONNECT socket on %s', async mode => {
    const stalledFixture = fileURLToPath(new URL('./fixtures/stalled-proxy.ts', import.meta.url))
    const result = await runFixture(mode, true, stalledFixture)
    expect(result).toEqual({
      code: mode === 'clarified-timeout' ? 'ETIMEDOUT' : mode.endsWith('timeout') ? 'ECONNABORTED' : 'ERR_CANCELED', openSockets: 0,
      ...(mode === 'clarified-timeout' ? { message: 'fixture deadline' } : {}),
      ...(mode.startsWith('concurrent-') ? { healthy: { healthy: true } } : {}),
    })
  })

  it.each(['timeout', 'abort', 'unsupported-proxy'])('settles and cleans up a real in-process %s request', async mode => {
    const keys = [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
      'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy',
      'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NO_PROXY',
    ]
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    for (const key of keys) process.env[key] = ''
    const sockets = new Set<Socket>()
    const proxy = http.createServer()
    const controller = new AbortController()
    const authorities: string[] = []
    let deadline: ReturnType<typeof setTimeout> | undefined
    proxy.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    proxy.on('connect', (request, socket) => {
      authorities.push(request.url ?? '')
      // CONNECT upgrades the server socket to half-open mode. Respond to the
      // client's FIN so the assertion measures client cleanup, not our fixture.
      socket.resume()
      socket.on('end', () => socket.end())
      if (mode === 'abort') controller.abort()
    })
    try {
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
      const port = (proxy.address() as AddressInfo).port
      process.env.HTTPS_PROXY = `${mode === 'unsupported-proxy' ? 'unsupported' : 'http'}://127.0.0.1:${port}`
      const options = { timeout: 100, signal: controller.signal }
      const outcome = createFeishuHttpClient().get('https://127.0.0.1:1/', options).then(
        () => ({ code: 'unexpected-success', message: '' }),
        error => ({ code: error.code, message: error.message }),
      )
      const result = await Promise.race([
        outcome,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Request did not settle')), 1000)
        }),
      ])
      if (mode === 'unsupported-proxy') {
        expect(result.message).toContain('Unsupported protocol for proxy URL: unsupported:')
        expect(authorities).toEqual([])
      } else {
        expect(result.code).toBe(mode === 'timeout' ? 'ECONNABORTED' : 'ERR_CANCELED')
        if (mode === 'timeout') expect(result.message).toBe('timeout of 100ms exceeded')
        expect(authorities).toEqual(['127.0.0.1:1'])
      }
      const cleanupDeadline = Date.now() + 500
      while (sockets.size && Date.now() < cleanupDeadline) await Bun.sleep(10)
      expect(sockets.size).toBe(0)
    } finally {
      clearTimeout(deadline)
      controller.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('preserves SDK request methods, JSON serialization, query parameters and headers', async () => {
    const keys = [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
      'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy',
      'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTP_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'NPM_CONFIG_NO_PROXY',
    ]
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    for (const key of keys) process.env[key] = ''
    process.env.NO_PROXY = process.env.no_proxy = '*'
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        return Response.json({
          method: request.method, body: await request.text(),
          query: new URL(request.url).searchParams.get('q'),
          header: request.headers.get('x-fixture'), userAgent: request.headers.get('user-agent'),
        })
      },
    })
    try {
      const client = createFeishuHttpClient()
      const url = `http://127.0.0.1:${server.port}/fixture`
      const options = { params: { q: 'query & value' }, headers: { 'x-fixture': 'preserved' } }
      for (const method of ['get', 'delete', 'options', 'post', 'put', 'patch'] as const) {
        const hasBody = ['post', 'put', 'patch'].includes(method)
        const result = hasBody
          ? await client[method as 'post' | 'put' | 'patch'](url, { input: 'fixture' }, options)
          : await client[method as 'get' | 'delete' | 'options'](url, options)
        expect(result).toEqual({
          method: method.toUpperCase(), body: hasBody ? '{"input":"fixture"}' : '',
          query: 'query & value', header: 'preserved', userAgent: 'oapi-node-sdk/1.0.0',
        })
      }
      expect(await client.head(url)).toBe('')
      expect((await client.request({ url, method: 'GET', ...options })).header).toBe('preserved')
    } finally {
      server.stop(true)
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it.each(['proxy', 'bypass', 'direct', 'proxy-authenticated'])('supports token, REST, streams and WS discovery with %s routing', async mode => {
    const result = await runFixture(mode)
    expect(result.error).toBeUndefined()
    expect(result.info.bot.open_id).toBe('fixture-bot')
    expect(result.connected).toBe(true)
    expect(result.download).toBe('fixture-download')
    expect(result.header).toBe('download')
    expect(result.requests).toContainEqual({
      path: '/open-apis/auth/v3/tenant_access_token/internal', authorization: null,
      body: JSON.stringify({ app_id: 'fixture-app', app_secret: 'fixture-secret' }),
    })
    expect(result.requests).toContainEqual({ path: '/open-apis/bot/v3/info', authorization: 'Bearer fixture-token', body: '' })
    expect(result.requests).toContainEqual({ path: '/upload', authorization: null, body: 'fixture-upload' })
    expect(result.requests.some((request: { path: string }) => request.path === '/callback/ws/endpoint')).toBe(true)
    if (mode === 'proxy-authenticated') {
      expect(result.proxyAuthorizations.length).toBeGreaterThan(0)
      expect(result.proxyAuthorizations.every((value: string) => value === `Basic ${Buffer.from('fixture-user:fixture-pass').toString('base64')}`)).toBe(true)
    }
  })

  it('preserves a rejected proxy status without sending target credentials', async () => {
    const result = await runFixture('proxy-auth-rejected')
    expect(result.status).toBe(407)
    expect(result.requests).toEqual([])
  })

  it('continues rejecting an untrusted target certificate through the bridge', async () => {
    const result = await runFixture('proxy', false)
    expect(result.error).toBeDefined()
    expect(result.requests).toEqual([])
  })

  it.each(['redirect-to-bypass', 'redirect-to-proxy'])('re-evaluates NO_PROXY for %s', async mode => {
    const result = await runFixture(mode)
    expect(result.error).toBeUndefined()
    expect(result.result).toEqual({ code: 0 })
    expect(result.tunnels).toEqual([result.expectedTunnel])
  })
})
