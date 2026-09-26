import { useEffect, useState } from 'react'
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
    <div className="flex-1 overflow-y-auto">
      <div className="animate-screen-pop mx-auto max-w-[1180px] px-4 pb-12 pt-8 lg:px-11">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1
              className="text-[28px] font-bold tracking-tight text-[var(--color-text-primary)]"
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              {t('scheduledPage.title')}
            </h1>
            <p className="mt-[7px] text-[14.5px] leading-[1.6] text-[var(--color-text-secondary)]">
              {(() => {
                const parts = t('scheduledPage.subtitle').split('{code}')
                return (
                  <>
                    {parts[0]}
                    <code className="rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 py-0.5 font-mono text-[12.5px] font-medium">
                      /schedule
                    </code>
                    {parts[1]}
                  </>
                )
              })()}
            </p>
          </div>
          <Button size="lg" className="shrink-0" onClick={() => openModal('new-task')}>{t('tasks.newTask')}</Button>
        </div>

        {/* Desktop-online notice. Terracotta rather than the previous
            `--color-warning` wash: this is a standing condition, not a fault.
            The old fill was `/8` and `/15` alpha, which Safari 15 WebView drops
            outright — on the desktop shell the strip had no ground at all. */}
        <div className="mt-[22px] flex items-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] px-[18px] py-[13px]">
          <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[18px] text-[var(--color-on-brand-soft)]">schedule</span>
          <span className="text-[13.5px] leading-[1.5] text-[var(--color-on-brand-soft)]">
            {t('scheduledPage.desktopNotice')}
          </span>
        </div>

        {/* Content */}
        <div className="mt-[18px]">
          {!initialized && isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner size={24} tone="brand" label={t('common.loading')} />
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
