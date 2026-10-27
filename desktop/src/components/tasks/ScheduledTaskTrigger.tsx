import { Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { useTaskStore } from '@/stores/taskStore'
import { formatTaskDate } from '@/lib/scheduledTask'
import type { ScheduledTaskTrigger as Trigger } from '@/types/task'

export function ScheduledTaskTrigger({ trigger }: { trigger: Trigger }) {
  const t = useTranslation()
  const open = useTaskStore(state => state.openTaskEditor)
  return <div className="my-3 flex flex-wrap items-center gap-1 text-[12px] text-[var(--color-text-tertiary)]" data-testid="scheduled-task-trigger">
    <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
    <span>{t('scheduledChat.trigger')}</span>
    <Button variant="ghost" size="sm" onClick={() => open(trigger.taskId)}>{trigger.taskName}</Button>
    <span>{formatTaskDate(trigger.scheduledFor)}</span>
  </div>
}
