import * as fs from 'fs'
import * as path from 'path'

import { MODEL_CONTEXT_WINDOWS_ENV_KEY } from '../../utils/model/modelContextWindows.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'
import type {
  ApiFormat,
  ProviderAuthStrategy,
  ProvidersIndex,
  SavedProvider,
} from '../types/provider.js'
import {
  BUILT_IN_PROVIDER_IDS,
} from '../types/provider.js'
import {
  ATTRIBUTION_HEADER_ENV_KEY,
  attributionHeaderEnvForModel,
} from './attributionHeaderPolicy.js'
import {
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
  OPENAI_OAUTH_PROVIDER_ENV_KEY,
  buildOpenAIOfficialRuntimeEnv,
  isOpenAIOfficialProviderId,
} from './openaiOfficialProvider.js'

export const MANAGED_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ENABLE_TOOL_SEARCH',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ATTRIBUTION_HEADER_ENV_KEY,
  MODEL_CONTEXT_WINDOWS_ENV_KEY,
  OPENAI_OAUTH_PROVIDER_ENV_KEY,
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
] as const

const CUSTOM_PROVIDER_MODEL_CAPABILITIES = 'thinking,effort,adaptive_thinking,max_effort'
const XIAOMI_MIMO_MODEL_CAPABILITIES = 'thinking'
const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
const MODEL_SLOTS = ['main', 'haiku', 'sonnet', 'opus'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isProviderModels(value: unknown): value is SavedProvider['models'] {
  return (
    isRecord(value) &&
    typeof value.main === 'string' &&
    typeof value.haiku === 'string' &&
    typeof value.sonnet === 'string' &&
    typeof value.opus === 'string'
  )
}

function isProviderModel1mSupport(value: unknown): value is SavedProvider['model1mSupport'] {
  return (
    isRecord(value) &&
    MODEL_SLOTS.every((slot) => typeof value[slot] === 'boolean')
  )
}

function isSavedProvider(value: unknown): value is SavedProvider {
  if (!isRecord(value)) return false
  const runtimeKind = value.runtimeKind
  return (
    typeof value.id === 'string' &&
    typeof value.presetId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.apiKey === 'string' &&
    typeof value.baseUrl === 'string' &&
    (
      runtimeKind === undefined ||
      runtimeKind === 'anthropic_compatible' ||
      runtimeKind === 'openai_oauth'
    ) &&
    isProviderModels(value.models) &&
    (value.model1mSupport === undefined || isProviderModel1mSupport(value.model1mSupport))
  )
}

function normalizeToolSearchEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false
    if (['1', 'true', 'on', 'yes', 'auto'].includes(normalized) || normalized.startsWith('auto:')) {
      return true
    }
  }
  return true
}

export function normalizeModelMapping(models: SavedProvider['models']): SavedProvider['models'] {
  const main = models.main.trim()
  return {
    main,
    haiku: models.haiku.trim() || main,
    sonnet: models.sonnet.trim() || main,
    opus: models.opus.trim() || main,
  }
}

function normalizeModel1mSupport(
  model1mSupport: SavedProvider['model1mSupport'] | undefined,
): SavedProvider['model1mSupport'] | undefined {
  if (!model1mSupport) return undefined
  const normalized = {
    main: model1mSupport.main === true,
    haiku: model1mSupport.haiku === true,
    sonnet: model1mSupport.sonnet === true,
    opus: model1mSupport.opus === true,
  }
  return MODEL_SLOTS.some((slot) => normalized[slot]) ? normalized : undefined
}

function applyModel1mSupport(model: string, enabled: boolean | undefined): string {
  const trimmed = model.trim()
  if (!enabled) return trimmed
  return `${trimmed.replace(/\[1m\]$/i, '').replace(/:1m$/i, '').trim()}[1m]`
}

function applyModel1mSupportMapping(
  models: SavedProvider['models'],
  model1mSupport: SavedProvider['model1mSupport'] | undefined,
): SavedProvider['models'] {
  return {
    main: applyModel1mSupport(models.main, model1mSupport?.main),
    haiku: applyModel1mSupport(models.haiku, model1mSupport?.haiku),
    sonnet: applyModel1mSupport(models.sonnet, model1mSupport?.sonnet),
    opus: applyModel1mSupport(models.opus, model1mSupport?.opus),
  }
}

