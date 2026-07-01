/**
 * Sentinel consistency check for review-style subagent output.
 *
 * Several built-in agents end their report with a machine-parseable verdict:
 *   - code-reviewer:     `REVIEW: APPROVE` | `REVIEW: CHANGES_NEEDED`
 *   - security-reviewer: `SECURITY: PASS`  | `SECURITY: CHANGES_NEEDED`
 *
 * Their system prompts forbid emitting the positive verdict while listing
 * a finding of severity `[CRITICAL]` or `[HIGH]`. The model is the only
 * line of defence today — if it slips, the parent agent reads "APPROVE"
 * and merges. This module mechanically detects that mismatch and rewrites
 * the verdict to the negative form, leaving a one-line audit notice so
 * the parent can see the harness intervened.
 *
 * Debugger (`ROOT CAUSE: FOUND/UNCONFIRMED`) is intentionally excluded —
 * its consistency rule ("evidence from a command you actually ran") is
 * not mechanically verifiable from the text alone.
 */

export type SentinelKind = 'review' | 'security'

export type SentinelCheckResult = {
  /** Possibly-rewritten text. Equal to input when no mismatch. */
  correctedText: string
  /** The sentinel kind that was corrected, or null if no correction. */
  mismatch: SentinelKind | null
  /** Original verdict word as emitted by the subagent (e.g. "APPROVE"). */
  originalVerdict?: string
  /** New verdict word the harness rewrote to (e.g. "CHANGES_NEEDED"). */
  correctedVerdict?: string
}

type SentinelSpec = {
  kind: SentinelKind
  /** Multi-line regex matching the entire sentinel line. */
  pattern: RegExp
  /** Verdicts that conflict with the presence of [CRITICAL]/[HIGH] findings. */
  positiveVerdicts: ReadonlySet<string>
  /** Negative verdict that the harness rewrites a conflicting positive to. */
  negativeVerdict: string
}

const SENTINEL_SPECS: ReadonlyArray<SentinelSpec> = [
  {
    kind: 'review',
    pattern: /^REVIEW:\s+(APPROVE|CHANGES_NEEDED)\s*$/m,
    positiveVerdicts: new Set(['APPROVE']),
    negativeVerdict: 'CHANGES_NEEDED',
  },
  {
    kind: 'security',
    pattern: /^SECURITY:\s+(PASS|CHANGES_NEEDED)\s*$/m,
    positiveVerdicts: new Set(['PASS']),
    negativeVerdict: 'CHANGES_NEEDED',
  },
]

/**
 * Findings of severity that should never coexist with a positive verdict.
 * The pattern is anchored at line start to avoid matching prose like
 * "the user said [CRITICAL] in passing".
 */
const FINDING_PATTERN = /^\s*\[(CRITICAL|HIGH)\]/m

/**
 * Scan subagent output for sentinel/findings inconsistencies and rewrite
 * the verdict line if a positive verdict was emitted alongside CRITICAL
 * or HIGH findings.
 *
 * Pure function: input is a single string of the subagent's final text
 * output. Returns the (possibly-rewritten) text and a marker for the
 * call site to log analytics.
 */
export function applySentinelCorrection(text: string): SentinelCheckResult {
  for (const spec of SENTINEL_SPECS) {
    const match = spec.pattern.exec(text)
    if (!match) continue

    const verdict = match[1]!
    if (!spec.positiveVerdicts.has(verdict)) {
      // Already a negative verdict — nothing to correct for this spec.
      // Keep scanning in case multiple sentinel kinds appear.
      continue
    }

    const beforeVerdict = text.slice(0, match.index)
    if (!FINDING_PATTERN.test(beforeVerdict)) {
      // Positive verdict, no conflicting findings — legitimate APPROVE/PASS.
      continue
    }

    // Mismatch: rewrite the verdict line and prepend a one-line notice
    // so the parent agent (and a human reading the transcript) can see
    // that the harness intervened.
    const correctedLine = match[0].replace(verdict, spec.negativeVerdict)
    const notice =
      `\n[Sentinel mismatch corrected by harness: ` +
      `original verdict "${verdict}" rewritten to "${spec.negativeVerdict}" ` +
      `because findings of severity CRITICAL or HIGH are present above.]\n`
    const correctedText =
      text.slice(0, match.index) +
      notice +
      correctedLine +
      text.slice(match.index + match[0].length)

    return {
      correctedText,
      mismatch: spec.kind,
      originalVerdict: verdict,
      correctedVerdict: spec.negativeVerdict,
    }
  }

  return { correctedText: text, mismatch: null }
}
