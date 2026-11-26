import {
  MODEL_REASONING_EFFORTS,
  getModelReasoningCapabilityOverride,
  resolveModelReasoningProfile,
  type ModelReasoningApiFormat,
  type ModelReasoningProviderKind,
} from '../../../src/shared/modelReasoning'
import type { ApiClient } from './client'
import type { PermissionMode, RuntimeConfig } from './types'

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity-acp' as const
export const ANTIGRAVITY_DEFAULT_MODEL = 'agent-default' as const
export const ANTIGRAVITY_LOGIN_GUIDANCE =
  '请先在电脑终端运行 agy acp --login 完成登录，然后回到这里刷新。'
export const ANTIGRAVITY_PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
]

/** Antigravity 草稿态原生斜杠命令（与桌面端对齐，在会话返回实时列表前提供）。 */
export const ANTIGRAVITY_DRAFT_SLASH_COMMANDS: readonly {
  name: string
  description: string
}[] = [
  { name: 'swarm', description: '调度多个 Antigravity Agent 在共享任务板协作' },
  { name: 'plan', description: '先规划复杂任务，再执行修改' },
  { name: 'boost', description: '为当前任务启用更深入的推理分析' },
  { name: 'teamwork', description: '按角色拆分并协同处理复杂项目' },
  { name: 'goal', description: '持续执行长任务直到完全达成目标' },
  { name: 'grill-me', description: '通过问答访谈对齐方案与设计细节' },
  { name: 'compact', description: '压缩当前对话上下文' },
  { name: 'browser', description: '使用浏览器自动化工具' },
  { name: 'schedule', description: '创建一次性定时器或周期性计划任务' },
  { name: 'learn', description: '沉淀本次修正或配置以便后续复用' },
  { name: 'model', description: '切换 Antigravity 模型与思考强度' },
  { name: 'permissions', description: '选择权限模式' },
]

export type AntigravityConnectionStatus =
  | 'not_installed'
  | 'unchecked'
  | 'ready'
  | 'login_required'
  | 'error'

export type AntigravityModel = {
  id: string
  name: string
  supportedReasoningEfforts?: string[]
  defaultReasoningEffort?: string
}

export type AntigravityStatus = {
  id: typeof ANTIGRAVITY_PROVIDER_ID
  kind: 'acp'
  status: AntigravityConnectionStatus
  models: AntigravityModel[]
  currentModelId?: string
  currentEffortLevel?: string
  version?: string
  tier?: { id?: string; name?: string }
  error?: string
}

export const isAntigravityProvider = (id: string | null | undefined): boolean =>
  id === ANTIGRAVITY_PROVIDER_ID

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
  kind?: 'acp'
  runtimeStatus?: AntigravityConnectionStatus
}
export type RuntimeDirectory = {
  providers: Provider[]
  presets: ProviderPreset[]
  activeId: string | null
  defaults: { models: Model[]; provider: { id: string; name: string } | null }
  sources: RuntimeSource[]
  antigravity: AntigravityStatus | null
}

// These are protocol identities, not saved provider rows. null explicitly means Claude.
export const OFFICIAL_RUNTIME_SOURCES = [
  { id: null, authId: 'claude-official', name: 'Claude 官方' },
  { id: 'openai-official', authId: 'openai-official', name: 'ChatGPT 官方' },
  { id: 'grok-official', authId: 'grok-official', name: 'Grok 官方' },
  { id: 'deepseek-account', authId: 'deepseek-account', name: 'DeepSeek 账号' },
] as const

const ANTIGRAVITY_STATUSES = new Set<AntigravityConnectionStatus>([
  'not_installed',
  'unchecked',
  'ready',
  'login_required',
  'error',
])

