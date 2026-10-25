import { Clock } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import { useTaskStore } from '@/stores/taskStore'
import { describeTaskSchedule, formatTaskDate, type ScheduledTaskResult, type ScheduledTaskRunsResult, type ScheduledTaskListResult } from '@/lib/scheduledTask'
import { openSessionSource } from '@/lib/sessionNavigation'

export function ScheduledTaskCard({ result }: { result: ScheduledTaskResult | ScheduledTaskRunsResult | ScheduledTaskListResult }) {
  const { tasks, loaded, error, openTaskEditor } = useTaskStore()
  const t = useTranslation()
  if (result.kind === 'scheduled_task_list') return <Card padding="sm" className="space-y-2">
    <p className="text-[13px] font-medium">{t('scheduledPage.title')} · {result.totalCount ?? result.tasks.length}</p>
    {result.tasks.map(task => <div key={task.id} className="flex items-center gap-2 text-[12px]">
      <Clock size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{task.name || task.promptPreview || task.id}</p>
        <p className="text-[var(--color-text-secondary)]">{describeTaskSchedule(task, t)}{task.enabled === false ? ` · ${t('scheduledChat.paused')}` : ''}</p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => openTaskEditor(task.id)}>{t('scheduledChat.open')}</Button>
    </div>)}
  </Card>
  if (result.kind === 'scheduled_task_runs') return <Card padding="sm" className="space-y-2">
    <p className="text-[13px] font-medium">{t('scheduledChat.results')}</p>
    {result.runs.length === 0 ? <p className="text-[12px] text-[var(--color-text-secondary)]">{t('scheduledChat.noRuns')}</p> : null}
    {result.runs.map(run => <div key={run.id} className="flex flex-wrap items-center gap-2 text-[12px]">
      <span>{run.taskName || run.taskId} · {formatTaskDate(run.startedAt)}</span>
      <span>{run.status === 'completed' ? t('scheduledChat.completed') : run.status === 'running' ? t('sidebar.sessionRunning') : t('common.error')}</span>
      {run.sessionId ? <Button size="sm" variant="secondary" onClick={() => openSessionSource(run.sessionId!, run.taskName)}>{t('chat.openReferencedSession', { id: run.taskName || run.sessionId })}</Button> : null}
      {run.output || run.error || run.outputPreview || run.errorPreview ? <details className="w-full"><summary className="cursor-pointer">{t('scheduledChat.results')}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[12px]">{run.error || run.errorPreview || run.output || run.outputPreview}</pre></details> : null}
    </div>)}
  </Card>
  const liveTask = tasks.find(task => task.id === result.taskId)
  const task = liveTask ?? result.task
  const deleted = result.operation === 'deleted' || (loaded && !error && !liveTask)
  const status = deleted ? t('scheduledChat.deleted') : task.scheduleState === 'completed' ? t('scheduledChat.completed') : task.enabled === false ? t('scheduledChat.paused') : ''
  return <Card padding="md" className="flex items-center gap-3" data-testid="scheduled-task-card">
    <Clock size={22} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
    <div className="min-w-0 flex-1">
      <p className="truncate text-[14px] font-medium text-[var(--color-text-primary)]">{task.name || task.prompt}</p>
      <p className="text-[12px] text-[var(--color-text-secondary)]">{describeTaskSchedule(task, t)}</p>
      {status ? <p className="text-[12px] text-[var(--color-text-tertiary)]">{status}</p> : null}
    </div>
    <Button size="sm" variant="secondary" disabled={deleted} onClick={() => openTaskEditor(result.taskId)}>{t('scheduledChat.open')}</Button>
  </Card>
}
