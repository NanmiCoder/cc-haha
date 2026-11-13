/**
 * #1864: MCP checks the desktop server runs itself (connector verification,
 * MCP status in Settings) must use the network setting. The desktop host
 * starts the server without proxy variables, so HTTPS_PROXY is never there.
 */
import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, stopServerRuntimeForShutdown } from '../index.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { resolveMcpHostProxy } from '../../services/mcp/hostProxy.js'
import {
  UNREACHABLE_MCP_HOST,
  isolateMcpFixtureCredentials,
  startRecordingProxy,
  startStreamableMcpServer,
  type McpFixture,
  type RecordingProxy,
} from '../../services/mcp/__tests__/networkProxyFixtures.js'

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'CC_HAHA_SYSTEM_PROXY_URL',
  'CC_HAHA_SYSTEM_PROXY_ERROR',
] as const

let configDir = ''
let originalConfigDir: string | undefined
let originalProxyEnv: Partial<Record<typeof PROXY_ENV_KEYS[number], string>> = {}
let server: ReturnType<typeof startServer> | undefined
let fixture: McpFixture
let proxy: RecordingProxy
let serverCount = 0
const createdServers: string[] = []
const extraServers: ReturnType<typeof startServer>[] = []
let restoreStorage: () => void

beforeEach(async () => {
  restoreStorage = isolateMcpFixtureCredentials()
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-mcp-network-proxy-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  originalProxyEnv = {}
  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) originalProxyEnv[key] = process.env[key]
    delete process.env[key]
  }
  // What the desktop host's clearProxyEnv leaves behind.
  process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
  process.env.no_proxy = process.env.NO_PROXY
  resetSettingsCache()
  fixture = startStreamableMcpServer()
  proxy = await startRecordingProxy(fixture.port)
})

afterEach(async () => {
  // User-scope servers live in the shared in-memory test config; remove them
  // so later test files in the same process do not see them.
  for (const name of createdServers.splice(0)) {
    if (!server) break
    await fetch(`http://127.0.0.1:${server.port}/api/mcp/${name}?scope=user`, { method: 'DELETE' }).catch(() => {})
  }
  server?.stop(true)
  for (const extra of extraServers.splice(0)) extra.stop(true)
  server = undefined
  await stopServerRuntimeForShutdown({ waitForCli: false })
  await proxy.close()
  await fixture.stop()
  restoreStorage()
  for (const key of PROXY_ENV_KEYS) {
    const value = originalProxyEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  resetSettingsCache()
  await rm(configDir, { recursive: true, force: true })
})

async function checkMcpServer(url: string): Promise<{ status: string, statusDetail?: string }> {
  server ??= startServer(0, '127.0.0.1')
  const baseUrl = `http://127.0.0.1:${server.port}`
  const name = `proxy-check-${++serverCount}`
  createdServers.push(name)
  const created = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scope: 'user', config: { type: 'http', url } }),
  })
  expect(created.status).toBe(201)
  const response = await fetch(`${baseUrl}/api/mcp/${name}/status`)
  expect(response.status).toBe(200)
  return (await response.json() as { server: { status: string, statusDetail?: string } }).server
}

describe('MCP checks run by the desktop server', () => {
  test('go through the system proxy bridge the desktop host passes in', async () => {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = proxy.url
    const url = `http://${UNREACHABLE_MCP_HOST}/mcp`

    const result = await checkMcpServer(url)

    expect(result).toMatchObject({ status: 'connected' })
    expect(proxy.requests).toContain(`POST ${url}`)
  })

  test('go through a manual proxy chosen in Settings', async () => {
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ network: { proxy: { mode: 'manual', url: proxy.url } } }),
      'utf-8',
    )
    const url = `http://${UNREACHABLE_MCP_HOST}/mcp`

    const result = await checkMcpServer(url)

    expect(result).toMatchObject({ status: 'connected' })
    expect(proxy.requests).toContain(`POST ${url}`)
  })

  test('reach loopback MCP servers directly', async () => {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = proxy.url

    const result = await checkMcpServer(`http://127.0.0.1:${fixture.port}/mcp`)

    expect(result).toMatchObject({ status: 'connected' })
    expect(proxy.requests).toEqual([])
  })

  for (const newestFirst of [false, true]) test(`two live API listeners keep proxy routing when the ${newestFirst ? 'newest' : 'oldest'} stops`, async () => {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = proxy.url
    const first = startServer(0, '127.0.0.1')
    const second = startServer(0, '127.0.0.1')
    const stopped = newestFirst ? second : first
    server = newestFirst ? first : second
    extraServers.push(stopped)
    stopped.stop(true)
    stopped.stop(true)
    expect(await checkMcpServer(`http://${UNREACHABLE_MCP_HOST}/mcp`)).toMatchObject({ status: 'connected' })
    expect(proxy.requests.some(request => request.startsWith('POST '))).toBe(true)
  })

  test('stopping the last API listener unregisters its host resolver', async () => {
    process.env.CC_HAHA_SYSTEM_PROXY_URL = proxy.url
    server = startServer(0, '127.0.0.1')
    expect(await resolveMcpHostProxy(`http://${UNREACHABLE_MCP_HOST}/mcp`)).toBeDefined()
    server.stop(true)
    expect(await resolveMcpHostProxy(`http://${UNREACHABLE_MCP_HOST}/mcp`)).toBeUndefined()
  })
})
