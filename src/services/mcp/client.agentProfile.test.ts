import '../../../preload.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearServerCache, connectToServer, setupSdkMcpClients } from './client.js'
import { getAllMcpConfigs } from './config.js'
import type { McpSdkServerConfig, ScopedMcpServerConfig } from './types.js'
import { LEAN_MCP_UNAVAILABLE, setAgentProfile } from '../../utils/agentProfile.js'
import { _setGlobalConfigCacheForTesting, enableConfigs, getProjectPathForConfig, saveGlobalConfig } from '../../utils/config.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'

const name = 'lean-profile-stdio'
const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS }
let root: string
let config: ScopedMcpServerConfig

function inProject<T>(fn: () => T) {
  return runWithCwdOverride(root, fn)
}
/** One line per process the fixture server was launched as. */
async function launches() {
  return (await readFile(join(root, 'launches'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
}
function resetConfigCaches() {
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
  _setGlobalConfigCacheForTesting(null)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lean-mcp-client-'))
  process.env.CLAUDE_CONFIG_DIR = root
  // Keep the claude.ai connector lookup offline and away from any credential store.
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = '0'
  resetConfigCaches()
  enableConfigs()
  // Records each launch, then exits: a spawn is observable without a handshake.
  await writeFile(join(root, 'server.cjs'), "require('node:fs').appendFileSync(process.argv[2], process.pid + '\\n')\n")
  config = { type: 'stdio', command: process.execPath, args: [join(root, 'server.cjs'), join(root, 'launches')], scope: 'user' }
  const { scope: _scope, ...userServer } = config
  // The test-mode global config is in-memory: register the user-scope server there.
  saveGlobalConfig(current => ({ ...current, mcpServers: { ...current.mcpServers, [name]: userServer } }))
})

afterEach(async () => {
  setAgentProfile('standard')
  saveGlobalConfig(current => {
    const { [name]: _removed, ...mcpServers } = current.mcpServers ?? {}
    return { ...current, mcpServers }
  })
  await inProject(() => clearServerCache(name, config))
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCaches()
  await rm(root, { recursive: true, force: true })
})

describe('lean MCP connection boundary', () => {
  test('lean refuses a configured stdio server before launching it; standard launches the same server', async () => {
    setAgentProfile('lean')
    expect(await inProject(() => connectToServer(name, config))).toEqual({ name, config, type: 'failed', error: LEAN_MCP_UNAVAILABLE })
    expect(await launches()).toEqual([])

    setAgentProfile('standard')
    expect((await inProject(() => connectToServer(name, config))).type).not.toBe('connected')
    expect(await launches()).toHaveLength(1)
  })

  test('lean never contacts SDK-hosted servers', async () => {
    const sdk: Record<string, McpSdkServerConfig> = { host: { type: 'sdk', name: 'host' } }
    let sent = 0
    const send = async () => {
      sent++
      throw new Error('fixture host does not answer')
    }
    setAgentProfile('lean')
    expect(await setupSdkMcpClients(sdk, send)).toEqual({
      clients: [{ type: 'failed', name: 'host', config: { type: 'sdk', name: 'host', scope: 'dynamic' }, error: LEAN_MCP_UNAVAILABLE }],
      tools: [],
    })
    expect(sent).toBe(0)

    setAgentProfile('standard')
    await setupSdkMcpClients(sdk, send)
    expect(sent).toBeGreaterThan(0)
  })

  test('runtime config refresh resolves no servers for lean', async () => {
    expect(Object.keys((await inProject(() => getAllMcpConfigs())).servers)).toContain(name)
    setAgentProfile('lean')
    expect(await inProject(() => getAllMcpConfigs())).toEqual({ servers: {}, errors: [] })
  })
})
