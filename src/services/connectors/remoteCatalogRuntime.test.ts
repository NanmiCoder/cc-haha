import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import * as optionStorage from '../../utils/plugins/pluginOptionsStorage.js'
import { extractMcpServersFromPlugins, getPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { REMOTE_RECIPES } from './remoteCatalog.js'
import { buildRemotePlugin, createRemoteConnectorBridge, saveRemoteApiKey, type RemoteConnectorDependencies, type RemoteConnectorRecipe } from './remoteConnector.js'

type Call = { kind: string, name: string, config?: unknown }
const signal = () => new AbortController().signal
let root: string
let previousHome: string | undefined
let previousConfig: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'remote-catalog-runtime-'))
  previousHome = process.env.HOME
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = root
})

afterEach(async () => {
  mock.restore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await rm(root, { recursive: true, force: true })
})

function fixture() {
  const otherId = 'office-unrelated@haha-connectors'
  const options: Record<string, optionStorage.PluginOptionValues> = { [otherId]: { apiKey: 'unrelated-fixture-key' } }
  const calls: Call[] = []
  const dependencies: RemoteConnectorDependencies = {
    async probe(name, config, abortSignal) {
      abortSignal.throwIfAborted()
      calls.push({ kind: 'probe', name, config })
      return { status: 'connected', toolCount: 2 }
    },
    async oauth(name, config, onUrl, abortSignal) {
      abortSignal.throwIfAborted()
      calls.push({ kind: 'oauth', name, config })
      onUrl('https://accounts.example/authorize?state=offline-fixture')
    },
    async disconnect(name, config) { calls.push({ kind: 'disconnect', name, config }) },
    loadOptions: id => options[id] ?? {},
    saveOptions(id, values, schema) {
      expect(schema.apiKey?.sensitive).toBe(true)
      options[id] = values
    },
    deleteOptions(id) { delete options[id] },
    clearOAuth(name, config) { calls.push({ kind: 'clear-oauth', name, config }) },
  }
  // Exercise the real file loader and user_config resolution without accessing
  // saved settings, credentials, keychain, or any provider endpoint.
  spyOn(optionStorage, 'loadPluginOptions').mockImplementation(dependencies.loadOptions)
  return { dependencies, options, calls, otherId }
}

async function loadedPlugin(recipe: RemoteConnectorRecipe): Promise<LoadedPlugin> {
  const plugin = buildRemotePlugin(recipe)
  await writeFile(join(root, '.mcp.json'), JSON.stringify(plugin.mcpConfig))
  return {
    name: plugin.manifest.name, manifest: plugin.manifest,
    path: root, source: recipe.pluginId, repository: recipe.pluginId, enabled: true,
  }
}

