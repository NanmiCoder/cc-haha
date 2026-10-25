import { useCallback } from 'react'
import { Pressable, View } from 'react-native'
import type { Host } from '../../core/types'
import { useConnection } from '../../state/AppContext'
import { useFocusedResource } from '../../core/useFocusedResource'
import { sessionPath, type BackgroundSnapshot } from '../../core/operations'
import { Icon, useColors } from '../kit'
import { Text } from '../Text'
import { latestTeam, loadTaskList, loadTeam, taskProgress } from './activityData'

/** Compact entry owned by the chat screen; navigation remains at the caller. */
export function ActivitySummary(props: { host: Host; sessionId: string; onPress(): void }) {
  return <SummaryBody key={`${props.host.id}:${props.sessionId}`} {...props} />
}
function SummaryBody({ host, sessionId, onPress }: { host: Host; sessionId: string; onPress(): void }) {
  const colors = useColors()
  const { client } = useConnection(host.id)
  const resource = useFocusedResource(useCallback(async (signal: AbortSignal) => {
    if (!client) throw new Error('正在连接电脑')
    const [tasks, team, background] = await Promise.allSettled([
      loadTaskList(client, sessionId, signal), loadTeam(client, sessionId, signal),
      client.get<BackgroundSnapshot>(`${sessionPath(sessionId)}/background-tasks`, { signal }),
    ])
    const parts: string[] = []
    if (tasks.status === 'fulfilled' && tasks.value.length) {
      const progress = taskProgress(tasks.value)
      parts.push(`任务 ${progress.completed}/${progress.total}`)
    }
    const snapshot = team.status === 'fulfilled' ? latestTeam(team.value) : null
    if (snapshot) parts.push(`团队 ${snapshot.team.members.length} 人`)
    if (background.status === 'fulfilled') {
      const running = background.value.tasks.filter((task) => task.status === 'running').length
      if (running) parts.push(`${running} 项后台运行`)
    }
    if ([tasks, team, background].some((result) => result.status === 'rejected')) parts.push('部分状态待刷新')
    return parts.join(' · ') || '查看任务与后台活动'
  }, [client, sessionId]), 6000)
  return <Pressable accessibilityRole="button" accessibilityLabel={`查看活动，${resource.value || '任务与后台活动'}`} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 40, paddingVertical: 9, paddingHorizontal: 16, opacity: pressed ? 0.65 : 1 })}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="list-checks" size={15} color={colors.ink3} />
      <Text style={{ flex: 1, fontSize: 12, lineHeight: 18, color: colors.ink2 }}>{resource.value || '查看任务与后台活动'}</Text>
      <Icon name="chevron-right" size={14} color={colors.ink3} />
    </View>
  </Pressable>
}
