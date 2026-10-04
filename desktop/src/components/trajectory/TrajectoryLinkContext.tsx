import { createContext, useContext } from 'react'
import { ListTree } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'
import { useTrajectoryViewStore } from '../../stores/trajectoryViewStore'

/**
 * Provided by the main session's message list. Tool cards render a "view in
 * trajectory" action only inside it — side chats, subagent transcripts and
 * mobile layouts have no trajectory tab to jump to.
 */
export const TrajectoryLinkContext = createContext<{ sessionId: string } | null>(null)

export function ViewInTrajectoryButton({ toolUseId, className }: { toolUseId: string; className?: string }) {
  const t = useTranslation()
  const link = useContext(TrajectoryLinkContext)
  const reveal = useTrajectoryViewStore((state) => state.revealInTrajectory)
  // Namespaced ids belong to a subagent's own transcript, not this session's.
  if (!link || toolUseId.includes('/')) return null
  return (
    <IconButton
      icon={<ListTree size={13} />}
      label={t('trajectory.viewInTrajectory')}
      size="xs"
      tone="muted"
      className={className}
      data-testid="view-in-trajectory"
      onClick={(event) => {
        event.stopPropagation()
        reveal(link.sessionId, `t:${toolUseId}`)
      }}
    />
  )
}
