import {
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
  { id: null, authId: 'claude-official', name: 'Claude 官方' },
  { id: 'openai-official', authId: 'openai-official', name: 'ChatGPT 官方' },
  { id: 'grok-official', authId: 'grok-official', name: 'Grok 官方' },
  { id: 'deepseek-account', authId: 'deepseek-account', name: 'DeepSeek 账号' },
] as const
export function runtimeSourceName(
  id: string | null,
  providers: { id: string; name: string }[]
) {
  return (
    providers.find((provider) => provider.id === id)?.name ??
    OFFICIAL_RUNTIME_SOURCES.find((source) => source.id === id)?.name ??
    '电脑默认来源'
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
  if (tier) return `${tier[1]}${tier[2]!.toUpperCase()} 上下文`
  if (/^\d+$/.test(raw)) {
    const tokens = Number(raw)
    if (!tokens) return undefined
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M 上下文`
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K 上下文`
    return `${tokens} 上下文`
  }
  return `${raw} 上下文`
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
export function effortUnavailableReason(choice: {
  source?: { auth: RuntimeSource['auth'] }
  model?: unknown
  catalogReady: boolean
  canSetEffort: boolean
}): string {
  return choice.source?.auth === 'missing'
    ? '请先在电脑上登录或配置此供应商，再重新读取。'
    : choice.source?.auth === 'error'
      ? '尚未确认此供应商的授权状态，请重新读取。'
      : !choice.source
        ? '当前供应商已不可用，请重新选择模型。'
        : !choice.model && choice.catalogReady
          ? '当前模型已不在供应商列表中，请重新选择模型。'
          : !choice.canSetEffort
            ? '此账号的新任务沿用电脑默认强度，可在会话中调整。'
            : '当前模型没有可调的思考强度。'
}
