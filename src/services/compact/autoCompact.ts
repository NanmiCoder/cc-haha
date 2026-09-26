import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel, has1mContext } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { getOpenAICodexContextWindowForModel } from '../../services/openaiAuth/models.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { getConfiguredOrBuiltInModelContextWindow } from '../../utils/model/modelContextWindows.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  hasUsableContextUsage,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
// Small-window providers cannot afford the fixed 20K summary reservation.
// Keep at least 75% of their advertised window available to the compact input.
const MAX_SUMMARY_RESERVE_CONTEXT_FRACTION = 0.25

/**
 * The model's context window before the summary reserve is subtracted — i.e.
 * the number an operator declares as "上下文窗口" (provider preset, built-in
 * table, `[1m]` marker, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). Auto-compact
 * tiers are keyed off this, because the tier bands (100K/200K/300K/500K) are
 * statements about the declared window, not about the post-reserve headroom.
 */
export function getResolvedContextWindow(model: string): number {
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // For models with a known window (configured, built-in, [1m], or Codex
      // catalog) the global override can only lower it — a 1M value left over
      // from another provider's preset must not pin a smaller model above its
      // provider's hard cap, where auto-compact never fires (#1162). Unknown
      // models resolve to the 200K default, and this env is the only way to
      // declare their real window, so there it applies directly.
      const hasKnownWindow =
        has1mContext(model) ||
        getConfiguredOrBuiltInModelContextWindow(model) !== undefined ||
        getOpenAICodexContextWindowForModel(model) != null
      contextWindow = hasKnownWindow
        ? Math.min(contextWindow, parsed)
        : parsed
    }
  }

  return contextWindow
}

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(model: string): number {
  const contextWindow = getResolvedContextWindow(model)

  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    Math.floor(contextWindow * MAX_SUMMARY_RESERVE_CONTEXT_FRACTION),
  )

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

/** The pre-tier fixed headroom. Still enforced as an upper bound on how late
 * compaction may start, so 12K–32K windows keep the behavior the small-window
 * guard was added for: at 13% of a 12K window only ~1.5K tokens would remain,
 * which is not enough room for the summary and would hit prompt_too_long. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

/**
 * Auto-compact tiers, keyed by the *declared* context window
 * (`getResolvedContextWindow`). Each tier states how much should be left when
 * compaction starts (`pctLeft` of the window) and the absolute floor below
 * which compaction is forced regardless of percentage (`floorTokens`).
 *
 * Bands are inclusive upper bounds, evaluated top to bottom.
 */
export const AUTOCOMPACT_TIERS: ReadonlyArray<{
  upToWindow: number
  pctLeft: number
  floorTokens: number
}> = [
  { upToWindow: 100_000, pctLeft: 0.13, floorTokens: 13_000 },
  { upToWindow: 200_000, pctLeft: 0.17, floorTokens: 32_000 },
  { upToWindow: 300_000, pctLeft: 0.21, floorTokens: 36_000 },
  { upToWindow: 500_000, pctLeft: 0.17, floorTokens: 53_000 },
  { upToWindow: Number.POSITIVE_INFINITY, pctLeft: 0.15, floorTokens: 65_000 },
]

