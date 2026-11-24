import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import { useUIStore } from '../stores/uiStore'
import { useTranslation } from '../i18n'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { TaskList } from '../components/tasks/TaskList'
import { TaskEmptyState } from '../components/tasks/TaskEmptyState'
import { NewTaskModal } from '../components/tasks/NewTaskModal'

export function ScheduledTasks() {
  const { tasks, fetchTasks, isLoading, error } = useTaskStore()
  const { activeModal, openModal, closeModal } = useUIStore()
  const t = useTranslation()
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    fetchTasks().then(() => setInitialized(true))
  }, [fetchTasks])

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--color-surface)]">
      <div className="mx-auto max-w-[960px] px-10 pb-16 pt-9">
        {/* Page head: 22 semibold title, 13 tertiary description, the one
            primary action on the right — the same head every list page uses. */}
        <header className="flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold leading-[1.3] text-[var(--color-text-primary)]">
              {t('scheduledPage.title')}
            </h1>
            <p className="mt-1.5 text-[13px] leading-[1.6] text-[var(--color-text-tertiary)]">
              {(() => {
                const parts = t('scheduledPage.subtitle').split('{code}')
                return (
                  <>
                    {parts[0]}
                    <code className="rounded-[var(--radius-xs)] bg-[var(--color-surface-container)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-primary)]">
                      /schedule
                    </code>
                    {parts[1]}
                  </>
                )
              })()}
            </p>
          </div>
          {/* The label carries its own "+", so no icon beside it. */}
          <Button size="base" className="shrink-0" onClick={() => openModal('new-task')}>{t('tasks.newTask')}</Button>
        </header>

        {/* Desktop-online notice: a standing condition, not a fault, so it is
            the light info strip rather than a warning or the brand wash. */}
        <div className="mt-5 flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-info-container)] px-3 py-2 text-[13px] leading-[1.5] text-[var(--color-on-info-container)]">
          <Info size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          <span>{t('scheduledPage.desktopNotice')}</span>
        </div>

        {/* Content */}
        <div className="mt-5">
          {!initialized && isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner size={20} tone="brand" label={t('common.loading')} />
            </div>
          ) : error && tasks.length === 0 ? (
            // Without this the store's error falls through to the empty state,
            // so a failed load reads as "you have no tasks".
            <ErrorState
              title={t('common.error')}
              detail={error}
              onRetry={() => void fetchTasks()}
              retryLabel={t('common.retry')}
            />
          ) : tasks.length === 0 ? (
            <TaskEmptyState onCreateTask={() => openModal('new-task')} />
          ) : (
            <TaskList tasks={tasks} />
          )}
        </div>
      </div>

      {/* New Task Modal */}
      {activeModal === 'new-task' && (
        <NewTaskModal
          open
          onClose={closeModal}
        />
      )}
    </div>
  )
}
