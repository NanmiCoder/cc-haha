/**
 * Per-session circuit breaker for repeated subagent invocations.
 *
 * The architecture has a known failure mode where a verifier — or any
 * specialist — can loop. The classic case is `verification: FAIL → fix
 * → verification: FAIL → fix → ...` where the fix doesn't actually
 * address what the verifier is flagging. Without a cap the loop only
 * stops when the model gives up or the token budget runs out.
 *
 * This module imposes two complementary gates per agent type:
 *
 *  1. A **total invocation cap** per session. Generous so legitimate
 *     multi-step work (e.g. five PRs in a row each running a verifier)
 *     does not trip the gate. Defends against any loop, including ones
 *     where the parent rewrites prompts so each call looks different.
 *
 *  2. A **consecutive-failure streak cap**. When a subagent's result
 *     reports FAIL `STREAK_FAIL_THRESHOLD` times in a row without a
 *     PASS in between, we cap immediately, regardless of total count.
 *     This catches pathological loops fast (the documented failure
 *     mode) while leaving plenty of headroom for normal work where
 *     verifiers usually return PASS.
 *
 * Caps are intentionally generous so the gate only fires on
 * pathological loops, not on normal multi-step work. When the cap is
 * exceeded the next invocation throws a tool error. The model sees the
 * error, surfaces it to the user, and the user can either authorise
 * more retries (raise the cap via env) or steer the task differently.
 */

import { getSessionId } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

type SessionCounters = {
  /** Total successful + failed invocations of this agent type, capped by the total limit. */
  total: Map<string, number>
  /** Consecutive FAIL streak per agent type. Reset to 0 by any PASS. */
  failStreak: Map<string, number>
}

const STATE = new Map<SessionId, SessionCounters>()

const FALLBACK_LIMIT = 8

/**
 * Per-agent default total caps. Anything not listed falls back to
 * FALLBACK_LIMIT.
 *
 * `verification` was 5 historically; that turned out to be too tight
 * for legitimate multi-PR work (one verification per PR ⇒ 5 PRs and
 * the gate fires). Raised to 12. The streak gate below is the real
 * defence against verifier loops, so we can afford a generous total.
 *
 * `fork` stays at 10 — coordinator-research-fork-on sessions that
 * fail to converge could burn through dozens of cache-shared forks
 * before the budget runs out, and they don't have a verdict-style
 * PASS/FAIL signal that would let the streak gate help.
 */
const DEFAULT_LIMITS: Readonly<Record<string, number>> = {
  verification: 12,
  fork: 10,
}

/**
 * Number of consecutive FAILs (no PASS in between) that trips the
 * streak gate. 3 is a strong loop signal — one or two FAILs in a row
 * are normal during fix-and-retry; three with no progress means the
 * approach probably needs to change.
 */
const STREAK_FAIL_THRESHOLD = 3

function envLimitFor(agentType: string): number | undefined {
  // Translate `code-reviewer` → CLAUDE_CODE_AGENT_LIMIT_CODE_REVIEWER
  const envName = `CLAUDE_CODE_AGENT_LIMIT_${agentType
    .replace(/[-/]/g, '_')
    .toUpperCase()}`
  const raw = process.env[envName]
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

export function getLimitFor(agentType: string): number {
  return envLimitFor(agentType) ?? DEFAULT_LIMITS[agentType] ?? FALLBACK_LIMIT
}

export function isLimiterDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIMITER_OFF)
}

export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN'

export type InvocationCheckResult = {
  /** Total invocations of this type in this session, including this one. */
  count: number
  /** Cap currently in effect for this type. */
  limit: number
  /** Current consecutive-FAIL streak before this invocation runs. */
  failStreak: number
  /** Streak threshold currently in effect. */
  failStreakLimit: number
  /** True when this invocation pushes the count past the cap. */
  capped: boolean
  /**
   * Reason this invocation was capped. 'total' means the cumulative
   * total cap fired; 'streak' means consecutive FAILs tripped the
   * fast-fail gate; 'none' means not capped.
   */
  cappedReason: 'none' | 'total' | 'streak'
  /**
   * True when this invocation is the LAST one allowed before the cap
   * fires. (count === limit and !capped). Callers can use this to surface
   * a one-shot system reminder so the model has a chance to switch
   * strategy before the next invocation is hard-blocked.
   */
  nearLimit: boolean
}

