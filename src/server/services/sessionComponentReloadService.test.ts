import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { conversationService } from './conversationService.js'
import { reloadSessionComponents } from './sessionComponentReloadService.js'
import { sessionService } from './sessionService.js'
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

// Connecting an MCP connector checks every running chat for the server. A lean
// CLI has no MCP runtime (its reload lists no servers and its reconnect is
// refused), so one lean chat alive must not make the connector fail.
test('a lean chat is not required to have the connector server, only its plugin and skill', async () => {
  const launchInfo = spyOn(sessionService, 'getSessionLaunchInfo').mockResolvedValue({ agentProfile: 'lean' } as never)
  try {
    requestControl.mockResolvedValue({ commands: [], error_count: 0, mcpServers: [] })
    expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: true, mcpServers: 0 })
    expect(requestControl.mock.calls.map(call => call[1])).toEqual([{ subtype: 'reload_plugins' }])

    // Lean runs skills, so the plugin and its skill are still proven in it.
    const requirement = { pluginId: 'office-supabase@haha-connectors', skillName: 'office-supabase:office-supabase' }
    requestControl.mockReset().mockResolvedValue({ plugins: [], commands: [], error_count: 0, mcpServers: [] })
    expect(await reloadSessionComponents('fixture-session', serverName, requirement)).toMatchObject({ applied: false, reason: 'failed' })

    // The same answers from a standard chat still fail: it has to have the server.
    launchInfo.mockResolvedValue({ agentProfile: 'standard' } as never)
    requestControl.mockReset().mockResolvedValue({ commands: [], error_count: 0, mcpServers: [] })
    expect(await reloadSessionComponents('fixture-session', serverName)).toMatchObject({ applied: false, reason: 'failed' })
  } finally {
    launchInfo.mockRestore()
  }
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
