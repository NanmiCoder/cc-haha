import { isAgentProfileCommandSupported } from '../utils/agentProfile.js'
import type { Command } from '../types/command.js'

export function supportsHeadlessSlashCommand(command: Command): boolean {
  if (command.type === 'prompt') return command.disableNonInteractive !== true
  if (command.type === 'local') return command.supportsNonInteractive
  return command.supportsNonInteractive === true
}

export function filterCommandsForHeadlessMode(commands: Command[]): Command[] {
  return commands.filter(command => supportsHeadlessSlashCommand(command) && isAgentProfileCommandSupported(command))
}

/** True when only the agent profile keeps a command out of the headless command list. */
export function isHeadlessCommandHiddenByAgentProfile(command: Command): boolean {
  return supportsHeadlessSlashCommand(command) && !isAgentProfileCommandSupported(command)
}
