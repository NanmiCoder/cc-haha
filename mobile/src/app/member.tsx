import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { EmptyState, NavBar, ScreenView } from '../ui/kit'
import { MemberRun } from '../ui/activity/MemberRun'

/** /member?host&id&agent —— 团队里一个成员的任务和只读执行记录。 */
export default function Member() {
  const { host, id, agent } = useLocalSearchParams<{ host?: string; id?: string; agent?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  if (!id || !agent)
    return (
      <ScreenView>
        <NavBar title="团队成员" />
        <EmptyState title="找不到这个成员" detail="团队可能已经结束，请回到会话重新打开。" />
      </ScreenView>
    )
  return <MemberRun key={`${hostId}:${id}:${agent}`} hostId={hostId} sessionId={id} agentId={agent} />
}
