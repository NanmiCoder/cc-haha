import { createHash } from 'node:crypto'
import { SKILL_RECIPES } from './skillCatalog.js'
import { createSkillBundleAdapter } from './skillAdapter.js'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { clearMarketplacesCache } from '../../utils/plugins/marketplaceManager.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { installConnectorPlugin, isConnectorPluginReady, removeConnectorPlugin, renderConnectorSkill, setConnectorPluginEnabled } from './pluginBridge.js'
import { REMOTE_CONNECTORS } from './remoteCatalog.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { loadPluginMcpServers, extractMcpServersFromPlugins } from '../../utils/plugins/mcpPluginIntegration.js'
import type { ConnectorDefinition, ConnectorInstallation } from './types.js'

const definition: ConnectorDefinition = {
  id: 'feishu', pluginId: 'office-feishu@haha-connectors', packageName: '@larksuite/cli',
  version: '1.0.95', homepage: 'https://github.com/larksuite/cli',
  credentialMode: 'shared', platforms: ['darwin-arm64', 'win32-x64'],
}

describe('managed connector plugin bridge', () => {
  let directory: string
  let previousConfig: string | undefined
  let installation: ConnectorInstallation
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'connector-bridge-'))
    previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = directory
    resetSettingsCache()
    clearAllCaches()
    clearMarketplacesCache()
    installation = { directory: join(directory, 'runtime'), command: join(directory, '工具 folder', 'lark-cli'), args: [], env: {} }
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ unknownUserField: { keep: true }, enabledPlugins: {} }))
    resetSettingsCache()
  })
  afterEach(async () => {
    clearAllCaches()
    clearMarketplacesCache()
    resetSettingsCache()
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    await rm(directory, { recursive: true, force: true })
  })

  it('installs disabled, enables a discoverable skill and removes it without touching other settings or credentials', async () => {
    const credentialFixture = join(directory, 'user-credentials.json')
    await writeFile(credentialFixture, '{"protected":true}')
    await installConnectorPlugin(definition, installation)
    expect(await isConnectorPluginReady(definition)).toBe(false)
    await setConnectorPluginEnabled(definition, true)
    expect(await isConnectorPluginReady(definition)).toBe(true)
    await setConnectorPluginEnabled(definition, false)
    expect(await isConnectorPluginReady(definition)).toBe(false)
    await removeConnectorPlugin(definition)
    expect(await isConnectorPluginReady(definition)).toBe(false)
    const market = JSON.parse(await readFile(join(directory, 'connectors', 'marketplace', '.claude-plugin', 'marketplace.json'), 'utf8'))
    expect(market.plugins).toEqual([])
    const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    expect(settings.unknownUserField).toEqual({ keep: true })
    expect(await readFile(credentialFixture, 'utf8')).toBe('{"protected":true}')
  })

  it('publishes verified upstream skill files and disables/removes every bundled skill', async () => {
    const text = Buffer.from('---\nname: upstream-fixture\ndescription: A test workflow\n---\nRead references/example.md.\n')
    const reference = Buffer.from('A supporting reference, preserved verbatim.')
    const recipe = { id: 'fixture-bundle', repository: 'example/skills', version: '1.0.0', commit: 'a'.repeat(40), license: 'MIT', files: [
      { source: 'skills/upstream-fixture/SKILL.md', target: 'skills/upstream-fixture/SKILL.md', integrity: `sha256-${createHash('sha256').update(text).digest('hex')}` },
      { source: 'skills/upstream-fixture/references/example.md', target: 'skills/upstream-fixture/references/example.md', integrity: `sha256-${createHash('sha256').update(reference).digest('hex')}` },
    ] }
    const def: ConnectorDefinition = { ...definition, id: recipe.id, pluginId: `office-${recipe.id}@haha-connectors`, version: recipe.version, transport: 'skills', collection: 'tools', credentialMode: 'isolated' }
    SKILL_RECIPES.push(recipe)
    try {
      const adapter = createSkillBundleAdapter(def, join(directory, 'connectors'), recipe, async urls => urls[0]!.endsWith('SKILL.md') ? text : reference)
      const installed = await adapter.prepare(new AbortController().signal, () => {})
      await installConnectorPlugin(def, installed)
      await setConnectorPluginEnabled(def, true)
      expect(await isConnectorPluginReady(def)).toBe(true)
      const loaded = (await loadAllPluginsCacheOnly()).enabled.find(item => item.source === def.pluginId)!
      expect(await readFile(join(loaded.path, 'skills/upstream-fixture/references/example.md'), 'utf8')).toBe(reference.toString())
      expect(renderConnectorSkill(def, installed)).toContain('../upstream-fixture/SKILL.md')
      expect(renderConnectorSkill(def, installed)).not.toContain('plugin:office-fixture-bundle:service')
      await rm(join(loaded.path, 'skills/upstream-fixture/references/example.md'))
      expect(await isConnectorPluginReady(def)).toBe(false)
      await setConnectorPluginEnabled(def, false)
      expect((await loadAllPluginsCacheOnly()).enabled.some(item => item.source === def.pluginId)).toBe(false)
      await removeConnectorPlugin(def)
      await adapter.remove(installed)
      expect(await isConnectorPluginReady(def)).toBe(false)
    } finally { SKILL_RECIPES.splice(SKILL_RECIPES.indexOf(recipe), 1) }
  })

  it('retains both plugins when preparations share the local marketplace', async () => {
    const second = { ...definition, id: 'dingtalk' as const, pluginId: 'office-dingtalk@haha-connectors' }
    await Promise.all([installConnectorPlugin(definition, installation), installConnectorPlugin(second, installation)])
    await setConnectorPluginEnabled(definition, true)
    await setConnectorPluginEnabled(second, true)
    expect(await isConnectorPluginReady(definition)).toBe(true)
    expect(await isConnectorPluginReady(second)).toBe(true)
  })

  it('refuses a marketplace collision instead of overwriting a user source', async () => {
    await mkdir(join(directory, 'plugins'), { recursive: true })
    const file = join(directory, 'plugins', 'known_marketplaces.json')
    const existing = { 'haha-connectors': { source: { source: 'directory', path: '/some/user/source' }, installLocation: '/some/user/source', lastUpdated: new Date(0).toISOString() } }
    await writeFile(file, JSON.stringify(existing))
    await expect(installConnectorPlugin(definition, installation)).rejects.toThrow('already used')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(existing)
  })

  it('publishes remote MCP tools under the same owned identity and removes them with the plugin', async () => {
    const remote = REMOTE_CONNECTORS.find(item => item.id === 'context7')!
    await installConnectorPlugin(remote, { directory: join(directory, 'remote'), command: '', args: [], env: {} })
    expect(await isConnectorPluginReady(remote)).toBe(false)
    await setConnectorPluginEnabled(remote, true)
    const loaded = await loadAllPluginsCacheOnly()
    const plugin = loaded.enabled.find(item => item.source === remote.pluginId)!
    const servers = await extractMcpServersFromPlugins([plugin])
    expect(servers['plugin:office-context7:service']).toMatchObject({ type: 'http', url: 'https://mcp.context7.com/mcp', pluginSource: remote.pluginId, scope: 'dynamic' })
    expect(await isConnectorPluginReady(remote)).toBe(true)
    const text = renderConnectorSkill(remote, installation)
    expect(text).toContain('plugin:office-context7:service')
    expect(text).not.toContain('lark-cli')
    await removeConnectorPlugin(remote)
    expect(await isConnectorPluginReady(remote)).toBe(false)
  })

  it('keeps required API keys as sensitive placeholders in remote plugin artifacts', async () => {
    const remote = REMOTE_CONNECTORS.find(item => item.id === 'amap')!
    await installConnectorPlugin(remote, installation)
    const loaded = await loadAllPluginsCacheOnly()
    const plugin = [...loaded.enabled, ...loaded.disabled].find(item => item.source === remote.pluginId)!
    expect(plugin.manifest.userConfig?.apiKey).toMatchObject({ sensitive: true, required: true })
    expect(await loadPluginMcpServers(plugin)).toMatchObject({ service: { url: 'https://mcp.amap.com/mcp?key=${user_config.apiKey}' } })
    const skill = await readFile(join(plugin.path, 'skills', 'office-amap', 'SKILL.md'), 'utf8')
    expect(skill).not.toContain('apiKey')
  })

  it('quotes executable paths for both shells and never embeds arbitrary environment secrets', () => {
    const text = renderConnectorSkill(definition, { ...installation, command: "/工具/O'Brien folder/cli", env: { DWS_CONFIG_DIR: '/managed/account', TOKEN: 'never-include-me' } })
    expect(text).toContain("O'\"'\"'Brien")
    expect(text).toContain("O''Brien")
    expect(text).toContain('DWS_CONFIG_DIR')
    expect(text).not.toContain('never-include-me')
    expect(text).toContain('do not install a global CLI')
  })
})
