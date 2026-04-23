import { Button } from '../shared/Button'
import { useTranslation } from '../../i18n'

type Props = {
  onCreateTask: () => void
}

export function TaskEmptyState({ onCreateTask }: Props) {
  const t = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center py-20">
      {/* Clock icon */}
      <div className="w-16 h-16 rounded-full bg-[var(--color-surface-info)] flex items-center justify-center mb-4">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>

      <h3 className="text-sm font-medium text-[var(--color-text-primary)] mb-1">
        {t('tasks.emptyTitle')}
      </h3>
      <p className="text-sm text-[var(--color-text-tertiary)] mb-4 text-center max-w-sm">
        {t('tasks.emptyDesc')}
      </p>

      <Button onClick={onCreateTask}>{t('tasks.newTask')}</Button>
    </div>
  )
}
