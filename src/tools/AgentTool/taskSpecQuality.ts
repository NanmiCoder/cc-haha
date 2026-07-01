/**
 * Task-spec quality assessor for AgentTool worker prompts.
 *
 * This is the positive-space complement to lazyDelegationCheck: where that
 * module blacklists prompts that *forward* a previous worker's report
 * ("based on the findings, fix it"), this one whitelists the dimensions a
 * good self-contained worker brief should have — because workers can't see
 * the coordinator's conversation and need everything in the prompt.
 *
 * The roadmap item is a full structured task spec
 * ({goal, success_criteria, files_in_scope, ...}). That would require
 * adding a new tool-input parameter, which changes the model-facing schema
 * and is a larger, separate change. This module is the validation half: a
 * pure heuristic that scores an existing free-text prompt against the same
 * dimensions, so we can warn on clearly under-specified briefs without
 * touching the tool contract.
 *
 * Integration is OPT-IN and coordinator-only
 * (CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT=1). Unlike the lazy-delegation
 * blacklist (a specific bad pattern, safe to default on), "this spec is too
 * thin" is fuzzier and more prone to false positives ("run the test suite"
 * is a perfectly fine one-liner), so it stays off unless a team asks for it.
 */

export type TaskSpecQuality = 'well-specified' | 'adequate' | 'underspecified'

export type TaskSpecAssessment = {
  /** Count of satisfied dimensions (0..4). */
  score: number
  /** Mentions a concrete file path or code identifier. */
  hasFileReference: boolean
  /** Starts with / contains a concrete imperative action verb. */
  hasConcreteAction: boolean
  /** States what "done" looks like (criteria, expected output, verification). */
  hasSuccessCriteria: boolean
  /** Long enough to plausibly carry context (not a bare fragment). */
  hasAdequateDetail: boolean
  /** Human-readable list of the dimensions that are missing. */
  missing: string[]
  /** Overall bucket derived from the signals. */
  quality: TaskSpecQuality
}

// A concrete file path (has a slash + extension), OR a dotted/extensioned
// filename, OR a backticked code span, OR an obvious symbol-ish token.
const FILE_REFERENCE = new RegExp(
  [
    // path with separator + extension: src/auth/validate.ts, a\b.py
    String.raw`(?:[\w@.-]+[\\/])+[\w@.-]+\.[a-z]{1,5}\b`,
    // bare filename with a known-ish extension at a word boundary
    String.raw`\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|cs|json|ya?ml|toml|md|sh|ps1|sql|css|scss|html)\b`,
    // backticked code span: `someFn`, `Foo.bar`
    String.raw`\`[^\`]+\``,
  ].join('|'),
  'i',
)

// Imperative action verbs that signal a concrete task (not a vague ask).
const CONCRETE_ACTION =
  /\b(?:add|fix|implement|build|create|update|change|modify|remove|delete|refactor|rename|move|replace|write|run|investigate|find|locate|verify|test|document|migrate|upgrade|extract|inline|wire|connect|split|merge|revert|bump|patch|configure|set\s+up|reproduce|profile|optimi[sz]e|review|audit|check|ensure|generate|draft)\b/i

// Phrases that state success criteria / a definition of done / expected output.
const SUCCESS_CRITERIA =
  /\b(?:should|must|so\s+that|expect(?:ed|s|ing)?|ensure|verify|confirm|return(?:s|ing)?|report(?:s|ing)?\b|until|done\s+when|pass(?:es|ing)?\b|fail(?:s|ing)?\b|then\s+(?:commit|report|run|verify)|output\s+(?:should|must|is)|acceptance|criteria|definition\s+of\s+done|exit\s+code|status\s+\d{3})\b/i

const ADEQUATE_DETAIL_CHARS = 80

export function assessTaskSpec(prompt: string): TaskSpecAssessment {
  const text = (prompt ?? '').trim()

  const hasFileReference = FILE_REFERENCE.test(text)
  const hasConcreteAction = CONCRETE_ACTION.test(text)
  const hasSuccessCriteria = SUCCESS_CRITERIA.test(text)
  const hasAdequateDetail = text.length >= ADEQUATE_DETAIL_CHARS

  const dimensions: Array<[boolean, string]> = [
    [hasConcreteAction, 'a concrete action (what to do)'],
    [hasFileReference, 'a file path or code symbol (where)'],
    [hasSuccessCriteria, 'a definition of done (what "complete" looks like)'],
    [hasAdequateDetail, 'enough detail to act without the conversation'],
  ]
  const missing = dimensions.filter(([ok]) => !ok).map(([, label]) => label)
  const score = dimensions.length - missing.length

  // Bucketing:
  //   well-specified: 3+ dimensions, including a concrete action.
  //   underspecified: no action at all, OR a single short fragment with
  //     neither a file nor success criteria (a worker can't act on it).
  //   adequate: everything in between.
  let quality: TaskSpecQuality
  if (hasConcreteAction && score >= 3) {
    quality = 'well-specified'
  } else if (
    !hasConcreteAction ||
    (!hasFileReference && !hasSuccessCriteria && !hasAdequateDetail)
  ) {
    quality = 'underspecified'
  } else {
    quality = 'adequate'
  }

  return {
    score,
    hasFileReference,
    hasConcreteAction,
    hasSuccessCriteria,
    hasAdequateDetail,
    missing,
    quality,
  }
}

/**
 * Opt-in, coordinator-only. Off unless explicitly enabled, because the
 * "thin spec" heuristic is fuzzier than the lazy-delegation blacklist and
 * a hard failure on a false positive is more annoying than helpful.
 */
export function isTaskSpecStrictEnabled(): boolean {
  return process.env.CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT === '1'
}

/**
 * Model-facing error for a clearly under-specified worker brief. Lists the
 * missing dimensions so the coordinator can rewrite the prompt instead of
 * delegating a vague task a worker can't execute.
 *
 * Mirrors formatSpecialistRedirectMessage's prose style — no `key="value"`
 * fragments (those have been observed to make the model emit textual
 * tool_use blocks).
 */
export function formatThinSpecError(
  assessment: TaskSpecAssessment,
  agentToolName: string,
): string {
  const missingList = assessment.missing.map(m => `  - ${m}`).join('\n')
  return (
    `${agentToolName} prompt looks under-specified for a worker that cannot see this conversation. ` +
    `It is missing:\n${missingList}\n\n` +
    `Rewrite the prompt as a self-contained brief: state the concrete action, the files or symbols ` +
    `involved, and what "done" looks like (tests to run, output to report, behavior to verify). ` +
    `Then re-call ${agentToolName}. ` +
    `(This strict check is opt-in; disable it by unsetting CLAUDE_CODE_COORDINATOR_TASK_SPEC_STRICT.)`
  )
}
