import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setInlinePlugins } from '../../bootstrap/state.js'
import { getCommandName } from '../../types/command.js'
import { clearPluginCache } from './pluginLoader.js'
import { getPluginSkills } from './loadPluginCommands.js'

let pluginDir: string | null = null

afterEach(async () => {
  setInlinePlugins([])
  getPluginSkills.cache?.clear?.()
  clearPluginCache('load-plugin-commands-test')
  if (pluginDir) {
    await rm(pluginDir, { recursive: true, force: true })
    pluginDir = null
  }
})

describe('plugin skill display names', () => {
  test('keeps the plugin prefix when frontmatter overrides the skill name', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-skill-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'review'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'acme',
        version: '1.0.0',
        description: 'Test plugin',
      }),
    )
    await writeFile(
      join(pluginDir, 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: custom-review',
        'description: Review a change',
        '---',
        'Review the requested change.',
      ].join('\n'),
    )

    setInlinePlugins([pluginDir])
    getPluginSkills.cache?.clear?.()
    clearPluginCache('load-plugin-commands-test-setup')

    const skills = await getPluginSkills()
    const skill = skills.find(command => command.name === 'acme:review')

    expect(skill).toBeDefined()
    expect(getCommandName(skill!)).toBe('acme:custom-review')
    expect(skill?.aliases).toContain('custom-review')
  })

  test('keeps the complete prefix when the plugin name contains a colon', async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-skill-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'review'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'foo:bar',
        version: '1.0.0',
        description: 'Test plugin',
      }),
    )
    await writeFile(
      join(pluginDir, 'skills', 'review', 'SKILL.md'),
      [
        '---',
        'name: custom-review',
        'description: Review a change',
        '---',
        'Review the requested change.',
      ].join('\n'),
    )

    setInlinePlugins([pluginDir])
    getPluginSkills.cache?.clear?.()
    clearPluginCache('load-plugin-commands-colon-test')

    const skills = await getPluginSkills()
    const skill = skills.find(command => command.name === 'foo:bar:review')

    expect(skill).toBeDefined()
    expect(getCommandName(skill!)).toBe('foo:bar:custom-review')
  })
})

