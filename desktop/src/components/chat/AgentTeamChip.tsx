import { Users, X } from 'lucide-react'
import { useTranslation } from '@/i18n'

/**
 * Shown in the composer toolbar while Agent Team is armed for the next
 * message, so the mode is visible — and removable — before sending.
 */
export function AgentTeamChip({ onRemove, touch = false }: { onRemove(): void, touch?: boolean }) {
  const t = useTranslation()
  return (
    <span
      data-testid="agent-team-chip"
      className={`inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-brand-soft)] pl-2 text-xs font-medium text-[var(--color-on-brand-soft)] ${touch ? 'h-9' : 'h-6'}`}
    >
      <Users size={12} strokeWidth={1.75} aria-hidden="true" />
      {t('chat.capabilities.teams')}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('chat.capabilities.teamRemove')}
        className={`inline-flex items-center justify-center rounded-[var(--radius-xs)] hover:bg-[var(--color-brand-soft-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${touch ? 'h-9 w-9' : 'h-6 w-6'}`}
      >
        <X size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  )
}