export function normalizeSavedProvider(provider: SavedProvider): SavedProvider {
  const { model1mSupport: rawModel1mSupport, ...rest } = provider
  const rawProvider = provider as SavedProvider & Record<string, unknown>
  const model1mSupport = normalizeModel1mSupport(rawModel1mSupport)
  return {
    ...rest,
    apiFormat: provider.apiFormat ?? 'anthropic',
    runtimeKind: provider.runtimeKind ?? 'anthropic_compatible',
    models: normalizeModelMapping(provider.models),
    toolSearchEnabled: normalizeToolSearchEnabled(rawProvider.toolSearchEnabled),
    ...(model1mSupport !== undefined ? { model1mSupport } : {}),
  }
}

function defaultProviderOrder(providers: SavedProvider[]): string[] {
  return [
    ...providers.map((provider) => provider.id),
    ...BUILT_IN_PROVIDER_IDS,
  ]
}

function normalizeProviderOrder(value: unknown, providers: SavedProvider[]): string[] {
  const providerIds = providers.map((provider) => provider.id)
  const knownIds = new Set<string>([
    ...providerIds,
    ...BUILT_IN_PROVIDER_IDS,
  ])
  const source = Array.isArray(value)
    ? value
    : defaultProviderOrder(providers)
  const seen = new Set<string>()
  const order: string[] = []

  for (const id of source) {
    if (typeof id !== 'string' || !knownIds.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  for (const id of defaultProviderOrder(providers)) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  return order
}

export function normalizeProvidersIndex(value: unknown): ProvidersIndex | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    return null
  }

  const {
    activeProviderId: legacyActiveProviderId,
    providerOrder: rawProviderOrder,
    ...rest
  } = value
  const providers = value.providers
    .filter(isSavedProvider)
    .map((provider) => normalizeSavedProvider(provider))
  const rawActiveId =
    typeof value.activeId === 'string'
      ? value.activeId
      : typeof legacyActiveProviderId === 'string'
        ? legacyActiveProviderId
        : null
  const activeId = rawActiveId && (
    providers.some((provider) => provider.id === rawActiveId) ||
    isOpenAIOfficialProviderId(rawActiveId)
  )
    ? rawActiveId
    : null

  return {
    ...rest,
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    activeId,
    providers,
    providerOrder: normalizeProviderOrder(rawProviderOrder, providers),
  }
}

export function getPresetDefaultEnv(presetId: string): Record<string, string> {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId)?.defaultEnv ?? {}
}

function omitAuthEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AUTH_ENV_KEYS.has(key.toUpperCase())),
  )
}

export function getPresetAuthStrategy(presetId: string): ProviderAuthStrategy {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId)?.authStrategy ?? 'auth_token'
}

function getPresetModelContextWindows(presetId: string): Record<string, number> {
  return PROVIDER_PRESETS.find((preset) => preset.id === presetId)?.modelContextWindows ?? {}
}

function isXiaomiMimoProvider(provider: SavedProvider, models: SavedProvider['models']): boolean {
  const baseUrl = provider.baseUrl.toLowerCase()
  const modelIds = Object.values(models).map((model) => model.toLowerCase())
  return (
    baseUrl.includes('xiaomimimo.com') ||
    modelIds.some((model) => /^mimo-v\d/i.test(model))
  )
}

function getCustomProviderModelCapabilities(
  provider: SavedProvider,
  models: SavedProvider['models'],
): string {
  if (isXiaomiMimoProvider(provider, models)) {
    return XIAOMI_MIMO_MODEL_CAPABILITIES
  }
  return CUSTOM_PROVIDER_MODEL_CAPABILITIES
}

export function buildProviderAuthEnv(
  provider: SavedProvider,
  presetDefaultEnv: Record<string, string>,
  needsProxy: boolean,
): Record<string, string> {
  if (needsProxy) {
    return { ANTHROPIC_API_KEY: 'proxy-managed' }
  }

  const strategy = provider.authStrategy ?? getPresetAuthStrategy(provider.presetId)
  const key = provider.apiKey || presetDefaultEnv.ANTHROPIC_AUTH_TOKEN || presetDefaultEnv.ANTHROPIC_API_KEY || ''

  switch (strategy) {
    case 'api_key':
      return key ? { ANTHROPIC_API_KEY: key } : {}
    case 'auth_token':
    case 'auth_token_empty_api_key':
      return {
        ANTHROPIC_API_KEY: '',
        ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}),
      }
    case 'dual_same_token':
      return key ? { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: key } : {}
    case 'dual_dummy':
      return { ANTHROPIC_API_KEY: 'dummy', ANTHROPIC_AUTH_TOKEN: 'dummy' }
  }
}

