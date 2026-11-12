import {
  MODEL_REASONING_EFFORTS,
  getModelReasoningCapabilityOverride,
  resolveModelReasoningProfile,
  type ModelReasoningApiFormat,
  type ModelReasoningProviderKind,
} from '../../../src/shared/modelReasoning'
import type { ApiClient } from './client'
import type { RuntimeConfig } from './types'

export type Provider = {
  id: string
  name: string
  presetId: string
  apiFormat: string
  baseUrl: string
  hasApiKey?: boolean
  models: Record<string, string>
  model1mSupport?: Record<string, boolean>
}
export type Model = {
  id: string
  name: string
  description?: string
  context?: string
  supportedReasoningEfforts?: string[]
  defaultReasoningEffort?: string
}
export type ProviderPreset = {
  id: string
  defaultEnv?: Record<string, string>
  reasoningProviderKind?: ModelReasoningProviderKind
}
export type RuntimeSource = {
  id: string | null
  name: string
  auth: 'ready' | 'missing' | 'error'
  builtin: boolean
}
export type RuntimeDirectory = {
  providers: Provider[]
  presets: ProviderPreset[]
  activeId: string | null
  defaults: { models: Model[]; provider: { id: string; name: string } | null }
  sources: RuntimeSource[]
}

// These are protocol identities, not saved provider rows. null explicitly means Claude.
export const OFFICIAL_RUNTIME_SOURCES = [
  { id: null, authId: 'claude-official', name: 'Claude Official' },
  { id: 'openai-official', authId: 'openai-official', name: 'ChatGPT Official' },
  { id: 'grok-official', authId: 'grok-official', name: 'Grok Official' },
  { id: 'deepseek-account', authId: 'deepseek-account', name: 'DeepSeek Account' },
] as const
export function runtimeSourceName(
  id: string | null,
  providers: { id: string; name: string }[]
) {
  return (
    providers.find((provider) => provider.id === id)?.name ??
    OFFICIAL_RUNTIME_SOURCES.find((source) => source.id === id)?.name ??
    'Computer default source'
  )
}
export const runtimeProviderIdentity = (id: string | null) =>
  id === 'claude-official' ? null : id

export async function loadRuntimeDirectory(
  client: ApiClient,
  signal: AbortSignal
): Promise<RuntimeDirectory> {
  const [saved, defaults, presets, official] = await Promise.all([
    client.get<{ providers: Provider[]; activeId: string | null }>(
      '/api/providers',
      { signal }
    ),
    client.get<RuntimeDirectory['defaults']>('/api/models', { signal }),
    client.get<{ presets: ProviderPreset[] }>('/api/providers/presets', {
      signal,
    }),
    Promise.all(
      OFFICIAL_RUNTIME_SOURCES.map(async (source) => {
        let auth: RuntimeSource['auth']
        try {
          const status = await client.get<{ hasAuth: boolean }>(
            `/api/providers/auth-status?providerId=${source.authId}`,
            { signal }
          )
          auth = status.hasAuth ? 'ready' : 'missing'
        } catch {
          auth = 'error'
        }
        return { id: source.id, name: source.name, auth, builtin: true }
      })
    ),
  ])
  return {
    providers: saved.providers,
    presets: presets.presets,
    activeId: runtimeProviderIdentity(saved.activeId),
    defaults,
    sources: [
      ...official,
      ...saved.providers
        .filter(
          (provider) =>
            !official.some(
              (source) => source.id === runtimeProviderIdentity(provider.id)
            )
        )
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          auth: 'ready' as const,
          builtin: false,
        })),
    ],
  }
}

const SLOTS = ['main', 'fable', 'haiku', 'sonnet', 'opus'] as const

/** Same preset capability resolver and context suffix semantics as the desktop model selector. */
export function savedProviderModels(
  provider: Provider,
  presets: ProviderPreset[]
): Model[] {
  const preset = presets.find((value) => value.id === provider.presetId)
  const mapping = Object.fromEntries(
    SLOTS.map((slot) => {
      const raw = provider.models[slot]?.trim() ?? ''
      const enabled = provider.model1mSupport?.[slot]
      return [
        slot,
        !raw || enabled === undefined
          ? raw
          : raw.replace(/(?:\[1m\]|:1m)$/i, '').trim() +
            (enabled ? '[1m]' : ''),
      ]
    })
  )
  const apiFormat = ['anthropic', 'openai_chat', 'openai_responses'].includes(
    provider.apiFormat
  )
    ? (provider.apiFormat as ModelReasoningApiFormat)
    : undefined
  return [...new Set(Object.values(mapping).filter(Boolean))].map((id) => {
    const profile = resolveModelReasoningProfile(
      id,
      apiFormat,
      getModelReasoningCapabilityOverride(
        id,
        mapping,
        preset?.defaultEnv ?? {}
      ),
      preset?.reasoningProviderKind
    )
    return {
      id,
      name: id,
      description: SLOTS.filter((slot) => mapping[slot] === id).join(' · '),
      supportedReasoningEfforts: [
        ...(profile?.supportedReasoningEfforts ?? []),
      ],
      ...(profile?.defaultReasoningEffort
        ? { defaultReasoningEffort: profile.defaultReasoningEffort }
        : {}),
    }
  })
}

