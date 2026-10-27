import {
  COST_FABLE_51,
  COST_HAIKU_35,
  COST_HAIKU_45,
  COST_HAIKU_55,
  COST_OPUS_55,
  COST_OPUS_55_FAST,
  COST_TIER_2_10,
  COST_TIER_3_15,
  COST_TIER_5_25,
  COST_TIER_10_50,
  COST_TIER_15_75,
  COST_TIER_30_150,
  getPromptLengthCosts,
  type ModelCosts,
} from './modelCost.js'

/**
 * Shared token-accounting rules for activity stats.
 *
 * Two independent code paths compute these stats — the local index reducer and the direct
 * transcript scan in `stats.ts` — and a parity test pins them to identical output. Rules that
 * decide what counts (deduplication, validity, working time, dollars) therefore live here rather
 * than being implemented twice and drifting apart.
 *
 * ## Cost estimation
 *
 * Deliberately does NOT reuse `calculateUSDCost()` from the CLI: that helper falls back to the
 * default model's rates for anything it doesn't recognize and fires an analytics event per call.
 * cc-haha is a multi-provider client, so a third-party model (glm, k3, deepseek, grok, gpt, ...)
 * priced at Claude rates would report wildly wrong dollars, and indexing runs this tens of
 * thousands of times per rebuild. Here an unknown model returns `null` instead — callers keep its
 * tokens in the activity totals but leave it out of the cost total, matching how ccusage and
 * openusage refuse to mix measured tokens with unpriceable ones.
 *
 * Rates come from `src/utils/modelCost.ts` so the dollar figures live in exactly one place; only
 * the model -> tier mapping is maintained here, because the CLI's canonical-name resolver pulls in
 * runtime state (settings, bootstrap) that has no business running inside the indexer.
 */

export type PricedTokens = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests?: number
}

// @[MODEL LAUNCH]: add the new model's canonical prefix here alongside its entry in MODEL_COSTS.
// Longest match wins, so a bare family name may sit next to its versioned variants.
const MODEL_TIERS: ReadonlyArray<readonly [prefix: string, costs: ModelCosts]> = [
  ['claude-opus-5-5', COST_OPUS_55],
  ['claude-opus-5', COST_TIER_5_25],
  ['claude-opus-4-8', COST_TIER_5_25],
  ['claude-opus-4-7', COST_TIER_5_25],
  ['claude-opus-4-6', COST_TIER_5_25],
  ['claude-opus-4-5', COST_TIER_5_25],
  ['claude-opus-4-1', COST_TIER_15_75],
  ['claude-opus-4', COST_TIER_15_75],
  ['claude-fable-5', COST_TIER_10_50],
  ['claude-fable-5-1', COST_FABLE_51],
  ['claude-mythos-5', COST_TIER_10_50],
  ['claude-sonnet-5-5', COST_TIER_2_10],
  ['claude-sonnet-5', COST_TIER_2_10],
  ['claude-sonnet-4-6', COST_TIER_3_15],
  ['claude-sonnet-4-5', COST_TIER_3_15],
  ['claude-sonnet-4', COST_TIER_3_15],
  ['claude-3-7-sonnet', COST_TIER_3_15],
  ['claude-3-5-sonnet', COST_TIER_3_15],
  ['claude-haiku-5-5', COST_HAIKU_55],
  ['claude-haiku-4-5', COST_HAIKU_45],
  ['claude-3-5-haiku', COST_HAIKU_35],
  ['claude-3-haiku', COST_HAIKU_35],
  ['claude-3-opus', COST_TIER_15_75],
]

// Fast mode bills at its own rate on the models that offer it; everything else ignores `speed`.
const FAST_MODE_TIERS: ReadonlyArray<readonly [prefix: string, costs: ModelCosts]> = [
  ['claude-opus-5-5', COST_OPUS_55_FAST],
  ['claude-opus-5', COST_TIER_10_50],
  ['claude-opus-4-8', COST_TIER_10_50],
  ['claude-opus-4-7', COST_TIER_30_150],
]

/**
 * Strip the decorations third-party gateways and dated snapshots add to an otherwise standard
 * model id: `claude-opus-4-8-20260101`, `claude-opus-4-8-r`, `anthropic/claude-sonnet-5`.
 */
