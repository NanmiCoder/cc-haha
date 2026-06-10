import { describe, expect, it } from 'vitest'
import {
  appendAgentSlashCommands,
  buildAgentSlashCommands,
  filterSlashCommands,
  findSlashToken,
  getLocalizedFallbackCommands,
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

  it('merges fallback commands so built-in entries like /clear remain visible', () => {
    expect(
      mergeSlashCommands([
        { name: 'help', description: '' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { name: 'help', description: 'Show available desktop and agent commands' },
        { name: 'clear', description: 'Clear conversation history' },
        { name: 'context', description: 'Show current context usage' },
      ]),
    )
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

  it('falls back to the static English description when a translation key is missing', () => {
    // Simulate an i18n t() function that returns the raw key for missing entries
    // (this is what the real translate() does via zh[key] ?? en[key] ?? key).
    const mockT = (key: string) => key

    const commands = getLocalizedFallbackCommands(mockT)
    const clearCmd = commands.find((c) => c.name === 'clear')
    expect(clearCmd?.description).toBe('Clear conversation history')
    expect(clearCmd?.description).not.toBe('slashCmd.clear.description')

    // Verify every command renders a human-readable description, never a raw key
    for (const cmd of commands) {
      expect(cmd.description).not.toMatch(/^slashCmd\./)
    }
  })

  it('uses the localized description when the translation key resolves to a real string', () => {
    const mockT = (key: string) => {
      const map: Record<string, string> = {
        'slashCmd.clear.description': '清空会话历史',
      }
      return map[key] ?? key
    }

    const commands = getLocalizedFallbackCommands(mockT)
    const clearCmd = commands.find((c) => c.name === 'clear')
    expect(clearCmd?.description).toBe('清空会话历史')

    // A command without a translated key should still fall back to English
    const mcpCmd = commands.find((c) => c.name === 'mcp')
    expect(mcpCmd?.description).toBe('Open available MCP tools for the current chat context')
    expect(mcpCmd?.description).not.toBe('slashCmd.mcp.description')
  })
})
