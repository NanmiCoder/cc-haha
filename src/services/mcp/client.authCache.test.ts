import '../../../preload.ts'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import { getServerKey, hasMcpDiscoveryButNoToken } from './auth.js'
import type { ScopedMcpServerConfig } from './types.js'
import { clearMcpAuthCache, clearServerCache, connectToServer, getMcpToolsCommandsAndResources } from './client.js'

const name = 'plugin:fixture-connector:service'
const otherName = 'plugin:other:service'
const config = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp', scope: 'dynamic' as const }
let credentials: { mcpOAuth: Record<string, Record<string, unknown>> }
const connections: ScopedMcpServerConfig[] = []
let root: string
let previousConfigDir: string | undefined
const cachePath = () => join(root, 'mcp-needs-auth-cache.json')
const recentFailures = () => ({ [name]: { timestamp: Date.now() }, [otherName]: { timestamp: Date.now() } })

async function discover(serverConfig: ScopedMcpServerConfig = config) {
  connections.push(serverConfig)
  const results: Parameters<Parameters<typeof getMcpToolsCommandsAndResources>[0]>[0][] = []
  await getMcpToolsCommandsAndResources(result => results.push(result), { [name]: serverConfig })
  return results[0]!
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-auth-cache-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  await clearMcpAuthCache()
  // Model the token another process saved after OAuth without touching keychain.
  credentials = { mcpOAuth: { [getServerKey(name, config)]: { accessToken: 'fixture-token', expiresAt: Date.now() + 60_000 } } }
  spyOn(secureStorage, 'getSecureStorage').mockReturnValue({ name: 'fixture', read: () => credentials, readAsync: async () => credentials, update: next => { credentials = next; return { success: true } }, delete: () => true } as never)
  spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
  spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({ tools: {} })
  spyOn(Client.prototype, 'request').mockResolvedValue({ tools: [{ name: 'list_projects', inputSchema: { type: 'object' } }] })
})

