import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamPlanRuntime } from '../../shared/teamPlan.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

type PresetSnapshot = { model?: string; provider?: string; effortLevel?: string }

const MODEL_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable'])

type SavedProviderModels = {
  models: Record<string, unknown>
  model1mSupport: Record<string, unknown>
}

// Parsed directly so team-plan code stays free of the server's provider
// modules; only saved API providers can be a member's runtime here.
function readSavedProviderModels(providerId: string): SavedProviderModels | undefined {
  try {
    const index = JSON.parse(readFileSync(join(getClaudeConfigHomeDir(), 'cc-haha', 'providers.json'), 'utf8')) as { providers?: unknown }
    if (!Array.isArray(index.providers)) return undefined
    const provider = index.providers.find(entry =>
      !!entry && typeof entry === 'object' &&
      (entry as { id?: unknown }).id === providerId &&
      ((entry as { runtimeKind?: unknown }).runtimeKind ?? 'anthropic_compatible') === 'anthropic_compatible') as
      { models?: unknown; model1mSupport?: unknown } | undefined
    if (!provider?.models || typeof provider.models !== 'object') return undefined
    return {
      models: provider.models as Record<string, unknown>,
      model1mSupport: provider.model1mSupport && typeof provider.model1mSupport === 'object'
        ? provider.model1mSupport as Record<string, unknown>
        : {},
    }
  } catch {
    return undefined
  }
}

/**
 * An Agent preset that pins a saved provider suggests that provider, its model
 * and its effort for the member, instead of the leader's provider.
 */
export function resolvePresetProviderRuntime(snapshot: PresetSnapshot | undefined): TeamPlanRuntime | undefined {
  if (!snapshot?.provider) return undefined
  const saved = readSavedProviderModels(snapshot.provider)
  if (!saved) return undefined
  // Same mapping as the provider's runtime env (applyModel1mSupport).
  const slot = (name: string) => {
    const value = saved.models[name]
    if (typeof value !== 'string' || !value.trim()) return undefined
    return saved.model1mSupport[name] === true
      ? `${value.trim().replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()}[1m]`
      : value.trim()
  }
  const spec = snapshot.model?.trim()
  const alias = spec?.toLowerCase()
  const modelId = !spec || alias === 'inherit'
    ? slot('main')
    : alias && MODEL_ALIASES.has(alias)
      ? slot(alias) ?? (alias === 'fable' ? slot('opus') : undefined) ?? slot('main')
      : spec
  if (!modelId) return undefined
  return {
    providerId: snapshot.provider,
    modelId,
    ...(snapshot.effortLevel !== undefined ? { effortLevel: snapshot.effortLevel } : {}),
  }
}
