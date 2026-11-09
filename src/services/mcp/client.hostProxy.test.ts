import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { clearServerCache, connectToServer, fetchToolsForClient } from './client.js'
import { setMcpHostProxyResolver } from './hostProxy.js'
import type { ScopedMcpServerConfig } from './types.js'
import {
  UNREACHABLE_MCP_HOST,
  startLegacySseMcpServer,
  startRecordingProxy,
  startStreamableMcpServer,
  waitFor,
  type McpFixture,
  type RecordingProxy,
} from './__tests__/networkProxyFixtures.js'

// NO_PROXY is cleared too: a developer value such as ".test" or "*" would
// otherwise bypass the proxy these tests expect.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const

let root = ''
let previousConfigDir: string | undefined
let previousProxyEnv: Partial<Record<typeof PROXY_ENV_KEYS[number], string>> = {}
let fixture: McpFixture | undefined
let proxy: RecordingProxy | undefined
let disposeResolver: (() => void) | undefined
let opened: { name: string, config: ScopedMcpServerConfig } | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-host-proxy-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  // Like the desktop server, start with no proxy variables at all.
  previousProxyEnv = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) previousProxyEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  if (opened) await clearServerCache(opened.name, opened.config)
  opened = undefined
  disposeResolver?.()
  disposeResolver = undefined
  await proxy?.close()
  await fixture?.stop()
  proxy = undefined
  fixture = undefined
  for (const key of PROXY_ENV_KEYS) {
    const value = previousProxyEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

async function connect(name: string, config: ScopedMcpServerConfig) {
  opened = { name, config }
  const client = await connectToServer(name, config)
  if (client.type !== 'connected') throw new Error(`Fixture did not connect: ${client.type} ${'error' in client ? client.error : ''}`)
  return client
}

function useHostProxy(proxyUrl: string) {
  disposeResolver = setMcpHostProxyResolver(async targetUrl => getProxyFetchOptions({ proxyUrl, targetUrl }))
}

describe('MCP connections opened by a host process', () => {
  test('streamable HTTP requests, including the GET stream, use the host proxy', async () => {
    fixture = startStreamableMcpServer()
    proxy = await startRecordingProxy(fixture.port)
    useHostProxy(proxy.url)
    const url = `http://${UNREACHABLE_MCP_HOST}/mcp`

    const client = await connect('host-proxy-http', { type: 'http', url, scope: 'dynamic' })

    expect(await fetchToolsForClient(client)).toHaveLength(1)
    expect(proxy.requests).toContain(`POST ${url}`)
    // The SDK opens its GET stream without requestInit; it must still use the proxy.
    await waitFor(() => proxy!.requests.includes(`GET ${url}`))
    expect(fixture.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']))
  })

  test('legacy SSE streams and message posts use the host proxy', async () => {
    fixture = startLegacySseMcpServer()
    proxy = await startRecordingProxy(fixture.port)
    useHostProxy(proxy.url)

    const client = await connect('host-proxy-sse', { type: 'sse', url: `http://${UNREACHABLE_MCP_HOST}/sse`, scope: 'dynamic' })

    expect(await fetchToolsForClient(client)).toHaveLength(1)
    expect(proxy.requests).toContain(`GET http://${UNREACHABLE_MCP_HOST}/sse`)
    expect(proxy.requests).toContain(`POST http://${UNREACHABLE_MCP_HOST}/messages`)
  })

  test('without a host resolver the environment proxy still applies', async () => {
    // Without a host resolver the SDK's GET stream uses plain fetch, so keep
    // the SDK from opening it: this test must make no request outside the proxy.
    fixture = startStreamableMcpServer({ openGetStream: false })
    proxy = await startRecordingProxy(fixture.port)
    process.env.HTTPS_PROXY = proxy.url
    const url = `http://${UNREACHABLE_MCP_HOST}/mcp`

    const client = await connect('env-proxy-http', { type: 'http', url, scope: 'dynamic' })

    expect(await fetchToolsForClient(client)).toHaveLength(1)
    expect(proxy.requests).toContain(`POST ${url}`)
  })
})
