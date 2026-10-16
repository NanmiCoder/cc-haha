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
import { findLastCompactBoundaryIndex } from '../../utils/messages.js'
import { getOpenAICodexContextWindowForModel } from '../../services/openaiAuth/models.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { getConfiguredOrBuiltInModelContextWindow } from '../../utils/model/modelContextWindows.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getTokenUsage,
  hasUsableContextUsage,
  isUsableContextUsage,
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

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(model: string): number {
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
  // Consecutive compactions that each refilled to the threshold within
  // RAPID_REFILL_TURN_WINDOW turns of the previous one. Used as a circuit
  // breaker when compaction succeeds but frees too little room to matter
  // (fixed context near the threshold, or oversized tool output).
  consecutiveRapidRefills?: number
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

// A compaction that leaves the context so full that it refills to the
// threshold within a few turns is not helping: every later turn pays for
// another summary call and loses detail (#1544). Same trip rule as the
// official CLI (3 refills, each within 3 turns), but a refill only counts
// when the compaction itself freed little room: a small window filled by
// large tool output still compacts usefully every couple of turns and must
// not have its turn ended.
export const RAPID_REFILL_TURN_WINDOW = 3
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3
// The first request after a compaction still using this share of the
// threshold means the summary did not free usable room.
export const RAPID_REFILL_MIN_POST_COMPACT_SHARE = 0.75

export const AUTOCOMPACT_THRASHING_MESSAGE =
  'Auto-compact is thrashing: the context refilled to the limit within 3 turns of the previous compaction, 3 times in a row, and each compaction left most of the limit in use. ' +
  'The fixed context (system prompt, tools, MCP servers, skills, CLAUDE.md) leaves too little room for this context window. ' +
  'Disable unused MCP servers or skills, shorten CLAUDE.md, switch to a model with a larger context window, or use /clear to start fresh.'

/**
 * Prompt size of the first API request after the latest compaction, read
 * from its reported usage. Undefined when there was no compaction in these
 * messages or the provider reported no usable usage.
 */
export function getPostCompactPromptTokens(
  messages: readonly Message[],
): number | undefined {
  const boundaryIndex = findLastCompactBoundaryIndex([...messages])
  if (boundaryIndex < 0) return undefined
  for (const message of messages.slice(boundaryIndex + 1)) {
    const usage = getTokenUsage(message)
    if (usage && isUsableContextUsage(usage)) {
      return (
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      )
    }
  }
  return undefined
}

export function getRapidRefillDecision(
  tracking: AutoCompactTrackingState | undefined,
  postCompactPromptTokens: number | undefined,
  autoCompactThreshold: number,
): { trip: boolean; consecutiveRapidRefills: number } {
  // Without usage we cannot tell a useless compaction from a useful one;
  // keep the loop guard rather than compact forever.
  const compactionLeftLittleRoom =
    postCompactPromptTokens === undefined ||
    postCompactPromptTokens >=
      autoCompactThreshold * RAPID_REFILL_MIN_POST_COMPACT_SHARE
  const consecutiveRapidRefills =
    tracking?.compacted === true &&
    tracking.turnCounter < RAPID_REFILL_TURN_WINDOW &&
    compactionLeftLittleRoom
      ? (tracking.consecutiveRapidRefills ?? 0) + 1
      : 0
  return {
    trip: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    consecutiveRapidRefills,
  }
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  // The fixed 13K buffer is larger than some supported context windows. Cap it
  // at one third of the effective window so the threshold remains useful for
  // 16K/32K providers while preserving the existing buffer for larger models.
  const autoCompactBuffer = Math.min(
    AUTOCOMPACT_BUFFER_TOKENS,
    Math.floor(effectiveContextWindow / 3),
  )
  const autocompactThreshold = effectiveContextWindow - autoCompactBuffer

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

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

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
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${fixedContextTokens > 0 ? ` fallbackFixed=${fixedContextTokens}` : ''}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
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
  consecutiveRapidRefills?: number
  rapidRefillBreakerTripped?: boolean
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

  const postCompactPromptTokens = tracking?.compacted
    ? getPostCompactPromptTokens(messages)
    : undefined
  const { trip, consecutiveRapidRefills } = getRapidRefillDecision(
    tracking,
    postCompactPromptTokens,
    getAutoCompactThreshold(model),
  )
  if (trip) {
    logForDebugging(
      `autocompact: rapid-refill breaker tripped — ${consecutiveRapidRefills} consecutive refills within <${RAPID_REFILL_TURN_WINDOW} turns each (last was ${tracking?.turnCounter} turns, post-compact prompt ${postCompactPromptTokens ?? 'unknown'} tokens)`,
      { level: 'warn' },
    )
    return { wasCompacted: false, rapidRefillBreakerTripped: true }
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
      consecutiveRapidRefills,
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
      consecutiveRapidRefills,
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
