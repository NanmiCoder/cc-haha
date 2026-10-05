import { CalendarClock } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useTranslation } from '../../i18n'

type Props = {
  onCreateTask: () => void
}

/**
 * The empty list sits in the same white, hairline-bordered card the filled
 * list uses, so creating the first task does not move the page's frame. The
 * action is `secondary`: the page head already carries the primary one, and
 * two ink blocks on one screen compete for the same click.
 */
export function TaskEmptyState({ onCreateTask }: Props) {
  const t = useTranslation()
  return (
    <Card radius="lg" surface="lowest" padding="none">
      <EmptyState
        variant="plain"
        size="md"
        icon={<CalendarClock size={20} strokeWidth={1.75} aria-hidden="true" />}
        title={t('tasks.emptyTitle')}
        description={t('tasks.emptyDesc')}
        action={{ label: t('tasks.newTask'), onClick: onCreateTask, variant: 'secondary' }}
      />
    </Card>
  )
}
