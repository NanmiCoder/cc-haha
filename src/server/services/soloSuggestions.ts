/**
 * Solo Pipeline mode — "what might you want to do next?" suggestion
 * engine.
 *
 * When the user toggles Solo mode and hasn't given a concrete task
 * yet, we want to greet them with project-aware guesses instead of an
 * empty prompt. This module is the pure-function brain of that
 * greeting: it takes the existing zero-token project snapshot
 * (`RecentActivityResult` from `projectActivityService`) and an
 * optional Tier-1 enrichment bag, and returns a ranked list of
 * `SoloSuggestion`s. The desktop renders them; the AI consumes the
 * `taskPrompt` as the seed for Stage 1 (or a later stage when
 * `entryStage` is set).
 *
 * Design constraints:
 *   - No I/O. No process spawning. No LLM calls. The host caller
 *     decides which signals to gather (Tier 0 is always available
 *     from `getRecentActivity`; Tier 1 — stash count, test-gap
 *     detection, TODO grep against dirtyFiles, version-vs-notes
 *     mismatch, in-progress merge state — is opt-in and bounded).
 *   - Deterministic. Same inputs → same suggestions in the same
 *     order, so the greeting is stable across welcome-screen
 *     re-renders within a session.
 *   - Locale-neutral. Returns translation KEYS plus interpolation
 *     params. The desktop translates with the user's active locale
 *     so the welcome chip and the embedded `taskPrompt` stay in
 *     sync. (taskPrompt itself is held as a separate i18n key —
 *     tested via a string-marker contract, see test file.)
 *   - Bounded. Final list capped at 5 entries; each category
 *     contributes at most one (avoids 3 finish-wip clones).
 *
 * Coupling boundary: this module imports types from
 * `projectActivityService` only. It MUST NOT pull in chat / WS /
 * coordinator surfaces, so it can be unit-tested without spinning
 * those up and so the eventual Solo-mode wiring layer can sit on top
 * without circular dependencies.
 */

import type {
  RecentActivityResult,
} from './projectActivityService.js'

/**
 * Optional Tier-1 signals — the host gathers these alongside
 * `RecentActivityResult` when it wants richer suggestions. Each is
 * independently optional so a partial gather still produces
 * suggestions for the signals that DID resolve.
 *
 * Cost model (when the host is reading them all):
 *   stashCount        — 1 `git stash list --no-decorate`
 *   missingTestFiles  — pure in-memory derivation from dirtyFiles
 *   todoHits          — grep restricted to dirtyFiles only (NOT full
 *                       repo); naturally bounded by dirty set size
 *   releaseMismatch   — 2 file reads (package.json + latest notes)
 *   gitInProgress     — 1 fs.access (.git/MERGE_HEAD or REBASE_HEAD)
 */
export type SoloSignalsTier1 = {
  /** Number of git stashes. 0 means clean stash list. */
  stashCount?: number
  /**
   * Repo-relative source files in the dirty set whose conventional
   * sibling test file is NOT in the dirty set. Picked from
   * `dirtyFiles` only — never reads the full repo tree.
   */
  missingTestFiles?: string[]
  /** Repo-relative paths + first-line excerpt for TODOs / FIXMEs in dirtyFiles. */
  todoHits?: Array<{ path: string; excerpt: string }>
  /**
   * Set when `desktop/package.json` version doesn't match the
   * latest `release-notes/vX.Y.Z.md`. The mismatch direction tells
   * the suggestion which way to nudge (notes-missing vs
   * version-not-bumped).
   */
  releaseMismatch?: {
    desktopVersion: string
    latestNotes?: string
    kind: 'notes-missing' | 'version-not-bumped' | 'tag-not-pushed'
  }
  /** True when `.git/MERGE_HEAD` / `REBASE_HEAD` / `CHERRY_PICK_HEAD` exists. */
  gitInProgress?: 'merge' | 'rebase' | 'cherry-pick'
  /**
   * Total LSP error count across the workspace (any positive integer
   * triggers the cleanup suggestion). Sourced from
   * `LspManager.getErrorCount(workspaceId)`. Undefined when LSP is
   * unavailable, the prereq is missing, or the gather call threw —
   * the suggestion silently sits this round out rather than nagging
   * the user about a setup problem they didn't ask about.
   */
  lspErrorCount?: number
}

export type SoloSuggestionCategory =
  | 'finish-wip'
  | 'ship'
  | 'test-gap'
  | 'cleanup'
  | 'release'
  | 'resolve-conflict'
  | 'generic'

