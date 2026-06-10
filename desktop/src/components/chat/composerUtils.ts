import type { SettingsTab } from '../../stores/uiStore'
import type { TranslationKey } from '../../i18n'

/** Map from slash command name to its i18n description key */
const SLASH_CMD_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
  agent: 'slashCmd.agent.description',
  mcp: 'slashCmd.mcp.description',
  skills: 'slashCmd.skills.description',
  help: 'slashCmd.help.description',
  status: 'slashCmd.status.description',
  cost: 'slashCmd.cost.description',
  context: 'slashCmd.context.description',
  plugin: 'slashCmd.plugin.description',
  memory: 'slashCmd.memory.description',
  doctor: 'slashCmd.doctor.description',
  compact: 'slashCmd.compact.description',
  clear: 'slashCmd.clear.description',
  goal: 'slashCmd.goal.description',
  review: 'slashCmd.review.description',
  commit: 'slashCmd.commit.description',
  pr: 'slashCmd.pr.description',
  init: 'slashCmd.init.description',
  bug: 'slashCmd.bug.description',
  config: 'slashCmd.config.description',
  login: 'slashCmd.login.description',
  logout: 'slashCmd.logout.description',
  model: 'slashCmd.model.description',
  permissions: 'slashCmd.permissions.description',
  'terminal-setup': 'slashCmd.terminal-setup.description',
  vim: 'slashCmd.vim.description',
}

/** Names of commands the desktop owns the description for (i.e. localized in our locales). */
const BUILT_IN_COMMAND_NAMES = new Set(Object.keys(SLASH_CMD_DESCRIPTION_KEYS))

export const PANEL_SLASH_COMMANDS = [
  { name: 'mcp' },
  { name: 'skills' },
  { name: 'help' },
  { name: 'status' },
  { name: 'cost' },
  { name: 'context' },
] as const

export const SETTINGS_SLASH_COMMANDS = [
  { name: 'config', tab: 'general' as const },
  { name: 'plugin', tab: 'plugins' as const },
  { name: 'memory', tab: 'memory' as const },
  { name: 'doctor', tab: 'diagnostics' as const },
] as const

export const SLASH_COMMAND_ALIASES = [
  { name: 'plugins', target: 'plugin' },
  { name: 'settings', target: 'config' },
] as const

/** Static fallback with English descriptions (for non-React contexts) */
export const FALLBACK_SLASH_COMMANDS: SlashCommandOption[] = [
  { name: 'agent', description: 'Run a prompt with a selected Agent', argumentHint: '<agent> <prompt>' },
  { name: 'mcp', description: 'Open available MCP tools for the current chat context' },
  { name: 'skills', description: 'Browse user-invocable skills for the current chat context' },
  { name: 'help', description: 'Show available desktop and agent commands' },
  { name: 'status', description: 'Show session status, usage, and context' },
  { name: 'cost', description: 'Show session usage and costs' },
  { name: 'context', description: 'Show current context usage' },
  { name: 'plugin', description: 'Open desktop plugin controls in Settings' },
  { name: 'memory', description: 'Open project memory files in Settings' },
  { name: 'doctor', description: 'Open Doctor in Diagnostics' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'goal', description: 'Set a completion goal', argumentHint: '[<condition> | clear]' },
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

/** Build localized fallback commands using the current locale.
 *
 * Resolution order for each command's description:
 *   1. Localized string from the i18n table (zh -> en) when a key is registered.
 *   2. The static English description shipped in FALLBACK_SLASH_COMMANDS.
 *
 * This guarantees we never render a raw key (e.g. "slashCmd.foo.description")
 * in the UI even if a command is missing from SLASH_CMD_DESCRIPTION_KEYS or
 * its translation entry is absent.
 */
export function getLocalizedFallbackCommands(t: (key: TranslationKey) => string): SlashCommandOption[] {
  return FALLBACK_SLASH_COMMANDS.map((cmd) => {
    const key = SLASH_CMD_DESCRIPTION_KEYS[cmd.name]
    let description = cmd.description
    if (key) {
      const translated = t(key)
      // i18n returns the key itself when no translation is found; fall back to
      // the static English description in that case.
      if (translated && translated !== key) {
        description = translated
      }
    }
    return {
      name: cmd.name,
      description,
      ...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
    }
  })
}

export type SlashCommandOption = {
  name: string
  description: string
  argumentHint?: string
}

export type AgentSlashCommandSource = {
  agentType: string
  description?: string
  modelDisplay?: string
  source?: string
}

export function buildAgentSlashCommands(
  agents: ReadonlyArray<AgentSlashCommandSource>,
): SlashCommandOption[] {
  const seen = new Set<string>()
  const commands: SlashCommandOption[] = []

  for (const agent of agents) {
    const agentType = agent.agentType.trim()
    if (!agentType || seen.has(agentType)) continue
    seen.add(agentType)

    const details = [agent.modelDisplay, agent.source].filter(Boolean).join(' - ')
    const description = [
      agent.description?.trim() || `Run with the ${agentType} Agent`,
      details ? `(${details})` : '',
    ].filter(Boolean).join(' ')

    commands.push({
      name: `agent ${agentType}`,
      description,
      argumentHint: '<prompt>',
    })
  }

  return commands
}

export function appendAgentSlashCommands(
  commands: ReadonlyArray<SlashCommandOption>,
  agentCommands: ReadonlyArray<SlashCommandOption>,
): SlashCommandOption[] {
  const names = new Set(commands.map((command) => command.name))
  return [
    ...commands,
    ...agentCommands.filter((command) => !names.has(command.name)),
  ]
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
  const fallbackByName = new Map<string, SlashCommandOption>()
  for (const command of fallback) {
    if (command?.name) fallbackByName.set(command.name, command)
  }

  const merged = new Map<string, SlashCommandOption>()

  for (const command of preferred) {
    if (!command?.name) continue
    const localized = fallbackByName.get(command.name)
    // For commands the desktop owns the copy for, prefer the localized fallback
    // description so users see translated text instead of the CLI's English.
    const useLocalDescription =
      BUILT_IN_COMMAND_NAMES.has(command.name) && Boolean(localized?.description)
    const description = useLocalDescription
      ? localized!.description
      : command.description?.trim() || localized?.description || ''
    const argumentHint = command.argumentHint?.trim() || localized?.argumentHint
    merged.set(command.name, {
      name: command.name,
      description,
      ...(argumentHint && { argumentHint }),
    })
  }

  for (const command of fallback) {
    if (!command?.name) continue
    if (merged.has(command.name)) continue
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
