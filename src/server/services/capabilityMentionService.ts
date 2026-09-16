import type { Command } from '../../types/command.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import type { CapabilityMentionCandidate, CapabilityMentionResponse } from '../../types/composerMention.js'

type Brand = { pluginId: string, id: string, displayName?: string, description?: string }
export type CapabilityMentionSnapshot = {
  commands: Command[]
  enabledPlugins: LoadedPlugin[]
  failedPluginIds?: string[]
  brands?: Brand[]
}

/** Serialize only exact invocation identities, never third-party description text. */
export function buildCapabilityMentions(snapshot: CapabilityMentionSnapshot): CapabilityMentionResponse {
  const failed = new Set(snapshot.failedPluginIds)
  const enabled = new Map(snapshot.enabledPlugins.filter(plugin => plugin.enabled !== false && !failed.has(plugin.source)).map(plugin => [plugin.source, plugin]))
  const brands = new Map(snapshot.brands?.map(brand => [brand.pluginId, brand]))
  const brandIcon = (source: string) => {
    const brand = brands.get(source)
    return brand && /^[a-z][a-z0-9-]*$/.test(brand.id) ? `/connectors/${brand.id}.svg` : undefined
  }
  const skills: CapabilityMentionCandidate[] = []
  const names = new Set<string>()
  for (const command of snapshot.commands) {
    if (command.type !== 'prompt' || command.disableModelInvocation || command.disableNonInteractive || command.userInvocable === false || command.isHidden || command.isEnabled?.() === false || command.source === 'builtin') continue
    const pluginId = command.source === 'plugin' ? command.pluginInfo?.repository : undefined
    if (command.source === 'plugin' && (!pluginId || !enabled.has(pluginId))) continue
    // Match SkillTool discovery, including described plugin prompt commands.
    if (!['bundled', 'skills', 'commands_DEPRECATED'].includes(command.loadedFrom ?? '') && !command.hasUserSpecifiedDescription && !command.whenToUse) continue
    if (!command.name || names.has(command.name)) continue
    names.add(command.name)
    const source = pluginId ?? command.source
    const owner = pluginId ? enabled.get(pluginId) : undefined
    const preferredName = command.userFacingName?.() || command.name
    const displayName = owner && preferredName === command.name && command.name.startsWith(`${owner.name}:`)
      ? command.name.slice(owner.name.length + 1) : preferredName
    skills.push({ kind: 'skill', id: command.name, name: command.name, displayName,
      description: command.description || '', source, ...(command.skillRoot ? { path: command.skillRoot } : {}),
      ...(brandIcon(source) ? { icon: brandIcon(source) } : {}),
      modelText: `Use the Skill tool with skill: ${JSON.stringify(command.name)} for this request.` })
  }
  const plugins: CapabilityMentionCandidate[] = []
  for (const plugin of enabled.values()) {
    const skillNames = skills.filter(skill => skill.source === plugin.source).map(skill => skill.name)
    const mcpServerNames = Object.keys(plugin.mcpServers ?? {}).map(name => `plugin:${plugin.name}:${name}`)
    // Hooks, LSP settings and marketplace availability alone are not a callable capability.
    if (!skillNames.length && !mcpServerNames.length) continue
    const brand = brands.get(plugin.source)
    plugins.push({ kind: 'plugin', id: plugin.source, name: plugin.name, displayName: brand?.displayName || plugin.name,
      description: brand?.description || plugin.manifest.description || '', source: plugin.source, path: plugin.path,
      ...(brandIcon(plugin.source) ? { icon: brandIcon(plugin.source) } : {}), skillNames, mcpServerNames,
      modelText: `Use the enabled plugin ${JSON.stringify(plugin.source)} for this request. Available skill identities: ${JSON.stringify(skillNames)}. MCP server identities: ${JSON.stringify(mcpServerNames)}. Invoke skills using the Skill tool and use only tools currently available from these servers. If unavailable or authentication is required, report that; do not install or authenticate automatically.` })
  }
  const sort = (a: CapabilityMentionCandidate, b: CapabilityMentionCandidate) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
  return { skills: skills.sort(sort), plugins: plugins.sort(sort) }
}

/** Cache-only local discovery: never installs packages, connects MCP, or logs in. */
export async function listCapabilityMentions(cwd: string): Promise<CapabilityMentionResponse> {
  const [local, plugins, { loadInstalledPluginsForProject }, { loadPluginMcpServers }, { ALL_CONNECTORS }, { resetSettingsCache }, { clearInstalledPluginsCache }] = await Promise.all([
    import('../../skills/loadSkillsDir.js'), import('../../utils/plugins/loadPluginCommands.js'),
    import('../../utils/plugins/pluginLoader.js'), import('../../utils/plugins/mcpPluginIntegration.js'), import('../../services/connectors/catalog.js'),
    import('../../utils/settings/settingsCache.js'), import('../../utils/plugins/installedPluginsManager.js'),
  ])
  // Reuse the runtime's installed-skill loaders, without importing built-in
  // login commands (which require provider credentials even for discovery).
  resetSettingsCache()
  clearInstalledPluginsCache()
  local.clearSkillCaches()
  const [localCommands, state] = await Promise.all([
    local.getSkillDirCommands(cwd), loadInstalledPluginsForProject(cwd),
  ])
  const [pluginCommands, pluginSkills] = await Promise.all([
    plugins.loadPluginCommandsFromEnabledPlugins(state.enabled), plugins.loadPluginSkillsFromEnabledPlugins(state.enabled),
  ])
  const commands = [...localCommands, ...pluginCommands, ...pluginSkills]
  const enabledPlugins = await Promise.all(state.enabled.map(async plugin => {
    const specs = Array.isArray(plugin.manifest.mcpServers) ? plugin.manifest.mcpServers : [plugin.manifest.mcpServers]
    // Unexpanded MCPB bundles may require preparation; mentioning must not unpack/install them.
    if (specs.some(spec => typeof spec === 'string' && /\.(?:mcpb|dxt)(?:$|[?#])/i.test(spec))) return plugin
    try { return { ...plugin, mcpServers: plugin.mcpServers ?? await loadPluginMcpServers(plugin, state.errors) } }
    catch { return { ...plugin, mcpServers: undefined } }
  }))
  return buildCapabilityMentions({ commands, enabledPlugins, failedPluginIds: state.errors.map(error => error.source), brands: ALL_CONNECTORS })
}
