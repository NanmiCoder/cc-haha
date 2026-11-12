import '../../../preload.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCACertsCache } from '../../utils/caCerts.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { configureMcpHostProxy } from '../../server/services/networkSettings.js'
import { clearServerCache, connectToServer, fetchToolsForClient, callIdeRpc } from './client.js'
import { getMcpConnectionError } from './connectionErrors.js'
import { resolveMcpHostProxy, setMcpHostProxyResolver } from './hostProxy.js'
import type { ScopedMcpServerConfig } from './types.js'
import { MCP_FIXTURE_CERT, UNREACHABLE_MCP_HOST, isolateMcpFixtureCredentials, startLegacySseMcpServer, startRecordingProxy, startStreamableMcpServer, waitFor, type McpFixture, type RecordingProxy } from './__tests__/networkProxyFixtures.js'

const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'CC_HAHA_SYSTEM_PROXY_URL', 'CC_HAHA_SYSTEM_PROXY_ERROR', 'CLAUDE_CONFIG_DIR', 'NODE_EXTRA_CA_CERTS'] as const
let previous: Record<string, string | undefined>
let root: string
let restoreStorage: () => void
let dispose: (() => void) | undefined
const fixtures: McpFixture[] = []
const proxies: RecordingProxy[] = []
const clients: Array<{ name: string, config: ScopedMcpServerConfig }> = []
let sequence = 0

beforeEach(async () => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  root = await mkdtemp(join(tmpdir(), 'mcp-routing-'))
  process.env.CLAUDE_CONFIG_DIR = root
  const certificate = join(root, 'fixture-ca.pem')
  await writeFile(certificate, MCP_FIXTURE_CERT)
  process.env.NODE_EXTRA_CA_CERTS = certificate
  resetSettingsCache()
  clearCACertsCache()
  restoreStorage = isolateMcpFixtureCredentials()
})

afterEach(async () => {
  for (const client of clients.splice(0)) await clearServerCache(client.name, client.config)
  dispose?.()
  dispose = undefined
  for (const proxy of proxies.splice(0)) await proxy.close()
  for (const fixture of fixtures.splice(0)) await fixture.stop()
  restoreStorage()
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  resetSettingsCache()
  clearCACertsCache()
  await rm(root, { recursive: true, force: true })
})

async function fixtureFor(type: 'http' | 'sse', tls = false) {
  const fixture = type === 'http' ? startStreamableMcpServer({ tls }) : startLegacySseMcpServer({ tls })
  fixtures.push(fixture)
  const proxy = await startRecordingProxy(fixture.port, { tunnelTls: tls })
  proxies.push(proxy)
  return { fixture, proxy }
}

async function configure(mode: 'system' | 'manual' | 'direct', proxyUrl: string, register = true) {
  await writeFile(join(root, 'settings.json'), JSON.stringify({ network: { proxy: { mode, url: mode === 'manual' ? proxyUrl : '' } } }))
  if (mode === 'system') process.env.CC_HAHA_SYSTEM_PROXY_URL = proxyUrl
  resetSettingsCache()
  if (register) dispose = configureMcpHostProxy()
}

async function call(type: 'http' | 'sse', url: string) {
  const name = `routing-${++sequence}`
  const config: ScopedMcpServerConfig = { type, url, scope: 'dynamic', headers: { Authorization: 'Bearer fake-routing-token', 'X-Mcp-Fixture': name } }
  clients.push({ name, config })
  const connected = await connectToServer(name, config)
  if (connected.type !== 'connected') throw new Error(`Fixture failed: ${connected.type} ${getMcpConnectionError(connected)?.kind ?? ''}`)
  expect(await fetchToolsForClient(connected)).toHaveLength(1)
  expect(await callIdeRpc('echo', { value: name }, connected)).toEqual([{ type: 'text', text: `echo:${name}` }])
  return name
}

