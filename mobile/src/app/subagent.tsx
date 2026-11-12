import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { EmptyState, NavBar, ScreenView } from '../ui/kit'
import { SubagentRun } from '../ui/activity/SubagentRun'

/** /subagent?host&id&taskId&toolUseId — Read-only conversation of a subagent; can be stopped while running. */
export default function Subagent() {
  const { host, id, taskId, toolUseId } = useLocalSearchParams<{
    host?: string
    id?: string
    taskId?: string
    toolUseId?: string
  }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  if (!id || !toolUseId)
    return (
      <ScreenView>
        <NavBar title="Subagent" />
        <EmptyState title="Cannot find this subagent" detail="Its records may have been cleaned up; go back to the session and reopen it." />
      </ScreenView>
    )
  return <SubagentRun key={`${hostId}:${id}:${toolUseId}`} hostId={hostId} sessionId={id} taskId={taskId} toolUseId={toolUseId} />
}
