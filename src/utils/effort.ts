// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isClaudeAISubscriber, isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  getAPIProvider,
  hasAnthropicCompatibleThirdPartyConfig,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel as RuntimeEffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'
import {
  getOpenAIModelCatalogEntry,
  isOpenAIResponsesModel,
} from 'src/services/openaiAuth/models.js'
import { GROK_MODEL_CATALOG, getGrokRuntimeModelCatalog } from 'src/services/grokAuth/models.js'

export type EffortLevel = RuntimeEffortLevel | 'xhigh'

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

function shouldTrustBuiltInClaudeCapabilityList(): boolean {
  if (hasAnthropicCompatibleThirdPartyConfig()) {
    return false
  }
  return (
    getAPIProvider() !== 'firstParty' ||
    isFirstPartyAnthropicBaseUrl() ||
    isClaudeAISubscriber()
  )
}

function getGrokCatalogEntry(model: string): (typeof GROK_MODEL_CATALOG)[number] | undefined {
  const normalized = model.trim().toLowerCase()
  // The live `/v1/models` feed is authoritative; the bundled entries are only a
  // fallback. Without this, a Grok model newer than this build matches no entry
  // and falls through to the Claude heuristics below, which report it as
  // effort-incapable and silently strip the parameter.
  return (
    getGrokRuntimeModelCatalog().find((entry) => entry.value === normalized) ??
    GROK_MODEL_CATALOG.find((entry) => entry.value === normalized)
  )
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (isOpenAIResponsesModel(model)) {
    return true
  }
  const grokEntry = getGrokCatalogEntry(model)
  if (grokEntry) {
    return grokEntry.supportsReasoningEffort !== false
  }
  // Supported by a subset of Claude 4 models
  if (shouldTrustBuiltInClaudeCapabilityList() && (
    m.includes('opus-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-5') ||
    m.includes('opus-4-8') ||
    m.includes('opus-4-5') ||
    m.includes('sonnet-4-6') ||
    m.includes('sonnet-5') ||
    m.includes('fable-5') ||
    m.includes('mythos-5') ||
    m.includes('mythos-preview')
  )) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return (
    getAPIProvider() === 'firstParty' &&
    (isFirstPartyAnthropicBaseUrl() || isClaudeAISubscriber())
  )
}

// @[MODEL LAUNCH]: Add new models that expose the 'xhigh' effort level.
export function modelSupportsXHighEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'xhigh_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (isOpenAIResponsesModel(model)) {
    const entry = getOpenAIModelCatalogEntry(model)
    return entry?.supportedReasoningEfforts.includes('xhigh') ?? true
  }
  const grokEntry = getGrokCatalogEntry(model)
  if (grokEntry) {
    return grokEntry.reasoningEfforts?.includes('xhigh') ?? false
  }
  const m = model.toLowerCase()
  return shouldTrustBuiltInClaudeCapabilityList() && (
    m.includes('opus-4-7') ||
    m.includes('opus-5') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-5') ||
    m.includes('fable-5') ||
    m.includes('mythos-5')
  )
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  if (isOpenAIResponsesModel(model)) {
    const entry = getOpenAIModelCatalogEntry(model)
    return entry?.supportedReasoningEfforts.includes('max') ?? true
  }
  const grokEntry = getGrokCatalogEntry(model)
  if (grokEntry) {
    return grokEntry.reasoningEfforts?.includes('max') ?? false
  }
  const m = model.toLowerCase()
  if (shouldTrustBuiltInClaudeCapabilityList() && (
    m.includes('opus-4-6') ||
    m.includes('opus-4-7') ||
    m.includes('opus-5') ||
    m.includes('opus-4-8') ||
    m.includes('sonnet-4-6') ||
    m.includes('sonnet-5') ||
    m.includes('fable-5') ||
    m.includes('mythos-5') ||
    m.includes('mythos-preview')
  )) {
    return true
  }
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

export function getSupportedEffortLevelsForModel(
  model: string,
): EffortLevel[] {
  if (!modelSupportsEffort(model)) return []
  return EFFORT_LEVELS.filter(
    level =>
      (level !== 'xhigh' || modelSupportsXHighEffort(model)) &&
      (level !== 'max' || modelSupportsMaxEffort(model)),
  )
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).trim().toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  if (!/^-?\d+$/.test(str)) return undefined
  const numericValue = Number(str)
  if (isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): RuntimeEffortLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort filters 'max' for non-ants on read, so a manually
  // edited settings.json doesn't leak session-scoped max into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   request-scoped Agent effort → env CLAUDE_CODE_EFFORT_LEVEL
 *   → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset' without a request-scoped override, or no default exists for the
 * model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  options?: { effortValueOverridesEnv?: boolean },
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  const hasRequestScopedOverride =
    options?.effortValueOverridesEnv === true &&
    appStateEffortValue !== undefined
  if (!hasRequestScopedOverride && envOverride === null) {
    return undefined
  }
  const resolved = hasRequestScopedOverride
    ? appStateEffortValue
    : envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // Claude Code falls back to the nearest supported level at or below the
  // requested level. Opus/Sonnet 4.6 therefore run xhigh as high.
  if (
    resolved === 'xhigh' &&
    !isOpenAIResponsesModel(model) &&
    !modelSupportsXHighEffort(model)
  ) {
    return 'high'
  }
  if (
    resolved === 'max' &&
    !isOpenAIResponsesModel(model) &&
    !modelSupportsMaxEffort(model)
  ) {
    return 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  return 'high'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'xhigh':
      return 'Extra-high reasoning for especially complex tasks'
    case 'max':
      return 'Maximum capability with deepest reasoning'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return 'Balanced approach with standard implementation and testing'
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    const antModel = resolveAntModel(model)
    if (antModel) {
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // Always default ants to undefined/high
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.7 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  if (
    model.toLowerCase().includes('opus-4-6') ||
    model.toLowerCase().includes('opus-4-7')
  ) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}
