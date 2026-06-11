/**
 * Worker-continue advisor.
 *
 * Coordinator-mode pattern: model calls AgentTool to spawn a fresh
 * subagent, but a previous subagent (of the same type, still alive on
 * the panel) already loaded the same files. Spawning a fresh worker
 * means re-prefilling the system prompt + tool schemas + per-file Read
 * results — easily 10-50k tokens that could be reused via SendMessage.
 *
 * This module is the spawn-time check. It looks at the just-completed
 * panel-agent tasks and asks: "did one of them touch a file the new
 * prompt mentions?" If yes, hard-fail the spawn with an error pointing
 * the model at SendMessage with that agentId. Same model-facing prose
 * style as specialistRouter — no `key="value"` fragments.
 *
 * Integration is opt-in via CLAUDE_CODE_COORDINATOR_CONTINUE_HINT=1.
 * Off by default for the same reason taskSpecQuality is opt-in: the
 * heuristic is fuzzier than blacklist-style checks (a model legitimately
 * may want a fresh worker even with file overlap), and a false-positive
 * hard-failure is more annoying than helpful unless a team wants the
 * stricter routing.
 */

export type ContinueCandidateTask = {
  /** Agent id usable as `to:` in SendMessage. */
  agentId: string
  /** Subagent type — must match the requested `subagent_type` to be a
   *  legitimate continue target. SendMessage to a type-mismatched worker
   *  would have it executing the wrong specialist's contract. */
  agentType: string
  /** Short human label for the error message. */
  description: string
  /** When the worker started; used to break ties (most-recent wins) and
   *  to filter out very old finished workers. */
  startTime: number
  /** Files the worker touched. The caller extracts these from
   *  task.progress.recentActivities; this module is policy-only. */
  touchedFiles: ReadonlyArray<string>
  /** Whether the worker reached a terminal (completed/failed/killed)
   *  status. Only completed workers are continue candidates — a still-
   *  running worker should be addressed via SendMessage anyway, and a
   *  failed/killed one shouldn't be revived blindly. */
  isCompleted: boolean
}

export type ContinueCandidateOptions = {
  /** Minimum number of overlapping files to recommend continuation.
   *  Default 1 — even a single shared file is a strong hint. */
  minSharedFiles?: number
  /** Maximum age of a candidate task. Older completed workers' context
   *  may already have been compacted away on the SDK side. Default 30
   *  minutes. */
  maxAgeMs?: number
  /** Wall-clock now, parameterised so tests can drive deterministically. */
  now?: number
}

export type ContinueCandidate = {
  agentId: string
  agentType: string
  description: string
  sharedFiles: ReadonlyArray<string>
  candidateAgeMs: number
}

const DEFAULT_OPTIONS = {
  minSharedFiles: 1,
  maxAgeMs: 30 * 60 * 1000, // 30 minutes
} as const

/**
 * Pull file paths from a worker prompt.
 *
 * Looks for path-with-extension tokens (`src/auth/validate.ts`,
 * `a\b.py`) and bare filenames with a known extension
 * (`README.md`, `package.json`). Conservative: ignores backticked code
 * spans (those usually carry symbols, not files) and ignores prose
 * mentions of generic names like "config" with no extension.
 *
 * Output is normalised to forward slashes so the comparison is
 * case-/separator-insensitive against task-recorded paths.
 */
export function extractFilePathsFromPrompt(prompt: string): Set<string> {
  const text = prompt ?? ''
  const result = new Set<string>()
  const pathLike =
    /(?<![\w.])(?:\.\.?\/|\/|[A-Z]:\\)?[\w@.-]+(?:[\\/][\w@.-]+){1,}\.[a-z]{1,5}\b/gi
  const bareKnown =
    /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|cs|json|ya?ml|toml|md|sh|ps1|sql|css|scss|html)\b/gi
  for (const re of [pathLike, bareKnown]) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      result.add(normalizePath(m[0]))
    }
  }
  return result
}

/** Normalise to forward slashes + lowercase for cross-OS comparison. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Score the given prompt against a list of recently-completed worker
 * tasks. Returns the best candidate (most files in common, ties broken
 * by recency) or null if no task crosses the threshold.
 *
 * Deliberately pure: the caller materialises the candidate list (with
 * file paths already extracted from each task's recentActivities) and
 * we just rank it. Keeps this module trivially testable without
 * stubbing the panel state.
 */