function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase()
  if (!trimmed) return ''
  const withoutVendor = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return withoutVendor
    .replace(/-\d{8}$/, '')
    .replace(/-(r|thinking|latest)$/, '')
}

function matchTier(
  normalized: string,
  tiers: ReadonlyArray<readonly [string, ModelCosts]>,
): ModelCosts | null {
  let best: ModelCosts | null = null
  let bestLength = 0
  for (const [prefix, costs] of tiers) {
    if (prefix.length <= bestLength) continue
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      best = costs
      bestLength = prefix.length
    }
  }
  return best
}

/**
 * Rates for a model, or `null` when we have no published pricing for it (every third-party
 * provider, and any Claude model released after this table was last updated).
 */
export function resolveModelCosts(model: string, speed?: string): ModelCosts | null {
  const normalized = normalizeModelId(model)
  if (!normalized) return null
  if (speed === 'fast') {
    const fast = matchTier(normalized, FAST_MODE_TIERS)
    if (fast) return fast
  }
  return matchTier(normalized, MODEL_TIERS)
}

/**
 * Longest silence between two messages still counted as one continuous stretch of work. Beyond
 * this the user has stepped away and come back — a resumed session, not a long-running task.
 * Without this bound "task length" is really a calendar span: a session picked up the next
 * morning reports the whole night as time on task.
 */
export const ACTIVE_SESSION_GAP_MS = 30 * 60 * 1000

/** Identity fields a transcript line carries for validity checks and deduplication. */
export type UsageRecordIdentity = {
  version?: unknown
  sessionId?: unknown
  requestId?: unknown
  messageId?: unknown
  forkedFrom?: unknown
}

/** `1.0.24`, `2.3.4-beta` — anything else marks a log written by something that isn't Claude Code. */
function isSemverPrefix(value: string): boolean {
  return /^\d+\.\d+\.\d/.test(value)
}

/**
 * Whether a line's `usage` should be counted at all. Mirrors ccusage's validity rules: a `version`
 * that isn't semver-ish means a foreign log format, and an id that is present but empty means a
 * malformed line. Deliberately does not reject an empty `model` the way ccusage does — cc-haha
 * files those under `unknown` and still shows their tokens.
 *
 * Only gates token accounting; the entry still counts toward messages and tool calls, which are
 * activity signals rather than billing ones.
 */
export function isBillableUsageRecord(identity: UsageRecordIdentity): boolean {
  if (isForkInheritedUsageRecord(identity)) return false
  if (typeof identity.version === 'string' && !isSemverPrefix(identity.version)) return false
  for (const value of [identity.sessionId, identity.requestId, identity.messageId]) {
    if (typeof value === 'string' && value.length === 0) return false
  }
  return true
}

/**
 * Conversation branches copy the selected prefix into a new transcript so the fork keeps its
 * context. Those lines retain their original usage and carry this provenance marker; the API calls
 * belong to the source session and must not be attributed to the fork a second time.
 */
export function isForkInheritedUsageRecord(record: { forkedFrom?: unknown }): boolean {
  const forkedFrom = record.forkedFrom
  if (!forkedFrom || typeof forkedFrom !== 'object') return false
  const source = forkedFrom as { sessionId?: unknown; messageUuid?: unknown }
  return (
    typeof source.sessionId === 'string' &&
    source.sessionId.length > 0 &&
    typeof source.messageUuid === 'string' &&
    source.messageUuid.length > 0
  )
}

/**
 * Deduplication key for one usage record, or `null` when the line carries no message id to key on
 * (those are always counted, matching ccusage).
 *
 * Claude Code writes one JSONL line per content block of an assistant message — a reply with
 * thinking, text and 12 tool_use blocks is 14 lines — and every one repeats the same complete
 * `usage` object. Counting each line once per block inflated real transcripts by 2.2x.
 */
export function usageRecordKey(
  identity: UsageRecordIdentity,
  suffix = '',
): string | null {
  const messageId = identity.messageId
  if (typeof messageId !== 'string' || !messageId) return null
  const requestId = typeof identity.requestId === 'string' ? identity.requestId : ''
  return `${messageId}\0${requestId}${suffix}`
}

