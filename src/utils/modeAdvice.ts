/**
 * Heuristic mode advisor for the coordinator/normal split.
 *
 * Coordinator mode forces the main agent to delegate every write through a
 * worker. That overhead (extra prompt prefill, extra round-trip) is worth it
 * for multi-step / multi-file work, but for "fix this typo" or pure Q&A it
 * just adds latency. Conversely, normal mode lets the main agent do
 * everything inline — fine for small tasks, but loses the parallel fan-out
 * + specialist routing that coordinator gives you on big work.
 *
 * This module reads a user's first message and produces a soft recommendation:
 * `normal` for small/conversational, `coordinator` for multi-file/long work.
 * It does NOT switch modes. It returns an advice object the caller can render
 * as a startup banner ("you started in coordinator but this looks small —
 * try Esc-Esc to switch") or a system-reminder appended to the system prompt.
 *
 * Pure heuristic — no network / LLM calls. Designed to be near-zero false-
 * negative for clearly-small tasks (Q&A, typo, single-line edit) and
 * near-zero false-positive for clearly-big ones (multi-module refactor,
 * migration, performance audit). Borderline cases return `undefined`
 * (no advice — let the user keep their default).
 */

export type SuggestedMode = 'normal' | 'coordinator'

export type ModeAdvice = {
  /** Recommended mode for this task. */
  suggestedMode: SuggestedMode
  /**
   * Heuristic confidence. Values:
   *   - high: strong signal in either direction (Q&A vs migration). The
   *     caller should surface the advice prominently.
   *   - medium: signal is present but not decisive. Caller can render a
   *     subtle banner.
   *   - low: omitted from the result; this enum has only the two values.
   */
  confidence: 'high' | 'medium'
  /** Short reasons that drove the suggestion — useful for the banner copy. */
  reasons: string[]
}

/**
 * Phrases that are unambiguous Q&A or trivial-edit signals. Hits push toward
 * `normal` mode.
 */
const NORMAL_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Pure questions about this codebase / language / config.
  {
    pattern: /^\s*(?:what|why|where|when|how|does|is|are|can|could|should|do|did)\s+\b(?:does|do|is|are|i|we|you|the|this|that|these|those|it)\b/i,
    reason: 'looks like a question (answers without delegation)',
  },
  // "Show me / explain / tell me" — read-only intents.
  {
    pattern:
      /^\s*(?:show|explain|describe|tell|walk)\s+(?:me\s+)?(?:through|about)?\b/i,
    reason: 'read-only / explanatory intent',
  },
  // Trivial single-spot edits.
  {
    pattern: /\b(?:fix|correct)\s+(?:the\s+|a\s+|that\s+)?(?:typo|spelling|misspelling|grammar)\b/i,
    reason: 'trivial typo / spelling fix',
  },
  // Rename a single identifier (the rename keyword in isolation, not as
  // part of "rename module X to Y").
  {
    pattern: /^\s*rename\s+\w[\w-]{0,40}\s+to\s+\w[\w-]{0,40}\s*\.?$/i,
    reason: 'single-symbol rename',
  },
  // Definitional questions.
  {
    pattern: /\bwhat\s+(?:is|does|are)\s+(?:the\s+|a\s+)?\w/i,
    reason: 'definition / explanation question',
  },
]

/**
 * Phrases that are unambiguous coordination signals. Hits push toward
 * `coordinator` mode.
 */
const COORDINATOR_SIGNALS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Migration / upgrade across versions or stacks.
  {
    pattern: /\bmigrat(?:e|ion|ing)\b|\bupgrade\s+(?:from|to)\b/i,
    reason: 'migration / upgrade work',
  },
  // Multi-file refactor.
  {
    pattern: /\brefactor(?:ing)?\b.*\b(?:multiple|several|across|throughout|whole|entire|all|every)\b/i,
    reason: 'cross-file refactor',
  },
  // Performance audit / investigation language.
  {
    pattern: /\b(?:audit|investigate|analyz(?:e|ing)\s+(?:the\s+)?performance)\b|\bbottleneck/i,
    reason: 'audit / investigation work',
  },
  // Implement new feature with clear scope.
  {
    pattern:
      /\b(?:implement|build|add|design)\b.*\b(?:feature|module|service|workflow|pipeline|integration|system|subsystem)\b/i,
    reason: 'feature / module implementation',
  },
  // Mentions of multiple components by name (very rough).
  {
    pattern: /\bacross\s+(?:multiple|several|the)\s+(?:files?|modules?|services?|packages?)\b/i,
    reason: 'work spans multiple components',
  },
  // End-to-end / full-stack work.
  {
    pattern: /\bend[\s-]?to[\s-]?end\b|\bfull[\s-]?stack\b/i,
    reason: 'cross-stack work',
  },
  // Verification + implementation in one ask (classic coordinator pattern).
  {
    pattern: /\b(?:and\s+)?(?:verify|test).{0,40}\b(?:and|then)\b.{0,40}\b(?:fix|implement|update|deploy|merge|ship)\b/i,
    reason: 'mixes implementation and verification',
  },
]

