import { ListChecks } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Spinner } from '@/components/ui/Spinner'
import { useActivityPanelStore } from '../../stores/activityPanelStore'

/**
 * The phone's way into a session's parallel work — subagents, background
 * tasks, team members, the task list. The desktop reaches it from the tab
 * strip; on a phone it is this pill in the top bar, which says how much needs
 * a look and opens the activity sheet. It only appears once there is
 * something to show.
 */
export function MobileActivityPill({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const summary = useActivityPanelStore((state) => state.mobileSummaryBySession[sessionId])
  const isOpen = useActivityPanelStore((state) => state.isOpen(sessionId))
  const open = useActivityPanelStore((state) => state.open)
  if (!summary?.visible) return null

  const busy = summary.count > 0
  return (
    <button
      type="button"
      data-testid="mobile-activity-pill"
      data-session-activity-trigger="true"
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={() => open(sessionId)}
      className={`v6c-pressable flex h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-1.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        busy
          ? 'text-[var(--color-on-info-container)]'
          : 'text-[var(--color-text-secondary)]'
      }`}
    >
      <span
        className={`v6c-raised flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-surface-glass-border)] px-2.5 tabular-nums ${
          busy
            ? 'text-[var(--color-info)]'
            : 'text-[var(--color-text-secondary)]'
        }`}
      >
        {busy
          ? <Spinner size={12} />
          : <ListChecks size={14} strokeWidth={1.75} aria-hidden="true" />}
        {busy
          ? <span className="codex-shimmer-text font-medium">{t('mobile.activity.inProgress', { count: summary.count })}</span>
          : t('session.activity.title')}
      </span>
    </button>
  )
}
