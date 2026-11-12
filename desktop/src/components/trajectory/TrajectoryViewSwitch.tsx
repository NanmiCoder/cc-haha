import { MessagesSquare, ListTree } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { SessionAttentionMark } from '../layout/SessionAttentionMark'
import { sessionNeedsAttention } from '../../lib/sessionAttention'
import { useChatStore } from '../../stores/chatStore'
import { useTrajectoryViewStore, type SessionViewMode } from '../../stores/trajectoryViewStore'

/** The Chat / Trajectory switch in the session header. */
export function TrajectoryViewSwitch({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const mode = useTrajectoryViewStore((state) => state.modes[sessionId] ?? 'chat')
  const setMode = useTrajectoryViewStore((state) => state.setMode)
  // Approval and question cards render in the chat, which Trajectory hides; the mark
  // on Chat is the only sign one is waiting while the ledger is up.
  const needsAttention = useChatStore((state) => sessionNeedsAttention(state.sessions[sessionId]))
  const chatLabel = t('trajectory.switch.chat')
  return (
    <SegmentedControl<SessionViewMode>
      as="tablist"
      size="sm"
      layout="auto"
      label={t('trajectory.switch.label')}
      value={mode}
      onChange={(next) => setMode(sessionId, next)}
      items={[
        {
          value: 'chat',
          label: mode === 'trajectory' && needsAttention
            ? <>{chatLabel}<SessionAttentionMark label={t('sidebar.sessionNeedsAttention')} /></>
            : chatLabel,
          icon: <MessagesSquare size={14} strokeWidth={1.75} aria-hidden />,
        },
        { value: 'trajectory', label: t('trajectory.switch.trajectory'), icon: <ListTree size={14} strokeWidth={1.75} aria-hidden /> },
      ]}
    />
  )
}