export type SoloSuggestion = {
  /** Stable id (rule + dedup key). Used for analytics and
   *  category dedup; never user-visible. */
  id: string
  category: SoloSuggestionCategory
  /** Material symbol icon name. */
  icon: string
  /** i18n key + interpolation params for the short title. */
  title: { key: string; params?: Record<string, string | number> }
  /**
   * Optional one-line "why this is suggested". i18n key + params,
   * same shape as `title`.
   */
  detail?: { key: string; params?: Record<string, string | number> }
  /**
   * The task description fed into Solo Stage 1 (or a later stage
   * when `entryStage` is set). Held as i18n key+params so the
   * locale stays consistent with the surrounding UI. Plugin /
   * skill prompts treat this as the user's literal task.
   */
  taskPrompt: { key: string; params?: Record<string, string | number> }
  /**
   * Pipeline stage to enter at. Default 'plan' (start at the top).
   * 'review' for "the work is already done, let's look it over".
   * 'land' for "everything is ready, just ship it".
   */
  entryStage?: 'plan' | 'review' | 'land'
  /** Computed score, exposed for tests + analytics. Higher = earlier. */
  score: number
}

/** Cap on the public-API suggestion list length. */
const MAX_SUGGESTIONS = 5

/**
 * Per-category base scores. Test gaps win over ship/finish-wip
 * because they're easiest to ignore and most aligned with this
 * repo's quality contract; conflict resolution dominates everything
 * because a mid-flight merge/rebase blocks every other useful
 * action; generic is the universal fallback so it sits at the
 * bottom.
 *
 * The numbers leave deliberate headroom for boosters (recency 0-15,
 * sample-bonus 0-10, file-specific 0-10): the resolve-conflict
 * gap is wide enough that ANY combination of boosters on a lower
 * rule can't displace it; test-gap's gap over ship is wide enough
 * that "I have a test gap AND already-shipped commits" still
 * surfaces the test gap first.
 */
const BASE_SCORE: Record<SoloSuggestionCategory, number> = {
  'resolve-conflict': 100, // hard override — git mid-state blocks everything
  'test-gap': 55,
  ship: 35,
  'finish-wip': 30,
  release: 28,
  cleanup: 20,
  generic: 0,
}

/** Recency boost based on the last session's modification time. */
function recencyBoost(modifiedAtIso: string | undefined, now: number): number {
  if (!modifiedAtIso) return 0
  const ts = Date.parse(modifiedAtIso)
  if (!Number.isFinite(ts)) return 0
  const ageMs = now - ts
  if (ageMs < 0) return 0
  const ageHours = ageMs / 3_600_000
  if (ageHours <= 24) return 15
  if (ageHours <= 24 * 7) return 5
  return 0
}

/**
 * Detect whether a given dirty path looks like "someone else's work"
 * — specifically, untracked files NOT mentioned in the previous
 * session's edited-files sample. Used to mildly downscore the
 * finish-wip suggestion when most dirty files are foreign to the
 * user's last session (e.g. another agent's parked work in the
 * worktree). Returns a boolean per path; caller uses the count.
 */
function isLikelyForeignDirtyFile(
  path: string,
  lastSessionFiles: ReadonlySet<string>,
): boolean {
  if (lastSessionFiles.size === 0) return false
  // Match exact + suffix: the session's filesEditedSample stores
  // whatever path the tool used, which may be absolute or repo-rel.
  // Try both directions so we don't false-positive on path style.
  if (lastSessionFiles.has(path)) return false
  for (const p of lastSessionFiles) {
    if (p === path) return false
    if (p.endsWith(path) || path.endsWith(p)) return false
  }
  return true
}

/**
 * Conservative test-file naming heuristic. We classify a path as
 * "source" only if it's a code file AND not itself a test. The
 * caller (Tier-1 enricher) handles the actual sibling-existence
 * check; the engine just trusts what the host hands in.
 */
function isCodeSource(p: string): boolean {
  if (!p) return false
  if (/\.(test|spec)\.[a-z]+$/i.test(p)) return false
  if (/_test\.(py|go|rs)$/i.test(p)) return false
  if (/(^|[/\\])(tests?|__tests?__)[/\\]/i.test(p)) return false
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|hpp|sh|ps1)$/i.test(
    p,
  )
}

