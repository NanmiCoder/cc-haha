import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFeishuHttpClient } from '../http-client.js'

const fixture = fileURLToPath(new URL('./fixtures/proxy-client.ts', import.meta.url))
const certificate = fileURLToPath(new URL('./fixtures/loopback-cert.fixture', import.meta.url))

async function runFixture(mode: string, trustCertificate = true, fixturePath = fixture, executable = process.execPath) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-proxy-'))
  try {
    const child = Bun.spawn([executable, ...(executable === process.execPath ? ['--no-env-file'] : ['--no-deprecation']), fixturePath, mode], {
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
    return JSON.parse(stdout.trim().split('\n').findLast(line => line.startsWith('{') || line.startsWith('['))!)
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

  it('settles and cleans up sequential Node agent requests as proxy configuration changes', async () => {
    // Bun's node:http implements requests through native fetch and does not call
    // Agent.connect. Test this Node-agent contract in Node; the Bun fixtures
    // above independently cover the runtime's timeout/abort/redirect behavior.
    const node = Bun.which('node')
    if (!node) throw new Error('Node.js is required for the Feishu Node agent transport contract')
    const directory = await mkdtemp(join(tmpdir(), 'feishu-node-transport-'))
    try {
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL('./fixtures/node-http-client.ts', import.meta.url))],
        target: 'node', format: 'cjs',
      })
      if (!built.success) throw new AggregateError(built.logs, 'Failed to build Node transport fixture')
      const fixturePath = join(directory, 'node-http-client.cjs')
      await Bun.write(fixturePath, built.outputs[0]!)
      const results = await runFixture('all', true, fixturePath, node)
      expect(results.map((result: { mode: string }) => result.mode)).toEqual(['timeout', 'abort', 'unsupported-proxy'])
      for (const result of results) {
        expect(result.connectCalls).toBe(1)
        expect(result.openSockets).toBe(0)
        if (result.mode === 'unsupported-proxy') {
          expect(result.message).toContain('Unsupported protocol for proxy URL: unsupported:')
          expect(result.authorities).toEqual([])
        } else {
          expect(result.code).toBe(result.mode === 'timeout' ? 'ECONNABORTED' : 'ERR_CANCELED')
          if (result.mode === 'timeout') expect(result.message).toBe('timeout of 100ms exceeded')
          expect(result.authorities).toEqual(['127.0.0.1:1'])
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
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
