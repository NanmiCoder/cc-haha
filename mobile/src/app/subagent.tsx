import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { EmptyState, NavBar, ScreenView } from '../ui/kit'
import { SubagentRun } from '../ui/activity/SubagentRun'

/** /subagent?host&id&taskId&toolUseId —— 一个子 Agent 的只读对话，运行中可停止。 */
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
        <NavBar title="子 Agent" />
        <EmptyState title="找不到这个子 Agent" detail="它的记录可能已被清理，请回到会话重新打开。" />
      </ScreenView>
    )
  return <SubagentRun key={`${hostId}:${id}:${toolUseId}`} hostId={hostId} sessionId={id} taskId={taskId} toolUseId={toolUseId} />
}