for (const mode of ['system', 'manual', 'direct'] as const) for (const type of ['http', 'sse'] as const) for (const tls of [false, true]) {
  test(`${mode} ${type} ${tls ? 'TLS tunnel' : 'HTTP'} preserves initialize/list/call and stream headers`, async () => {
    const { fixture, proxy } = await fixtureFor(type, tls)
    await configure(mode, proxy.url)
    const authority = mode === 'direct' ? `127.0.0.1:${fixture.port}` : UNREACHABLE_MCP_HOST
    const url = `${tls ? 'https' : 'http'}://${authority}/${type === 'sse' ? 'sse' : 'mcp'}`
    const name = await call(type, url)
    await waitFor(() => fixture.requests.some(request => request.method === 'GET'))
    expect(fixture.activeStreams()).toBeGreaterThan(0)
    expect(fixture.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call']))
    for (const request of fixture.requests) {
      expect(request.headers.authorization).toBe('Bearer fake-routing-token')
      expect(request.headers['x-mcp-fixture']).toBe(name)
      expect(request.headers['user-agent']).toBeTruthy()
    }
    if (mode === 'direct') expect(proxy.requests).toEqual([])
    else if (tls) expect(proxy.requests).toContain(`CONNECT ${UNREACHABLE_MCP_HOST}:443`)
    else {
      expect(proxy.requests.some(request => request.startsWith('GET '))).toBe(true)
      expect(proxy.requests.some(request => request.startsWith('POST '))).toBe(true)
    }
  })
}

test('host direct overrides inherited native proxy variables', async () => {
  const { fixture, proxy } = await fixtureFor('http')
  process.env.HTTP_PROXY = proxy.url
  process.env.HTTPS_PROXY = proxy.url
  await configure('direct', proxy.url)
  await call('http', `http://127.0.0.1:${fixture.port}/mcp`)
  expect(proxy.requests).toEqual([])
})

test('NO_PROXY wildcard keeps the real native flow direct even with inherited proxy variables', async () => {
  const { fixture, proxy } = await fixtureFor('http')
  process.env.HTTP_PROXY = proxy.url
  process.env.HTTPS_PROXY = proxy.url
  process.env.NO_PROXY = '*'
  await configure('system', proxy.url)
  // This address is the same IPv4 loopback listener but not a default literal
  // NO_PROXY entry. Assert traffic, rather than the shape of proxy options.
  await call('http', `http://[::ffff:127.0.0.1]:${fixture.port}/mcp`)
  expect(proxy.requests).toEqual([])
})

for (const explicit of [false, true]) test(`failed bridge still permits ${explicit ? 'explicit NO_PROXY' : 'loopback'} tool calls`, async () => {
  const { fixture, proxy } = await fixtureFor('http')
  await configure('system', proxy.url)
  delete process.env.CC_HAHA_SYSTEM_PROXY_URL
  process.env.CC_HAHA_SYSTEM_PROXY_ERROR = 'fixture bridge failed: secret-upstream-detail'
  if (explicit) process.env.NO_PROXY = '*'
  const host = explicit ? '[::ffff:127.0.0.1]' : '127.0.0.1'
  await call('http', `http://${host}:${fixture.port}/mcp`)
  expect(proxy.requests).toEqual([])
})

test('a remote target still fails closed when its bridge is unavailable', async () => {
  const { fixture, proxy } = await fixtureFor('http')
  await configure('system', proxy.url)
  delete process.env.CC_HAHA_SYSTEM_PROXY_URL
  process.env.CC_HAHA_SYSTEM_PROXY_ERROR = 'fixture bridge failed: secret-upstream-detail'
  const config: ScopedMcpServerConfig = { type: 'http', url: `http://${UNREACHABLE_MCP_HOST}/mcp`, scope: 'dynamic' }
  clients.push({ name: 'bridge-failed', config })
  const result = await connectToServer('bridge-failed', config)
  expect(result.type).toBe('failed')
  expect(getMcpConnectionError(result)?.kind).toBe('proxy')
  expect(JSON.stringify(result)).not.toContain('secret-upstream-detail')
  expect(proxy.requests).toEqual([])
  expect(fixture.requests).toEqual([])
})

for (const type of ['http', 'sse'] as const) test(`unregistered CLI ${type} environment fallback includes the real GET stream`, async () => {
  const { fixture, proxy } = await fixtureFor(type)
  process.env.HTTP_PROXY = proxy.url
  process.env.HTTPS_PROXY = proxy.url
  await configure('direct', proxy.url, false)
  expect(await resolveMcpHostProxy(`http://${UNREACHABLE_MCP_HOST}/mcp`)).toBeUndefined()
  await call(type, `http://${UNREACHABLE_MCP_HOST}/${type === 'sse' ? 'sse' : 'mcp'}`)
  await waitFor(() => fixture.activeStreams() > 0)
  expect(proxy.requests.some(request => request.startsWith('GET '))).toBe(true)
  expect(proxy.requests.some(request => request.startsWith('POST '))).toBe(true)
})

test('parallel HTTP/SSE transports retain their own host-selected routes and replies', async () => {
  const http = await fixtureFor('http')
  const sse = await fixtureFor('sse')
  dispose = setMcpHostProxyResolver(async target => getProxyFetchOptions({ targetUrl: target, proxyUrl: target.endsWith('/sse') ? sse.proxy.url : http.proxy.url }))
  await Promise.all([call('http', `http://${UNREACHABLE_MCP_HOST}/mcp`), call('sse', `http://${UNREACHABLE_MCP_HOST}/sse`)])
  expect(http.fixture.methods).toContain('tools/call')
  expect(sse.fixture.methods).toContain('tools/call')
  expect(http.proxy.requests.every(request => request.includes('/mcp'))).toBe(true)
  expect(sse.proxy.requests.every(request => request.includes('/sse') || request.includes('/messages'))).toBe(true)
})

test('a TLS tunnel does not disable certificate validation', async () => {
  const { fixture, proxy } = await fixtureFor('http', true)
  delete process.env.NODE_EXTRA_CA_CERTS
  clearCACertsCache()
  await configure('manual', proxy.url)
  const config: ScopedMcpServerConfig = { type: 'http', url: `https://${UNREACHABLE_MCP_HOST}/mcp`, scope: 'dynamic' }
  clients.push({ name: 'untrusted-tls', config })
  expect((await connectToServer('untrusted-tls', config)).type).toBe('failed')
  expect(proxy.requests).toContain(`CONNECT ${UNREACHABLE_MCP_HOST}:443`)
  expect(fixture.methods).not.toContain('initialize')
})
