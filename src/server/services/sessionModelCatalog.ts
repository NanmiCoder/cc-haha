import type { SessionRuntimeSelection, SessionModelOption } from '../../shared/sessionDelegation.js'
import { resolveModelReasoningProfile, getModelReasoningCapabilityOverride } from '../../shared/modelReasoning.js'
import { ProviderService } from './providerService.js'
import { hahaOAuthService } from './hahaOAuthService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { hahaGrokOAuthService } from './hahaGrokOAuthService.js'
import { hahaDeepSeekOAuthService } from './hahaDeepSeekOAuthService.js'
import { CLAUDE_OFFICIAL_DEFAULT_MODELS, normalizeExplicitClaudeOfficialModelId } from './claudeOfficialRuntime.js'
import { OPENAI_CODEX_MODEL_CATALOG, OPENAI_DEFAULT_MAIN_MODEL } from '../../services/openaiAuth/models.js'
import { GROK_MODEL_CATALOG, GROK_DEFAULT_MAIN_MODEL } from '../../services/grokAuth/models.js'
import { DEEPSEEK_ACCOUNT_MODEL_CATALOG } from '../../services/deepseekAuth/modelCatalog.js'
import { getPresetDefaultEnv, getPresetReasoningProviderKind } from './providerRuntimeEnv.js'
import { ApiError } from '../middleware/errorHandler.js'
import type { SavedProvider } from '../types/provider.js'

const providers = new ProviderService()
const slots = ['main', 'fable', 'opus', 'sonnet', 'haiku'] as const

/** Only local account presence is inspected; catalog discovery never refreshes tokens or calls a provider. */
export async function listSessionModels(): Promise<SessionModelOption[]> {
  const [index, claude, openai, grok, deepseek] = await Promise.all([
    providers.listProviders(), hahaOAuthService.loadTokens(), hahaOpenAIOAuthService.loadTokens(),
    hahaGrokOAuthService.loadTokens(), hahaDeepSeekOAuthService.loadTokens(),
  ])
  const catalog = buildSessionModelCatalog(index.providers, { claude: !!claude, openai: !!openai, grok: !!grok, deepseek: !!deepseek }, index.activeId)
  // Official accounts also have user-configured slot mappings. Keep those
  // concrete choices and defaults without consulting a remote model catalog.
  for (const providerId of [null, 'openai-official', 'grok-official', 'deepseek-account']) {
    const first = catalog.find(item => item.providerId === providerId)
    if (!first) continue
    const mapping = await providers.getOfficialProviderModels(providerId ?? 'claude-official')
    for (const modelId of Object.values(mapping)) {
      if (!modelId || catalog.some(item => item.providerId === providerId && item.modelId === modelId)) continue
      const profile = resolveModelReasoningProfile(modelId)
      catalog.push({ providerId, providerName: first.providerName, modelId, modelName: modelId,
        supportedEfforts: [...(profile?.supportedReasoningEfforts ?? [])],
        ...(profile?.defaultReasoningEffort ? { defaultEffort: profile.defaultReasoningEffort } : {}), isDefault: false })
    }
    for (const item of catalog) if (item.providerId === providerId) {
      item.isProviderDefault = item.modelId === mapping.main
      item.isDefault = item.isProviderDefault && providerId === index.activeId
    }
  }
  return catalog
}

