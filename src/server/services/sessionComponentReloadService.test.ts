import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { conversationService } from './conversationService.js'
import { reloadSessionComponents } from './sessionComponentReloadService.js'
import { __resetWebSocketHandlerStateForTests } from '../ws/handler.js'

const serverName = 'plugin:office-supabase:service'
const ready = { name: serverName, status: 'connected', tools: [{ name: 'list_tables' }] }
const hasSession = spyOn(conversationService, 'hasSession').mockReturnValue(true)
const requestControl = spyOn(conversationService, 'requestControl')

test.each(['feishu', 'dingtalk', 'wecom', 'remotion', 'supabase'])('requires the %s connector plugin and skill in the chat, not only on disk', async id => {
  const requirement = { pluginId: `office-${id}@haha-connectors`, skillName: `office-${id}:office-${id}` }
  for (const response of [
    { plugins: [], commands: [{ name: requirement.skillName }] },
    { plugins: [{ source: requirement.pluginId }], commands: [] },
    { plugins: [{ source: 'other@market' }], commands: [{ name: requirement.skillName }] },
  ]) {
    requestControl.mockResolvedValue({ ...response, error_count: 0 })
    expect(await reloadSessionComponents('fixture-session', undefined, requirement)).toMatchObject({ applied: false, reason: 'failed' })
  }
  requestControl.mockReset().mockResolvedValue({
    plugins: [{ source: requirement.pluginId }], commands: [{ name: requirement.skillName }], error_count: 0,
  })
  expect(await reloadSessionComponents('fixture-session', undefined, requirement)).toMatchObject({ applied: true, commands: 1, plugins: 1 })
  expect(requestControl).toHaveBeenCalledTimes(1)
})

afterAll(() => {
  requestControl.mockRestore()
  hasSession.mockRestore()
})

afterEach(() => {
  requestControl.mockReset()
  hasSession.mockReturnValue(true)
  __resetWebSocketHandlerStateForTests()
})

test('connector reload replaces stale authentication state with tools from the chat process', async () => {
  requestControl.mockResolvedValueOnce({ commands: [], error_count: 0, mcpServers: [{ name: serverName, status: 'needs-auth' }] })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ mcpServers: [ready] })

  expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: true, errors: 0 })
  expect(requestControl.mock.calls.map(call => call[1])).toEqual([
    { subtype: 'reload_plugins' },
    { subtype: 'mcp_reconnect', serverName },
    { subtype: 'mcp_status' },
  ])
})

test.each([
  [],
  [{ name: serverName, status: 'needs-auth', tools: [{ name: 'authenticate' }] }],
  [{ name: serverName, status: 'failed' }],
  [{ name: serverName, status: 'disabled' }],
  [{ name: serverName, status: 'connected', tools: [] }],
  [{ name: serverName, status: 'connected', tools: [{ name: 'authenticate' }] }],
  [{ name: 'another-server', status: 'connected', tools: [{ name: 'list_tables' }] }],
].map(mcpServers => ({ mcpServers })))('a successful plugin reload cannot hide an unusable connector: %j', async ({ mcpServers }) => {
  requestControl.mockResolvedValue({ commands: [], error_count: 0, mcpServers })
  expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: false, reason: 'failed' })
})

test('healthy tools avoid reconnecting and ordinary skill reload does not require MCP', async () => {
  requestControl.mockResolvedValue({ commands: [], error_count: 0, mcpServers: [ready] })
  expect((await reloadSessionComponents('fixture-session', serverName)).applied).toBe(true)
  expect(requestControl).toHaveBeenCalledTimes(1)
  requestControl.mockReset().mockResolvedValue({ commands: [], error_count: 0 })
  expect((await reloadSessionComponents('fixture-session')).applied).toBe(true)
  expect(requestControl).toHaveBeenCalledTimes(1)
})

test('a stopped session needs no reconnect and a failed reconnect is not ready', async () => {
  hasSession.mockReturnValue(false)
  expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: false, reason: 'not_running' })
  expect(requestControl).not.toHaveBeenCalled()
  hasSession.mockReturnValue(true)
  requestControl.mockResolvedValueOnce({ commands: [], error_count: 0, mcpServers: [] })
    .mockRejectedValueOnce(new Error('Server status: needs-auth'))
  expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: false, reason: 'failed' })
})
