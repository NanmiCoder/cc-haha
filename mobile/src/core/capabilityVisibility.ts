import type { ComposerReference } from './composerReferences'
import type { SkillCommand } from './chatComposer'

/**
 * Managed packages delisted from the skill marketplace: they do not appear in desktop input skills, `@` or slash commands
 * (`desktop/src/lib/composerCapabilityVisibility.ts`), and mobile stays consistent.
 * Only these managed packages are hidden; user-installed skills with the same name are unaffected.
 */
const withdrawnPluginNames = new Set([
  'office-frontend-design',
  'office-canvas-design',
  'office-algorithmic-art',
  'office-webapp-testing',
  'office-mcp-builder',
])

export function isPluginIdVisible(pluginId: string): boolean {
  const [name, marketplace, ...rest] = pluginId.split('@')
  return marketplace !== 'haha-connectors' || rest.length > 0 || !withdrawnPluginNames.has(name ?? '')
}

/** A plugin id is `name@marketplace`; a skill source is the id of its plugin (or a source like userSettings). */
export function isReferenceVisible(reference: Pick<ComposerReference, 'kind' | 'id'> & { source?: string }): boolean {
  return isPluginIdVisible(reference.kind === 'plugin' ? reference.id : (reference.source ?? ''))
}

export function isCommandVisible(command: Pick<SkillCommand, 'name' | 'kind'> & { source?: string }): boolean {
  if (command.source === 'user' || command.source === 'project' || command.kind === 'agent') return true
  if (!isPluginIdVisible(command.name)) return false
  // CLI slash commands carry the plugin namespace without the marketplace id: match only the exact managed namespace, not bare skill names.
  const separator = command.name.indexOf(':')
  return separator < 0 || !withdrawnPluginNames.has(command.name.slice(0, separator))
}
