import { basename, join, sep } from 'node:path'
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js'
import type { McpServerConfig } from '../../services/mcp/types.js'
import {
  disablePluginOp,
  enablePluginOp,
  type InstallableScope,
  uninstallPluginOp,
  updatePluginOp,
} from '../../services/plugins/pluginOperations.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import {
  getMarketplaceSourceDisplay,
} from '../../utils/plugins/marketplaceHelpers.js'
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js'
import {
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { loadPluginLspServers } from '../../utils/plugins/lspPluginIntegration.js'
import { loadPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { loadPluginHooks } from '../../utils/plugins/loadPluginHooks.js'
import { getPluginCommands } from '../../utils/plugins/loadPluginCommands.js'
import { clearPluginCacheExclusions } from '../../utils/plugins/orphanedPluginFilter.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { extractDescriptionFromMarkdown } from '../../utils/markdownConfigLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type {
  PluginInstallationEntry,
  PluginScope,
} from '../../utils/plugins/schemas.js'
import { ApiError } from '../middleware/errorHandler.js'
import { walkPluginMarkdown } from '../../utils/plugins/walkPluginMarkdown.js'
import type { HookCommand, HooksSettings } from '../../utils/settings/types.js'

export type ApiPluginCapabilitySet = {
  commands: string[]
  agents: string[]
  skills: string[]
  hooks: string[]
  mcpServers: string[]
  lspServers: string[]
}

export type ApiPluginSummary = {
  id: string
  name: string
  marketplace: string
  scope: PluginScope | 'builtin'
  enabled: boolean
  hasErrors: boolean
  isBuiltin: boolean
  version?: string
  description?: string
  authorName?: string
  installPath?: string
  projectPath?: string
  componentCounts: Record<keyof ApiPluginCapabilitySet, number>
  errors: string[]
}

export type ApiPluginSkillEntry = {
  name: string
  displayName?: string
  description: string
  version?: string
  pluginName?: string
}

export type ApiPluginCommandEntry = {
  name: string
  description: string
}

export type ApiPluginAgentEntry = {
  name: string
  displayName?: string
  description: string
}

export type ApiPluginHookEntry = {
  event: string
  matcher?: string
  actions: string[]
}

export type ApiPluginMcpServerEntry = {
  name: string
  displayName?: string
  transport: string
  summary: string
}

export type ApiPluginDetail = ApiPluginSummary & {
  capabilities: ApiPluginCapabilitySet
  commandEntries: ApiPluginCommandEntry[]
  agentEntries: ApiPluginAgentEntry[]
  hookEntries: ApiPluginHookEntry[]
  skillEntries: ApiPluginSkillEntry[]
  mcpServerEntries: ApiPluginMcpServerEntry[]
}

export type ApiPluginMarketplaceSummary = {
  name: string
  source: string
  lastUpdated?: string
  autoUpdate: boolean
  installedCount: number
}

export type ApiPluginListResponse = {
  plugins: ApiPluginSummary[]
  marketplaces: ApiPluginMarketplaceSummary[]
  summary: {
    total: number
    enabled: number
    errorCount: number
    marketplaceCount: number
  }
}

export type ApiPluginActionResponse = {
  ok: true
  message: string
}

export type ApiPluginReloadResponse = {
  ok: true
  summary: {
    enabled: number
    disabled: number
    skills: number
    agents: number
    hooks: number
    mcpServers: number
    lspServers: number
    errors: number
  }
}

type HydratedPluginState = {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

export class PluginService {
  async listPlugins(cwd?: string): Promise<ApiPluginListResponse> {
    const { plugins, marketplaces } = await this.collectPluginState(cwd)
    return {
      plugins,
      marketplaces,
      summary: {
        total: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        errorCount: plugins.reduce((sum, plugin) => sum + plugin.errors.length, 0),
        marketplaceCount: marketplaces.length,
      },
    }
  }

  async getPluginDetail(
    pluginId: string,
    cwd?: string,
  ): Promise<ApiPluginDetail> {
    const { plugins, detailById } = await this.collectPluginState(cwd)
    const detail = detailById.get(pluginId)

    if (!detail) {
      throw ApiError.notFound(`Plugin not found: ${pluginId}`)
    }

    return detail
  }

  async enablePlugin(
    pluginId: string,
    scope?: InstallableScope,
  ): Promise<ApiPluginActionResponse> {
    const result = await enablePluginOp(pluginId, scope)
    if (!result.success) {
      throw ApiError.badRequest(result.message)
    }
    return { ok: true, message: result.message }
  }

  async disablePlugin(
    pluginId: string,
    scope?: InstallableScope,
  ): Promise<ApiPluginActionResponse> {
    const result = await disablePluginOp(pluginId, scope)
    if (!result.success) {
      throw ApiError.badRequest(result.message)
    }
    return { ok: true, message: result.message }
  }

  async uninstallPlugin(
    pluginId: string,
    scope?: InstallableScope,
    keepData = false,
  ): Promise<ApiPluginActionResponse> {
    if (!scope) {
      throw ApiError.badRequest('Plugin uninstall requires a scope')
    }

    const result = await uninstallPluginOp(pluginId, scope, keepData)
    if (!result.success) {
      throw ApiError.badRequest(result.message)
    }
    return { ok: true, message: result.message }
  }

  async updatePlugin(
    pluginId: string,
    scope?: PluginScope,
  ): Promise<ApiPluginActionResponse> {
    if (!scope) {
      throw ApiError.badRequest('Plugin update requires a scope')
    }

    const result = await updatePluginOp(pluginId, scope)
    if (!result.success) {
      throw ApiError.badRequest(result.message)
    }
    return { ok: true, message: result.message }
  }

  async reloadPlugins(cwd?: string): Promise<ApiPluginReloadResponse> {
    resetSettingsCache()
    clearAllCaches()
    clearPluginCacheExclusions()

    const pluginState = await this.loadPluginState()
    const { enabled, disabled, errors } = pluginState

    const [commands, agentDefinitions] = await Promise.all([
      getPluginCommands(),
      getAgentDefinitionsWithOverrides(cwd),
    ])

    const hookCount = await this.getHookCount(enabled)
    const mcpCounts = await Promise.all(
      enabled.map(async (plugin) => {
        const servers = plugin.mcpServers || await loadPluginMcpServers(plugin, errors)
        return servers ? Object.keys(servers).length : 0
      }),
    )
    const lspCounts = await Promise.all(
      enabled.map(async (plugin) => {
        const servers = plugin.lspServers || await loadPluginLspServers(plugin, errors)
        return servers ? Object.keys(servers).length : 0
      }),
    )

    return {
      ok: true,
      summary: {
        enabled: enabled.length,
        disabled: disabled.length,
        skills: commands.length,
        agents: agentDefinitions.allAgents.length,
        hooks: hookCount,
        mcpServers: mcpCounts.reduce((sum, count) => sum + count, 0),
        lspServers: lspCounts.reduce((sum, count) => sum + count, 0),
        errors: errors.length,
      },
    }
  }

  private async collectPluginState(cwd?: string): Promise<{
    plugins: ApiPluginSummary[]
    detailById: Map<string, ApiPluginDetail>
    marketplaces: ApiPluginMarketplaceSummary[]
  }> {
    const [pluginState, installedData, marketplaceConfig] = await Promise.all([
      this.loadPluginState(),
      Promise.resolve(loadInstalledPluginsV2()),
      loadKnownMarketplacesConfig(),
    ])

    const allLoaded = [...pluginState.enabled, ...pluginState.disabled]
    const loadedById = new Map(
      allLoaded
        .filter((plugin) => !plugin.source.endsWith('@inline'))
        .map((plugin) => [plugin.source, plugin]),
    )

    const pluginIds = new Set<string>([
      ...Object.keys(installedData.plugins),
      ...allLoaded
        .filter((plugin) => !plugin.source.endsWith('@inline'))
        .map((plugin) => plugin.source),
    ])

    const detailById = new Map<string, ApiPluginDetail>()

    for (const pluginId of [...pluginIds].sort()) {
      const installation = this.pickInstallation(
        installedData.plugins[pluginId] ?? [],
        cwd,
      )
      const loaded = loadedById.get(pluginId)
      const detail = await this.serializePluginDetail(
        pluginId,
        installation,
        loaded,
        pluginState.errors,
      )
      detailById.set(pluginId, detail)
    }

    const plugins = [...detailById.values()].map((detail) =>
      this.toSummary(detail),
    )

    const marketplaces = Object.entries(marketplaceConfig.marketplaces ?? {})
      .map(([name, entry]) => ({
        name,
        source: getMarketplaceSourceDisplay(entry.source),
        lastUpdated: entry.lastUpdated,
        autoUpdate: entry.autoUpdate !== false,
        installedCount: plugins.filter((plugin) => plugin.marketplace === name).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))

    return { plugins, detailById, marketplaces }
  }

  private async loadPluginState(): Promise<HydratedPluginState> {
    const result = await loadAllPlugins()
    await Promise.all(
      result.enabled.map(async (plugin) => {
        plugin.mcpServers = plugin.mcpServers || await loadPluginMcpServers(plugin, result.errors)
        plugin.lspServers = plugin.lspServers || await loadPluginLspServers(plugin, result.errors)
      }),
    )
    return result
  }

  private async serializePluginDetail(
    pluginId: string,
    installation: PluginInstallationEntry | null,
    loaded: LoadedPlugin | undefined,
    errors: PluginError[],
  ): Promise<ApiPluginDetail> {
    const { name, marketplace } = parsePluginIdentifier(pluginId)
    const pluginErrors = this.getErrorsForPlugin(pluginId, name, errors)

    if (!loaded) {
      return {
        id: pluginId,
        name,
        marketplace: marketplace || 'unknown',
        scope: installation?.scope ?? 'user',
        enabled: false,
        hasErrors: pluginErrors.length > 0,
        isBuiltin: false,
        installPath: installation?.installPath,
        projectPath: installation?.projectPath,
        errors: pluginErrors,
        componentCounts: this.countCapabilities(this.emptyCapabilities()),
        capabilities: this.emptyCapabilities(),
        commandEntries: [],
        agentEntries: [],
        hookEntries: [],
        skillEntries: [],
        mcpServerEntries: [],
      }
    }

    const {
      capabilities,
      commandEntries,
      agentEntries,
      hookEntries,
      skillEntries,
      mcpServerEntries,
    } = await this.collectCapabilities(loaded)
    return {
      id: pluginId,
      name: loaded.name,
      marketplace: marketplace || 'unknown',
      scope: installation?.scope ?? 'user',
      enabled: loaded.enabled !== false,
      hasErrors: pluginErrors.length > 0,
      isBuiltin: Boolean(loaded.isBuiltin),
      version: loaded.manifest.version,
      description: loaded.manifest.description,
      authorName: loaded.manifest.author?.name,
      installPath: installation?.installPath,
      projectPath: installation?.projectPath,
      errors: pluginErrors,
      componentCounts: this.countCapabilities(capabilities),
      capabilities,
      commandEntries,
      agentEntries,
      hookEntries,
      skillEntries,
      mcpServerEntries,
    }
  }

  private async collectCapabilities(
    plugin: LoadedPlugin,
  ): Promise<{
    capabilities: ApiPluginCapabilitySet
    commandEntries: ApiPluginCommandEntry[]
    agentEntries: ApiPluginAgentEntry[]
    hookEntries: ApiPluginHookEntry[]
    skillEntries: ApiPluginSkillEntry[]
    mcpServerEntries: ApiPluginMcpServerEntry[]
  }> {
    if (plugin.isBuiltin) {
      const definition = getBuiltinPluginDefinition(plugin.name)
      const skillEntries = (definition?.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
      }))
      const mcpServerEntries = Object.entries(definition?.mcpServers ?? {}).map(([serverName, config]) => ({
        name: `plugin:${plugin.name}:${serverName}`,
        displayName: serverName,
        transport: this.getPluginMcpTransport(config),
        summary: this.getPluginMcpSummary(config),
      }))

      return {
        capabilities: {
          commands: [],
          agents: [],
          skills: skillEntries.map((skill) => skill.name),
          hooks: definition?.hooks ? Object.keys(definition.hooks) : [],
          mcpServers: mcpServerEntries.map((server) => server.name),
          lspServers: [],
        },
        commandEntries: [],
        agentEntries: [],
        hookEntries: this.collectHookEntries(definition?.hooks),
        skillEntries,
        mcpServerEntries,
      }
    }

    const commandEntries = await this.collectCommandEntries(plugin)
    const agentEntries = await this.collectAgentEntries(plugin)
    const hookEntries = this.collectHookEntries(plugin.hooksConfig)
    const skillEntries = await this.collectSkillEntries([
      plugin.skillsPath,
      ...(plugin.skillsPaths ?? []),
    ], plugin.name)
    const mcpServerEntries = this.collectMcpServerEntries(plugin.name, plugin.mcpServers)

    return {
      capabilities: {
        commands: commandEntries.map((command) => command.name),
        agents: agentEntries.map((agent) => agent.name),
        skills: skillEntries.map((skill) => skill.name),
        hooks: [...new Set(hookEntries.map((hook) => hook.event))],
        mcpServers: mcpServerEntries.map((server) => server.name),
        lspServers: plugin.lspServers ? Object.keys(plugin.lspServers) : [],
      },
      commandEntries,
      agentEntries,
      hookEntries,
      skillEntries,
      mcpServerEntries,
    }
  }

  private async collectCommandEntries(
    plugin: LoadedPlugin,
  ): Promise<ApiPluginCommandEntry[]> {
    return this.collectMarkdownEntriesWithDescriptions(
      plugin.name,
      [plugin.commandsPath, ...(plugin.commandsPaths ?? [])],
      { stopAtSkillDir: true, useNamespace: true },
    )
  }

  private async collectAgentEntries(
    plugin: LoadedPlugin,
  ): Promise<ApiPluginAgentEntry[]> {
    return this.collectMarkdownEntriesWithDescriptions(
      plugin.name,
      [plugin.agentsPath, ...(plugin.agentsPaths ?? [])],
      { stopAtSkillDir: false, useNamespace: true, preferFrontmatterName: true },
    )
  }

  private async collectMarkdownEntries(paths: Array<string | undefined>): Promise<string[]> {
    const fs = await import('node:fs/promises')
    const names = new Set<string>()

    for (const dirPath of paths) {
      if (!dirPath) continue

      try {
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
        for (const entry of dirEntries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue
          names.add(entry.name.replace(/\.md$/i, ''))
        }
      } catch {
        // Ignore unreadable plugin component directories and keep rendering.
      }
    }

    return [...names].sort()
  }

  private async collectMarkdownEntriesWithDescriptions(
    pluginName: string,
    paths: Array<string | undefined>,
    options: {
      stopAtSkillDir: boolean
      useNamespace: boolean
      preferFrontmatterName?: boolean
    },
  ): Promise<Array<{ name: string; displayName?: string; description: string }>> {
    const fs = await import('node:fs/promises')
    const entries = new Map<string, { name: string; displayName?: string; description: string }>()

    for (const rootPath of paths) {
      if (!rootPath) continue

      await walkPluginMarkdown(
        rootPath,
        async (fullPath, namespace) => {
          const raw = await fs.readFile(fullPath, 'utf-8')
          const parsed = parseFrontmatter(raw, fullPath)
          const baseName = basename(fullPath).replace(/\.md$/i, '')
          const resolvedLeafName =
            options.preferFrontmatterName &&
            typeof parsed.frontmatter.name === 'string' &&
            parsed.frontmatter.name.trim().length > 0
              ? parsed.frontmatter.name.trim()
              : /^skill$/i.test(baseName)
                ? basename(join(fullPath, '..'))
                : baseName
          const leafName = resolvedLeafName
          const name = options.useNamespace && namespace.length > 0
            ? `${pluginName}:${namespace.join(':')}:${leafName}`
            : options.useNamespace
              ? `${pluginName}:${leafName}`
              : leafName
          const description =
            (typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description.trim()) ||
            (typeof parsed.frontmatter['when-to-use'] === 'string' && parsed.frontmatter['when-to-use'].trim()) ||
            extractDescriptionFromMarkdown(parsed.content, 'No description')

          if (!entries.has(name)) {
            entries.set(name, {
              name,
              displayName: leafName !== name ? leafName : undefined,
              description,
            })
          }
        },
        {
          stopAtSkillDir: options.stopAtSkillDir,
          logLabel: options.useNamespace ? 'plugin-details' : 'markdown',
        },
      )
    }

    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async collectSkillEntries(
    paths: Array<string | undefined>,
    pluginName: string,
  ): Promise<ApiPluginSkillEntry[]> {
    const fs = await import('node:fs/promises')
    const skillEntriesByName = new Map<string, ApiPluginSkillEntry>()

    for (const dirPath of paths) {
      if (!dirPath) continue

      try {
        const directSkill = await this.readPluginSkillEntry(dirPath, pluginName)
        if (directSkill && !skillEntriesByName.has(directSkill.name)) {
          skillEntriesByName.set(directSkill.name, directSkill)
          continue
        }
      } catch {
        // Fall back to scanning as a skill root.
      }

      try {
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
        for (const entry of dirEntries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

          try {
            const skillEntry = await this.readPluginSkillEntry(join(dirPath, entry.name), pluginName)
            if (skillEntry && !skillEntriesByName.has(skillEntry.name)) {
              skillEntriesByName.set(skillEntry.name, skillEntry)
            }
          } catch {
            // Ignore non-skill directories.
          }
        }
      } catch {
        // Ignore unreadable plugin component directories and keep rendering.
      }
    }

    return [...skillEntriesByName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readPluginSkillEntry(
    skillDir: string,
    pluginName: string,
  ): Promise<ApiPluginSkillEntry | null> {
    const fs = await import('node:fs/promises')
    const skillFile = join(skillDir, 'SKILL.md')
    try {
      const stat = await fs.stat(skillFile)
      if (!stat.isFile()) return null

      const raw = await fs.readFile(skillFile, 'utf-8')
      const parsed = parseFrontmatter(raw, skillFile)
      const body = parsed.content
      const name = typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name.trim().length > 0
        ? parsed.frontmatter.name.trim()
        : basename(skillDir)

      const description =
        (typeof parsed.frontmatter.description === 'string' && parsed.frontmatter.description.trim()) ||
        body
          .split('\n')
          .find((line) => line.trim().length > 0)
          ?.trim() ||
        'No description'

      return {
        name: `${pluginName}:${basename(skillDir)}`,
        displayName: name !== basename(skillDir) ? name : undefined,
        description,
        version: parsed.frontmatter.version != null ? String(parsed.frontmatter.version) : undefined,
        pluginName,
      }
    } catch {
      return null
    }
  }

  private collectMcpServerEntries(
    pluginName: string,
    servers?: Record<string, McpServerConfig>,
  ): ApiPluginMcpServerEntry[] {
    return Object.entries(servers ?? {})
      .map(([name, config]) => ({
        name: `plugin:${pluginName}:${name}`,
        displayName: name,
        transport: this.getPluginMcpTransport(config),
        summary: this.getPluginMcpSummary(config),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private collectHookEntries(hooks?: HooksSettings): ApiPluginHookEntry[] {
    const entries: ApiPluginHookEntry[] = []
    for (const [event, matchers] of Object.entries(hooks ?? {})) {
      for (const matcher of matchers ?? []) {
        entries.push({
          event,
          matcher: matcher.matcher,
          actions: matcher.hooks.map((hook) => this.describeHookAction(hook)),
        })
      }
    }

    return entries.sort((a, b) => {
      if (a.event !== b.event) return a.event.localeCompare(b.event)
      return (a.matcher ?? '').localeCompare(b.matcher ?? '')
    })
  }

  private describeHookAction(hook: HookCommand): string {
    switch (hook.type) {
      case 'command':
        return hook.command
      case 'prompt':
        return hook.prompt
      case 'agent':
        return hook.prompt
      case 'http':
        return hook.url
      default:
        return hook.type
    }
  }

  private getPluginMcpTransport(config: McpServerConfig): string {
    return config.type ?? 'stdio'
  }

  private getPluginMcpSummary(config: McpServerConfig): string {
    if (!config.type || config.type === 'stdio') {
      const stdioConfig = config as McpServerConfig & {
        command?: string
        args?: string[]
      }
      return [stdioConfig.command, ...(stdioConfig.args ?? [])].filter(Boolean).join(' ').trim()
    }

    if ('url' in config && typeof config.url === 'string') {
      return config.url
    }

    return config.type
  }

  private getErrorsForPlugin(
    pluginId: string,
    pluginName: string,
    errors: PluginError[],
  ): string[] {
    return errors
      .filter((error) => {
        if (error.source === pluginId) return true
        if ('plugin' in error && error.plugin === pluginName) return true
        return error.source.startsWith(`${pluginName}@`)
      })
      .map(getPluginErrorMessage)
  }

  private pickInstallation(
    installations: PluginInstallationEntry[],
    cwd?: string,
  ): PluginInstallationEntry | null {
    if (!installations.length) return null

    const relevantForCwd = cwd
      ? installations.filter((entry) =>
          entry.projectPath ? this.isPathWithinProject(cwd, entry.projectPath) : false,
        )
      : []

    const localMatch = relevantForCwd.find((entry) => entry.scope === 'local')
    if (localMatch) return localMatch

    const projectMatch = relevantForCwd.find((entry) => entry.scope === 'project')
    if (projectMatch) return projectMatch

    const userMatch = installations.find((entry) => entry.scope === 'user')
    if (userMatch) return userMatch

    return installations[0] ?? null
  }

  private isPathWithinProject(cwd: string, projectPath: string): boolean {
    return cwd === projectPath || cwd.startsWith(`${projectPath}${sep}`)
  }

  private emptyCapabilities(): ApiPluginCapabilitySet {
    return {
      commands: [],
      agents: [],
      skills: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
    }
  }

  private countCapabilities(
    capabilities: ApiPluginCapabilitySet,
  ): Record<keyof ApiPluginCapabilitySet, number> {
    return {
      commands: capabilities.commands.length,
      agents: capabilities.agents.length,
      skills: capabilities.skills.length,
      hooks: capabilities.hooks.length,
      mcpServers: capabilities.mcpServers.length,
      lspServers: capabilities.lspServers.length,
    }
  }

  private toSummary(detail: ApiPluginDetail): ApiPluginSummary {
    return {
      id: detail.id,
      name: detail.name,
      marketplace: detail.marketplace,
      scope: detail.scope,
      enabled: detail.enabled,
      hasErrors: detail.hasErrors,
      isBuiltin: detail.isBuiltin,
      version: detail.version,
      description: detail.description,
      authorName: detail.authorName,
      installPath: detail.installPath,
      projectPath: detail.projectPath,
      componentCounts: detail.componentCounts,
      errors: detail.errors,
    }
  }

  private async getHookCount(plugins: LoadedPlugin[]): Promise<number> {
    try {
      await loadPluginHooks()
    } catch {
      // Hook loading failures are already represented in the shared plugin errors.
    }

    return plugins.reduce((sum, plugin) => {
      if (!plugin.hooksConfig) return sum
      return sum + Object.values(plugin.hooksConfig).reduce((hookSum, matchers) => (
        hookSum + (matchers?.reduce((matcherSum, matcher) => matcherSum + matcher.hooks.length, 0) ?? 0)
      ), 0)
    }, 0)
  }
}
