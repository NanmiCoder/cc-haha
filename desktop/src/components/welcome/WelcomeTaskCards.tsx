import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { projectsApi, type RecentActivityResult } from '../../api/projects'

/**
 * Quick-start task cards on the welcome screen. Each card pre-fills the
 * composer with a starter prompt for a common workflow. Cards flagged with
 * `orchestrate: true` also enable the orchestration toggle on the session
 * that gets created (or the session that's already live in ActiveSession's
 * empty state), so a new user sees fan-out behavior on first contact with
 * the feature instead of having to discover the "+" menu first.
 *
 * Keep this list short (≤6) and biased toward genuinely multi-step tasks;
 * the cards are entry points, not a feature wall.
 *
 * Each card owns a `resolvePrompt(t, ctx)` function that returns the final
 * prompt text. This is where project-state-aware substitutions happen —
 * e.g. `preMergeReview` swaps in the actual `defaultBranch` instead of a
 * hardcoded "main", and `writeTests` / `investigateTest` suggest a real
 * recently-edited file from the dirty list. When `ctx` is unavailable the
 * resolver falls back to a static placeholder so the card is still usable
 * before the recent-activity fetch completes (or when there's no git
 * repo).
 */
export type WelcomeTaskCardKey =
  | 'preMergeReview'
  | 'investigateTest'
  | 'writeTests'
  | 'understandProject'

export type WelcomeTaskCard = {
  key: WelcomeTaskCardKey
  /** Material symbol icon name. Already used elsewhere in the desktop UI. */
  icon: string
  /** When true, the card auto-enables Orchestration mode for the session. */
  orchestrate: boolean
  /**
   * Compute the final prompt text. Receives the i18n translator and the
   * fetched project context (may be `null` if the host hasn't loaded it
   * yet or the workdir isn't a git repo). Resolvers MUST tolerate a null
   * `ctx` by falling back to static placeholders.
   */
  resolvePrompt: (
    t: ReturnType<typeof useTranslation>,
    ctx: RecentActivityResult | null,
  ) => string
}

/**
 * Pick a recently-modified test file from the dirty list. Test files are
 * recognized by common naming conventions across JS/TS/Python/Go/Rust.
 * Returns null if no such file is in the dirty set; caller falls back to
 * the localized placeholder.
 */
function pickTestFile(ctx: RecentActivityResult | null): string | null {
  const files = ctx?.git?.dirtyFiles ?? []
  const testRx = /(?:^|[\\/])(?:__tests__|__test__|tests?)[\\/]|\.(?:test|spec)\.[a-z]+$|_test\.(?:py|go|rs)$/i
  return files.find((f) => testRx.test(f)) ?? null
}

/**
 * Pick a recently-modified source file (preferring non-test, code-bearing
 * files) for the "write tests" card. Skips lock files, config dumps, and
 * test files themselves. Returns null on no good candidate.
 */
function pickSourceFile(ctx: RecentActivityResult | null): string | null {
  const files = ctx?.git?.dirtyFiles ?? []
  const testRx = /(?:^|[\\/])(?:__tests__|__test__|tests?)[\\/]|\.(?:test|spec)\.[a-z]+$|_test\.(?:py|go|rs)$/i
  const nonCodeRx = /(?:^|[\\/])(?:node_modules|dist|build|coverage|\.git|artifacts)[\\/]|\.(?:lock|map|min\.js|jsonl|log|png|jpg|webp|svg|md)$|^bun\.lock$|^package-lock\.json$|^yarn\.lock$/i
  const codeRx = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|hpp|sh|ps1)$/i
  return (
    files.find((f) => codeRx.test(f) && !testRx.test(f) && !nonCodeRx.test(f)) ??
    null
  )
}

export const WELCOME_TASK_CARDS: ReadonlyArray<WelcomeTaskCard> = [
  {
    key: 'preMergeReview',
    icon: 'rate_review',
    orchestrate: true,
    resolvePrompt: (t, ctx) => {
      const branch = ctx?.git?.defaultBranch || 'main'
      return t('empty.tasks.preMergeReview.prompt', { branch })
    },
  },
  {
    key: 'investigateTest',
    icon: 'bug_report',
    orchestrate: true,
    resolvePrompt: (t, ctx) => {
      const suggested = pickTestFile(ctx)
      const placeholder = t('empty.tasks.investigateTest.placeholder')
      return t('empty.tasks.investigateTest.prompt', {
        testPath: suggested ?? placeholder,
      })
    },
  },
  {
    key: 'writeTests',
    icon: 'verified',
    orchestrate: false,
    resolvePrompt: (t, ctx) => {
      const suggested = pickSourceFile(ctx)
      const placeholder = t('empty.tasks.writeTests.placeholder')
      return t('empty.tasks.writeTests.prompt', {
        filePath: suggested ?? placeholder,
      })
    },
  },
  {
    key: 'understandProject',
    icon: 'travel_explore',
    orchestrate: false,
    resolvePrompt: (t, ctx) => {
      const branch = ctx?.git?.branch || ctx?.git?.defaultBranch || 'main'
      return t('empty.tasks.understandProject.prompt', { branch })
    },
  },
]