export function buildSessionModelCatalog(saved: SavedProvider[], accounts: { claude: boolean; openai: boolean; grok: boolean; deepseek: boolean }, activeProviderId?: string | null): SessionModelOption[] {
  const result: SessionModelOption[] = []
  const add = (providerId: string | null, providerName: string, modelId: string, modelName: string, isDefault: boolean, supportedEfforts?: readonly string[], defaultEffort?: string) => {
    if (!modelId || result.some(item => item.providerId === providerId && item.modelId === modelId)) return
    const profile = resolveModelReasoningProfile(modelId)
    result.push({ providerId, providerName, modelId, modelName, isProviderDefault: isDefault, isDefault: isDefault && providerId === activeProviderId,
      supportedEfforts: [...(supportedEfforts ?? profile?.supportedReasoningEfforts ?? [])],
      ...(defaultEffort ?? profile?.defaultReasoningEffort ? { defaultEffort: defaultEffort ?? profile?.defaultReasoningEffort } : {}),
    })
  }
  if (accounts.claude) for (const model of [...Object.values(CLAUDE_OFFICIAL_DEFAULT_MODELS), 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) add(null, 'Claude Official', model, model, model === CLAUDE_OFFICIAL_DEFAULT_MODELS.main)
  if (accounts.openai) for (const model of OPENAI_CODEX_MODEL_CATALOG) add('openai-official', 'ChatGPT Official', model.value, model.label, model.value === OPENAI_DEFAULT_MAIN_MODEL, model.supportedReasoningEfforts, model.defaultReasoningEffort)
  if (accounts.grok) for (const model of GROK_MODEL_CATALOG) add('grok-official', 'Grok Official', model.value, model.label, model.value === GROK_DEFAULT_MAIN_MODEL, model.reasoningEfforts ?? [], model.reasoningEffort)
  if (accounts.deepseek) for (const [i, model] of DEEPSEEK_ACCOUNT_MODEL_CATALOG.entries()) add('deepseek-account', 'DeepSeek Account', model.id, model.name, i === 0)
  for (const provider of saved) {
    for (const slot of slots) {
      let modelId = provider.models[slot]?.trim()
      if (!modelId) continue
      const support = provider.model1mSupport?.[slot]
      if (support !== undefined) modelId = modelId.replace(/(?:\[1m\]|:1m)$/i, '') + (support ? '[1m]' : '')
      const profile = resolveModelReasoningProfile(modelId, provider.apiFormat,
        getModelReasoningCapabilityOverride(modelId, provider.models, getPresetDefaultEnv(provider.presetId)), getPresetReasoningProviderKind(provider.presetId))
      add(provider.id, provider.name, modelId, modelId, slot === 'main', profile?.supportedReasoningEfforts ?? [], profile?.defaultReasoningEffort)
      const candidate = result.find(item => item.providerId === provider.id && item.modelId === modelId)!
      candidate.aliases = [...(candidate.aliases ?? []), slot, ...(slot === 'main' ? ['default'] : [])]
    }
  }
  const identitiesByName = new Map<string, Set<string>>()
  for (const item of result) {
    const identities = identitiesByName.get(item.providerName) ?? new Set<string>()
    identities.add(item.providerId ?? 'claude-official')
    identitiesByName.set(item.providerName, identities)
  }
  for (const item of result) {
    const identities = identitiesByName.get(item.providerName)!
    if (identities.size < 2) continue
    const id = item.providerId ?? 'claude-official'
    const short = id.slice(-6)
    const label = [...identities].filter(value => value.endsWith(short)).length === 1 ? short : id
    item.providerName = `${item.providerName} (${label})`
  }
  return result
}

export type SessionRuntimeInput = { runtime?: SessionRuntimeSelection; model?: string; providerId?: string | null }
const providerIdentity = (id: string | null) => id === 'claude-official' ? null : id

export function resolveSessionRuntimeFromCatalog(input: SessionRuntimeInput, parent: SessionRuntimeSelection, catalog: SessionModelOption[]): SessionRuntimeSelection {
  if (input.runtime && (input.model !== undefined || input.providerId !== undefined)) throw ApiError.badRequest('Use runtime or legacy model/providerId, not both')
  let selection: SessionRuntimeSelection
  if (input.runtime) selection = { ...input.runtime, providerId: providerIdentity(input.runtime.providerId), modelId: input.runtime.modelId.trim() }
  else if (input.providerId === undefined && input.model === undefined) selection = { ...parent, providerId: providerIdentity(parent.providerId) }
  else {
    const providerId = input.providerId === undefined ? undefined : providerIdentity(input.providerId)
    const model = input.model?.trim()
    const candidates = catalog.filter(item => (providerId === undefined || item.providerId === providerId) && (model !== undefined ? item.modelId === model || item.aliases?.includes(model) : item.isProviderDefault ?? item.isDefault))
    if (candidates.length !== 1) throw new ApiError(400, candidates.length ? 'Model is ambiguous; choose a provider and model from ListSessionModels' : 'Requested provider/model is unavailable; choose from ListSessionModels', candidates.length ? 'SESSION_MODEL_AMBIGUOUS' : 'SESSION_MODEL_UNAVAILABLE')
    const candidate = candidates[0]!
    selection = { providerId: candidate.providerId, modelId: candidate.modelId }
  }
  if (selection.providerId === null) selection.modelId = normalizeExplicitClaudeOfficialModelId(selection.modelId) ?? selection.modelId
  if (selection.modelId === 'default' || selection.modelId === 'main') {
    selection.modelId = catalog.find(item => item.providerId === selection.providerId && (item.isProviderDefault ?? item.isDefault))?.modelId ?? selection.modelId
  }
  const candidate = catalog.find(item => item.providerId === selection.providerId && item.modelId === selection.modelId)
    ?? catalog.find(item => item.providerId === selection.providerId && item.aliases?.includes(selection.modelId))
  if (!candidate) throw new ApiError(400, 'Requested provider/model is unavailable; choose from ListSessionModels', 'SESSION_MODEL_UNAVAILABLE')
  selection.modelId = candidate.modelId
  if (selection.effortLevel !== undefined && !candidate.supportedEfforts.includes(selection.effortLevel)) {
    if (!input.runtime && input.model === undefined && input.providerId === undefined) delete selection.effortLevel
    else throw new ApiError(400, 'Unsupported reasoning effort for the selected model', 'SESSION_MODEL_EFFORT_INVALID')
  }
  if (selection.openAIFastMode && selection.providerId !== 'openai-official') throw ApiError.badRequest('Fast mode requires ChatGPT Official')
  return selection
}

export async function resolveSessionRuntime(input: SessionRuntimeInput, parent: SessionRuntimeSelection): Promise<SessionRuntimeSelection> {
  return resolveSessionRuntimeFromCatalog(input, parent, await listSessionModels())
}

export async function validateSessionRuntime(runtime: SessionRuntimeSelection): Promise<SessionRuntimeSelection> {
  return resolveSessionRuntime({ runtime }, runtime)
}
