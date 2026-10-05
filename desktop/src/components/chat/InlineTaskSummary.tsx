import { Circle, CircleCheck, CircleDot, ListChecks, type LucideIcon } from 'lucide-react'
import type { TaskSummaryItem } from '../../types/chat'
import { useTranslation } from '../../i18n'

/** In progress is a running state, so it takes `info` — never the brand colour. */
const statusIcon: Record<TaskSummaryItem['status'], { Icon: LucideIcon; color: string }> = {
  pending: { Icon: Circle, color: 'var(--color-text-tertiary)' },
  in_progress: { Icon: CircleDot, color: 'var(--color-info)' },
  completed: { Icon: CircleCheck, color: 'var(--color-success)' },
}

export function InlineTaskSummary({ tasks }: { tasks: TaskSummaryItem[] }) {
  const t = useTranslation()
  const completed = tasks.filter((tk) => tk.status === 'completed').length
  const total = tasks.length

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <div className="flex h-10 items-center gap-2 border-b border-[var(--color-border)] px-3 text-[13px]">
        <ListChecks size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
        <span className="font-medium text-[var(--color-text-primary)]">
          {t('tasks.completed')}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {completed}/{total}
        </span>
      </div>
      <div className="flex flex-col py-1">
        {tasks.map((task) => {
          const { Icon, color } = statusIcon[task.status]
          return (
            <div key={task.id} className="flex min-h-7 items-center gap-2 px-3 py-1">
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" style={{ color }} />
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                #{task.id}
              </span>
              <span className={`min-w-0 text-[13px] ${
                task.status === 'completed'
                  ? 'text-[var(--color-text-tertiary)] line-through'
                  : task.status === 'in_progress'
                    ? 'font-medium text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-primary)]'
              }`}>
                {task.subject}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