export function getAutoCompactTier(declaredWindow: number): {
  pctLeft: number
  floorTokens: number
} {
  for (const tier of AUTOCOMPACT_TIERS) {
    if (declaredWindow <= tier.upToWindow) {
      return { pctLeft: tier.pctLeft, floorTokens: tier.floorTokens }
    }
  }
  const last = AUTOCOMPACT_TIERS[AUTOCOMPACT_TIERS.length - 1]!
  return { pctLeft: last.pctLeft, floorTokens: last.floorTokens }
}

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/**
 * Soft trigger: the token count at which auto-compact starts.
 *
 * The tier supplies the share of the window that should remain, but the result
 * is additionally capped by the legacy `min(13K, window/3)` guard. For windows
 * up to ~40K that guard is the binding term, so small-window behavior is
 * unchanged; for larger windows the tier decides and compaction starts
 * meaningfully earlier than a flat 13K buffer would allow.
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const { pctLeft } = getAutoCompactTier(getResolvedContextWindow(model))

  const tieredThreshold = Math.floor(
    effectiveContextWindow * (1 - pctLeft),
  )
  const legacyGuard =
    effectiveContextWindow -
    Math.min(AUTOCOMPACT_BUFFER_TOKENS, Math.floor(effectiveContextWindow / 3))
  const autocompactThreshold = Math.min(tieredThreshold, legacyGuard)

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/**
 * Hard trigger: remaining tokens below the tier's absolute floor. The soft
 * percentage normally fires first, so this is a backstop — it guarantees a
 * compaction attempt when the remaining budget is genuinely small even if the
 * percentage path was bypassed (overridden, or already compacted and refilled).
 *
 * Never returned earlier than the soft trigger, so crossing it always implies
 * the soft condition was already satisfied.
 */
export function getForcedCompactThreshold(model: string): number {
  // Measured on the declared window, the same basis as the tier bands: the
  // floor is stated as an absolute number of tokens left, so it has to be
  // subtracted from the window the operator declared. Both are clamped so the
  // result can never precede the soft trigger.
  const declaredWindow = getResolvedContextWindow(model)
  const { floorTokens } = getAutoCompactTier(declaredWindow)
  const floor = Math.min(floorTokens, declaredWindow)
  return Math.max(declaredWindow - floor, getAutoCompactThreshold(model))
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtForcedCompactLimit: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  // Percent is reported against the context window, not against the compaction
  // threshold. Using the threshold as the denominator made the indicator read
  // 0% at the moment compaction starts, while the tier rules — and the reader —
  // mean "13%/17%/21%/15% of the window still free".
  const percentBase = getEffectiveContextWindowSize(model)
  const percentLeft = Math.max(
    0,
    Math.min(
      100,
      Math.round(((percentBase - tokenUsage) / percentBase) * 100),
    ),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold
  const isAtForcedCompactLimit =
    isAutoCompactEnabled() && tokenUsage >= getForcedCompactThreshold(model)

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtForcedCompactLimit,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

/**
 * Provider usage normally includes the system prompt, tools, skills, and
 * request metadata. When a compatibility relay omits usable usage entirely,
 * add a conservative local estimate for that fixed request prefix instead of
 * comparing messages alone against the auto-compact threshold.
 */
export function estimateFallbackFixedContextTokens(
  cacheSafeParams: CacheSafeParams,
): number {
  const tools = cacheSafeParams.toolUseContext.options.tools.map(tool => ({
    name: tool.name,
    input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
  }))
  return roughTokenCountEstimation(jsonStringify({
    systemPrompt: cacheSafeParams.systemPrompt,
    systemContext: cacheSafeParams.systemContext,
    userContext: cacheSafeParams.userContext,
    tools,
  }))
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
  fallbackFixedContextTokens = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const fixedContextTokens = hasUsableContextUsage(messages)
    ? 0
    : fallbackFixedContextTokens
  const tokenCount =
    tokenCountWithEstimation(messages) +
    fixedContextTokens -
    snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const forcedThreshold = getForcedCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} forcedThreshold=${forcedThreshold} effectiveWindow=${effectiveWindow}${fixedContextTokens > 0 ? ` fallbackFixed=${fixedContextTokens}` : ''}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold, isAtForcedCompactLimit } =
    calculateTokenWarningState(tokenCount, model)

  // The forced trigger is a backstop: the tier keeps `floorTokens` at or below
  // `window * pctLeft`, so the soft condition normally fires first. The OR only
  // matters if the percentage path was bypassed.
  return isAboveAutoCompactThreshold || isAtForcedCompactLimit
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
    estimateFallbackFixedContextTokens(cacheSafeParams),
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
