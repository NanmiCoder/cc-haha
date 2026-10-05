import { ListChecks } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import { useActivityPanelStore } from '../../stores/activityPanelStore'

type SessionActivityButtonProps = {
  sessionId: string
  label?: string
}

export function SessionActivityButton({
  sessionId,
  label,
}: SessionActivityButtonProps) {
  const t = useTranslation()
  const resolvedLabel = label ?? t('session.activity.title')
  const isOpen = useActivityPanelStore((state) => state.isOpen(sessionId))
  const toggle = useActivityPanelStore((state) => state.toggle)
  return (
    <IconButton
      icon={<ListChecks size={16} strokeWidth={1.75} />}
      label={resolvedLabel}
      size="md"
      // An open panel is a pressed toolbar toggle: the neutral selected fill,
      // not a terracotta wash — brand is kept for the send key and selection
      // marks. `pressed` also owns `aria-pressed`.
      tone="muted"
      pressed={isOpen}
      aria-expanded={isOpen}
      onClick={() => toggle(sessionId)}
      data-active={isOpen ? 'true' : 'false'}
      data-session-activity-trigger="true"
    />
  )
}
