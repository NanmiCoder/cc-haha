import type { SlashCommandOption } from '@/types/slashCommand'

// The runtime enforces the capability boundary; discovery only advertises
// commands that still have a meaningful result with the core coding tools.
const leanCommands = new Set(['clear', 'compact', 'cost', 'context', 'help', 'model', 'permissions', 'status'])
export function isLeanSlashCommand(command: SlashCommandOption): boolean {
  return command.kind === 'skill' || (!command.kind || command.kind === 'command') && !command.source && leanCommands.has(command.name)
}

/** Paths remain ordinary input; unknown command-like names are left to runtime validation. */
export function isUnsupportedLeanSlashInput(text: string, commands: SlashCommandOption[]): boolean {
  const name = /^\/([a-zA-Z0-9:_-]+)(?:\s|$)/.exec(text)?.[1]
  if (!name) return false
  const command = commands.find(command => command.name === name)
  return command ? !isLeanSlashCommand(command) : ['btw', 'agent', 'team', 'plan', 'workflow'].includes(name)
}
