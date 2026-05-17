import type { SettingsTab } from '../../stores/uiStore'

export const PANEL_SLASH_COMMANDS = [
  { name: 'mcp', description: 'Open available MCP tools for the current chat context' },
  { name: 'skills', description: 'Browse user-invocable skills for the current chat context' },
  { name: 'help', description: 'Show available desktop and agent commands' },
  { name: 'status', description: 'Show session status, usage, and context' },
  { name: 'cost', description: 'Show session usage and costs' },
  { name: 'context', description: 'Show current context usage' },
] as const

export const SETTINGS_SLASH_COMMANDS = [
  { name: 'plugin', description: 'Open desktop plugin controls in Settings', tab: 'plugins' as const },
  { name: 'memory', description: 'Open project memory files in Settings', tab: 'memory' as const },
  { name: 'doctor', description: 'Open Doctor in Diagnostics', tab: 'diagnostics' as const },
] as const

export const SLASH_COMMAND_ALIASES = [
  { name: 'plugins', target: 'plugin' },
] as const

export const FALLBACK_SLASH_COMMANDS = [
  ...PANEL_SLASH_COMMANDS,
  ...SETTINGS_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'review', description: 'Review code changes' },
  { name: 'commit', description: 'Create a git commit' },
  { name: 'pr', description: 'Create a pull request' },
  { name: 'init', description: 'Initialize project CLAUDE.md' },
  { name: 'bug', description: 'Report a bug' },
  { name: 'config', description: 'Open configuration' },
  { name: 'login', description: 'Switch Anthropic accounts' },
  { name: 'logout', description: 'Sign out of current account' },
  { name: 'model', description: 'Switch AI model' },
  { name: 'permissions', description: 'View or manage tool permissions' },
  { name: 'terminal-setup', description: 'Set up terminal integration' },
  { name: 'vim', description: 'Toggle vim editing mode' },
]

export type SlashCommandOption = {
  name: string
  description: string
  argumentHint?: string
}

export type SlashUiAction =
  | {
      type: 'panel'
      command: typeof PANEL_SLASH_COMMANDS[number]['name']
    }
  | {
      type: 'settings'
      tab: SettingsTab
    }

export function resolveSlashUiAction(value: string): SlashUiAction | null {
  const normalizedValue = SLASH_COMMAND_ALIASES.find((alias) => alias.name === value)?.target ?? value
  const panelCommand = PANEL_SLASH_COMMANDS.find((command) => command.name === normalizedValue)
  if (panelCommand) {
    return { type: 'panel', command: panelCommand.name }
  }

  const settingsCommand = SETTINGS_SLASH_COMMANDS.find((command) => command.name === normalizedValue)
  if (settingsCommand) {
    return { type: 'settings', tab: settingsCommand.tab }
  }

  return null
}

export function mergeSlashCommands(
  preferred: ReadonlyArray<SlashCommandOption>,
  fallback: ReadonlyArray<SlashCommandOption> = FALLBACK_SLASH_COMMANDS,
): SlashCommandOption[] {
  const merged = new Map<string, SlashCommandOption>()

  for (const command of preferred) {
    if (!command?.name) continue
    merged.set(command.name, {
      name: command.name,
      description: command.description?.trim() || '',
      ...(command.argumentHint?.trim() && { argumentHint: command.argumentHint.trim() }),
    })
  }

  for (const command of fallback) {
    if (!command?.name) continue
    const existing = merged.get(command.name)
    if (existing) {
      if ((!existing.description && command.description) || (!existing.argumentHint && command.argumentHint)) {
        merged.set(command.name, {
          ...existing,
          description: existing.description || command.description,
          argumentHint: existing.argumentHint || command.argumentHint,
        })
      }
      continue
    }
    merged.set(command.name, command)
  }

  return [...merged.values()]
}

function getSlashCommandMatchRank(command: SlashCommandOption, filter: string): number {
  const name = command.name.toLowerCase()
  const description = command.description.toLowerCase()
  const argumentHint = command.argumentHint?.toLowerCase() ?? ''
  const nameParts = name.split(/[:/._-]+/).filter(Boolean)

  if (name === filter) return 0
  if (name.startsWith(filter)) return 1
  if (nameParts.some((part) => part.startsWith(filter))) return 2
  if (name.includes(filter)) return 3
  if (description.includes(filter)) return 4
  if (argumentHint.includes(filter)) return 5
  return Number.POSITIVE_INFINITY
}

export function filterSlashCommands(
  commands: ReadonlyArray<SlashCommandOption>,
  filter: string,
): SlashCommandOption[] {
  const normalized = filter.toLowerCase()
  if (!normalized.trim()) return [...commands]

  return commands
    .map((command, index) => ({
      command,
      index,
      rank: getSlashCommandMatchRank(command, normalized),
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.command)
}

export type SlashTrigger = {
  slashPos: number
  filter: string
}

export function findSlashTrigger(value: string, cursorPos: number): SlashTrigger | null {
  const textBeforeCursor = value.slice(0, cursorPos)
  const slashPos = textBeforeCursor.lastIndexOf('/')
  if (slashPos < 0) return null
  if (slashPos > 0 && !/\s/.test(textBeforeCursor[slashPos - 1]!)) return null

  const filter = textBeforeCursor.slice(slashPos + 1)
  if (filter.includes('\n')) return null
  if (/\s/.test(filter)) return null

  return { slashPos, filter }
}

export function replaceSlashToken(
  input: string,
  cursorPos: number,
  command: string,
  options?: { trailingSpace?: boolean },
): { value: string; cursorPos: number } {
  const trigger = findSlashTrigger(input, cursorPos)
  if (!trigger) {
    const prefix = input && !/\s$/.test(input) ? `${input} ` : input
    const token = `/${command}`
    const suffix = options?.trailingSpace !== false ? ' ' : ''
    const value = `${prefix}${token}${suffix}`
    return { value, cursorPos: value.length }
  }

  const before = input.slice(0, trigger.slashPos)
  const after = input.slice(cursorPos)
  const token = `/${command}`
  const suffix = options?.trailingSpace !== false ? ' ' : ''
  const value = `${before}${token}${suffix}${after}`
  const nextCursorPos = before.length + token.length + suffix.length
  return { value, cursorPos: nextCursorPos }
}

export type SlashToken = {
  start: number
  filter: string
}

export function findSlashToken(value: string, cursorPos: number): SlashToken | null {
  const trigger = findSlashTrigger(value, cursorPos)
  if (!trigger) return null
  return { start: trigger.slashPos, filter: trigger.filter }
}

export function replaceSlashCommand(
  value: string,
  cursorPos: number,
  command: string,
): { value: string; cursorPos: number } | null {
  const trigger = findSlashTrigger(value, cursorPos)
  if (!trigger) return null

  return replaceSlashToken(value, cursorPos, command, { trailingSpace: true })
}

export function insertSlashTrigger(
  value: string,
  cursorPos: number,
): { value: string; cursorPos: number } {
  const before = value.slice(0, cursorPos)
  const after = value.slice(cursorPos)
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const token = `${needsLeadingSpace ? ' ' : ''}/`
  return {
    value: `${before}${token}${after}`,
    cursorPos: before.length + token.length,
  }
}
