import { useState } from 'react'
import type { CronTask } from '../../types/task'
import { TaskRow } from './TaskRow'
import { Card } from '@/components/ui/Card'
import { useTranslation } from '../../i18n'

type Props = {
  tasks: CronTask[]
}

export function TaskList({ tasks }: Props) {
  const t = useTranslation()
  const enabledCount = tasks.filter((task) => task.enabled).length
  const [expandedLogsId, setExpandedLogsId] = useState<string | null>(null)

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('tasks.totalTasks')} value={String(tasks.length)} />
        <StatCard label={t('tasks.active')} value={String(enabledCount)} />
        <StatCard label={t('tasks.disabled')} value={String(tasks.length - enabledCount)} />
      </div>

      {/* Task rows — accordion: only one logs panel open at a time.
          The separators live on this container rather than on each row so the
          last row does not draw a rule against the card's own edge.

          The corners are rounded per-row instead of with `overflow-hidden`:
          each row anchors a confirm popover and an action menu, and an
          `overflow-hidden` ancestor clips absolutely positioned descendants
          whatever their own stacking is. Rounding the first row's head and the
          last row's tail keeps the row hover fill and the open runs drawer
          inside the card's edge without a clipping context. */}
      <Card
        radius="lg"
        surface="lowest"
        padding="none"
        className="mt-4 divide-y divide-[var(--color-border)] [&>*:first-child>*:first-child]:rounded-t-[var(--radius-lg)] [&>*:last-child>*:last-child]:rounded-b-[var(--radius-lg)]"
      >
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            showLogs={expandedLogsId === task.id}
            onToggleLogs={() => setExpandedLogsId(expandedLogsId === task.id ? null : task.id)}
          />
        ))}
      </Card>
    </div>
  )
}

/** Label above, figure below: the figure is what the eye lands on. */
function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card radius="lg" surface="lowest" padding="none" className="flex flex-col gap-1 px-4 py-3.5">
      <div className="text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="text-[22px] font-semibold leading-[1.2] tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
    </Card>
  )
}
