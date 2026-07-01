/**
 * Heuristic detection of "this prompt clearly belongs to a specialist".
 *
 * The default fallback for an `Agent` tool call without an explicit
 * `subagent_type` is `general-purpose` — a permissive agent that will
 * cheerfully take on review/security/perf/refactor/migration work it
 * isn't actually specialised for. That produces lower-quality output
 * than the dedicated specialist would, and burns the more expensive
 * default model where the specialist would have used `inherit` or a
 * smaller model.
 *
 * This module tries to spot the obvious "you should have routed this
 * to a specialist" cases via keyword matching on the prompt and gently
 * hard-fails the call so the main agent retries with the right type.
 *
 * The matching is intentionally narrow: only fire on phrases that
 * strongly imply a specific specialist. Vague prompts ("look at this
 * code") fall through to the default. Disable with
 * `CLAUDE_CODE_GP_DEFAULT_STRICT=0` if the heuristic gets in the way.
 */

type SpecialistHint = {
  /**
   * Phrase that strongly signals the prompt is intended for one
   * specialist. Anchored with word boundaries where useful so we don't
   * match "audited" inside "audited dependencies" when the user really
   * just wants research.
   */
  pattern: RegExp
  /** The `agentType` of the specialist to suggest. */
  agentType: string
}

/**
 * Order matters — earlier entries win. Place narrower / higher-stakes
 * hints first (security before code-review, verification before debug).
 */
const SPECIALIST_HINTS: ReadonlyArray<SpecialistHint> = [
  // Security review — narrow, high-stakes
  {
    pattern:
      /\b(security[-\s]+(?:review|audit)|vulnerab(?:le|ility|ilities)|sql\s+injection|xss\b|ssrf\b|csrf\b|auth(?:n|z|orization|entication)\s+(?:bypass|gap|hole)|sanitis|sanitiz|secret(?:s)?\s+(?:in|leak)|attack\s+path|audit\s+(?:secret|password|token|credential|cred|api[-\s]key)s?\b)\b/i,
    agentType: 'security-reviewer',
  },
  // Code review — explicit "review my change"
  {
    pattern:
      /\b(code[-\s]+review|review\s+(?:my|this|these|the)\s+(?:change(?:s)?|code|diff|patch|pr|pull\s+request))\b/i,
    agentType: 'code-reviewer',
  },
  // Verification (the adversarial validator)
  {
    pattern:
      /\b(adversarial\s+(?:verification|validation|check)|verify\s+(?:that\s+)?(?:the|my)\s+(?:change|fix|implementation)\s+(?:works|is\s+correct))\b/i,
    agentType: 'verification',
  },
  // Debugger — find root cause
  {
    pattern:
      /\b(root\s+cause|reproduce\s+the\s+bug|why\s+(?:is\s+\S+|does\s+(?:\S+\s+){0,4}\S+)\s+(?:fail|crash|throw|error|break|broken|hang)|debug\s+(?:why|the))\b/i,
    agentType: 'debugger',
  },
  // Refactor
  {
    pattern:
      /\b(refactor|deslop|extract\s+(?:method|function|component)|de[-\s]?duplicate|simplify\s+(?:this|the)\s+(?:code|control[-\s]flow))\b/i,
    agentType: 'refactor',
  },
  // Migration / upgrade
  {
    pattern:
      /\b(migrate\s+(?:from|to)|migration\s+(?:from|to|guide)|upgrade\s+(?:from|to)|(?:major|breaking)\s+(?:version|change)\s+upgrade)\b/i,
    agentType: 'migration',
  },
  // Docs
  {
    pattern:
      /\b(write|update|draft|generate)\s+(?:the\s+)?(?:doc|docs|documentation|readme|docstring|api\s+reference|jsdoc|tsdoc)\b/i,
    agentType: 'docs-writer',
  },
  // Performance
  {
    pattern:
      /\b(performance\s+(?:problem|issue|investigation|tuning)|profil(?:e|ing)\s+(?:the|my)|n\+1|bundle[-\s]size|memory\s+leak|too\s+slow|optimi[sz]e\s+(?:the|this|performance))\b/i,
    agentType: 'performance',
  },
  // Commit / PR description
  {
    pattern:
      /\b(write\s+(?:a\s+)?(?:commit\s+message|pr\s+description|pull[-\s]request\s+description|merge[-\s]request\s+description)|draft\s+(?:a\s+)?(?:pr|pull\s+request|merge\s+request))\b/i,
    agentType: 'commit-pr',
  },
  // Test authoring
  {
    pattern:
      /\b(write\s+(?:a\s+)?(?:unit\s+test|regression\s+test|test\s+for)|add\s+(?:tests?|coverage)\s+for|cover\s+this\s+with\s+a?\s*test)\b/i,
    agentType: 'test-author',
  },
]

/**
 * If the prompt looks like a strong match for a specialist that's
 * actually available in the current session, return its agentType.
 * Otherwise return undefined (caller proceeds with default routing).
 */
export function suggestSpecialist(
  prompt: string,
  availableAgentTypes: ReadonlySet<string>,
): string | undefined {
  for (const hint of SPECIALIST_HINTS) {
    if (!availableAgentTypes.has(hint.agentType)) continue
    if (hint.pattern.test(prompt)) return hint.agentType
  }
  return undefined
}

/**
 * Build the error message shown when the general-purpose default is
 * refused in favour of a specialist.
 *
 * IMPORTANT: this string is returned to the model as a tool error and
 * becomes part of its context. It must NOT contain `key="value"`
 * attribute-style fragments (e.g. `subagent_type="code-reviewer"`).
 * Observed in live testing: when the error embedded that shape, the
 * model copied it into a *textual* `<tool_use name="Agent">{...}` block
 * instead of issuing a real tool call, and every subsequent Agent call
 * in that session degraded to text. Phrase the guidance as prose that
 * names the parameter and value without the assignment-and-quotes form.
 */
export function formatSpecialistRedirectMessage(
  suggested: string,
  agentToolName: string,
): string {
  return (
    `This task looks like a job for the ${suggested} specialist rather than the general-purpose default. ` +
    `Re-call ${agentToolName} with the subagent_type parameter set to ${suggested}. ` +
    `If general-purpose really is the right choice, set the subagent_type parameter to general-purpose explicitly. ` +
    `(Disable this guard by setting the env var CLAUDE_CODE_GP_DEFAULT_STRICT to 0.)`
  )
}

/** Exported for tests. */
export const _SPECIALIST_HINTS_FOR_TESTS = SPECIALIST_HINTS