export function getManagedEnvKeys(): string[] {
  const keys = new Set<string>(MANAGED_PROVIDER_ENV_KEYS)
  for (const preset of PROVIDER_PRESETS) {
    for (const key of Object.keys(preset.defaultEnv ?? {})) {
      keys.add(key)
    }
  }
  return [...keys]
}

export function buildProviderManagedEnv(
  provider: SavedProvider,
  options?: { proxyPath?: string; serverPort?: number },
): Record<string, string> {
  if (provider.runtimeKind === 'openai_oauth') {
    return buildOpenAIOfficialRuntimeEnv()
  }

  const apiFormat: ApiFormat = provider.apiFormat ?? 'anthropic'
  const needsProxy = apiFormat !== 'anthropic'
  const proxyPath = options?.proxyPath ?? '/proxy'
  const serverPort = options?.serverPort ?? 3456
  const baseUrl = needsProxy
    ? `http://127.0.0.1:${serverPort}${proxyPath}`
    : provider.baseUrl

  const models = normalizeModelMapping(provider.models)
  const runtimeModels = applyModel1mSupportMapping(models, provider.model1mSupport)
  const modelContextWindows = {
    ...getPresetModelContextWindows(provider.presetId),
    ...(provider.modelContextWindows ?? {}),
  }

  const presetDefaultEnv = getPresetDefaultEnv(provider.presetId)
  const customProviderCapabilities = getCustomProviderModelCapabilities(provider, models)
  const customProviderCapabilityEnv =
    provider.presetId === 'custom'
      ? {
          ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: customProviderCapabilities,
          ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: customProviderCapabilities,
          ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: customProviderCapabilities,
        }
      : {}

  return {
    ...omitAuthEnv(presetDefaultEnv),
    ...customProviderCapabilityEnv,
    ...(provider.autoCompactWindow !== undefined && {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(provider.autoCompactWindow),
    }),
    ...(Object.keys(modelContextWindows).length > 0 && {
      [MODEL_CONTEXT_WINDOWS_ENV_KEY]: JSON.stringify(modelContextWindows),
    }),
    ...(apiFormat === 'anthropic' && {
      ENABLE_TOOL_SEARCH: provider.toolSearchEnabled === false ? 'false' : 'true',
    }),
    ANTHROPIC_BASE_URL: baseUrl,
    ...buildProviderAuthEnv(provider, presetDefaultEnv, needsProxy),
    ANTHROPIC_MODEL: runtimeModels.main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModels.haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModels.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModels.opus,
    ...attributionHeaderEnvForModel(runtimeModels.main),
  }
}

export function readActiveProviderManagedEnv(
  configDir: string,
  options?: { serverPort?: number },
): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(path.join(configDir, 'cc-haha', 'providers.json'), 'utf-8')
    const index = normalizeProvidersIndex(JSON.parse(raw))
    if (!index?.activeId) return null

    if (isOpenAIOfficialProviderId(index.activeId)) {
      return buildOpenAIOfficialRuntimeEnv()
    }

    const provider = index.providers.find((entry) => entry.id === index.activeId)
    if (!provider) return null

    return buildProviderManagedEnv(provider, {
      serverPort: options?.serverPort,
    })
  } catch {
    return null
  }
}

export function mergeActiveProviderManagedEnv(
  settingsEnv: Record<string, string>,
  configDir: string,
  options?: { serverPort?: number },
): Record<string, string> {
  const activeProviderEnv = readActiveProviderManagedEnv(configDir, options)
  if (!activeProviderEnv) {
    return settingsEnv
  }

  const cleanedEnv = { ...settingsEnv }
  for (const key of getManagedEnvKeys()) {
    delete cleanedEnv[key]
  }
  return {
    ...cleanedEnv,
    ...activeProviderEnv,
  }
}
