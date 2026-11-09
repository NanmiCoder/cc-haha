import '../../../preload.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import { setMcpHostProxyResolver } from '../mcp/hostProxy.js'
import { UNREACHABLE_MCP_HOST, startRecordingProxy, type RecordingProxy } from '../mcp/__tests__/networkProxyFixtures.js'
import { createRemoteConnectorBridge, type RemoteConnectorRecipe } from './remoteConnector.js'

// NO_PROXY is cleared too: a developer value such as ".test" or "*" would
// otherwise bypass the proxy this test expects.
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const

let root = ''
let previousConfigDir: string | undefined
let previousProxyEnv: Partial<Record<typeof PROXY_ENV_KEYS[number], string>> = {}
let proxy: RecordingProxy | undefined
let disposeResolver: (() => void) | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'connector-host-proxy-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  previousProxyEnv = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) previousProxyEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(async () => {
  disposeResolver?.()
  disposeResolver = undefined
  await proxy?.close()
  proxy = undefined
  for (const key of PROXY_ENV_KEYS) {
    const value = previousProxyEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
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

  await expect(bridge.check(new AbortController().signal)).rejects.toThrow()
  expect(proxy.requests).toContain(`CONNECT ${UNREACHABLE_MCP_HOST}:443`)
})
