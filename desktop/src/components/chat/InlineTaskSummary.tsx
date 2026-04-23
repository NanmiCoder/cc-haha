import type { TaskSummaryItem } from '../../types/chat'
import { useTranslation } from '../../i18n'

const statusIcon: Record<TaskSummaryItem['status'], string> = {
  pending: 'radio_button_unchecked',
  in_progress: 'pending',
  completed: 'check_circle',
}

const statusColor: Record<TaskSummaryItem['status'], string> = {
  pending: 'var(--color-text-tertiary)',
  in_progress: 'var(--color-warning)',
  completed: 'var(--color-success)',
}

export function InlineTaskSummary({ tasks }: { tasks: TaskSummaryItem[] }) {
  const t = useTranslation()
  const completed = tasks.filter((tk) => tk.status === 'completed').length
  const total = tasks.length

  return (
    <div className="mb-3 rounded-[var(--radius-lg)] border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 bg-[var(--color-surface-container)]">
        <div className="flex items-center justify-center w-5 h-5 rounded-[var(--radius-md)] bg-[var(--color-success)]/10">
          <span className="material-symbols-outlined text-[13px] text-[var(--color-success)]" style={{ fontVariationSettings: "'FILL' 1" }}>
            task_alt
          </span>
        </div>
        <span className="text-xs font-semibold text-[var(--color-text-primary)]">
          {t('tasks.completed')}
        </span>
        <span className="text-[10px] text-[var(--color-text-tertiary)] tabular-nums">
          {completed}/{total}
        </span>
      </div>
      <div className="px-4 py-2 flex flex-col gap-0.5">
        {tasks.map((task) => (
          <div key={task.id} className="flex items-center gap-2 py-1 px-1">
            <span
              className="material-symbols-outlined text-[14px] shrink-0"
              style={{ color: statusColor[task.status], fontVariationSettings: "'FILL' 1" }}
            >
              {statusIcon[task.status]}
            </span>
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
        ))}
      </div>
    </div>
  )
}