export function parseAntigravityStatus(raw: unknown): AntigravityStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.status !== 'string' ||
    !ANTIGRAVITY_STATUSES.has(value.status as AntigravityConnectionStatus)
  )
    return null
  const models: AntigravityModel[] = Array.isArray(value.models)
    ? value.models.flatMap((entry): AntigravityModel[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return []
        const item = entry as Record<string, unknown>
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        if (!id) return []
        const name =
          typeof item.name === 'string' && item.name.trim()
            ? item.name.trim()
            : id
        const efforts = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts.filter(
              (effort): effort is string =>
                typeof effort === 'string' && effort.trim().length > 0
            )
          : undefined
        const defaultEffort =
          typeof item.defaultReasoningEffort === 'string' &&
          item.defaultReasoningEffort.trim()
            ? item.defaultReasoningEffort.trim()
            : undefined
        return [
          {
            id,
            name,
            ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
            ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
          },
        ]
      })
    : []
  const rawTier =
    value.tier && typeof value.tier === 'object' && !Array.isArray(value.tier)
      ? (value.tier as Record<string, unknown>)
      : null
  const tier =
    rawTier &&
    (typeof rawTier.id === 'string' || typeof rawTier.name === 'string')
      ? {
          ...(typeof rawTier.id === 'string' && rawTier.id.trim()
            ? { id: rawTier.id.trim() }
            : {}),
          ...(typeof rawTier.name === 'string' && rawTier.name.trim()
            ? { name: rawTier.name.trim() }
            : {}),
        }
      : undefined
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    kind: 'acp',
    status: value.status as AntigravityConnectionStatus,
    models,
    ...(typeof value.currentModelId === 'string' && value.currentModelId.trim()
      ? { currentModelId: value.currentModelId.trim() }
      : {}),
    ...(typeof value.currentEffortLevel === 'string' &&
    value.currentEffortLevel.trim()
      ? { currentEffortLevel: value.currentEffortLevel.trim() }
      : {}),
    ...(typeof value.version === 'string' && value.version.trim()
      ? { version: value.version.trim() }
      : {}),
    ...(tier && (tier.id || tier.name) ? { tier } : {}),
    ...(typeof value.error === 'string' && value.error.trim()
      ? { error: value.error.trim() }
      : {}),
  }
}

function antigravityRuntimeSource(
  antigravity: AntigravityStatus | null
): RuntimeSource | null {
  if (!antigravity || antigravity.status === 'not_installed') return null
  const auth: RuntimeSource['auth'] =
    antigravity.status === 'login_required'
      ? 'missing'
      : antigravity.status === 'error'
        ? 'error'
        : 'ready'
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    name: 'Antigravity',
    auth,
    builtin: true,
    kind: 'acp',
    runtimeStatus: antigravity.status,
  }
}

export function antigravityModels(
  antigravity: AntigravityStatus | null | undefined
): Model[] {
  if (
    !antigravity ||
    antigravity.status === 'not_installed' ||
    antigravity.status === 'login_required' ||
    antigravity.status === 'error'
  )
    return []
  const models = antigravity.models.map(
    (model): Model => ({
      id: model.id,
      name: model.name,
      ...(model.supportedReasoningEfforts
        ? { supportedReasoningEfforts: [...model.supportedReasoningEfforts] }
        : {}),
      ...(model.defaultReasoningEffort
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {}),
    })
  )
  if (models.length > 0) return models
  if (antigravity.status === 'ready')
    return [{ id: ANTIGRAVITY_DEFAULT_MODEL, name: 'Antigravity 默认模型' }]
  return []
}

export function antigravityStatusLabel(
  antigravity: AntigravityStatus | null | undefined
): string {
  switch (antigravity?.status) {
    case 'ready':
      return '已就绪'
    case 'login_required':
      return '需要电脑登录'
    case 'unchecked':
      return '待检测'
    case 'error':
      return '状态异常'
    default:
      return '未安装'
  }
}

export function antigravitySourceDetail(
  antigravity: AntigravityStatus | null | undefined
): string | undefined {
  if (!antigravity || antigravity.status === 'not_installed') return undefined
  if (antigravity.status === 'login_required') return '需在电脑终端登录'
  if (antigravity.status === 'error') return '状态待确认'
  if (antigravity.status === 'unchecked') return '待检测模型'
  return (
    [antigravity.tier?.name, antigravity.version ? `v${antigravity.version}` : '']
      .filter(Boolean)
      .join(' · ') || '本地 Agent 引擎'
  )
}

/** Pick the initial Antigravity model and compatible effort for a new task. */
export function defaultAntigravitySelection(
  antigravity: AntigravityStatus | null | undefined
): { config: RuntimeConfig; name: string } {
  const models = antigravityModels(antigravity)
  const chosen =
    (antigravity?.currentModelId
      ? models.find((model) => model.id === antigravity.currentModelId)
      : undefined) ??
    models[0] ?? {
      id: antigravity?.currentModelId || ANTIGRAVITY_DEFAULT_MODEL,
      name: antigravity?.currentModelId || 'Antigravity 默认模型',
    }
  const supported = chosen.supportedReasoningEfforts ?? []
  const effort =
    antigravity?.currentEffortLevel &&
    supported.includes(antigravity.currentEffortLevel)
      ? antigravity.currentEffortLevel
      : chosen.defaultReasoningEffort
  return {
    config: runtimeSelection(ANTIGRAVITY_PROVIDER_ID, chosen, effort, false),
    name: chosen.name,
  }
}

