import { Lock, X } from 'lucide-react'
import { useTranslation } from '@/i18n'

/**
 * The composer's mark for a lean conversation. Standard is the default and has
 * no mark. While the mode can still be picked it is a removable chip, like the
 * armed Agent Team; once the session exists it is the locked record, with no
 * way to take it off.
 */
export function AgentProfileChip({ onRemove }: { onRemove?(): void }) {
  const t = useTranslation()
  const height = 'h-6'
  if (!onRemove) {
    return (
      <span
        data-testid="agent-profile-chip"
        title={t('agentProfile.locked')}
        className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 text-xs font-medium text-[var(--color-text-secondary)] ${height}`}
      >
        <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
        {t('agentProfile.leanShort')}
      </span>
    )
  }
  return (
    <span
      data-testid="agent-profile-chip"
      title={t('agentProfile.draftHint')}
      className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-brand-soft)] pl-2 text-xs font-medium text-[var(--color-on-brand-soft)] ${height}`}
    >
      {t('agentProfile.leanShort')}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('agentProfile.chipRemove')}
        className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-xs)] hover:bg-[var(--color-brand-soft-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        <X size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  )
}