export async function loadRuntimeModels(
  client: ApiClient,
  directory: RuntimeDirectory,
  providerId: string | null,
  signal: AbortSignal
): Promise<Model[]> {
  const source = directory.sources.find((value) => value.id === providerId)
  if (!source || source.auth !== 'ready') return []
  if (
    providerId ===
    runtimeProviderIdentity(directory.defaults.provider?.id ?? null)
  )
    return directory.defaults.models
  const saved = directory.providers.find((value) => value.id === providerId)
  if (saved) return savedProviderModels(saved, directory.presets)
  // The real endpoint rejects saved-provider IDs. Never temporarily activate one to inspect it.
  return (
    await client.get<{ models: Model[] }>(
      `/api/models/catalog?provider=${encodeURIComponent(providerId ?? 'claude-official')}`,
      { signal }
    )
  ).models
}

/** OpenAI/Grok startup chooses its account catalog default, ignoring the global /api/effort value. */
export function canSetRuntimeEffort(
  providerId: string | null,
  defaultScope: boolean
): boolean {
  return (
    !defaultScope ||
    !['openai-official', 'grok-official'].includes(providerId ?? '')
  )
}

export function runtimeSelection(
  providerId: string | null,
  model: Model,
  effort: string | undefined,
  defaultScope: boolean
): RuntimeConfig {
  return {
    providerId,
    modelId: model.id,
    ...(canSetRuntimeEffort(providerId, defaultScope) &&
    effort &&
    model.supportedReasoningEfforts?.includes(effort)
      ? { effortLevel: effort }
      : {}),
  }
}

/** Desktop catalogs report context as a tier ("200k", "1m") or a raw token count. */
export function contextLabel(context?: string): string | undefined {
  const raw = context?.trim()
  if (!raw || raw.toLowerCase() === 'unknown') return undefined
  const tier = raw.match(/^(\d+(?:\.\d+)?)\s*([km])$/i)
  if (tier) return `${tier[1]}${tier[2]!.toUpperCase()} context`
  if (/^\d+$/.test(raw)) {
    const tokens = Number(raw)
    if (!tokens) return undefined
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K context`
    return `${tokens} context`
  }
  return `${raw} context`
}

/** Second line of a model row: description · context, omitting whatever the computer did not report. */
export function modelDetail(model: Pick<Model, 'description' | 'context'>) {
  return [model.description?.trim(), contextLabel(model.context)]
    .filter(Boolean)
    .join(' · ')
}

/** A model change preserves compatible composer effort and same-account fast mode. */
export function runtimeModelSelection(
  providerId: string | null,
  model: Model,
  previous: RuntimeConfig | undefined,
  defaultScope = false,
): RuntimeConfig {
  const supported = model.supportedReasoningEfforts ?? []
  const effort = previous?.effortLevel && supported.includes(previous.effortLevel)
    ? previous.effortLevel
    : model.defaultReasoningEffort
  return {
    ...runtimeSelection(providerId, model, effort, defaultScope),
    ...(providerId === 'openai-official' && previous?.providerId === providerId && previous.openAIFastMode !== undefined
      ? { openAIFastMode: previous.openAIFastMode }
      : {}),
  }
}

/** Why the effort control has nothing to offer, in the words shown beside it. */
/** Strip the 1M context suffix: `x[1m]` and `x` are the same model with the same thinking effort. */
const contextBase = (id: string) => id.replace(/(?:\[1m\]|:1m)$/i, '').trim()
/** Generic tiers when the current model is not in the list, same as desktop: remove "Max", which few models support; the computer validates. */
const FALLBACK_EFFORTS: readonly string[] = MODEL_REASONING_EFFORTS.filter((value) => value !== 'xhigh')

/**
 * Adjustable thinking efforts of the current model, same as the desktop model picker: look up by id, then ignoring the 1M context suffix; 
 * no error if the model is not in the list, use generic tiers. Empty only when the model explicitly declares no adjustable effort.
 */
export function currentModelEfforts(
  models: readonly Model[],
  modelId: string
): { efforts: string[]; defaultEffort?: string } {
  const model =
    models.find((value) => value.id === modelId) ??
    models.find((value) => contextBase(value.id) === contextBase(modelId))
  return {
    efforts: [...(model?.supportedReasoningEfforts ?? FALLBACK_EFFORTS)],
    ...(model?.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  }
}

/** Reason thinking effort cannot be adjusted; a model missing from the list does not count (see currentModelEfforts). */
export function effortUnavailableReason(choice: {
  source?: { auth: RuntimeSource['auth'] }
  canSetEffort: boolean
}): string {
  return choice.source?.auth === 'missing'
    ? 'Sign in or configure this provider on the computer first, then reload.'
    : choice.source?.auth === 'error'
      ? 'Authorization status of this provider is not confirmed yet; please reload.'
      : !choice.source
        ? 'The current provider is no longer available; please choose the model again.'
        : !choice.canSetEffort
          ? 'New tasks for this account use the computer default effort; adjustable in the session.'
          : 'The current model has no adjustable thinking effort.'
}