/** Truncate a string to N chars with single-char ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

type RuleContext = {
  activity: RecentActivityResult
  tier1: SoloSignalsTier1
  now: number
  lastSessionFiles: ReadonlySet<string>
}

type RuleEmitter = (
  ctx: RuleContext,
) => SoloSuggestion[]

/**
 * R-CONFLICT — Highest priority. A merge / rebase / cherry-pick is
 * mid-flight; nothing else productive happens until that's
 * resolved. Routes straight to Stage 1 with explicit context so the
 * planner specialist asks the right questions.
 */
const ruleResolveConflict: RuleEmitter = ({ tier1 }) => {
  if (!tier1.gitInProgress) return []
  return [
    {
      id: `resolve-${tier1.gitInProgress}`,
      category: 'resolve-conflict',
      icon: 'merge_type',
      title: {
        key: `solo.suggest.resolveConflict.${tier1.gitInProgress}.title`,
      },
      detail: {
        key: `solo.suggest.resolveConflict.${tier1.gitInProgress}.detail`,
      },
      taskPrompt: {
        key: `solo.suggest.resolveConflict.${tier1.gitInProgress}.taskPrompt`,
      },
      entryStage: 'plan',
      score: BASE_SCORE['resolve-conflict'],
    },
  ]
}

/**
 * R1 — finish-wip. The repo has uncommitted dirty files; suggest
 * walking them through the pipeline so the user closes the loop.
 * Downscored when most dirty files look foreign (likely another
 * agent's parked work in the same worktree).
 */
const ruleFinishWip: RuleEmitter = ({ activity, lastSessionFiles, now }) => {
  const dirtyCount = activity.git?.dirtyCount ?? 0
  if (dirtyCount === 0) return []
  const dirtyFiles = activity.git?.dirtyFiles ?? []
  const foreignCount = dirtyFiles.filter((p) =>
    isLikelyForeignDirtyFile(p, lastSessionFiles),
  ).length
  const foreignDominates =
    dirtyFiles.length > 0 && foreignCount / dirtyFiles.length > 0.6
  const sample = dirtyFiles.slice(0, 3).join(', ')
  const score =
    BASE_SCORE['finish-wip'] +
    recencyBoost(activity.lastSession?.modifiedAt, now) +
    (sample ? 10 : 0) +
    (foreignDominates ? -15 : 0)
  return [
    {
      id: 'finish-wip',
      category: 'finish-wip',
      icon: 'edit_note',
      title: {
        key: 'solo.suggest.finishWip.title',
        params: { count: dirtyCount },
      },
      detail: {
        key: foreignDominates
          ? 'solo.suggest.finishWip.detailForeign'
          : 'solo.suggest.finishWip.detail',
        params: { sample: truncate(sample, 80) || '—' },
      },
      taskPrompt: {
        key: 'solo.suggest.finishWip.taskPrompt',
        params: { count: dirtyCount, files: truncate(sample, 200) || '—' },
      },
      entryStage: 'plan',
      score,
    },
  ]
}

/**
 * R2 — ship. Local commits ahead of upstream on a non-default
 * branch. The work is already done; the pipeline enters at REVIEW
 * so the user gets a code-review pass + approval gate + landing
 * (PR / push), without re-running plan/implement on already-shipped
 * code.
 */
const ruleShipAhead: RuleEmitter = ({ activity, now }) => {
  const ahead = activity.git?.aheadCount ?? 0
  const branch = activity.git?.branch
  const defaultBranch = activity.git?.defaultBranch
  if (ahead <= 0 || !branch) return []
  const onDefault =
    !!defaultBranch && (branch === defaultBranch || branch === 'main' || branch === 'master')
  if (onDefault) return []
  const score =
    BASE_SCORE.ship + recencyBoost(activity.lastSession?.modifiedAt, now) + 10
  return [
    {
      id: 'ship-ahead',
      category: 'ship',
      icon: 'rocket_launch',
      title: {
        key: 'solo.suggest.shipAhead.title',
        params: { branch, count: ahead },
      },
      detail: {
        key: 'solo.suggest.shipAhead.detail',
        params: { count: ahead },
      },
      taskPrompt: {
        key: 'solo.suggest.shipAhead.taskPrompt',
        params: { branch, count: ahead },
      },
      entryStage: 'review',
      score,
    },
  ]
}

/**
 * R3 — test-gap. A source file in the dirty set has no co-located
 * test in the dirty set. Highest base-score because this is the
 * easiest quality lapse for an agent to ship, and it's exactly
 * what AGENTS.md's same-area-test contract is supposed to catch.
 */