test('lean plugin skills cannot grant shell interpolation permissions', async () => {
  const { spyOn } = await import('bun:test')
  const shell = await import('../promptShellExecution.js')
  const { setAgentProfile } = await import('../agentProfile.js')
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const captured: unknown[] = []
  const execute = spyOn(shell, 'executeShellCommandsInPrompt').mockImplementation(async (text, context) => {
    captured.push(context.getAppState().toolPermissionContext.alwaysAllowRules.command)
    return text
  })
  try {
    pluginDir = await mkdtemp(join(tmpdir(), 'lean-plugin-skill-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'skills', 'fixture'), { recursive: true })
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lean-fixture', version: '1.0.0' }))
    await writeFile(join(pluginDir, 'skills', 'fixture', 'SKILL.md'), '---\ndescription: fixture\nallowed-tools: Bash(*)\n---\n!`fixture`')
    setInlinePlugins([pluginDir])
    clearPluginCache('lean-permission-fixture')
    getPluginSkills.cache?.clear?.()
    const skill = (await getPluginSkills()).find(command => command.name === 'lean-fixture:fixture')
    if (skill?.type !== 'prompt') throw new Error('missing fixture skill')
    const permissions = getEmptyToolPermissionContext()
    permissions.alwaysAllowRules.command = ['Read']
    const context = { getAppState: () => ({ toolPermissionContext: permissions }) } as import('../../Tool.js').ToolUseContext
    setAgentProfile('lean')
    await skill.getPromptForCommand('', context)
    setAgentProfile('standard')
    await skill.getPromptForCommand('', context)
    expect(captured).toEqual([['Read'], ['Bash(*)']])
  } finally {
    setAgentProfile('standard')
    execute.mockRestore()
  }
})

describe('plugin command discovery, namespaces, and path safety', () => {
  test('formats nested subdirectory namespaces across POSIX and Windows path separators', async () => {
    const pathMod = await import('path')
    const mod = await import('./loadPluginCommands.js')
    const getCommandNameFromFile = (mod as Record<string, unknown>).getCommandNameFromFile as
      | ((filePath: string, baseDir: string, pluginName: string, pathOps?: typeof pathMod.posix) => string)
      | undefined
    expect(typeof getCommandNameFromFile).toBe('function')
    expect(
      getCommandNameFromFile!(
        '/plugins/nexuskit/.claude/commands/ui/nk-build.md',
        '/plugins/nexuskit/.claude/commands',
        'nexuskit',
        pathMod.posix,
      ),
    ).toBe('nexuskit:ui:nk-build')
    expect(
      getCommandNameFromFile!(
        'C:\\plugins\\nexuskit\\.claude\\commands\\ui\\forms\\nk-build.md',
        'C:\\plugins\\nexuskit\\.claude\\commands',
        'nexuskit',
        pathMod.win32,
      ),
    ).toBe('nexuskit:ui:forms:nk-build')
    expect(
      getCommandNameFromFile!(
        'C:\\plugins\\nexuskit\\skills\\ui\\my-skill\\SKILL.md',
        'C:\\plugins\\nexuskit\\skills',
        'nexuskit',
        pathMod.win32,
      ),
    ).toBe('nexuskit:ui:my-skill')
  })

  test('preserves context: fork on plugin commands and skills for lean compatibility checks', async () => {
    const { isLeanCompatibleSkill } = await import('../agentProfile.js')
    const { createPluginFromPath } = await import('./pluginLoader.js')
    const { loadPluginCommandsFromEnabledPlugins } = await import('./loadPluginCommands.js')

    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-fork-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, '.claude', 'commands'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'nexuskit',
        version: '0.4.0',
        commands: ['./.claude/commands'],
      }),
    )
    await writeFile(
      join(pluginDir, '.claude', 'commands', 'nk-build.md'),
      '---\ndescription: Build target\n---\nBuild it.',
    )
    await writeFile(
      join(pluginDir, '.claude', 'commands', 'nk-forked.md'),
      '---\ndescription: Forked command\ncontext: fork\n---\nFork it.',
    )

    const { plugin } = await createPluginFromPath(pluginDir, 'nexuskit@nexuskit-skills', true, 'nexuskit')
    const commands = await loadPluginCommandsFromEnabledPlugins([plugin])
    const inlineCmd = commands.find(cmd => cmd.name === 'nexuskit:nk-build')
    const forkedCmd = commands.find(cmd => cmd.name === 'nexuskit:nk-forked')

    expect(inlineCmd).toBeDefined()
    expect(forkedCmd).toBeDefined()
    expect(isLeanCompatibleSkill(inlineCmd!)).toBe(true)
    expect(isLeanCompatibleSkill(forkedCmd!)).toBe(false)
  })

  test('rejects manifest command paths that traverse outside the plugin root', async () => {
    const { createPluginFromPath } = await import('./pluginLoader.js')
    const { loadPluginCommandsFromEnabledPlugins } = await import('./loadPluginCommands.js')

    const parentDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-escape-'))
    pluginDir = parentDir
    const safePluginDir = join(parentDir, 'plugin')
    const outsideCommandsDir = join(parentDir, 'outside-commands')
    await mkdir(join(safePluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(outsideCommandsDir, { recursive: true })
    await writeFile(
      join(outsideCommandsDir, 'escaped.md'),
      '---\ndescription: Escaped command\n---\nShould never load.',
    )
    await writeFile(
      join(safePluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'escape-test',
        version: '1.0.0',
        commands: ['./../outside-commands'],
      }),
    )

    const { plugin } = await createPluginFromPath(safePluginDir, 'escape-test@market', true, 'escape-test')
    const commands = await loadPluginCommandsFromEnabledPlugins([plugin])
    expect(commands).toEqual([])
  })

  test('normalizes non-string YAML argument-hint values safely without object stringification', async () => {
    const { createPluginFromPath } = await import('./pluginLoader.js')
    const { loadPluginCommandsFromEnabledPlugins } = await import('./loadPluginCommands.js')

    pluginDir = await mkdtemp(join(tmpdir(), 'cc-haha-plugin-arghint-'))
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginDir, 'commands'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hint-plugin', version: '1.0.0' }),
    )
    await writeFile(
      join(pluginDir, 'commands', 'num.md'),
      '---\ndescription: Number hint\nargument-hint: 8080\n---\nPort command.',
    )
    await writeFile(
      join(pluginDir, 'commands', 'bool.md'),
      '---\ndescription: Boolean hint\nargument-hint: true\n---\nFlag command.',
    )
    await writeFile(
      join(pluginDir, 'commands', 'seq.md'),
      '---\ndescription: Sequence hint\nargument-hint:\n  - --force\n  - 8080\n---\nSeq command.',
    )
    await writeFile(
      join(pluginDir, 'commands', 'obj.md'),
      '---\ndescription: Object hint\nargument-hint:\n  nested: value\n---\nObj command.',
    )

    const { plugin } = await createPluginFromPath(pluginDir, 'hint-plugin@market', true, 'hint-plugin')
    const commands = await loadPluginCommandsFromEnabledPlugins([plugin])
    const byName = new Map(commands.map(cmd => [cmd.name, cmd]))

    expect(byName.get('hint-plugin:num')?.argumentHint).toBe('8080')
    expect(byName.get('hint-plugin:bool')?.argumentHint).toBe('true')
    expect(byName.get('hint-plugin:seq')?.argumentHint).toBe('--force 8080')
    expect(byName.get('hint-plugin:obj')?.argumentHint).toBeUndefined()
  })

  test('rejects marketplace entry command and skill paths escaping plugin root with or without plugin.json', async () => {
    const { loadPluginSkillsFromEnabledPlugins, loadPluginCommandsFromEnabledPlugins } = await import('./loadPluginCommands.js')
    const { loadActivePluginsForProject } = await import('./pluginLoader.js')
    const { clearInstalledPluginsCache } = await import('./installedPluginsManager.js')
    const { resetSettingsCache } = await import('../settings/settingsCache.js')

    const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-market-escape-'))
    pluginDir = sandbox
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
    process.env.CLAUDE_CONFIG_DIR = join(sandbox, '.claude')

    try {
      const projectDir = join(sandbox, 'project')
      const pluginsDir = join(sandbox, '.claude', 'plugins')
      const marketDir = join(sandbox, 'market')
      const noManifestPluginDir = join(marketDir, 'plugins', 'no-manifest')
      const withManifestPluginDir = join(marketDir, 'plugins', 'with-manifest')
      const outsideCommandsDir = join(marketDir, 'outside-commands')
      const outsideSkillsDir = join(marketDir, 'outside-skills', 'leaked-skill')

      await Promise.all([
        mkdir(join(projectDir, '.claude'), { recursive: true }),
        mkdir(pluginsDir, { recursive: true }),
        mkdir(join(marketDir, '.claude-plugin'), { recursive: true }),
        mkdir(noManifestPluginDir, { recursive: true }),
        mkdir(join(withManifestPluginDir, '.claude-plugin'), { recursive: true }),
        mkdir(outsideCommandsDir, { recursive: true }),
        mkdir(outsideSkillsDir, { recursive: true }),
      ])

      await writeFile(
        join(outsideCommandsDir, 'escaped.md'),
        '---\ndescription: Outside command\n---\nNever load.',
      )
      await writeFile(
        join(outsideSkillsDir, 'SKILL.md'),
        '---\ndescription: Outside skill\n---\nNever load.',
      )
      await writeFile(
        join(withManifestPluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'with-manifest', version: '1.0.0' }),
      )
      await writeFile(
        join(marketDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'escape-market',
          owner: { name: 'Test' },
          plugins: [
            {
              name: 'no-manifest',
              source: './plugins/no-manifest',
              version: '1.0.0',
              commands: ['./../../outside-commands'],
              skills: ['./../../outside-skills'],
            },
            {
              name: 'no-manifest-obj',
              source: './plugins/no-manifest',
              version: '1.0.0',
              commands: {
                leaked: { source: './../../outside-commands/escaped.md' },
              },
            },
            {
              name: 'with-manifest',
              source: './plugins/with-manifest',
              version: '1.0.0',
              strict: true,
              commands: ['./../../outside-commands'],
              skills: ['./../../outside-skills'],
            },
            {
              name: 'with-manifest-obj',
              source: './plugins/with-manifest',
              version: '1.0.0',
              strict: true,
              commands: {
                leaked: { source: './../../outside-commands/escaped.md' },
              },
            },
          ],
        }),
      )
      await writeFile(
        join(pluginsDir, 'known_marketplaces.json'),
        JSON.stringify({
          'escape-market': {
            source: { source: 'directory', path: marketDir },
            installLocation: marketDir,
            lastUpdated: new Date(0).toISOString(),
          },
        }),
      )
      await writeFile(
        join(sandbox, '.claude', 'settings.json'),
        JSON.stringify({
          enabledPlugins: {
            'no-manifest@escape-market': true,
            'no-manifest-obj@escape-market': true,
            'with-manifest@escape-market': true,
            'with-manifest-obj@escape-market': true,
          },
        }),
      )

      resetSettingsCache()
      clearInstalledPluginsCache()
      clearPluginCache('market-escape-test')

      const loaded = await loadActivePluginsForProject(projectDir)
      const commands = await loadPluginCommandsFromEnabledPlugins(loaded.enabled)
      const skills = await loadPluginSkillsFromEnabledPlugins(loaded.enabled)
      expect(commands).toEqual([])
      expect(skills).toEqual([])
      expect(
        loaded.errors.filter(
          err => err.type === 'generic-error' && err.error.includes('Path traversal detected'),
        ).length,
      ).toBeGreaterThanOrEqual(6)

      // Defense-in-depth: manually constructed LoadedPlugin with out-of-root skillsPath / skillsPaths
      const manualSkills = await loadPluginSkillsFromEnabledPlugins([
        {
          name: 'manual',
          manifest: { name: 'manual', version: '1.0.0' },
          path: noManifestPluginDir,
          source: 'manual@escape-market',
          repository: 'manual@escape-market',
          enabled: true,
          skillsPath: join(marketDir, 'outside-skills'),
          skillsPaths: [outsideSkillsDir],
        },
      ])
      expect(manualSkills).toEqual([])
    } finally {
      resetSettingsCache()
      clearInstalledPluginsCache()
      clearPluginCache('market-escape-cleanup')
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevUserProfile
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    }
  })
})
