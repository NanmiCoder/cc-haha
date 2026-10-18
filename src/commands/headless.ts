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
