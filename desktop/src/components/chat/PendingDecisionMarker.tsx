import { CircleAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'

/**
 * Where a waiting request sits in the transcript on a phone. The card itself
 * is answered from the approval bar that takes the composer's place, so here
 * it shrinks to one line that says what is waiting and where to answer it —
 * two live copies of one card would each hold half of an answer.
 */
export function PendingDecisionMarker({ title }: { title: string }) {
  const t = useTranslation()
  return (
    <div
      role="group"
      aria-label={title}
      data-testid="pending-decision-marker"
      className="mb-4 flex min-h-10 min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-2 text-[13px] text-[var(--color-on-warning-container)]"
    >
      <CircleAlert aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="shrink-0 text-[12px]">{t('mobile.approval.answerBelow')}</span>
    </div>
  )
}
