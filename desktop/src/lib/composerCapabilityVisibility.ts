import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { SlashCommandOption } from '@/types/slashCommand'

// These managed packages were withdrawn from the skill market. Keep them out
// of composer discovery too, without disabling installed packages or hiding
// independently installed personal/project skills with the same short name.
const withdrawnPluginNames = new Set([
  'office-frontend-design',
  'office-canvas-design',
  'office-algorithmic-art',
  'office-webapp-testing',
  'office-mcp-builder',
])

export function isComposerPluginVisible(pluginId: string): boolean {
  const [name, marketplace, ...rest] = pluginId.split('@')
  return marketplace !== 'haha-connectors' || rest.length > 0 || !withdrawnPluginNames.has(name!)
}

export function isComposerReferenceVisible(reference: ComposerReferenceCandidate): boolean {
  return isComposerPluginVisible(reference.kind === 'plugin' ? reference.id : reference.source)
}

export function isComposerSlashCommandVisible(command: SlashCommandOption): boolean {
  if (command.source === 'user' || command.source === 'project' || command.kind === 'agent') return true
  if (!isComposerPluginVisible(command.name)) return false
  // CLI slash snapshots carry the plugin namespace, but not its marketplace ID.
  // Match the exact managed namespace, never an unqualified skill name.
  const separator = command.name.indexOf(':')
  return separator < 0 || !withdrawnPluginNames.has(command.name.slice(0, separator))
}