function getOrCreateCounters(sessionId: SessionId): SessionCounters {
  let counters = STATE.get(sessionId)
  if (!counters) {
    counters = { total: new Map(), failStreak: new Map() }
    STATE.set(sessionId, counters)
  }
  return counters
}

/**
 * Increment the counter for `agentType` in the current session and
 * return the post-increment count plus whether either gate fired.
 *
 * Pure side effect: bumps the counter even when capped, so repeated
 * over-cap calls keep the count growing for analytics. Callers should
 * throw when `capped` is true.
 *
 * The streak gate fires *before* incrementing the total (it is the
 * earlier defence): if the consecutive-FAIL streak already meets the
 * threshold when this call begins, we cap immediately. Otherwise we
 * apply the total cap as before.
 */
export function noteInvocation(agentType: string): InvocationCheckResult {
  const sessionId = getSessionId()
  const counters = getOrCreateCounters(sessionId)
  const next = (counters.total.get(agentType) ?? 0) + 1
  counters.total.set(agentType, next)

  const limit = getLimitFor(agentType)
  const failStreak = counters.failStreak.get(agentType) ?? 0
  const failStreakLimit = STREAK_FAIL_THRESHOLD

  // Streak gate: an existing run of consecutive FAILs at or above the
  // threshold means the previous attempts already failed and the parent
  // is about to retry without success in between. Cap before doing more
  // work. (failStreak is read pre-increment; the current invocation has
  // not had its outcome recorded yet, so `>=` is correct.)
  const streakCapped = failStreak >= failStreakLimit
  const totalCapped = next > limit

  const capped = streakCapped || totalCapped
  const cappedReason: 'none' | 'total' | 'streak' = streakCapped
    ? 'streak'
    : totalCapped
      ? 'total'
      : 'none'

  // nearLimit fires once, on the last allowed invocation (next === limit).
  // Skip on small caps where it would coincide with the very first call:
  // a "you're near the limit" reminder on call #1 is noise, not signal.
  const nearLimit = !capped && next === limit && limit >= 2

  return {
    count: next,
    limit,
    failStreak,
    failStreakLimit,
    capped,
    cappedReason,
    nearLimit,
  }
}

/**
 * Record the outcome of a subagent invocation. PASS clears the
 * consecutive-FAIL streak; FAIL extends it; UNKNOWN treats the run
 * conservatively as PASS so subagents that don't emit a verdict are
 * not punished. Total count is unaffected — that is the
 * cumulative-cap concern.
 */
export function noteOutcome(agentType: string, verdict: Verdict): void {
  const sessionId = getSessionId()
  const counters = getOrCreateCounters(sessionId)

  if (verdict === 'FAIL') {
    counters.failStreak.set(agentType, (counters.failStreak.get(agentType) ?? 0) + 1)
  } else {
    // PASS or UNKNOWN — break the streak. UNKNOWN is treated as a
    // soft-PASS to avoid penalising subagents that simply don't emit a
    // structured verdict (e.g. one-shot research / Explore). The total
    // cap still bounds them.
    counters.failStreak.set(agentType, 0)
  }
}

/**
 * Heuristic verdict parser for subagent text output. Looks for an
 * explicit "VERDICT: PASS|FAIL|PARTIAL|CHANGES_NEEDED" line, common in
 * the verification / code-reviewer / security-reviewer skills, plus a
 * few well-defined synonyms. Anything else returns UNKNOWN.
 *
 * Conservative on purpose: PASS-shaped outputs that omit the keyword
 * should not extend the FAIL streak. The verifier loops we want to
 * catch always end in an explicit FAIL/CHANGES_NEEDED, so missing the
 * keyword on a PASS-shaped output is a safe miss; missing it on a
 * FAIL-shaped output would be a false PASS, but in practice the
 * verifier skill always prints the verdict line.
 */
