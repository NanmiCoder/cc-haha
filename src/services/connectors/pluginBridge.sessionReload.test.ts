import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { reloadConnectorSessions } from './pluginBridge.js'
import { ALL_CONNECTORS } from './catalog.js'

const remote = ALL_CONNECTORS.find(def => def.id === 'supabase')!
const remoteSkill = { pluginId: remote.pluginId, skillName: 'office-supabase:office-supabase' }
import { conversationService } from '../../server/services/conversationService.js'
import * as sessionReload from '../../server/services/sessionComponentReloadService.js'

afterEach(() => { mock.restore() })

test.each(ALL_CONNECTORS)('$id requires its own plugin and skill; only MCP requires remote tools', async definition => {
  spyOn(conversationService, 'getActiveSessions').mockReturnValue(['catalog-chat'])
  const reload = spyOn(sessionReload, 'reloadSessionComponents').mockResolvedValue({
    applied: true, commands: 1, agents: 0, plugins: 1, mcpServers: 0, errors: 0,
  })
  await reloadConnectorSessions(undefined, definition)
  expect(reload.mock.calls).toEqual([[
    'catalog-chat',
    definition.transport === 'mcp' ? `plugin:office-${definition.id}:service` : undefined,
    { pluginId: definition.pluginId, skillName: `office-${definition.id}:office-${definition.id}` },
  ]])
})

test('connector readiness verifies its server in every active chat and deduplicates the requested chat', async () => {
  spyOn(conversationService, 'getActiveSessions').mockReturnValue(['chat-a', 'chat-b'])
  spyOn(conversationService, 'hasSession').mockReturnValue(true)
  const reload = spyOn(sessionReload, 'reloadSessionComponents').mockResolvedValue({
    applied: true, commands: 1, agents: 0, plugins: 1, mcpServers: 1, errors: 0,
  })
  await reloadConnectorSessions('chat-a', remote)
  expect(reload.mock.calls).toEqual([
    ['chat-a', 'plugin:office-supabase:service', remoteSkill],
    ['chat-b', 'plugin:office-supabase:service', remoteSkill],
  ])
  reload.mockClear()
  await reloadConnectorSessions('chat-a')
  expect(reload.mock.calls).toEqual([['chat-a', undefined, undefined], ['chat-b', undefined, undefined]])
})

test('one chat failing to obtain tools prevents connector readiness; stopped chats need no tools', async () => {
  spyOn(conversationService, 'getActiveSessions').mockReturnValue(['chat-a'])
  spyOn(conversationService, 'hasSession').mockReturnValue(false)
  const reload = spyOn(sessionReload, 'reloadSessionComponents').mockResolvedValue({
    applied: false, reason: 'failed', commands: 0, agents: 0, plugins: 0, mcpServers: 0, errors: 0,
  })
  await expect(reloadConnectorSessions(undefined, remote)).rejects.toThrow('active task')
  reload.mockResolvedValue({ applied: false, reason: 'not_running', commands: 0, agents: 0, plugins: 0, mcpServers: 0, errors: 0 })
  await expect(reloadConnectorSessions(undefined, remote)).resolves.toBeUndefined()
})

test('an unrelated plugin load error in a chat does not veto the connector reload', async () => {
  spyOn(conversationService, 'getActiveSessions').mockReturnValue(['chat-a'])
  // error_count > 0 from a foreign plugin (e.g. stale enabledPlugins tombstone)
  // must not fail this connector's refresh; the connector itself is proven by
  // requiredPlugin/requiredMcpServer inside reloadSessionComponents.
  spyOn(sessionReload, 'reloadSessionComponents').mockResolvedValue({
    applied: true, commands: 1, agents: 0, plugins: 1, mcpServers: 0, errors: 1,
  })
  await expect(reloadConnectorSessions(undefined, remote)).resolves.toBeUndefined()
})
