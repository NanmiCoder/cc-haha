import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  findSlashToken,
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

  it('keeps server-provided descriptions when they exist', () => {
    expect(
      mergeSlashCommands([
        { name: 'clear', description: 'Server description' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { name: 'clear', description: 'Server description' },
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

  it('does not expose paused /goal fallback commands', () => {
    const commands = filterSlashCommands(mergeSlashCommands([]), 'goal')

    expect(commands.map((command) => command.name)).toEqual([])
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal status')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('goal --tokens')
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
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('plugin')
    expect(mergeSlashCommands([]).map((command) => command.name)).toContain('memory')
    expect(mergeSlashCommands([]).map((command) => command.name)).not.toContain('plugins')
  })

  it('routes session inspection commands to the desktop panel', () => {
    expect(resolveSlashUiAction('cost')).toEqual({ type: 'panel', command: 'cost' })
    expect(resolveSlashUiAction('context')).toEqual({ type: 'panel', command: 'context' })
    expect(resolveSlashUiAction('status')).toEqual({ type: 'panel', command: 'status' })
  })
})