export function findContinueCandidate(args: {
  prompt: string
  subagentType: string
  candidates: ReadonlyArray<ContinueCandidateTask>
  options?: ContinueCandidateOptions
}): ContinueCandidate | null {
  const opts = { ...DEFAULT_OPTIONS, ...(args.options ?? {}) }
  const now = opts.now ?? Date.now()
  const promptFiles = extractFilePathsFromPrompt(args.prompt)
  if (promptFiles.size === 0) return null

  const scored: Array<ContinueCandidate & { score: number }> = []
  for (const task of args.candidates) {
    if (!task.isCompleted) continue
    if (task.agentType !== args.subagentType) continue
    if (now - task.startTime > opts.maxAgeMs) continue
    const taskFiles = new Set(task.touchedFiles.map(normalizePath))
    const overlap: string[] = []
    for (const f of taskFiles) {
      if (promptFiles.has(f)) overlap.push(f)
    }
    if (overlap.length < opts.minSharedFiles) continue
    scored.push({
      agentId: task.agentId,
      agentType: task.agentType,
      description: task.description,
      sharedFiles: overlap,
      candidateAgeMs: now - task.startTime,
      score: overlap.length,
    })
  }
  if (scored.length === 0) return null
  // Most-overlap wins; on tie, most-recent wins.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidateAgeMs - b.candidateAgeMs,
  )
  const winner = scored[0]!
  // Strip the score field — it's a ranking aid, not part of the contract.
  return {
    agentId: winner.agentId,
    agentType: winner.agentType,
    description: winner.description,
    sharedFiles: winner.sharedFiles,
    candidateAgeMs: winner.candidateAgeMs,
  }
}

/**
 * Pull `file_path` (Read/Edit/Write/NotebookEdit) and `path`
 * (Grep/Glob — these are *directory* paths, not files, but a directory
 * mention is still a useful signal that the worker touched that area).
 *
 * Helper for callers building the candidate list out of
 * ProgressTracker.recentActivities. Pure on the input — does not assume
 * any specific tool name, just probes the input record for known fields.
 */
export function extractTouchedFilesFromActivities(
  activities: ReadonlyArray<{ input?: Record<string, unknown> }>,
): string[] {
  const out = new Set<string>()
  for (const a of activities) {
    const inp = a.input ?? {}
    const fp = inp['file_path']
    if (typeof fp === 'string' && fp.length > 0) {
      out.add(normalizePath(fp))
    }
    const p = inp['path']
    if (typeof p === 'string' && p.length > 0) {
      // Grep/Glob `path` is a directory; we still record it for overlap
      // detection because a fresh worker that mentions a file inside the
      // same directory is very likely re-loading the same area.
      out.add(normalizePath(p))
    }
    // Bash `command` strings can also reference files; deliberately
    // skipped to avoid false positives (a `git log` command isn't a
    // file touch).
  }
  return [...out]
}

export function isContinueHintEnabled(): boolean {
  return process.env.CLAUDE_CODE_COORDINATOR_CONTINUE_HINT === '1'
}

/**
 * Format the model-facing error string when a continue-target is
 * available. Same prose-style contract as specialistRouter — no
 * `key="value"` fragments, no `<tool_use>` shapes.
 */
export function formatContinueHintError(
  candidate: ContinueCandidate,
  agentToolName: string,
  sendMessageToolName: string,
): string {
  const fileList =
    candidate.sharedFiles.length <= 4
      ? candidate.sharedFiles.join(', ')
      : `${candidate.sharedFiles.slice(0, 4).join(', ')} (+${candidate.sharedFiles.length - 4} more)`
  return (
    `A recent ${candidate.agentType} subagent already loaded the same file(s): ${fileList}. ` +
    `Continuing that worker reuses its prompt cache and prior context (the worker id is ${candidate.agentId}). ` +
    `Use ${sendMessageToolName} with the to parameter set to ${candidate.agentId} instead of spawning a new ${agentToolName}. ` +
    `If you really need a fresh worker context (e.g. you want adversarial verification with no anchor on the prior approach), ` +
    `disable this hint with CLAUDE_CODE_COORDINATOR_CONTINUE_HINT=0.`
  )
}
