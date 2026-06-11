/**
 * Per-session circuit breaker for repeated subagent invocations.
 *
 * The architecture has a known failure mode where a verifier — or any
 * specialist — can loop. The classic case is `verification: FAIL → fix
 * → verification: FAIL → fix → ...` where the fix doesn't actually
 * address what the verifier is flagging. Without a cap the loop only
 * stops when the model gives up or the token budget runs out.
 *
 * This module imposes a per-session cap on each built-in agent type.
 * When the cap is exceeded the next invocation throws a tool error.
 * The model sees the error, surfaces it to the user, and the user can
 * either authorise more retries (raise the cap via env) or steer the
 * task differently.
 *
 * Caps are intentionally generous so the gate only fires on pathological
 * loops, not on normal multi-step work. Verification is capped tighter
 * because verifier loops are the documented failure mode.
 */

import { getSessionId } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

type SessionCounters = Map<string, number>

const STATE = new Map<SessionId, SessionCounters>()

const FALLBACK_LIMIT = 8

/**
 * Per-agent default caps. Tighter for `verification` because the
 * verifier-loop pattern is the primary failure mode this gate exists
 * to catch. Anything not listed falls back to FALLBACK_LIMIT.
 */
const DEFAULT_LIMITS: Readonly<Record<string, number>> = {
  verification: 5,
}

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

export type InvocationCheckResult = {
  /** Total invocations of this type in this session, including this one. */
  count: number
  /** Cap currently in effect for this type. */
  limit: number
  /** True when this invocation pushes the count past the cap. */
  capped: boolean
  /**
   * True when this invocation is the LAST one allowed before the cap
   * fires. (count === limit and !capped). Callers can use this to surface
   * a one-shot system reminder so the model has a chance to switch
   * strategy before the next invocation is hard-blocked.
   */
  nearLimit: boolean
}

/**
 * Increment the counter for `agentType` in the current session and
 * return the post-increment count plus whether the cap was crossed.
 *
 * Pure side effect: bumps the counter even when capped, so repeated
 * over-cap calls keep the count growing for analytics. Callers should
 * throw when `capped` is true.
 */
export function noteInvocation(agentType: string): InvocationCheckResult {
  const sessionId = getSessionId()
  let counters = STATE.get(sessionId)
  if (!counters) {
    counters = new Map<string, number>()
    STATE.set(sessionId, counters)
  }
  const next = (counters.get(agentType) ?? 0) + 1
  counters.set(agentType, next)
  const limit = getLimitFor(agentType)
  const capped = next > limit
  // nearLimit fires once, on the last allowed invocation (next === limit).
  // Skip on small caps where it would coincide with the very first call:
  // a "you're near the limit" reminder on call #1 is noise, not signal.
  const nearLimit = !capped && next === limit && limit >= 2
  return { count: next, limit, capped, nearLimit }
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
 * Format the user-facing error string when an invocation goes over cap.
 * Kept separate so call sites can compose it into Tool errors without
 * re-importing AGENT_TOOL_NAME etc.
 */
export function formatLimitExceededMessage(
  agentType: string,
  result: InvocationCheckResult,
): string {
  const envName = `CLAUDE_CODE_AGENT_LIMIT_${agentType
    .replace(/[-/]/g, '_')
    .toUpperCase()}`
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
): ReadonlyMap<string, number> | undefined {
  return STATE.get(sessionId)
}
