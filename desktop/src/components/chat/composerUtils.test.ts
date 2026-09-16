import { describe, expect, it } from 'vitest'
import {
  FALLBACK_SLASH_COMMANDS,
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  filterSlashCommands,
  findSlashToken,
  getLocalizedFallbackCommands,
  getSlashCommandNameConflict,
  groupSlashCommands,
  insertSlashTrigger,
  mergeSlashCommands,
  replaceSlashCommand,
  resolveSlashUiAction,
} from './composerUtils'

describe('composerUtils', () => {
  it('finds slash token without trailing space', () => {
    expect(findSlashToken('/rev', 4)).toEqual({ start: 0, filter: 'rev' })
    expect(findSlashToken('hello /rev', 10)).toEqual({ start: 6, filter: 'rev' })
  })

  it('does not treat slash followed by a space as an active token', () => {
    expect(findSlashToken('/ review', 8)).toBeNull()
  })

  it('closes slash completion once /goal arguments start', () => {
    expect(findSlashToken('/goal ', 6)).toBeNull()
    expect(findSlashToken('/goal sta', 9)).toBeNull()
    expect(findSlashToken('/goal build app', 15)).toBeNull()
  })

  it('inserts a slash trigger without appending a trailing space', () => {
    expect(insertSlashTrigger('', 0)).toEqual({ value: '/', cursorPos: 1 })
    expect(insertSlashTrigger('hello', 5)).toEqual({ value: 'hello /', cursorPos: 7 })
  })

  it('replaces the current slash token with a command and one trailing separator', () => {
    expect(replaceSlashCommand('/rev', 4, 'review')).toEqual({
      value: '/review ',
      cursorPos: 8,
    })
  })

  it('merges fallback commands so built-in entries like /compact remain visible', () => {
    expect(
      mergeSlashCommands([
        { name: 'help', description: '' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { name: 'help', description: 'Show available desktop and agent commands' },
        { name: 'compact', description: 'Compact conversation context' },
        { name: 'context', description: 'Show current context usage' },
      ]),
    )
  })

  it('never falls back to commands this desktop cannot run', () => {
    // The headless CLI answers these with "Unknown skill", so offering them in
    // the menu is a dead end. They regressing back in means the fallback list
    // drifted away from what the session can actually execute.
    const names = FALLBACK_SLASH_COMMANDS.map(command => command.name)
    for (const dead of ['clear', 'vim', 'terminal-setup', 'permissions', 'commit', 'pr', 'bug', 'login', 'logout']) {
      expect(names).not.toContain(dead)
    }
  })

  it('keeps server-provided descriptions for non-built-in commands', () => {
    expect(
      mergeSlashCommands([
        { name: 'team:lark', description: 'Team-provided description' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { name: 'team:lark', description: 'Team-provided description' },
      ]),
    )
  })

  it('prefers the localized fallback description for built-in commands', () => {
    // For commands the desktop owns the copy for (e.g. /clear, /compact, /help),
    // the localized description must win over whatever the CLI broadcasts so the
    // i18n keys actually take effect at runtime.
    expect(
      mergeSlashCommands(
        [{ name: 'clear', description: 'CLI English description' }],
        [{ name: 'clear', description: 'Localized description' }],
      ),
    ).toEqual(
      expect.arrayContaining([
        { name: 'clear', description: 'Localized description' },
      ]),
    )
  })

  it('keeps slash command argument hints and fills missing fallback hints', () => {
    expect(
      mergeSlashCommands([
        {
          name: 'compact',
          description: '',
          argumentHint: '',
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        {
          name: 'compact',
          description: 'Compact conversation context',
        },
      ]),
    )
  })

  it('keeps /goal as a single command with argument hints instead of pseudo subcommands', () => {
    const commands = filterSlashCommands(mergeSlashCommands([]), 'goal')

    expect(commands.map((command) => command.name)).toEqual(['goal'])
    expect(commands[0]).toMatchObject({
      description: 'Set a completion goal',
      argumentHint: '[<condition> | clear]',
    })
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal status')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal --tokens')
  })

  it('builds agent slash entries under the /agent namespace', () => {
    expect(
      buildAgentSlashCommands([
        {
          agentType: 'debugger',
          description: 'Debug failures',
          modelDisplay: 'OPUS',
          source: 'userSettings',
        },
      ]),
    ).toEqual([
      {
        name: 'agent debugger',
        description: 'Debug failures (OPUS - userSettings)',
        argumentHint: '<prompt>',
        kind: 'agent',
      },
    ])
  })

  it('appends agent entries after normal slash commands without replacing them', () => {
    const base = mergeSlashCommands([{ name: 'agent', description: 'CLI /agent' }])
    const withAgents = appendAgentSlashCommands(base, [
      { name: 'agent debugger', description: 'Debug failures', argumentHint: '<prompt>' },
    ])

    expect(withAgents.map((command) => command.name).slice(0, 2)).toEqual(['agent', 'mcp'])
    expect(withAgents.map((command) => command.name)).toContain('agent debugger')
  })

  it('does not replace /goal arguments as slash command fragments', () => {
    expect(replaceSlashCommand('/goal sta', 9, 'goal status')).toBeNull()
  })

  it('ranks slash command name matches before broad description matches', () => {
    expect(
      filterSlashCommands([
        { name: 'lark-calendar', description: 'Includes shortcuts and suggestion helpers' },
        { name: 'agent-team-orchestrator', description: 'Uses Subagent orchestration' },
        { name: 'superpowers:brainstorming', description: 'Creative work planning' },
        { name: 'superpowers:systematic-debugging', description: 'Debug unexpected behavior' },
      ], 'su').map((command) => command.name),
    ).toEqual([
      'superpowers:brainstorming',
      'superpowers:systematic-debugging',
      'lark-calendar',
      'agent-team-orchestrator',
    ])
  })

  it('opens on the commands the desktop owns instead of the CLI registration order', () => {
    // The CLI lists its bundled skills first, so an unprioritised menu opens on
    // `update-config` / `debug` / `batch`. Desktop-owned commands lead instead,
    // and everything else keeps the order its source gave it.
    const commands = [
      { name: 'update-config', description: 'Configure' },
      { name: 'debug', description: 'Debug' },
      { name: 'compact', description: 'Compact conversation context' },
      { name: 'help', description: 'Show available commands' },
      { name: 'model', description: 'Switch AI model' },
    ]
    expect(filterSlashCommands(commands, '').map((command) => command.name)).toEqual([
      'help',
      'model',
      'update-config',
      'debug',
      'compact',
    ])
  })

  it('leaves match ranking alone once a query is typed', () => {
    const commands = [
      { name: 'help', description: 'Show available commands' },
      { name: 'compact', description: 'Compact conversation context' },
      { name: 'update-config', description: 'Compact the config' },
    ]
    expect(filterSlashCommands(commands, 'comp').map((command) => command.name)).toEqual([
      'compact',
      'update-config',
    ])
  })

  it('groups built-in app commands before personal skills without changing their relative order', () => {
    const groups = groupSlashCommands([
      { name: 'amazon-review-scraper', description: 'Collect Amazon reviews', kind: 'skill', source: 'user' },
      { name: 'status', description: 'Show session status', kind: 'command' },
      { name: 'agent debugger', description: 'Run the debugger agent', kind: 'agent' },
      { name: 'audit', description: 'Audit product UX', kind: 'skill', source: 'project' },
      { name: 'future-native-command', description: 'A CLI command unknown to this desktop build' },
      { name: 'model', description: 'Switch model', kind: 'command' },
    ])

    expect(groups.system.map((command) => command.name)).toEqual([
      'status',
      'agent debugger',
      'future-native-command',
      'model',
    ])
    expect(groups.skills.map((command) => command.name)).toEqual([
      'amazon-review-scraper',
      'audit',
    ])
    expect(groups.ordered.map((command) => command.name)).toEqual([
      'status',
      'agent debugger',
      'future-native-command',
      'model',
      'amazon-review-scraper',
      'audit',
    ])
  })

  it('resolves hidden settings aliases without displaying duplicate fallback rows', () => {
    expect(resolveSlashUiAction('plugins')).toEqual({ type: 'settings', tab: 'plugins' })
    expect(resolveSlashUiAction('memory')).toEqual({ type: 'settings', tab: 'memory' })
    expect(resolveSlashUiAction('doctor')).toEqual({ type: 'settings', tab: 'diagnostics' })
    expect(resolveSlashUiAction('config')).toEqual({ type: 'settings', tab: 'general' })
    expect(resolveSlashUiAction('settings')).toEqual({ type: 'settings', tab: 'general' })
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('plugin')
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('memory')
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('config')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('plugins')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('settings')
  })

  it('routes session inspection commands to the desktop panel', () => {
    expect(resolveSlashUiAction('cost')).toEqual({ type: 'panel', command: 'cost' })
    expect(resolveSlashUiAction('context')).toEqual({ type: 'panel', command: 'context' })
    expect(resolveSlashUiAction('status')).toEqual({ type: 'panel', command: 'status' })
  })

  it('routes /save-workflow to a desktop panel instead of the model', () => {
    expect(resolveSlashUiAction('save-workflow')).toEqual({
      type: 'panel',
      command: 'save-workflow',
    })
    expect(mergeSlashCommands([])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'save-workflow',
      }),
    ]))
  })

  it('protects desktop-owned and existing slash command names from workflow saves', () => {
    for (const name of ['save-workflow', 'help', 'status', 'config', 'model', 'SETTINGS']) {
      expect(getSlashCommandNameConflict(name)).toBe('reserved')
    }
    expect(
      getSlashCommandNameConflict('Release-Audit', [
        { name: 'release-audit' },
      ]),
    ).toBe('existing')
    expect(getSlashCommandNameConflict('new-audit', [{ name: 'review' }])).toBeNull()
  })

  it('routes /model to the local model selector action', () => {
    expect(resolveSlashUiAction('model')).toEqual({ type: 'model' })
  })

  it('falls back to the static English description when a translation key is missing', () => {
    // Simulate an i18n t() function that returns the raw key for missing entries
    // (this is what the real translate() does via zh[key] ?? en[key] ?? key).
    const mockT = (key: string) => key

    const commands = getLocalizedFallbackCommands(mockT)
    const contextCmd = commands.find((c) => c.name === 'context')
    expect(contextCmd?.description).toBe('Show current context usage')
    expect(contextCmd?.description).not.toBe('slashCmd.context.description')

    // Verify every command renders a human-readable description, never a raw key
    for (const cmd of commands) {
      expect(cmd.description).not.toMatch(/^slashCmd\./)
    }
  })

  it('uses the localized description when the translation key resolves to a real string', () => {
    const mockT = (key: string) => {
      const map: Record<string, string> = {
        'slashCmd.context.description': '当前上下文用量',
      }
      return map[key] ?? key
    }

    const commands = getLocalizedFallbackCommands(mockT)
    const contextCmd = commands.find((c) => c.name === 'context')
    expect(contextCmd?.description).toBe('当前上下文用量')

    // A command without a translated key should still fall back to English
    const mcpCmd = commands.find((c) => c.name === 'mcp')
    expect(mcpCmd?.description).toBe('Open available MCP tools for the current chat context')
    expect(mcpCmd?.description).not.toBe('slashCmd.mcp.description')
  })
})

it('orders plugin mentions between commands and skills without changing their canonical ids', () => {
  const groups = groupSlashCommands([
    { name: 'skill:video', description: 'Video', kind: 'skill' },
    { name: 'plugin:hyperframes', description: 'HyperFrames', kind: 'plugin' },
    { name: 'help', description: 'Help', kind: 'command' },
  ])
  expect(groups.plugins?.map(item => item.name)).toEqual(['plugin:hyperframes'])
  expect(groups.ordered.map(item => item.name)).toEqual(['help', 'plugin:hyperframes', 'skill:video'])
})
