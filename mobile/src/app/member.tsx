import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { EmptyState, NavBar, ScreenView } from '../ui/kit'
import { MemberRun } from '../ui/activity/MemberRun'

/** /member?host&id&agent — A team member tasks and read-only execution log. */
export default function Member() {
  const { host, id, agent } = useLocalSearchParams<{ host?: string; id?: string; agent?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  if (!id || !agent)
    return (
      <ScreenView>
        <NavBar title="Team member" />
        <EmptyState title="Cannot find this member" detail="The team may have ended; go back to the session and reopen it." />
      </ScreenView>
    )
  return <MemberRun key={`${hostId}:${id}:${agent}`} hostId={hostId} sessionId={id} agentId={agent} />
}