afterEach(async () => {
  for (const serverConfig of [config, ...connections.splice(0)]) await clearServerCache(name, serverConfig)
  await clearMcpAuthCache()
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

const transports = ['http', 'sse'] as const
const authenticationModes = ['oauth', 'authorization-header', 'api-key-header', 'api-key-query', 'anonymous'] as const

for (const transport of transports) {
  for (const authentication of authenticationModes) {
    test(`${transport}/${authentication}: successful explicit connection replaces old failure evidence for subsequent chats`, async () => {
      const serverConfig = {
        ...config,
        type: transport,
        ...(authentication === 'authorization-header' && { headers: { Authorization: 'Bearer fixture-key' } }),
        ...(authentication === 'api-key-header' && { headers: { 'X-Api-Key': 'fixture-key' } }),
        ...(authentication === 'api-key-query' && { url: `${config.url}?api_key=fixture-key` }),
      }
      const serverKey = getServerKey(name, serverConfig)
      // OAuth discovery can remain from a previous 401 even when the service
      // now accepts an API key or anonymous requests without OAuth tokens.
      credentials.mcpOAuth[serverKey] = {
        accessToken: authentication === 'oauth' ? 'fixture-token' : '',
        expiresAt: authentication === 'oauth' ? Date.now() + 60_000 : 0,
        discoveryState: { authorizationServerUrl: 'https://auth.fixture.invalid' },
        clientId: 'preserve-client-id',
        clientSecret: 'preserve-client-secret',
        futureField: 'preserve-unknown-data',
      }
      const otherKey = getServerKey(otherName, config)
      credentials.mcpOAuth[otherKey] = { accessToken: '', discoveryState: { authorizationServerUrl: 'https://other.fixture.invalid' } }
      const otherEntry = structuredClone(credentials.mcpOAuth[otherKey])
      await writeFile(cachePath(), JSON.stringify(recentFailures()))
      expect((await discover(serverConfig)).tools.map(tool => tool.name)).toEqual([expect.stringContaining('authenticate')])
      expect((await connectToServer(name, serverConfig)).type).toBe('connected')
      await clearServerCache(name, serverConfig)
      const nextChat = await discover(serverConfig)
      expect(nextChat.client.type).toBe('connected')
      expect(nextChat.tools.map(tool => tool.mcpInfo?.toolName)).toEqual(['list_projects'])
      const remaining = JSON.parse(await readFile(cachePath(), 'utf8'))
      expect(remaining[name]).toBeUndefined()
      expect(remaining[otherName]).toBeDefined()
      expect(credentials.mcpOAuth[serverKey]).toMatchObject({ clientId: 'preserve-client-id', clientSecret: 'preserve-client-secret', futureField: 'preserve-unknown-data' })
      expect(credentials.mcpOAuth[otherKey]).toEqual(otherEntry)
      if (authentication === 'oauth') expect(credentials.mcpOAuth[serverKey]!.discoveryState).toBeDefined()
    })
  }
}

test('client registration without discovery is not evidence of an authentication failure', async () => {
  credentials.mcpOAuth[getServerKey(name, config)] = { accessToken: '', clientId: 'fixture-client' }
  expect(hasMcpDiscoveryButNoToken(name, config)).toBe(false)
  expect((await discover()).client.type).toBe('connected')
})

test('successful connections preserve refresh-token-only OAuth credentials and discovery', async () => {
  credentials.mcpOAuth[getServerKey(name, config)] = {
    accessToken: '',
    refreshToken: 'fixture-refresh-token',
    discoveryState: { authorizationServerUrl: 'https://auth.fixture.invalid' },
  }
  const previousCredentials = structuredClone(credentials)
  expect((await discover()).client.type).toBe('connected')
  expect(credentials).toEqual(previousCredentials)
})

test('unresolved OAuth discovery still avoids repeated connection attempts after the short failure cache expires', async () => {
  credentials.mcpOAuth[getServerKey(name, config)] = { accessToken: '', discoveryState: { authorizationServerUrl: 'https://auth.fixture.invalid' } }
  await writeFile(cachePath(), JSON.stringify({ [name]: { timestamp: Date.now() - 16 * 60_000 } }))
  expect((await discover()).client.type).toBe('needs-auth')
  expect((await discover()).client.type).toBe('needs-auth')
  expect(Client.prototype.connect).not.toHaveBeenCalled()
})

for (const placement of ['header', 'query'] as const) {
  test(`changing an API key in the ${placement} isolates OAuth discovery from the old credentials`, async () => {
    const withKey = (key: string) => ({ ...config, ...(placement === 'header' ? { headers: { 'X-Api-Key': key } } : { url: `${config.url}?api_key=${key}` }) })
    const oldConfig = withKey('old-fixture-key')
    const newConfig = withKey('new-fixture-key')
    expect(getServerKey(name, newConfig)).not.toBe(getServerKey(name, oldConfig))
    credentials.mcpOAuth = { [getServerKey(name, oldConfig)]: { accessToken: '', discoveryState: { authorizationServerUrl: 'https://auth.fixture.invalid' } } }
    const previousCredentials = structuredClone(credentials)
    await writeFile(cachePath(), JSON.stringify(recentFailures()))
    expect((await connectToServer(name, newConfig)).type).toBe('connected')
    expect((await discover(newConfig)).client.type).toBe('connected')
    expect(credentials).toEqual(previousCredentials)
  })
}

test('a new discovery batch observes another process clearing the cached OAuth failure', async () => {
  await writeFile(cachePath(), JSON.stringify(recentFailures()))
  expect((await discover()).client.type).toBe('needs-auth')
  await writeFile(cachePath(), JSON.stringify({ [otherName]: { timestamp: Date.now() } }))
  expect((await discover()).tools.map(tool => tool.mcpInfo?.toolName)).toEqual(['list_projects'])
})

test('targeted clears complete before returning and preserve unrelated failures', async () => {
  await writeFile(cachePath(), JSON.stringify(recentFailures()))
  await clearMcpAuthCache(name)
  expect(JSON.parse(await readFile(cachePath(), 'utf8'))).toEqual({ [otherName]: expect.any(Object) })
})

test('authorization cleanup runs after an already queued 401 write', async () => {
  await writeFile(cachePath(), JSON.stringify({ [otherName]: { timestamp: Date.now() } }))
  spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new UnauthorizedError())
  expect((await connectToServer(name, config)).type).toBe('needs-auth')
  await clearMcpAuthCache(name)
  const remaining = JSON.parse(await readFile(cachePath(), 'utf8'))
  expect(remaining[name]).toBeUndefined()
  expect(remaining[otherName]).toBeDefined()
})
