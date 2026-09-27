// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getOpenAICodexContextWindowForModel } from '../services/openaiAuth/models.js'
import { getGlobalConfig } from './config.js'
import {
  calculateContextBudget,
  calculateContextPercentagesFromTokens,
  type ProviderUsageTrust,
} from './contextBudget.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'
import {
  getBuiltInModelContextWindow,
  getConfiguredModelContextWindow,
} from './model/modelContextWindows.js'

// Default fallback when the model-specific capability is unknown.
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model) || /:1m$/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-fable-5') ||
    canonical.includes('claude-sonnet-5') ||
    canonical.includes('claude-opus-5') ||
    canonical.includes('claude-opus-4-8') ||
    canonical.includes('claude-opus-4-7') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6')
  )
}

// C4E admins can disable extended context for HIPAA compliance; configured
// windows above the default are capped rather than ignored.
function capToDefaultIfExtendedContextDisabled(window: number): number {
  if (window > MODEL_CONTEXT_WINDOW_DEFAULT && is1mContextDisabled()) {
    return MODEL_CONTEXT_WINDOW_DEFAULT
  }
  return window
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Allow override via environment variable (ant-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // Explicit per-model configuration (CLAUDE_CODE_MODEL_CONTEXT_WINDOWS) wins
  // over the [1m] marker: the marker gets appended automatically by provider
  // settings, while a configured window states the model's real limit. A 256K
  // model pinned at 1M never reaches the auto-compact threshold and dies at
  // the provider's hard cap instead (#1162).
  const userConfiguredWindow = getConfiguredModelContextWindow(model)
  if (userConfiguredWindow !== undefined) {
    return capToDefaultIfExtendedContextDisabled(userConfiguredWindow)
  }

  // [1m] suffix — explicit client-side opt-in, respected over built-in tables
  // so that models whose table entry predates extended-context support (e.g.
  // claude-sonnet-4-6 at 200K) can still opt in to 1M.
  if (has1mContext(model)) {
    return 1_000_000
  }

  const builtInWindow = getBuiltInModelContextWindow(model)
  if (builtInWindow !== undefined) {
    return capToDefaultIfExtendedContextDisabled(builtInWindow)
  }

  const openAIContextWindow = getOpenAICodexContextWindowForModel(model)
  if (openAIContextWindow) {
    return openAIContextWindow
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  return calculateContextPercentagesFromTokens(
    currentUsage.input_tokens +
      currentUsage.cache_creation_input_tokens +
      currentUsage.cache_read_input_tokens,
    contextWindowSize,
  )
}

/**
 * Calculate the current context size after the latest assistant response.
 *
 * API usage reports the prompt tokens used for the just-finished request plus
 * that request's output tokens. The output becomes part of the next request's
 * conversation context, so omitting it can make context usage appear to drop
 * immediately after the model finishes responding. The local estimate is kept
 * as a lower bound because it includes system/tool/message material that some
 * provider usage payloads under-report.
 *
 * Pass `contextWindow` to clamp the result to the model's context window size.
 * This prevents display values from exceeding 100% for providers (e.g. DeepSeek)
 * whose input_tokens already approach the window limit before output is added.
 */
export function calculateCurrentContextTokenTotal(
  estimatedTokens: number,
  currentUsage: {
    input_tokens: number
    output_tokens?: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindow?: number,
  options?: {
    hasMediaInput?: boolean
    usageTrust?: ProviderUsageTrust
    canonicalTokens?: number
  },
): number {
  const hasMediaInput = options?.hasMediaInput ?? false
  const usageTrust = options?.usageTrust ?? 'high'

  if (contextWindow !== undefined) {
    const budget = calculateContextBudget({
      estimatedTokens,
      contextWindow,
      currentUsage,
      usageTrust,
      hasMediaInput,
    })
    if (
      budget.ignoredUsageReason ||
      !currentUsage ||
      options?.canonicalTokens === undefined
    ) {
      return budget.usedTokens
    }
    return Math.min(
      Math.max(budget.usedTokens, options.canonicalTokens),
      contextWindow,
    )
  }

  if (!currentUsage) return estimatedTokens

  const totalFromAPI =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens +
    (currentUsage.output_tokens ?? 0)

  return Math.max(estimatedTokens, totalFromAPI)
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  if (m === 'claude-opus-5-5') {
    defaultTokens = 128_000
    upperLimit = 128_000
  } else if (
    m.includes('fable-5') ||
    m.includes('opus-5') ||
    m.includes('opus-4-8') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-5')
  ) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
