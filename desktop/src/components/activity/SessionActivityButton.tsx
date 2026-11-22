import { ListChecks } from 'lucide-react'
import { IconButton, type IconButtonSize } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import { useActivityPanelStore } from '../../stores/activityPanelStore'

type SessionActivityButtonProps = {
  sessionId: string
  label?: string
  size?: IconButtonSize
  /** Applies crisp hairline bevel when open (e.g. inside WorkspaceLayoutControls cluster). */
  borderedWhenActive?: boolean
}

export function SessionActivityButton({
  sessionId,
  label,
  size = 'md',
  borderedWhenActive = false,
}: SessionActivityButtonProps) {
  const t = useTranslation()
  const resolvedLabel = label ?? t('session.activity.title')
  const isOpen = useActivityPanelStore((state) => state.isOpen(sessionId))
  const toggle = useActivityPanelStore((state) => state.toggle)
  return (
    <IconButton
      icon={<ListChecks size={size === 'sm' ? 15 : 16} strokeWidth={1.75} aria-hidden="true" />}
      label={resolvedLabel}
      size={size}
      // An open panel is a pressed toolbar toggle: the neutral selected fill,
      // not a terracotta wash — brand is kept for the send key and selection
      // marks. `pressed` also owns `aria-pressed`.
      tone="muted"
      pressed={isOpen}
      bordered={borderedWhenActive && isOpen}
      aria-expanded={isOpen}
      onClick={() => toggle(sessionId)}
      data-active={isOpen ? 'true' : 'false'}
      data-session-activity-trigger="true"
    />
  )
}