type Props = {
  /**
   * Working directory used to fetch project context (default branch,
   * recently-edited file list) for prompt resolvers. When omitted or
   * empty, resolvers fall back to localized placeholders. Hosts pass
   * the same workDir they use for `RecentActivityCard`.
   */
  workDir?: string
  /**
   * If the host already has a live session, exclude it from "latest
   * session" picking so resolvers see the prior session's activity, not
   * the just-created empty one. Mirrors `RecentActivityCard`.
   */
  excludeSessionId?: string
  /**
   * Called with the card's `key` and resolved prompt text when the user
   * clicks a card. The host decides what to do (prefill its own composer,
   * dispatch an event, push into a store, etc.) and whether to flip
   * Orchestration mode based on `card.orchestrate`.
   */
  onApplyTask: (card: WelcomeTaskCard, promptText: string) => void
}

/**
 * Render the welcome-screen task cards as a 2-column grid. The host is
 * expected to gate on viewport size (cards are hidden on phone-sized H5
 * because the composer is already dense there); this component itself is
 * layout-neutral and just renders the buttons.
 *
 * The native `title` tooltip on each button shows the FULL resolved prompt
 * so the user can hover to see what they're about to send before clicking.
 */
export function WelcomeTaskCards({ workDir, excludeSessionId, onApplyTask }: Props) {
  const t = useTranslation()
  const [projectContext, setProjectContext] = useState<RecentActivityResult | null>(null)

  // Lightweight fetch of project context. Drives per-card resolvers so
  // `preMergeReview` knows the real default branch, and `writeTests` /
  // `investigateTest` can suggest a recently-edited file. Reuses the same
  // /api/projects/recent-activity endpoint RecentActivityCard hits, with
  // server-side caching to soak the duplicate. Failures are silent —
  // resolvers fall back to localized placeholders.
  useEffect(() => {
    if (!workDir) {
      setProjectContext(null)
      return
    }
    let cancelled = false
    void projectsApi
      .recentActivity(workDir, {
        ...(excludeSessionId ? { excludeSessionId } : {}),
      })
      .then((result) => {
        if (!cancelled) setProjectContext(result)
      })
      .catch(() => {
        if (!cancelled) setProjectContext(null)
      })
    return () => {
      cancelled = true
    }
  }, [workDir, excludeSessionId])

  return (
    <div
      data-testid="welcome-task-cards"
      className="mt-10 w-full max-w-3xl px-4"
    >
      <h2 className="mb-3 text-center text-xs font-medium uppercase tracking-wider text-[var(--color-text-tertiary)]">
        {t('empty.tasks.heading')}
      </h2>
      <div className="grid grid-cols-2 gap-3">
        {WELCOME_TASK_CARDS.map((card) => {
          const titleKey = `empty.tasks.${card.key}.title` as const
          const resolvedPrompt = card.resolvePrompt(t, projectContext)
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onApplyTask(card, resolvedPrompt)}
              data-testid={`welcome-task-card-${card.key}`}
              title={resolvedPrompt}
              aria-label={`${t(titleKey)} — ${resolvedPrompt}`}
              className="group flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-3 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]"
            >
              <span
                className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-text-secondary)] group-hover:text-[var(--color-primary)]"
                aria-hidden="true"
              >
                {card.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">
                  {t(titleKey)}
                </span>
                {card.orchestrate && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-tertiary)]">
                    <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                      hub
                    </span>
                    {t('empty.tasks.orchestratedHint')}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Custom DOM event used by ActiveSession's empty welcome state to push a
 * task-card prompt into ChatInput's draft. Decoupled via window event so we
 * don't have to plumb a prefill mechanism through the chat store.
 */
export const COMPOSER_PREFILL_EVENT = 'cc-haha:composer-prefill'
export type ComposerPrefillDetail = {
  sessionId: string
  text: string
}
