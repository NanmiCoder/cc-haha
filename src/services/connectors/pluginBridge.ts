import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { cacheAndRegisterPlugin } from '../../utils/plugins/pluginInstallationHelpers.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { addMarketplaceSource, clearMarketplacesCache, loadKnownMarketplacesConfig } from '../../utils/plugins/marketplaceManager.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { uninstallPluginOp } from '../plugins/pluginOperations.js'
import { getRemoteRecipe } from './remoteCatalog.js'
import { buildRemotePlugin } from './remoteConnector.js'
import { getSkillRecipe } from './skillCatalog.js'
import { readSkillBundleFiles } from './skillAdapter.js'
import type { ConnectorDefinition, ConnectorInstallation } from './types.js'

import { nativeConnectorRecipes as recipes, renderNativeConnectorSkill } from './nativeConnectorSkill.js'

const MARKETPLACE = 'haha-connectors'


// All three connectors share one local marketplace and user settings entry.
// Serialize bridge writes so simultaneous preparation does not lose an entry.
let writes: Promise<unknown> = Promise.resolve()
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = writes.then(work, work)
  writes = next.catch(() => {})
  return next
}

function rootDirectory() {
  return join(getClaudeConfigHomeDir(), 'connectors', 'marketplace')
}

function pluginName(definition: ConnectorDefinition): string {
  const expected = `office-${definition.id}`
  if (definition.pluginId !== `${expected}@${MARKETPLACE}`) {
    throw new Error('Invalid managed connector plugin identity')
  }
  return expected
}


export function renderConnectorSkill(definition: ConnectorDefinition, installation: ConnectorInstallation): string {
  const bundle = getSkillRecipe(definition.id, definition.version)
  if (bundle) return `---
name: ${pluginName(definition)}
description: Use ${definition.displayName ?? definition.id} for the user's requested creative or development task.
---

# ${definition.displayName ?? definition.id}

${definition.description ?? ''}

This plugin contains the upstream skills listed below. Read the corresponding SKILL.md and its referenced files before using the workflow. Paths are relative to this plugin's skills directory:
${[...new Set(bundle.files.filter(file => /^skills\/[^/]+\/SKILL.md$/.test(file.target)).map(file => file.target.slice('skills/'.length)))].map(path => `- ../${path}`).join('\n')}

${definition.requirements ?? ''}

Installing this plugin installs instructions and supporting files only, not Node, browsers, renderers, or service accounts. Check the documented dependencies before running a task. Do not claim that installation verifies a render or business operation. Online services and writes require authorization from the user's task.

Source: https://github.com/${bundle.repository}/tree/${bundle.commit}
License: ${bundle.license}
`
  const remote = getRemoteRecipe(definition.id)
  if (remote) return `---
name: ${pluginName(definition)}
description: Use ${definition.displayName ?? definition.id} when the user requests its connected services.
---

# ${definition.displayName ?? definition.id}

${definition.description ?? ''}

Use the tools exposed by plugin:${pluginName(definition)}:service. Inspect their schemas and use only available tools. Do not invent CLI commands, install other software, or read credential files.
${definition.requirements ?? ''}

Use read-only discovery first. Business writes (messages, documents, transactions) require authorization from the user's task. Connection or tools/list success does not prove every permission or a business operation succeeded. Report missing scopes, limits, and service errors accurately. If authentication fails, direct the user to this connector's settings. Never print tokens.

Official documentation: ${definition.homepage}
`
  return renderNativeConnectorSkill(definition, installation)
}

async function writeAtomic(file: string, content: string | Uint8Array) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function assertMarketplaceOwnership(root: string) {
  const existing = (await loadKnownMarketplacesConfig())[MARKETPLACE]
  if (existing && (existing.source.source !== 'directory' || resolve(existing.source.path) !== resolve(root))) {
    throw new Error('The haha-connectors marketplace name is already used by another source')
  }
}

function writeEnabled(definition: ConnectorDefinition, enabled: boolean) {
  if (enabled && isPluginBlockedByPolicy(definition.pluginId)) {
    throw new Error('This connector plugin is disabled by organization policy')
  }
  const settings = getSettingsForSource('userSettings')
  const { error } = updateSettingsForSource('userSettings', {
    enabledPlugins: { ...settings?.enabledPlugins, [definition.pluginId]: enabled },
  })
  if (error) throw error
  clearAllCaches()
}

