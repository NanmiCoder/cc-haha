import {
  COST_FABLE_51,
  COST_HAIKU_35,
  COST_HAIKU_45,
  COST_TIER_3_15,
  COST_TIER_5_25,
  COST_TIER_10_50,
  COST_TIER_15_75,
  COST_TIER_30_150,
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
  ['claude-sonnet-5', COST_TIER_3_15],
  ['claude-sonnet-4-6', COST_TIER_3_15],
  ['claude-sonnet-4-5', COST_TIER_3_15],
  ['claude-sonnet-4', COST_TIER_3_15],
  ['claude-3-7-sonnet', COST_TIER_3_15],
  ['claude-3-5-sonnet', COST_TIER_3_15],
  ['claude-haiku-4-5', COST_HAIKU_45],
  ['claude-3-5-haiku', COST_HAIKU_35],
  ['claude-3-haiku', COST_HAIKU_35],
  ['claude-3-opus', COST_TIER_15_75],
]

// Fast mode bills at its own rate on the models that offer it; everything else ignores `speed`.
const FAST_MODE_TIERS: ReadonlyArray<readonly [prefix: string, costs: ModelCosts]> = [
  ['claude-opus-5', COST_TIER_10_50],
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
  const costs = resolveModelCosts(model, speed)
  if (!costs) return null
  return (
    (tokens.inputTokens / 1_000_000) * costs.inputTokens +
    (tokens.outputTokens / 1_000_000) * costs.outputTokens +
    (tokens.cacheReadInputTokens / 1_000_000) * costs.promptCacheReadTokens +
    (tokens.cacheCreationInputTokens / 1_000_000) * costs.promptCacheWriteTokens +
    (tokens.webSearchRequests ?? 0) * costs.webSearchRequests
  )
}
