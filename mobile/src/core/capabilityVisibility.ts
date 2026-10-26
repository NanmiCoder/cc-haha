import type { ComposerReference } from './composerReferences'
import type { SkillCommand } from './chatComposer'

/**
 * 已经从技能市场下架的托管包：桌面输入框的技能、`@` 和斜杠命令里都不出现它们
 * （`desktop/src/lib/composerCapabilityVisibility.ts`），手机端保持一致。
 * 只隐藏这些托管包本身，不影响用户自己装的同名技能。
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

/** 插件的 id 就是 `name@marketplace`；技能的 source 是它所属插件的 id（或 userSettings 这类来源）。 */
export function isReferenceVisible(reference: Pick<ComposerReference, 'kind' | 'id'> & { source?: string }): boolean {
  return isPluginIdVisible(reference.kind === 'plugin' ? reference.id : (reference.source ?? ''))
}

export function isCommandVisible(command: Pick<SkillCommand, 'name' | 'kind'> & { source?: string }): boolean {
  if (command.source === 'user' || command.source === 'project' || command.kind === 'agent') return true
  if (!isPluginIdVisible(command.name)) return false
  // CLI 的斜杠命令带的是插件命名空间，不带市场 id：只按精确的托管命名空间匹配，不按不带前缀的技能名。
  const separator = command.name.indexOf(':')
  return separator < 0 || !withdrawnPluginNames.has(command.name.slice(0, separator))
}
