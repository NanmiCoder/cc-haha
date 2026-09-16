import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../Tool.js'
import * as mcpClient from '../services/mcp/client.js'
import type { ConnectedMCPServer } from '../services/mcp/types.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { reconcileMcpServers, type DynamicMcpState } from './print.js'

const name = 'plugin:office-supabase:service'
const config = { type: 'http' as const, url: 'http://127.0.0.1:1/original', scope: 'dynamic' as const }
const oldTools = [
  { name: 'mcp__plugin_office-supabase_service__authenticate' },
  { name: 'mcp__plugin_office-supabase_service__list_tables' },
] as Tool[]
const unrelated = { name: 'mcp__plugin_other_service__lookup' } as Tool
const fresh = { name: 'mcp__plugin_office-supabase_service__list_projects' } as Tool
let root: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-plugin-reconcile-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  spyOn(mcpClient, 'clearServerCache').mockResolvedValue(undefined)
  spyOn(mcpClient, 'connectToServer').mockImplementation(async (serverName, serverConfig) => ({
    name: serverName, config: serverConfig, type: 'connected', capabilities: {},
    client: {} as ConnectedMCPServer['client'], cleanup: async () => {},
  }))
  spyOn(mcpClient, 'fetchToolsForClient').mockResolvedValue([fresh])
})

afterEach(async () => {
  mock.restore()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

function fixture() {
  const dynamic: DynamicMcpState = {
    clients: [{ name, config, type: 'needs-auth' }],
    configs: { [name]: config },
    tools: [...oldTools],
  }
  let state = getDefaultAppState()
  state = { ...state, mcp: { ...state.mcp, clients: [...dynamic.clients], tools: [...oldTools, unrelated] } }
  return {
    dynamic,
    state: () => state,
    setState: (update: (previous: typeof state) => typeof state) => { state = update(state) },
  }
}

test('removing a plugin MCP server clears business and authentication tools from both pools', async () => {
  const f = fixture()
  const result = await reconcileMcpServers({}, f.dynamic, f.setState)
  expect(result.newState.tools).toEqual([])
  expect(f.state().mcp.tools).toEqual([unrelated])
  expect(result.newState.clients).toEqual([])
  expect(result.response.removed).toEqual([name])
  expect(mcpClient.connectToServer).not.toHaveBeenCalled()
})

test('replacing a plugin MCP connection publishes only fresh tools while preserving other servers', async () => {
  const f = fixture()
  const result = await reconcileMcpServers({ [name]: { ...config, url: 'http://127.0.0.1:1/replacement' } }, f.dynamic, f.setState)
  expect(result.newState.tools).toEqual([fresh])
  expect(f.state().mcp.tools).toEqual([unrelated, fresh])
  expect(result.newState.clients.map(client => client.type)).toEqual(['connected'])
  expect(mcpClient.clearServerCache).toHaveBeenCalledWith(name, config)
})

test('adding a plugin server replaces its stale startup authentication tool in app state', async () => {
  const f = fixture()
  const result = await reconcileMcpServers({ [name]: config }, { clients: [], tools: [], configs: {} }, f.setState)
  expect(result.newState.tools).toEqual([fresh])
  expect(f.state().mcp.tools).toEqual([unrelated, fresh])
})
