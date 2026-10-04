import { MessagesSquare, ListTree } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { useTrajectoryViewStore, type SessionViewMode } from '../../stores/trajectoryViewStore'

/** The 对话 / 轨迹 switch in the session header. */
export function TrajectoryViewSwitch({ sessionId }: { sessionId: string }) {
  const t = useTranslation()
  const mode = useTrajectoryViewStore((state) => state.modes[sessionId] ?? 'chat')
  const setMode = useTrajectoryViewStore((state) => state.setMode)
  return (
    <SegmentedControl<SessionViewMode>
      as="tablist"
      size="sm"
      layout="auto"
      label={t('trajectory.switch.label')}
      value={mode}
      onChange={(next) => setMode(sessionId, next)}
      items={[
        { value: 'chat', label: t('trajectory.switch.chat'), icon: <MessagesSquare size={13} aria-hidden /> },
        { value: 'trajectory', label: t('trajectory.switch.trajectory'), icon: <ListTree size={13} aria-hidden /> },
      ]}
    />
  )
}
