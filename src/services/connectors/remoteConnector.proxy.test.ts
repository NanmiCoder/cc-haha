import '../../../preload.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { clearCACertsCache } from '../../utils/caCerts.js'
import { setMcpHostProxyResolver } from '../mcp/hostProxy.js'
import { McpConnectionError } from '../mcp/connectionErrors.js'
import { MCP_FIXTURE_CERT, UNREACHABLE_MCP_HOST, isolateMcpFixtureCredentials, startLegacySseMcpServer, startRecordingProxy, startStreamableMcpServer, type McpFixture, type RecordingProxy } from '../mcp/__tests__/networkProxyFixtures.js'
import { createRemoteConnectorBridge, type RemoteConnectorRecipe } from './remoteConnector.js'

// NO_PROXY is cleared too: a developer value such as ".test" or "*" would
// otherwise bypass the proxy this test expects.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'MCP_TIMEOUT'] as const

let root = ''
let previousConfigDir: string | undefined
let previousProxyEnv: Partial<Record<typeof PROXY_ENV_KEYS[number], string>> = {}
let proxy: RecordingProxy | undefined
let disposeResolver: (() => void) | undefined
let restoreStorage: () => void
let fixture: McpFixture | undefined
const bridges: Array<ReturnType<typeof createRemoteConnectorBridge>> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'connector-host-proxy-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  previousProxyEnv = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) previousProxyEnv[key] = process.env[key]
    delete process.env[key]
  }
  restoreStorage = isolateMcpFixtureCredentials()
  const certificate = join(root, 'fixture-ca.pem')
  await writeFile(certificate, MCP_FIXTURE_CERT)
  process.env.NODE_EXTRA_CA_CERTS = certificate
  process.env.MCP_TIMEOUT = '2000'
  clearCACertsCache()
})

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.deactivate()
  disposeResolver?.()
  disposeResolver = undefined
  await proxy?.close()
  proxy = undefined
  await fixture?.stop()
  fixture = undefined
  restoreStorage()
  for (const key of PROXY_ENV_KEYS) {
    const value = previousProxyEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  clearCACertsCache()
  await rm(root, { recursive: true, force: true })
})

test('a connector check reaches its HTTPS endpoint through the host proxy (#1864)', async () => {
  // The recorder refuses CONNECT tunnels, so the check fails after the proxy
  // sees it. Without the host proxy the request would go out directly.
  proxy = await startRecordingProxy(1)
  const proxyUrl = proxy.url
  disposeResolver = setMcpHostProxyResolver(async targetUrl => getProxyFetchOptions({ proxyUrl, targetUrl }))
  const recipe: RemoteConnectorRecipe = {
    id: 'proxy-fixture',
    pluginId: 'office-proxy-fixture@haha-connectors',
    version: '1.0.0',
    endpoint: `https://${UNREACHABLE_MCP_HOST}/mcp`,
    transport: 'http',
    auth: { type: 'none' },
  }

  const bridge = createRemoteConnectorBridge(recipe)
  bridges.push(bridge)

  await expect(bridge.check(new AbortController().signal)).rejects.toThrow()
  expect(proxy.requests).toContain(`CONNECT ${UNREACHABLE_MCP_HOST}:443`)
})

for (const transport of ['http', 'sse'] as const) {
  for (const [status, kind] of [[401, 'authentication'], [403, 'permission'], [407, 'proxy'], [408, 'timeout'], [500, 'network'], [undefined, 'discovery']] as const) {
    test(`real ${transport} TLS connector maps ${status ?? 'an empty tool list'} to a safe ${kind} result`, async () => {
      const options = { tls: true, status, emptyTools: status === undefined }
      fixture = transport === 'http' ? startStreamableMcpServer(options) : startLegacySseMcpServer(options)
      proxy = await startRecordingProxy(fixture.port, { tunnelTls: true })
      const proxyUrl = proxy.url
      disposeResolver = setMcpHostProxyResolver(async targetUrl => getProxyFetchOptions({ proxyUrl, targetUrl }))
      const bridge = createRemoteConnectorBridge({
        id: 'proxy-fixture', pluginId: 'office-proxy-fixture@haha-connectors', version: '1.0.0',
        endpoint: `https://${UNREACHABLE_MCP_HOST}/${transport === 'sse' ? 'sse' : 'mcp'}`,
        transport, auth: { type: 'none' },
      })
      bridges.push(bridge)
      const checked = bridge.check(new AbortController().signal)
      if (kind === 'authentication') {
        expect(await checked).toEqual({ authenticated: false, verification: 'remote', toolCount: 0 })
      } else {
        await expect(checked).rejects.toMatchObject({ kind, message: new McpConnectionError(kind).message })
      }
      expect(proxy.requests).toContain(`CONNECT ${UNREACHABLE_MCP_HOST}:443`)
      expect(fixture.requests.length).toBeGreaterThan(0)
      expect(fixture.methods).not.toContain('tools/call')
    })
  }
}
