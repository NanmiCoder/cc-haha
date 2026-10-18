import type { SlashCommandOption } from '@/types/slashCommand'

// The runtime enforces the capability boundary and decides what a lean session
// may run. A lean session's own command list has already passed that rule: the
// server filters it (`listSkillSlashCommands` with `agentProfile: 'lean'`, where
// `.claude/commands/*.md` arrive as sourceless `kind: 'command'` rows) and so
// does the CLI (`filterCommandsForHeadlessMode`). A name that list offers is
// available. The desktop judges only the rows it adds itself — its built-in
// fallback table and the agent shortcuts.

/**
 * The runtime's local commands that lean keeps (`leanLocalCommands` in
 * src/utils/agentProfile.ts), for the built-ins the desktop lists on its own.
 * src/server/__tests__/skills.test.ts fails when the two tables differ.
 */
export const LEAN_LOCAL_COMMAND_NAMES: ReadonlySet<string> = new Set(['clear', 'compact', 'cost', 'context', 'help', 'model', 'permissions', 'status'])

/** Capabilities lean omits; typed without any list entry, say so instead of sending. */
const LEAN_UNAVAILABLE_INPUT_NAMES = new Set(['btw', 'agent', 'team', 'plan', 'workflow'])

const NO_LISTED_COMMANDS: ReadonlySet<string> = new Set()

/**
 * @param listed Names in the lean session's own command list. Rows outside it
 *   are taken to be the desktop's own, so leave it empty only when every
 *   server-provided row is a skill.
 */
export function isLeanSlashCommand(command: SlashCommandOption, listed: ReadonlySet<string> = NO_LISTED_COMMANDS): boolean {
  // A skill the server marked incompatible (it forks a subagent) is refused by the runtime.
  if (command.kind === 'skill') return command.leanCompatible !== false
  // Agent shortcuts reach the Agent tool, which lean omits.
  if (command.kind && command.kind !== 'command') return false
  return listed.has(command.name) || (!command.source && LEAN_LOCAL_COMMAND_NAMES.has(command.name))
}

/** Paths remain ordinary input; unknown command-like names are left to runtime validation. */
export function isUnsupportedLeanSlashInput(
  text: string,
  commands: SlashCommandOption[],
  listed: ReadonlySet<string> = NO_LISTED_COMMANDS,
): boolean {
  const name = /^\/([a-zA-Z0-9:_-]+)(?:\s|$)/.exec(text)?.[1]
  if (!name || listed.has(name)) return false
  const command = commands.find(command => command.name === name)
  return command ? !isLeanSlashCommand(command, listed) : LEAN_UNAVAILABLE_INPUT_NAMES.has(name)
}
