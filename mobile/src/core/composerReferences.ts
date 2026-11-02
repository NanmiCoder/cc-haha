import type { ApiClient } from './client'
import type { RuntimeConfig } from './types'
import type { SkillCommand } from './chatComposer'
import { isCommandVisible, isReferenceVisible } from './capabilityVisibility'

export type ComposerReference = {
  kind: 'skill' | 'plugin'
  id: string
  name: string
  displayName: string
  description: string
  modelText: string
  /** 插件自带的 MCP 服务：有它的插件对用户来说是「连接器」。 */
  mcpServerNames?: string[]
  /** 技能所属的插件 id 或来源（电脑给什么就是什么）。 */
  source?: string
}
export type ComposerCandidate = SkillCommand & { reference?: ComposerReference }
export type ComposerTrigger = { start: number; end: number; kind: '/' | '@'; query: string }

/** A trigger must begin a token: emails, file paths and selected ranges stay literal. */
export function composerTrigger(text: string, start: number, end = start): ComposerTrigger | null {
  if (start !== end || start < 0 || start > text.length) return null
  const match = text.slice(0, start).match(/(?:^|\s)([/@])([^\s/@]*)$/)
  if (!match) return null
  return { start: start - match[2].length - 1, end: start, kind: match[1] as '/' | '@', query: match[2] }
}

/** `/` 列出命令和技能，`@` 只列出能引用的技能；关键词匹配名称、说明和显示名。 */
export function filterComposerCandidates(candidates: ComposerCandidate[], trigger: ComposerTrigger | null): ComposerCandidate[] {
  if (!trigger) return []
  const query = trigger.query.toLocaleLowerCase()
  return candidates.filter((candidate) =>
    (trigger.kind !== '@' || !!candidate.reference) &&
    (!query || `${candidate.name} ${candidate.description} ${candidate.reference?.displayName ?? ''}`.toLocaleLowerCase().includes(query))
  )
}

/** 候选行右侧的类型标签。 */
export function candidateTypeLabel(candidate: ComposerCandidate): string {
  if (candidate.reference) return candidate.reference.kind === 'plugin' ? '插件' : '技能'
  return candidate.kind === 'skill' ? '技能' : candidate.kind === 'agent' ? 'Agent' : candidate.kind === 'plugin' ? '插件' : '命令'
}

export function insertComposerCandidate(text: string, trigger: ComposerTrigger | null, candidate: ComposerCandidate) {
  const start = trigger?.start ?? text.length
  const end = trigger?.end ?? text.length
  // References are separate, removable chips, never a fake rich-text span.
  const insertion = candidate.reference ? '' : `/${candidate.name.replace(/^\//, '')} `
  const prefix = !trigger && text && insertion && !/\s$/.test(text) ? ' ' : ''
  return { text: text.slice(0, start) + prefix + insertion + text.slice(end), cursor: start + prefix.length + insertion.length }
}

export function mergeComposerReferences(...groups: (ComposerReference[] | undefined)[]) {
  const seen = new Set<string>()
  return groups.flatMap((group) => group ?? []).filter((reference) => {
    const key = `${reference.kind}:${reference.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Only an explicitly selected server candidate becomes model instructions. */
export function serializeComposer(text: string, references: ComposerReference[] = []) {
  return [...mergeComposerReferences(references).map((reference) => reference.modelText), text.trim()]
    .filter(Boolean).join('\n\n')
}

export async function loadComposerCandidates(client: ApiClient, context: {
  sessionId?: string; workDir?: string; runtime?: RuntimeConfig; lean: boolean
}, signal: AbortSignal): Promise<ComposerCandidate[]> {
  const query = new URLSearchParams()
  if (context.workDir) query.set('cwd', context.workDir)
  if (context.runtime) query.set('providerId', context.runtime.providerId ?? 'claude-official')
  if (context.lean) query.set('agentProfile', 'lean')
  const [references, commands] = await Promise.all([
    client.get<{ skills: ComposerReference[]; plugins: ComposerReference[] }>(`/api/skills/mentions?${query}`, { signal }),
    context.sessionId
      ? client.get<{ commands: SkillCommand[] }>(`/api/sessions/${encodeURIComponent(context.sessionId)}/slash-commands`, { signal })
      : client.get<{ commands: SkillCommand[] }>(`/api/skills/commands?${query}`, { signal }),
  ])
  const candidates: ComposerCandidate[] = [...references.skills, ...references.plugins].filter(isReferenceVisible).map((reference) => ({
    name: reference.name, description: reference.description, kind: reference.kind, reference,
  }))
  for (const command of commands.commands.filter(isCommandVisible)) {
    if (!candidates.some((candidate) => candidate.name === command.name)) candidates.push(command)
  }
  for (const command of [{ name: 'model', description: '选择这次任务的模型' }, { name: 'permissions', description: '选择权限模式' }]) {
    if (!candidates.some((candidate) => candidate.name === command.name)) candidates.push({ ...command, kind: 'command' })
  }
  return candidates
}
