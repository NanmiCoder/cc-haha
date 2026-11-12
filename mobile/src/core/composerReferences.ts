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
  /** MCP server bundled with a plugin: plugins that have one are "connectors" to the user. */
  mcpServerNames?: string[]
  /** Plugin id or source the skill belongs to (whatever the computer gives). */
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

/** `/` List commands and skills; `@` lists only referenceable skills; keywords match name, description and display name. */
export function filterComposerCandidates(candidates: ComposerCandidate[], trigger: ComposerTrigger | null): ComposerCandidate[] {
  if (!trigger) return []
  const query = trigger.query.toLocaleLowerCase()
  return candidates.filter((candidate) =>
    (trigger.kind !== '@' || !!candidate.reference) &&
    (!query || `${candidate.name} ${candidate.description} ${candidate.reference?.displayName ?? ''}`.toLocaleLowerCase().includes(query))
  )
}

/** Type label on the right of a suggestion row. */
export function candidateTypeLabel(candidate: ComposerCandidate): string {
  if (candidate.reference) return candidate.reference.kind === 'plugin' ? 'Plugin' : 'Skills'
  return candidate.kind === 'skill' ? 'Skills' : candidate.kind === 'agent' ? 'Agent' : candidate.kind === 'plugin' ? 'Plugin' : 'Commands'
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
  for (const command of [{ name: 'model', description: 'Choose the model for this task' }, { name: 'permissions', description: 'Choose permission mode' }]) {
    if (!candidates.some((candidate) => candidate.name === command.name)) candidates.push({ ...command, kind: 'command' })
  }
  return candidates
}