const ruleTestGap: RuleEmitter = ({ tier1 }) => {
  const gaps = tier1.missingTestFiles ?? []
  if (gaps.length === 0) return []
  // Pick the first gap that genuinely looks like source. Defensive:
  // the host SHOULD already have filtered, but we trust-but-verify.
  const sourceGap = gaps.find(isCodeSource)
  if (!sourceGap) return []
  return [
    {
      id: `test-gap:${sourceGap}`,
      category: 'test-gap',
      icon: 'verified',
      title: {
        key: 'solo.suggest.testGap.title',
        params: { file: truncate(sourceGap, 60) },
      },
      detail: {
        key: 'solo.suggest.testGap.detail',
        params: { count: gaps.length },
      },
      taskPrompt: {
        key: 'solo.suggest.testGap.taskPrompt',
        params: { file: sourceGap, count: gaps.length },
      },
      entryStage: 'plan',
      score: BASE_SCORE['test-gap'] + 10, // file-specific
    },
  ]
}

/** R5 — TODO/FIXME found in dirty files. Cleanup-class. */
const ruleTodoMarker: RuleEmitter = ({ tier1 }) => {
  const hits = tier1.todoHits ?? []
  if (hits.length === 0) return []
  const first = hits[0]!
  return [
    {
      id: `todo:${first.path}`,
      category: 'cleanup',
      icon: 'task_alt',
      title: {
        key: 'solo.suggest.todoMarker.title',
        params: { file: truncate(first.path, 50) },
      },
      detail: {
        key: 'solo.suggest.todoMarker.detail',
        params: { excerpt: truncate(first.excerpt, 80), count: hits.length },
      },
      taskPrompt: {
        key: 'solo.suggest.todoMarker.taskPrompt',
        params: {
          file: first.path,
          excerpt: truncate(first.excerpt, 120),
          count: hits.length,
        },
      },
      entryStage: 'plan',
      score: BASE_SCORE.cleanup + 5, // mild boost for actionability
    },
  ]
}

/**
 * R6 — release. The desktop version doesn't line up with the
 * release-notes file. Routes to LAND directly: the work is done,
 * the release script just needs the missing notes file or the
 * version bump.
 */
const ruleReleaseMismatch: RuleEmitter = ({ tier1 }) => {
  const mismatch = tier1.releaseMismatch
  if (!mismatch) return []
  return [
    {
      id: `release-${mismatch.kind}`,
      category: 'release',
      icon: 'sell',
      title: {
        key: `solo.suggest.releaseMismatch.${mismatch.kind}.title`,
        params: {
          desktopVersion: mismatch.desktopVersion,
          latestNotes: mismatch.latestNotes ?? '—',
        },
      },
      detail: {
        key: `solo.suggest.releaseMismatch.${mismatch.kind}.detail`,
        params: {
          desktopVersion: mismatch.desktopVersion,
          latestNotes: mismatch.latestNotes ?? '—',
        },
      },
      taskPrompt: {
        key: `solo.suggest.releaseMismatch.${mismatch.kind}.taskPrompt`,
        params: {
          desktopVersion: mismatch.desktopVersion,
          latestNotes: mismatch.latestNotes ?? '—',
        },
      },
      entryStage: 'land',
      score: BASE_SCORE.release,
    },
  ]
}

/** R7 — recover stashed work. Mild score; user often forgot. */
const ruleStashRecover: RuleEmitter = ({ tier1 }) => {
  const stashCount = tier1.stashCount ?? 0
  if (stashCount === 0) return []
  return [
    {
      id: 'stash-recover',
      category: 'finish-wip',
      icon: 'inventory_2',
      title: {
        key: 'solo.suggest.stashRecover.title',
        params: { count: stashCount },
      },
      detail: { key: 'solo.suggest.stashRecover.detail' },
      taskPrompt: {
        key: 'solo.suggest.stashRecover.taskPrompt',
        params: { count: stashCount },
      },
      entryStage: 'plan',
      score: BASE_SCORE['finish-wip'] - 12, // almost always lower than fresh dirty
    },
  ]
}

/**
 * R8 — sync upstream. Lowest priority; only when truly nothing else.
 */
const ruleSyncUpstream: RuleEmitter = ({ activity }) => {
  const behind = activity.git?.behindCount ?? 0
  if (behind <= 0) return []
  return [
    {
      id: 'sync-upstream',
      category: 'cleanup',
      icon: 'sync',
      title: { key: 'solo.suggest.syncUpstream.title', params: { count: behind } },
      detail: { key: 'solo.suggest.syncUpstream.detail' },
      taskPrompt: {
        key: 'solo.suggest.syncUpstream.taskPrompt',
        params: { count: behind },
      },
      score: BASE_SCORE.cleanup - 12,
    },
  ]
}

