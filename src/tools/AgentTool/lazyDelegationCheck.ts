/**
 * Lazy-delegation detector for AgentTool prompts.
 *
 * Coordinator-mode prompts repeatedly warn the model not to write things
 * like "based on your findings" or "based on the research" when delegating
 * to a subagent — these phrases mean the coordinator is forwarding a
 * worker's report instead of synthesizing it. Workers can't see the
 * conversation, so a delegated prompt that references "the findings" gives
 * the worker no actionable context.
 *
 * Prompt-level reminders aren't enough; the model still slips. This module
 * lints AgentTool prompts at the call boundary and rejects ones that match
 * known lazy patterns. The error message tells the model what to do
 * instead — restate the concrete files, line numbers, and changes the
 * worker needs.
 *
 * Disabled with CLAUDE_CODE_LAZY_DELEGATION_CHECK=0.
 */

/**
 * Patterns that mean "I'm forwarding a worker's report instead of
 * synthesizing it." Each is conservative — it only fires on phrasing that
 * is almost always a delegation tell. Long substrings reduce false
 * positives from quoting / topic mentions.
 */
const LAZY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\bbased on (?:the |your |these |our )?(?:findings?|research|investigation|analysis|exploration|results?)\b/i,
    reason:
      'phrase "based on (the/your/these) findings/research/..." forwards a worker report instead of restating the work',
  },
  {
    pattern:
      /\b(?:as|per) (?:the |your |these |our )?(?:worker|agent|previous worker|previous agent|prior worker)\s+(?:found|discovered|reported|noted|mentioned|investigated|identified)\b/i,
    reason:
      'phrase "as/per the worker found/reported/..." defers to a previous worker without restating the concrete plan',
  },
  {
    pattern:
      /\bper (?:the |your )?(?:findings?|research|previous (?:worker|agent|investigation))\b/i,
    reason:
      'phrase "per the findings/research/previous worker" forwards a report instead of synthesizing it',
  },
  {
    pattern:
      /\baccording to (?:the |your |these )?(?:findings?|research|previous (?:worker|agent))\b/i,
    reason:
      'phrase "according to the findings/research/previous worker" defers instead of synthesizing',
  },
  {
    pattern:
      /\busing (?:the |your )?(?:findings?|research|previous (?:worker|agent))\b/i,
    reason:
      'phrase "using the findings/research/previous worker" defers instead of synthesizing',
  },
  {
    pattern:
      /\bfollow (?:up |through )?on (?:the |your )?(?:findings?|research|previous (?:worker|agent))\b/i,
    reason:
      'phrase "follow up on the findings/research" defers instead of synthesizing',
  },
  {
    pattern:
      /\bbased on what (?:you|the worker|the agent|we) (?:found|discovered|reported|saw)\b/i,
    reason:
      'phrase "based on what you/the worker found/reported" defers instead of synthesizing',
  },
  {
    pattern: /\bimplement (?:the |your )?(?:findings?|recommendations?)\b/i,
    reason:
      'phrase "implement the findings/recommendations" forwards a report instead of restating concrete file/line edits',
  },
]

export type LazyDelegationMatch = {
  /** Source-text snippet that triggered the rule. */
  phrase: string
  /** Human-readable reason — embedded in the error message back to the model. */
  reason: string
}

/**
 * Lint an AgentTool prompt for lazy-delegation tells.
 * Returns the first match, or null if the prompt is fine.
 */
export function detectLazyDelegation(prompt: string): LazyDelegationMatch | null {
  for (const { pattern, reason } of LAZY_PATTERNS) {
    const m = prompt.match(pattern)
    if (m && m[0]) {
      return { phrase: m[0], reason }
    }
  }
  return null
}

export function isLazyDelegationCheckEnabled(): boolean {
  return process.env.CLAUDE_CODE_LAZY_DELEGATION_CHECK !== '0'
}

/**
 * Format a model-facing error explaining the rejection and what to do.
 * Mirrors the tone of formatSpecialistRedirectMessage so the model
 * recognizes the corrective pattern.
 */
export function formatLazyDelegationError(
  match: LazyDelegationMatch,
  agentToolName: string,
): string {
  return (
    `${agentToolName} prompt rejected: lazy-delegation phrase "${match.phrase}" — ${match.reason}.\n\n` +
    `Workers cannot see your conversation. A prompt that says "based on the findings" or ` +
    `"as the worker reported" gives the new worker nothing to act on. Rewrite the prompt as a ` +
    `self-contained spec that restates:\n` +
    `  - the concrete files and line numbers involved\n` +
    `  - the specific change to make (or question to answer)\n` +
    `  - what "done" looks like\n\n` +
    `Then call ${agentToolName} again with the synthesized prompt. ` +
    `If you legitimately need to forward a previous worker's text verbatim (rare), set ` +
    `CLAUDE_CODE_LAZY_DELEGATION_CHECK=0 to disable this check.`
  )
}
