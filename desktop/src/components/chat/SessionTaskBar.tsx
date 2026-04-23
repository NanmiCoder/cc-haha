import { useCLITaskStore } from '../../stores/cliTaskStore'
import { useTranslation } from '../../i18n'
import type { CLITask } from '../../types/cliTask'

const statusConfig = {
  pending: {
    icon: 'radio_button_unchecked',
    color: 'var(--color-text-tertiary)',
    label: 'pending',
  },
  in_progress: {
    icon: 'pending',
    color: 'var(--color-warning)',
    label: 'active',
  },
  completed: {
    icon: 'check_circle',
    color: 'var(--color-success)',
    label: 'done',
  },
} as const

export function SessionTaskBar() {
  const {
    tasks,
    expanded,
    toggleExpanded,
    completedAndDismissed,
    resetCompletedTasks,
  } = useCLITaskStore()
  const t = useTranslation()

  if (tasks.length === 0) return null

  // Don't show sticky bar if tasks were completed and the user already continued chatting
  const allCompleted = tasks.every((tk) => tk.status === 'completed')
  if (allCompleted && completedAndDismissed) return null

  const completedCount = tasks.filter((tk) => tk.status === 'completed').length
  const totalCount = tasks.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  return (
    <div className="shrink-0 px-8">
      <div className="mx-auto max-w-[860px] rounded-[var(--radius-lg)] border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] overflow-hidden mb-2">
        {/* Header — always visible, clickable to toggle */}
        <div className="flex items-center gap-2 bg-[var(--color-surface-container)] px-2 py-1.5">
          <button
            type="button"
            onClick={toggleExpanded}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-md)] px-2 py-1 hover:bg-[var(--color-surface-container-low)] transition-colors"
          >
            <div className="flex items-center justify-center w-6 h-6 rounded-[var(--radius-md)] bg-[var(--color-secondary)]/10">
              <span
                className="material-symbols-outlined text-[14px] text-[var(--color-secondary)]"
              >
                checklist
              </span>
            </div>

            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              {t('tasks.title')}
            </span>

            {/* Progress bar */}
            <div className="flex-1 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden max-w-[200px]">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${progressPercent}%`,
                  backgroundColor: completedCount === totalCount
                    ? 'var(--color-success)'
                    : 'var(--color-brand)',
                }}
              />
            </div>

            <span className="text-[10px] text-[var(--color-text-tertiary)] tabular-nums">
              {completedCount}/{totalCount}
            </span>

            <span
              className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)] transition-transform duration-200"
              style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >
              expand_less
            </span>
          </button>

          {allCompleted && (
            <button
              type="button"
              aria-label={t('tasks.dismissCompleted')}
              onClick={() => { void resetCompletedTasks() }}
              className="flex shrink-0 items-center justify-center rounded-[var(--radius-md)] p-1.5 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          )}
        </div>

        {/* Expanded task list */}
        {expanded && (
          <div className="px-4 pb-2 pt-1 flex flex-col gap-0.5 max-h-[240px] overflow-y-auto border-t border-[var(--color-outline-variant)]/20">
            {tasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskItem({ task }: { task: CLITask }) {
  const config = statusConfig[task.status]

  return (
    <div className="flex items-start gap-2 py-1.5 px-1 rounded-md">
      <span
        className="material-symbols-outlined text-[16px] mt-px shrink-0"
        style={{ color: config.color, fontVariationSettings: "'FILL' 1" }}
      >
        {config.icon}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-[var(--color-text-tertiary)]">
            #{task.id}
          </span>
          <span className={`text-xs ${
            task.status === 'completed'
              ? 'text-[var(--color-text-tertiary)] line-through'
              : 'text-[var(--color-text-primary)]'
          }`}>
            {task.subject}
          </span>
        </div>

        {task.status === 'in_progress' && task.activeForm && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse" />
            <span className="text-[10px] text-[var(--color-warning)]">
              {task.activeForm}
            </span>
          </div>
        )}

        {task.owner && (
          <span className="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 inline-flex items-center gap-0.5">
            <span className="material-symbols-outlined text-[10px]">person</span>
            {task.owner}
          </span>
        )}
      </div>
    </div>
  )
}