/**
 * What one reply's content-block lines add to a ledger of already-counted usage.
 *
 * The lines of one reply do not necessarily agree: the first block can be written with an
 * all-zero or partial `usage` (output_tokens still 0) and a later line carries the final numbers.
 * Keeping "the first line wins" therefore recorded some replies as ~0 output tokens. Instead each
 * field keeps the largest value any line reported, and a line only contributes what exceeds what
 * was already counted. Identical repeats add nothing; a late-arriving final line adds the rest.
 *
 * `previous` is what had been counted before this line (null for a first sighting) and `total` is
 * the reply's running figure, so tiered pricing can be applied to the whole reply and billed as
 * `cost(total) - cost(previous)` instead of pricing each fragment as a tiny prompt.
 */
export type UsageIncrement = {
  previous: Required<PricedTokens> | null
  total: Required<PricedTokens>
  delta: Required<PricedTokens>
  isEmpty: boolean
}

export type UsageLedger = Map<string, Required<PricedTokens>>

function withWebSearch(tokens: PricedTokens): Required<PricedTokens> {
  return { ...tokens, webSearchRequests: tokens.webSearchRequests ?? 0 }
}

export function claimUsageIncrement(
  ledger: UsageLedger,
  key: string | null,
  current: PricedTokens,
): UsageIncrement {
  const next = withWebSearch(current)
  const previous = key === null ? undefined : ledger.get(key)
  const total: Required<PricedTokens> = previous
    ? {
        inputTokens: Math.max(previous.inputTokens, next.inputTokens),
        outputTokens: Math.max(previous.outputTokens, next.outputTokens),
        cacheReadInputTokens: Math.max(previous.cacheReadInputTokens, next.cacheReadInputTokens),
        cacheCreationInputTokens: Math.max(
          previous.cacheCreationInputTokens,
          next.cacheCreationInputTokens,
        ),
        webSearchRequests: Math.max(previous.webSearchRequests, next.webSearchRequests),
      }
    : next
  if (key !== null) ledger.set(key, total)
  const base = previous ?? withWebSearch({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  })
  const delta: Required<PricedTokens> = {
    inputTokens: total.inputTokens - base.inputTokens,
    outputTokens: total.outputTokens - base.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens - base.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens - base.cacheCreationInputTokens,
    webSearchRequests: total.webSearchRequests - base.webSearchRequests,
  }
  const isEmpty =
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cacheReadInputTokens === 0 &&
    delta.cacheCreationInputTokens === 0 &&
    delta.webSearchRequests === 0
  return { previous: previous ?? null, total, delta, isEmpty }
}

/**
 * Time actually worked between two consecutive messages, or 0 when the gap is a break rather than
 * a stretch of work. Non-positive gaps (out-of-order timestamps) contribute nothing.
 */
export function activeGapMs(previousMs: number | null, currentMs: number): number {
  if (previousMs === null) return 0
  const gap = currentMs - previousMs
  return gap > 0 && gap <= ACTIVE_SESSION_GAP_MS ? gap : 0
}

/**
 * Estimated dollars for one usage record, or `null` when the model can't be priced. Callers must
 * treat `null` as "exclude from the cost total", never as zero — a zero would quietly understate
 * spend for anyone running mostly third-party models.
 */
export function estimateCostUSD(
  model: string,
  tokens: PricedTokens,
  speed?: string,
): number | null {
  const tierCosts = resolveModelCosts(model, speed)
  if (!tierCosts) return null
  const costs = getPromptLengthCosts(
    tierCosts,
    tokens.inputTokens + tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens,
  )
  return (
    (tokens.inputTokens / 1_000_000) * costs.inputTokens +
    (tokens.outputTokens / 1_000_000) * costs.outputTokens +
    (tokens.cacheReadInputTokens / 1_000_000) * costs.promptCacheReadTokens +
    (tokens.cacheCreationInputTokens / 1_000_000) * costs.promptCacheWriteTokens +
    (tokens.webSearchRequests ?? 0) * costs.webSearchRequests
  )
}
