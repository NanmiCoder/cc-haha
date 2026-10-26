import { Clock } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { useTaskStore } from '@/stores/taskStore'
import { formatTaskDate, taskIsAttached } from '@/lib/scheduledTask'

/** A noninteractive mark: session rows themselves are buttons. */
export function SessionScheduleMark({ sessionId }: { sessionId: string }) {
  const tasks = useTaskStore(state => state.tasks)
  const t = useTranslation()
  const attached = tasks.filter(task => taskIsAttached(task, sessionId))
  if (!attached.length) return null
  const enabled = attached.filter(task => task.enabled !== false)
  const next = enabled.map(task => task.nextRunAt ?? (task.schedule?.kind === 'once' ? Date.parse(task.schedule.runAt) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0]
  const label = [t('scheduledChat.attached', { count: attached.length }), enabled.length === 0 ? t('scheduledChat.paused') : next ? t('scheduledChat.nextRun', { time: formatTaskDate(next) }) : ''].filter(Boolean).join(' · ')
  const Icon = Clock
  return <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 text-[var(--color-text-tertiary)]"><Icon size={13} strokeWidth={1.75} aria-hidden="true" /></span>
}
