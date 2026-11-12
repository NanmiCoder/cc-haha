import '../../../preload.ts'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import * as secureStorage from '../../utils/secureStorage/index.js'
import { clearMcpAuthCache, clearServerCache, connectToServer, fetchToolsForClient, fetchToolsForClientStrict } from './client.js'
import { getMcpConnectionError, McpConnectionError, type McpConnectionErrorKind } from './connectionErrors.js'
import { setMcpHostProxyResolver } from './hostProxy.js'
import type { ScopedMcpServerConfig } from './types.js'

const secret = 'https://fixture.invalid/mcp?key=fake-private-key Authorization: Bearer fake-header-secret'
const envKeys = ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'MCP_TIMEOUT', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const
let previous: Partial<Record<typeof envKeys[number], string>>
let root: string
let disposeResolver: (() => void) | undefined
const opened: Array<{ name: string, config: ScopedMcpServerConfig }> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-connection-errors-'))
  previous = {}
  for (const key of envKeys) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
  process.env.XDG_CONFIG_HOME = root
  disposeResolver = setMcpHostProxyResolver(async () => ({}))
  let credentials = {}
  spyOn(secureStorage, 'getSecureStorage').mockReturnValue({
    name: 'fixture', read: () => credentials, readAsync: async () => credentials,
    update: (next: typeof credentials) => {
      credentials = next
      return { success: true }
    },
    delete: () => true,
  } as never)
  spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
  spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({ tools: {} })
  spyOn(Client.prototype, 'request').mockResolvedValue({ tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] })
})

afterEach(async () => {
  for (const { name, config } of opened.splice(0)) await clearServerCache(name, config)
  await clearMcpAuthCache()
  disposeResolver?.()
  mock.restore()
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(root, { recursive: true, force: true })
})

function connect(transport: 'http' | 'sse', name = `safe-errors-${crypto.randomUUID()}`) {
  const config = { type: transport, url: 'https://fixture.invalid/mcp?key=fake-private-key', scope: 'dynamic' } as const
  opened.push({ name, config })
  return connectToServer(name, config)
}

for (const transport of ['http', 'sse'] as const) {
  test.each([
    [Object.assign(new Error(secret), { code: 'ECONNREFUSED' }), 'network'],
    [new McpConnectionError('proxy'), 'proxy'],
    [new DOMException(secret, 'TimeoutError'), 'timeout'],
    [Object.assign(new Error(secret), { code: 401 }), 'authentication'],
    [Object.assign(new Error(secret), { code: 403 }), 'permission'],
    [new Error(secret), 'discovery'],
  ] satisfies Array<[Error, McpConnectionErrorKind]>)(`${transport} failed connection %# preserves a safe transient classification`, async (upstream, kind) => {
    spyOn(Client.prototype, 'connect').mockRejectedValueOnce(upstream)
    const client = await connect(transport)
    expect(client.type).toBe('failed')
    expect(getMcpConnectionError(client)?.kind).toBe(kind)
    if (client.type !== 'failed') throw new Error('Fixture should fail')
    expect(client.error).toBe(new McpConnectionError(kind).message)
    expect(client.error).not.toContain('fake-private-key')
    expect(client.error).not.toContain('fake-header-secret')
    expect(Object.keys(client).sort()).toEqual(['config', 'error', 'name', 'type'])
  })

  test(`${transport} Unauthorized still returns needs-auth`, async () => {
    spyOn(Client.prototype, 'connect').mockRejectedValueOnce(new UnauthorizedError(secret))
    const client = await connect(transport)
    expect(client.type).toBe('needs-auth')
    expect(getMcpConnectionError(client)).toBeUndefined()
  })

  test(`${transport} connection deadline is classified as timeout without exposing the endpoint`, async () => {
    process.env.MCP_TIMEOUT = '5'
    spyOn(Client.prototype, 'connect').mockImplementationOnce(async () => new Promise<never>(() => {}))
    const client = await connect(transport)
    expect(client).toMatchObject({ type: 'failed', error: new McpConnectionError('timeout').message })
    expect(getMcpConnectionError(client)?.kind).toBe('timeout')
  })
}

test('strict discovery retries a cached CLI failure and keeps structured errors instead of returning an empty list', async () => {
  const client = await connect('http')
  const request = spyOn(Client.prototype, 'request').mockRejectedValue(new Error(secret))
  expect(await fetchToolsForClient(client)).toEqual([])
  await expect(fetchToolsForClientStrict(client)).rejects.toMatchObject({ kind: 'discovery', message: new McpConnectionError('discovery').message })
  expect(request).toHaveBeenCalledTimes(2)
  request.mockRejectedValue(Object.assign(new Error(secret), { code: 'ECONNRESET' }))
  await expect(fetchToolsForClientStrict(client)).rejects.toMatchObject({ kind: 'network' })
  request.mockRejectedValue(new UnauthorizedError(secret))
  await expect(fetchToolsForClientStrict(client)).rejects.toMatchObject({ kind: 'authentication' })
  // Strict failures do not replace the CLI's existing tolerant cache entry.
  expect(await fetchToolsForClient(client)).toEqual([])
  expect(request).toHaveBeenCalledTimes(4)
})

test('strict discovery shares normal conversion and filtering while bypassing its cache', async () => {
  const client = await connect('sse', 'ide')
  const request = spyOn(Client.prototype, 'request').mockResolvedValue({ tools: [
    { name: 'executeCode', description: 'Fixture tool', inputSchema: { type: 'object' }, _meta: { 'anthropic/searchHint': 'one\ntwo' } },
    { name: 'notAllowedInIde', inputSchema: { type: 'object' } },
  ] })
  const normal = await fetchToolsForClient(client)
  const strict = await fetchToolsForClientStrict(client)
  expect(normal.map(tool => tool.name)).toEqual(['mcp__ide__executeCode'])
  expect(strict.map(tool => tool.name)).toEqual(normal.map(tool => tool.name))
  expect(strict[0]?.searchHint).toBe('one two')
  expect(strict[0]?.mcpInfo).toEqual({ serverName: 'ide', toolName: 'executeCode' })
  expect(request).toHaveBeenCalledTimes(2)
})