export function installConnectorPlugin(definition: ConnectorDefinition, installation: ConnectorInstallation): Promise<void> {
  return serialize(async () => {
    const name = pluginName(definition)
    const bundle = getSkillRecipe(definition.id, definition.version)
    const bundleFiles = bundle ? await readSkillBundleFiles(bundle, installation.directory) : []
    const root = rootDirectory()
    await assertMarketplaceOwnership(root)
    if (isPluginBlockedByPolicy(definition.pluginId)) throw new Error('This connector plugin is disabled by organization policy')
    const pluginRoot = join(root, 'plugins', name)
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true })
    if (bundle) await rm(join(pluginRoot, 'skills'), { recursive: true, force: true })
    await mkdir(join(pluginRoot, 'skills', name), { recursive: true })
    for (const file of bundleFiles) {
      const path = join(pluginRoot, file.target)
      await mkdir(dirname(path), { recursive: true })
      await writeAtomic(path, Buffer.from(file.bytes))
    }
    const version = `${definition.version}-connector.1`
    const remoteRecipe = getRemoteRecipe(definition.id)
    const remote = remoteRecipe ? buildRemotePlugin(remoteRecipe) : undefined
    const manifest = { ...remote?.manifest, name, version, description: `${definition.displayName ?? recipes[definition.id]?.name ?? name} desktop connector`, skills: './skills', ...(remote ? { mcpServers: './.mcp.json' } : {}) }
    if (remote) await writeAtomic(join(pluginRoot, '.mcp.json'), JSON.stringify(remote.mcpConfig, null, 2))
    await writeAtomic(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2))
    await writeAtomic(join(pluginRoot, 'skills', name, 'SKILL.md'), renderConnectorSkill(definition, installation))

    const marketFile = join(root, '.claude-plugin', 'marketplace.json')
    let entries: Array<{ name: string; source: string; version: string }> = []
    try {
      const previous = JSON.parse(await readFile(marketFile, 'utf8'))
      if (previous.name !== MARKETPLACE || !Array.isArray(previous.plugins)) throw new Error('Invalid managed connector marketplace')
      entries = previous.plugins
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const entry = { name, source: `./plugins/${name}`, version, strict: true }
    await writeAtomic(marketFile, JSON.stringify({
      name: MARKETPLACE,
      owner: { name: 'Claude Code Haha' },
      plugins: [...entries.filter(item => item.name !== name), entry],
    }, null, 2))
    clearMarketplacesCache()
    await addMarketplaceSource({ source: 'directory', path: root })
    // Do not briefly expose an unauthenticated skill via installPluginOp's
    // default auto-enable. Reuse its cache/registration core, initially off.
    writeEnabled(definition, false)
    await cacheAndRegisterPlugin(definition.pluginId, entry, 'user', undefined, pluginRoot)
    clearAllCaches()
  })
}

export function setConnectorPluginEnabled(definition: ConnectorDefinition, enabled: boolean): Promise<void> {
  return serialize(async () => {
    pluginName(definition)
    await assertMarketplaceOwnership(rootDirectory())
    writeEnabled(definition, enabled)
  })
}

export async function isConnectorPluginReady(definition: ConnectorDefinition): Promise<boolean> {
  pluginName(definition)
  const { enabled, errors } = await loadAllPluginsCacheOnly()
  const plugin = enabled.find(item => item.source === definition.pluginId)
  if (!plugin || errors.some(error => error.source === definition.pluginId)) return false
  const skill = join(plugin.path, 'skills', pluginName(definition), 'SKILL.md')
  try {
    const bundle = getSkillRecipe(definition.id, definition.version)
    if (bundle) await readSkillBundleFiles(bundle, plugin.path)
    return (await readFile(skill, 'utf8')).startsWith('---\nname:')
  } catch {
    return false
  }
}

export function removeConnectorPlugin(definition: ConnectorDefinition): Promise<void> {
  return serialize(async () => {
    const name = pluginName(definition)
    await assertMarketplaceOwnership(rootDirectory())
    writeEnabled(definition, false)
    const result = await uninstallPluginOp(definition.pluginId, 'user', false)
    if (!result.success && !result.message.includes('not installed')) throw new Error(result.message)
    const marketFile = join(rootDirectory(), '.claude-plugin', 'marketplace.json')
    try {
      const market = JSON.parse(await readFile(marketFile, 'utf8'))
      if (market.name !== MARKETPLACE || !Array.isArray(market.plugins)) throw new Error('Invalid managed connector marketplace')
      await writeAtomic(marketFile, JSON.stringify({ ...market, plugins: market.plugins.filter((entry: { name: string }) => entry.name !== name) }, null, 2))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rm(join(rootDirectory(), 'plugins', name), { recursive: true, force: true })
    clearMarketplacesCache()
    clearAllCaches()
  })
}

export async function reloadConnectorSessions(sessionId?: string, requiredConnector?: ConnectorDefinition): Promise<void> {
  const name = requiredConnector ? pluginName(requiredConnector) : undefined
  const requiredPlugin = requiredConnector ? { pluginId: requiredConnector.pluginId, skillName: `${name}:${name}` } : undefined
  const requiredMcpServer = requiredConnector?.transport === 'mcp' ? `plugin:${name}:service` : undefined
  const { conversationService } = await import('../../server/services/conversationService.js')
  const { reloadSessionComponents } = await import('../../server/services/sessionComponentReloadService.js')
  const sessions = new Set(conversationService.getActiveSessions())
  if (sessionId && conversationService.hasSession(sessionId)) sessions.add(sessionId)
  const results = await Promise.all([...sessions].map(id => reloadSessionComponents(id, requiredMcpServer, requiredPlugin)))
  // error_count covers ALL plugins in the session, including unrelated ones
  // with stale settings entries. The connector itself is verified by
  // requiredPlugin/requiredMcpServer inside reloadSessionComponents and by
  // isConnectorPluginReady after this call; a foreign plugin's load error
  // must not veto this connector's install.
  if (results.some(result => result.reason === 'failed')) {
    throw new Error('Connector changed on disk, but an active task could not refresh its tools and skills. Retry the connection check before use.')
  }
}