// Catalog-driven: newly added services automatically inherit the contract.
// No live OAuth, network discovery, or business-tool execution is performed.
function runtimeContract(recipe: RemoteConnectorRecipe) {
  test(`${recipe.id}: settings probe and both chat loaders use the same isolated server configuration`, async () => {
    const f = fixture()
    const bridge = createRemoteConnectorBridge(recipe, f.dependencies)
    const plugin = await loadedPlugin(recipe)
    const errors: PluginError[] = []
    const rawKey = `fixture-${recipe.id}&scope=read#fragment`
    if (recipe.auth.type === 'api-key') {
      expect(bridge.isConfigured()).toBe(false)
      await expect(bridge.check(signal())).rejects.toThrow('API key')
      expect(await getPluginMcpServers(plugin, errors)).toEqual({})
      expect(errors).toHaveLength(1)
      expect(f.calls).toHaveLength(0)
      errors.length = 0
      saveRemoteApiKey(recipe, rawKey, f.dependencies)
      expect(f.options[recipe.pluginId]?.apiKey).toBe(recipe.auth.in === 'query' ? encodeURIComponent(rawKey) : rawKey)
      expect(JSON.stringify(buildRemotePlugin(recipe))).not.toContain(rawKey)
    }

    const config = (await getPluginMcpServers(plugin, errors))?.[bridge.serverName]
    expect(config).toBeDefined()
    expect(config).toMatchObject({ type: recipe.transport, scope: 'dynamic', pluginSource: recipe.pluginId })
    expect(await extractMcpServersFromPlugins([plugin], errors)).toEqual({ [bridge.serverName]: config })
    expect(errors).toEqual([])
    const phases: string[] = []
    await bridge.authenticate(signal(), phase => phases.push(phase))
    expect(f.calls.filter(call => call.kind === 'probe')).toHaveLength(0)
    expect(phases).toEqual(recipe.auth.type === 'oauth' ? ['authorizing', 'awaiting-authorization'] : [])
    expect(f.calls.filter(call => call.kind === 'oauth')).toHaveLength(recipe.auth.type === 'oauth' ? 1 : 0)
    expect(await bridge.check(signal())).toEqual({ authenticated: true, verification: 'remote', toolCount: 2 })
    expect(f.calls.slice(-2).map(call => call.kind)).toEqual(['disconnect', 'probe'])
    for (const call of f.calls) {
      expect(call.name).toBe(bridge.serverName)
      expect(call.config).toEqual(config)
    }

    if (recipe.auth.type === 'api-key') {
      const replacement = `replacement-${recipe.id}&scope=write#fragment`
      await bridge.deactivate()
      expect(f.calls.at(-1)?.config).toEqual(config)
      saveRemoteApiKey(recipe, replacement, f.dependencies)
      // extractMcpServersFromPlugins caches unresolved templates. Both the
      // cached loader and the bridge must resolve the newly saved credential.
      const next = (await getPluginMcpServers(plugin, errors))?.[bridge.serverName]
      expect(next).not.toEqual(config)
      await bridge.check(signal())
      expect(f.calls.at(-1)?.config).toEqual(next)
      expect(JSON.stringify(plugin.mcpServers)).not.toContain(replacement)
      if (next?.type === 'http' || next?.type === 'sse') {
        if (recipe.auth.in === 'query') {
          expect(new URL(next.url).searchParams.get(recipe.auth.name)).toBe(replacement)
          expect(new URL(next.url).hash).toBe('')
        } else expect(next.headers?.[recipe.auth.name]).toBe(`${recipe.auth.prefix ?? ''}${replacement}`)
      }
    }
    await bridge.removeCredentials()
    expect(f.options[recipe.pluginId]).toBeUndefined()
    expect(f.options[f.otherId]).toEqual({ apiKey: 'unrelated-fixture-key' })
    expect(f.calls.filter(call => call.kind === 'clear-oauth')).toHaveLength(recipe.auth.type === 'oauth' ? 1 : 0)
    expect(await getPluginMcpServers({ ...plugin, enabled: false }, errors)).toBeUndefined()
  })

  test(`${recipe.id}: authorization alone, empty discovery, failed discovery and cancellation cannot pass readiness`, async () => {
    const f = fixture()
    if (recipe.auth.type === 'api-key') saveRemoteApiKey(recipe, 'offline-fixture-key', f.dependencies)
    const bridge = createRemoteConnectorBridge(recipe, f.dependencies)
    await bridge.authenticate(signal(), () => {})
    f.dependencies.probe = async () => ({ status: 'needs-auth', toolCount: 0 })
    expect(await bridge.check(signal())).toEqual({ authenticated: false, verification: 'remote', toolCount: 0 })
    for (const status of ['connected', 'failed', 'disabled'] as const) {
      f.dependencies.probe = async () => ({ status, toolCount: 0 })
      await expect(bridge.check(signal())).rejects.toThrow('Unable to connect')
    }
    f.dependencies.probe = async () => { throw new Error('transport failed: fake-private-key') }
    await expect(bridge.check(signal())).rejects.toThrow('Remote connector connection or tool discovery failed')
    const count = f.calls.length
    const controller = new AbortController()
    controller.abort()
    await expect(bridge.check(controller.signal)).rejects.toThrow()
    expect(f.calls).toHaveLength(count)
  })
}

describe('every remote catalog recipe obeys the shared runtime contract', () => {
  for (const recipe of REMOTE_RECIPES) runtimeContract(recipe)
})

// Currently all catalog entries use HTTP. Retain explicit SSE coverage for
// every supported authentication shape without implying any live SSE service.
describe('SSE transport authentication matrix (synthetic fixtures)', () => {
  for (const auth of [
    { type: 'oauth', clientId: 'offline-public-client' },
    { type: 'api-key', in: 'header', name: 'Authorization', prefix: 'Bearer ' },
    { type: 'api-key', in: 'query', name: 'key' },
    { type: 'none' },
  ] satisfies RemoteConnectorRecipe['auth'][]) {
    const id = `sse-${auth.type}${auth.type === 'api-key' ? `-${auth.in}` : ''}`
    runtimeContract({ id, pluginId: `office-${id}@haha-connectors`, version: '1.0.0', endpoint: 'https://fixture.example/sse?format=0', transport: 'sse', auth })
  }
})