/**
 * Soft length / scope estimators. These nudge the suggestion when the regex
 * signals are silent. Weights are sub-1 so a single nudge never decides on
 * its own — it has to combine with another signal to clear the threshold.
 */
function lengthScore(text: string): { score: number; reason?: string } {
  const len = text.trim().length
  if (len === 0) return { score: 0 }
  // Very short messages (< 40 chars) lean toward normal — half-weight so a
  // bare "look at this code" doesn't auto-decide on its own. The threshold
  // is tight (40 not 60) so a 50-char "Upgrade from React X to Y in app Z"
  // isn't penalised before its coordinator signal is counted.
  if (len < 40) {
    return { score: -0.5, reason: 'short message (< 40 chars)' }
  }
  // Long detailed asks (> 600 chars) lean toward coordinator. Full weight —
  // a 600-char prompt is almost always multi-step.
  if (len > 600) {
    return { score: 1, reason: 'long, detailed task description' }
  }
  return { score: 0 }
}

/**
 * Count how many distinct file-path-like or path-segment tokens appear in
 * the message. Three or more strongly suggests cross-file work.
 */
function fileMentionScore(text: string): { score: number; reason?: string } {
  // Match tokens that look like a path: contains a / or \ and a filename
  // with an extension. Conservative — counts unique tokens only.
  const matches = text.match(
    /(?<![\w.])(?:\.\.?\/|\/|[A-Z]:\\)?[\w@.-]+(?:[\\/][\w@.-]+){1,}\.[a-z]{1,5}\b/gi,
  )
  if (!matches) return { score: 0 }
  const unique = new Set(matches)
  if (unique.size >= 3) {
    return { score: 1, reason: `mentions ${unique.size} files` }
  }
  if (unique.size === 1) {
    // A single file mention IS a normal signal on its own — "fix the bug
    // in src/x.ts" rarely needs coordinator overhead. Full weight.
    return { score: -1, reason: 'mentions exactly one file' }
  }
  return { score: 0 }
}

/**
 * Analyze a candidate first-message and recommend a mode.
 *
 * Returns `undefined` for borderline / unclear messages — the caller should
 * keep the user's current mode unchanged in that case.
 *
 * Inputs:
 *   text — raw user message (string). Empty / whitespace-only returns
 *   undefined.
 *
 * Algorithm:
 *   1. Sum signal hits per direction.
 *   2. Add length and file-mention nudges.
 *   3. If |score| >= 1, return advice with confidence based on |score|.
 *   4. Otherwise undefined.
 */
export function analyzeFirstMessageForMode(text: string): ModeAdvice | undefined {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return undefined

  const reasons: string[] = []
  let score = 0

  for (const { pattern, reason } of NORMAL_SIGNALS) {
    if (pattern.test(trimmed)) {
      score -= 1
      reasons.push(`normal: ${reason}`)
    }
  }
  for (const { pattern, reason } of COORDINATOR_SIGNALS) {
    if (pattern.test(trimmed)) {
      score += 1
      reasons.push(`coordinator: ${reason}`)
    }
  }
  const lenResult = lengthScore(trimmed)
  if (lenResult.reason) {
    score += lenResult.score
    reasons.push(`${lenResult.score < 0 ? 'normal' : 'coordinator'}: ${lenResult.reason}`)
  }
  const fileResult = fileMentionScore(trimmed)
  if (fileResult.reason) {
    score += fileResult.score
    reasons.push(`${fileResult.score < 0 ? 'normal' : 'coordinator'}: ${fileResult.reason}`)
  }

  if (score <= -1) {
    return {
      suggestedMode: 'normal',
      confidence: score <= -2 ? 'high' : 'medium',
      reasons,
    }
  }
  if (score >= 1) {
    return {
      suggestedMode: 'coordinator',
      confidence: score >= 2 ? 'high' : 'medium',
      reasons,
    }
  }
  return undefined
}

/**
 * Format a banner string for a mismatch between the active mode and the
 * recommendation. Returns null when there's no mismatch (so callers can
 * skip rendering without conditionals).
 *
 * `currentMode` is what the CLI started in; `advice` is the analyzer
 * output for the user's first message.
 */
export function formatModeAdviceBanner(
  currentMode: SuggestedMode,
  advice: ModeAdvice | undefined,
): string | null {
  if (!advice) return null
  if (advice.suggestedMode === currentMode) return null

  const reasonText = advice.reasons.length > 0
    ? ` (${advice.reasons.slice(0, 2).join('; ')})`
    : ''

  if (advice.suggestedMode === 'normal') {
    return (
      `This session is in coordinator mode but the task looks small${reasonText}. ` +
      `Coordinator mode routes every change through a worker, which adds latency ` +
      `for quick tasks. A normal session (launched without CLAUDE_CODE_COORDINATOR_MODE=1) ` +
      `would be faster — or stay in coordinator mode if you want the structured worker delegation.`
    )
  }
  return (
    `This session is in normal mode but the task looks like multi-step work${reasonText}. ` +
    `Coordinator mode (launched with CLAUDE_CODE_COORDINATOR_MODE=1) runs research, ` +
    `implementation, and verification in parallel via specialist workers — or stay in ` +
    `normal mode if you prefer to keep direct, single-agent control.`
  )
}
