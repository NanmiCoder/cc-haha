import { useTranslation } from '../../i18n'

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
 */
export type WelcomeTaskCardKey =
  | 'preMergeReview'
  | 'investigateTest'
  | 'writeTests'
  | 'explainCode'

export type WelcomeTaskCard = {
  key: WelcomeTaskCardKey
  /** Material symbol icon name. Already used elsewhere in the desktop UI. */
  icon: string
  /** When true, the card auto-enables Orchestration mode for the session. */
  orchestrate: boolean
}

export const WELCOME_TASK_CARDS: ReadonlyArray<WelcomeTaskCard> = [
  { key: 'preMergeReview', icon: 'rate_review', orchestrate: true },
  { key: 'investigateTest', icon: 'bug_report', orchestrate: true },
  { key: 'writeTests', icon: 'verified', orchestrate: false },
  { key: 'explainCode', icon: 'menu_book', orchestrate: false },
]

type Props = {
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
 */
export function WelcomeTaskCards({ onApplyTask }: Props) {
  const t = useTranslation()
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
          const promptKey = `empty.tasks.${card.key}.prompt` as const
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onApplyTask(card, t(promptKey))}
              data-testid={`welcome-task-card-${card.key}`}
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