export function withAntigravityStatus(
  directory: RuntimeDirectory,
  antigravity: AntigravityStatus | null
): RuntimeDirectory {
  const withoutAntigravity = directory.sources.filter(
    (source) => source.id !== ANTIGRAVITY_PROVIDER_ID
  )
  const nextSource = antigravityRuntimeSource(antigravity)
  return {
    ...directory,
    antigravity,
    sources: nextSource
      ? [...withoutAntigravity, nextSource]
      : withoutAntigravity,
  }
}

export async function discoverAntigravity(
  client: ApiClient,
  signal?: AbortSignal
): Promise<AntigravityStatus | null> {
  const response = await client.post<{ antigravity?: unknown }>(
    `/api/providers/${ANTIGRAVITY_PROVIDER_ID}/discover`,
    {},
    signal ? { signal } : undefined
  )
  return parseAntigravityStatus(response?.antigravity)
}

export function runtimeSourceName(
  id: string | null,
  providers: { id: string; name: string }[]
) {
  if (id === ANTIGRAVITY_PROVIDER_ID) return 'Antigravity'
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
    client.get<{
      providers: Provider[]
      activeId: string | null
      antigravity?: unknown
    }>('/api/providers', { signal }),
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
  const antigravity = parseAntigravityStatus(saved.antigravity)
  const antigravitySource = antigravityRuntimeSource(antigravity)
  return {
    providers: saved.providers,
    presets: presets.presets,
    activeId: runtimeProviderIdentity(saved.activeId),
    defaults,
    antigravity,
    sources: [
      ...official,
      ...saved.providers
        .filter(
          (provider) =>
            provider.id !== ANTIGRAVITY_PROVIDER_ID &&
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
      ...(antigravitySource ? [antigravitySource] : []),
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
  if (providerId === ANTIGRAVITY_PROVIDER_ID) {
    const status = directory.antigravity
    if (!status || status.status === 'not_installed' || status.status === 'login_required' || status.status === 'error')
      return []
    if (status.status === 'ready') return antigravityModels(status)
    const discovered = await discoverAntigravity(client, signal)
    return antigravityModels(discovered)
  }
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
/** 去掉 1M 上下文后缀：`x[1m]` 和 `x` 是同一个模型，思考强度一样。 */
const contextBase = (id: string) => id.replace(/(?:\[1m\]|:1m)$/i, '').trim()
/** 当前模型不在列表里时给的通用档位，和桌面端一致：去掉只有少数模型支持的「超高」，由电脑校验。 */
const FALLBACK_EFFORTS: readonly string[] = MODEL_REASONING_EFFORTS.filter((value) => value !== 'xhigh')

/**
 * 当前模型可调的思考强度，和桌面端模型选择器一致：先按 id 找，再忽略 1M 上下文后缀找；
 * 列表里没有这个模型也不报错，给通用档位。只有模型明确声明没有可调强度时才为空。
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

/** 思考强度调不了时的原因；模型不在列表里不算（见 currentModelEfforts）。 */
export function effortUnavailableReason(choice: {
  source?: {
    id?: string | null
    auth: RuntimeSource['auth']
    runtimeStatus?: AntigravityConnectionStatus
  }
  canSetEffort: boolean
}): string {
  if (choice.source?.id === ANTIGRAVITY_PROVIDER_ID) {
    if (choice.source.runtimeStatus === 'login_required' || choice.source.auth === 'missing')
      return ANTIGRAVITY_LOGIN_GUIDANCE
    if (choice.source.runtimeStatus === 'error' || choice.source.auth === 'error')
      return '尚未确认 Antigravity 状态，请点击刷新重试。'
    if (choice.source.runtimeStatus === 'unchecked')
      return '正在检测 Antigravity 可用模型，请稍候或点击刷新。'
  }
  return choice.source?.auth === 'missing'
    ? '请先在电脑上登录或配置此供应商，再重新读取。'
    : choice.source?.auth === 'error'
      ? '尚未确认此供应商的授权状态，请重新读取。'
      : !choice.source
        ? '当前供应商已不可用，请重新选择模型。'
        : !choice.canSetEffort
          ? '此账号的新任务沿用电脑默认强度，可在会话中调整。'
          : '当前模型没有可调的思考强度。'
}