/**
 * R10 — LSP error cleanup. Phase 5 of editor-lsp-foundation.
 *
 * Fires whenever `tier1.lspErrorCount` is a positive integer. Within
 * the cleanup category this entry needs to outrank R7 (todo marker)
 * and R8 (sync upstream) — the user being told to clear N type errors
 * is the most actionable cleanup we can recommend, and the dedup pass
 * keeps the highest-scoring cleanup entry. Score 80 is also above
 * test-gap/ship/finish-wip/release base scores so it wins outright
 * when LSP errors exist.
 */
const ruleLspError: RuleEmitter = ({ tier1 }) => {
  const count = tier1.lspErrorCount
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return []
  return [
    {
      id: 'lsp-error',
      category: 'cleanup',
      icon: 'error',
      title: { key: 'solo.suggest.lspError.title', params: { count } },
      detail: { key: 'solo.suggest.lspError.detail' },
      taskPrompt: {
        key: 'solo.suggest.lspError.taskPrompt',
        params: { count },
      },
      score: 80,
    },
  ]
}

/**
 * R9 — generic fallback. Always emitted. Filtered out at the end if
 * the user has at least one concrete suggestion, OR retained as the
 * sole entry when nothing fired (the "you're on a clean repo, what
 * do you want to build?" case).
 */
const ruleGeneric: RuleEmitter = () => [
  {
    id: 'generic',
    category: 'generic',
    icon: 'auto_awesome',
    title: { key: 'solo.suggest.generic.title' },
    detail: { key: 'solo.suggest.generic.detail' },
    taskPrompt: { key: 'solo.suggest.generic.taskPrompt' },
    entryStage: 'plan',
    score: BASE_SCORE.generic,
  },
]

const RULES: ReadonlyArray<RuleEmitter> = [
  ruleResolveConflict,
  ruleFinishWip,
  ruleShipAhead,
  ruleTestGap,
  ruleTodoMarker,
  ruleReleaseMismatch,
  ruleStashRecover,
  ruleSyncUpstream,
  ruleLspError,
  ruleGeneric,
]

/**
 * Build the ranked Solo-mode suggestion list.
 *
 * Determinism contract: with identical `activity`, `tier1`, and
 * `now`, this function returns identical output (same ids, same
 * order, same scores). Tests rely on this for stable assertions.
 *
 * Scoring + post-processing:
 *   1. Each rule emits 0..1 candidates.
 *   2. Within a category, only the highest-scoring candidate
 *      survives — avoids the "3 finish-wip clones" failure.
 *   3. Candidates sorted by score DESC, then by id ASC for
 *      tiebreak determinism.
 *   4. List capped at MAX_SUGGESTIONS.
 *   5. The generic fallback is dropped iff at least one specific
 *      suggestion survived; otherwise it stays as the sole entry.
 */
export function buildSoloSuggestions(
  activity: RecentActivityResult,
  tier1?: SoloSignalsTier1,
  options?: { now?: number },
): SoloSuggestion[] {
  const now = options?.now ?? Date.now()
  const ctx: RuleContext = {
    activity,
    tier1: tier1 ?? {},
    now,
    lastSessionFiles: new Set(activity.lastSession?.filesEditedSample ?? []),
  }

  const candidates: SoloSuggestion[] = []
  for (const rule of RULES) {
    for (const s of rule(ctx)) candidates.push(s)
  }

  // Per-category dedup: keep the highest-scoring entry per category.
  const byCategory = new Map<SoloSuggestionCategory, SoloSuggestion>()
  for (const s of candidates) {
    const prev = byCategory.get(s.category)
    if (!prev || s.score > prev.score) byCategory.set(s.category, s)
  }

  const ranked = [...byCategory.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.id.localeCompare(b.id)
  })

  // Drop the generic fallback if any specific suggestion survived,
  // otherwise keep it as the only entry. Generic is special-cased
  // here so future rules can ignore the "should we filter generic"
  // detail and just emit their candidate.
  const hasSpecific = ranked.some((s) => s.category !== 'generic')
  const filtered = hasSpecific
    ? ranked.filter((s) => s.category !== 'generic')
    : ranked

  return filtered.slice(0, MAX_SUGGESTIONS)
}

/** @internal — exported for unit tests so the score table is locked in. */
export const _SOLO_SUGGESTIONS_INTERNALS = {
  BASE_SCORE,
  MAX_SUGGESTIONS,
  recencyBoost,
  isCodeSource,
}
