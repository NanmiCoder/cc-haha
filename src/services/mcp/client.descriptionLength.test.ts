import '../../../preload.ts'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { clearServerCache, connectToServer, fetchToolsForClient } from './client.js'

const envName = 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH'
const original = process.env[envName]
const config = { type: 'sse' as const, url: 'http://127.0.0.1:1/mcp' }
const names: string[] = []
const spies: { mockRestore(): void }[] = []
const text = 'description '.repeat(500)

afterEach(async () => {
  for (const name of names.splice(0)) await clearServerCache(name, config)
  for (const spy of spies.splice(0)) spy.mockRestore()
  if (original === undefined) delete process.env[envName]
  else process.env[envName] = original
})

async function fixture() {
  const name = `description-length-${crypto.randomUUID()}`
  names.push(name)
  spies.push(spyOn(Client.prototype, 'connect').mockResolvedValue(undefined))
  spies.push(spyOn(Client.prototype, 'getServerCapabilities').mockReturnValue({ tools: {} }))
  spies.push(spyOn(Client.prototype, 'getInstructions').mockReturnValue(text))
  spies.push(spyOn(Client.prototype, 'request').mockImplementation(async () => ({
    tools: [{ name: 'fixture', description: text, inputSchema: { type: 'object' } }],
  }) as never))
  const connected = await connectToServer(name, config)
  if (connected.type !== 'connected') throw new Error(`Fixture connection failed: ${JSON.stringify(connected)}`)
  const [tool] = await fetchToolsForClient(connected)
  expect(tool).toBeDefined()
  return { connected, tool: tool! }
}

for (const [value, limit] of [
  [undefined, 2048], ['', 2048], [' ', 2048], ['invalid', 2048],
  ['0', 2048], ['-1', 2048], ['2.5', 2048], ['25oops', 2048],
  ['Infinity', 2048], ['9007199254740992', 2048],
  ['1', 1], ['4096', 4096], [' 123 ', 123], ['9007199254740991', Number.MAX_SAFE_INTEGER],
] as const) {
  test(`MCP description limit ${JSON.stringify(value)} applies to instructions and tool prompt`, async () => {
    if (value === undefined) delete process.env[envName]
    else process.env[envName] = value
    const { connected, tool } = await fixture()
    const expected = text.length > limit ? text.slice(0, limit) + '… [truncated]' : text
    expect(connected.instructions).toBe(expected)
    expect(await tool.prompt({} as never)).toBe(expected)
    expect(await tool.description({} as never, {} as never)).toBe(text)
  })
}

test('the exact limit is not truncated and a later prompt reads the current setting', async () => {
  process.env[envName] = String(text.length)
  const { connected, tool } = await fixture()
  expect(connected.instructions).toBe(text)
  expect(await tool.prompt({} as never)).toBe(text)
  process.env[envName] = '10'
  expect(await tool.prompt({} as never)).toBe(text.slice(0, 10) + '… [truncated]')
})