export function parseVerdict(text: string | null | undefined): Verdict {
  if (!text) return 'UNKNOWN'

  // Take the last 4 KB — verdict lines live near the end of the report
  // and scanning the whole transcript wastes time on huge outputs.
  const tail = text.length > 4096 ? text.slice(text.length - 4096) : text

  // Match VERDICT: <token> on a line of its own (the documented format).
  // Allow optional markdown bullets / leading whitespace.
  const verdictLine = /(?:^|\n)[\s>*\-#]*VERDICT\s*:\s*([A-Z_/]+)/i.exec(tail)
  if (verdictLine) {
    const token = verdictLine[1]!.toUpperCase()
    if (token === 'PASS' || token === 'APPROVE') return 'PASS'
    if (
      token === 'FAIL' ||
      token === 'PARTIAL' ||
      token === 'CHANGES_NEEDED' ||
      token === 'UNCONFIRMED'
    ) {
      return 'FAIL'
    }
    return 'UNKNOWN'
  }

  // Common standalone summary lines used by some skills.
  if (/(?:^|\n)\s*SECURITY\s*:\s*PASS\b/i.test(tail)) return 'PASS'
  if (/(?:^|\n)\s*SECURITY\s*:\s*CHANGES_NEEDED\b/i.test(tail)) return 'FAIL'
  if (/(?:^|\n)\s*PLAN_REVIEW\s*:\s*APPROVE\b/i.test(tail)) return 'PASS'
  if (/(?:^|\n)\s*PLAN_REVIEW\s*:\s*CHANGES_NEEDED\b/i.test(tail)) return 'FAIL'
  if (/(?:^|\n)\s*ROOT CAUSE\s*:\s*FOUND\b/i.test(tail)) return 'PASS'
  if (/(?:^|\n)\s*ROOT CAUSE\s*:\s*UNCONFIRMED\b/i.test(tail)) return 'FAIL'

  return 'UNKNOWN'
}

/**
 * Format a one-shot reminder injected on the LAST allowed invocation.
 * Surfaced to the model as a `<system-reminder>` text block prepended to
 * the subagent's result, so the model reads "you're at the cap" alongside
 * the worker's report and can decide to change tack instead of retrying.
 */
export function formatNearLimitWarning(
  agentType: string,
  result: InvocationCheckResult,
): string {
  const envName = `CLAUDE_CODE_AGENT_LIMIT_${agentType
    .replace(/[-/]/g, '_')
    .toUpperCase()}`
  return (
    `<system-reminder>\n` +
    `Subagent '${agentType}' invocation ${result.count} of ${result.limit} (the cap). ` +
    `One more call to this subagent type in this session will be blocked. ` +
    `Repeated calls without progress usually mean the approach needs to change — ` +
    `consider a different specialist, narrowing the scope, or asking the user. ` +
    `If you must keep retrying, raise the cap via ${envName}=N or disable the ` +
    `gate with CLAUDE_CODE_AGENT_LIMITER_OFF=1.\n` +
    `</system-reminder>`
  )
}

/**
 * Format the user-facing error string when an invocation goes over a
 * cap. Differentiates between the total cap and the consecutive-FAIL
 * streak so the user can see *which* gate fired and act accordingly.
 */
export function formatLimitExceededMessage(
  agentType: string,
  result: InvocationCheckResult,
): string {
  const envName = `CLAUDE_CODE_AGENT_LIMIT_${agentType
    .replace(/[-/]/g, '_')
    .toUpperCase()}`

  if (result.cappedReason === 'streak') {
    return (
      `Subagent '${agentType}' has reported FAIL ${result.failStreak} times in a row ` +
      `(streak cap is ${result.failStreakLimit}). Stop and consult the user — ` +
      `repeated FAIL/CHANGES_NEEDED outcomes without a PASS in between are the ` +
      `verifier-loop pattern this gate exists to catch. A PASS verdict from this ` +
      `agent type clears the streak. If the user authorises more attempts, raise ` +
      `the total cap via ${envName}=N or disable this guard with ` +
      `CLAUDE_CODE_AGENT_LIMITER_OFF=1.`
    )
  }

  return (
    `Subagent '${agentType}' has been invoked ${result.count} times in this session, ` +
    `exceeding the cap of ${result.limit}. Stop and consult the user before invoking it again — ` +
    `repeated calls without progress are usually a sign the approach needs to change. ` +
    `If the user authorises more attempts, raise the cap via ${envName}=N or disable this guard with ` +
    `CLAUDE_CODE_AGENT_LIMITER_OFF=1.`
  )
}

/** Test helper. */
export function _resetLimiterState(): void {
  STATE.clear()
}

/** Test helper. */
export function _getLimiterStateSnapshot(
  sessionId: SessionId,
): { total: ReadonlyMap<string, number>; failStreak: ReadonlyMap<string, number> } | undefined {
  const c = STATE.get(sessionId)
  if (!c) return undefined
  return { total: c.total, failStreak: c.failStreak }
}
