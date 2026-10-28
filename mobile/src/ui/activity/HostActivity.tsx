import { useCallback, useEffect, useRef } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import { useDashboard } from '../../state/DashboardContext'
import { loadHostBackgroundTasks } from '../../core/hostActivity'
import { useFocusedResource } from '../../core/useFocusedResource'
import {
  Chevron,
  EmptyState,
  Footnote,
  Group,
  InlineError,
  Loading,
  NavBar,
  ScreenView,
  Separator,
  type,
  useColors,
} from '../kit'
import { Text } from '../Text'
import { activeSessions } from './hostSessions'
import { TaskRow } from './TaskRow'
import { useNow } from './useNow'

/** 整台电脑的后台活动：按会话分组、只读，点会话进入它的后台活动再停止。 */
export function HostActivity({ hostId }: { hostId: string }) {
  const colors = useColors()
  const { client, host, error: connectionError } = useConnection(hostId)
  const { snapshot } = useDashboard()
  // 快照放进 ref：首页每次刷新不重建轮询，下一次 3 秒轮询自然读到最新会话。
  const current = snapshot?.hostId === hostId ? snapshot : null
  const snapshotRef = useRef(current)
  useEffect(() => {
    snapshotRef.current = current
  }, [current])
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        const sessions = await activeSessions(client, snapshotRef.current, signal)
        const groups = await loadHostBackgroundTasks(
          client,
          sessions.map((session) => session.id),
          signal
        )
        // 一个会话都没读到时不能说“没有后台活动”，按读取失败处理；部分没读到要说明。
        if (sessions.length && !groups.length)
          throw new Error('读不到后台活动，确认电脑连接正常后再试。')
        const titles = new Map(sessions.map((session) => [session.id, session.title]))
        return {
          missing: sessions.length - groups.length,
          groups: groups
            .filter((group) => group.tasks.length > 0)
            .map((group) => ({ ...group, title: titles.get(group.sessionId) ?? '未命名会话' })),
        }
      },
      [client]
    ),
    3000
  )
  const groups = resource.value?.groups ?? []
  const missing = resource.value?.missing ?? 0
  const now = useNow(groups.some((group) => group.tasks.some((task) => task.status === 'running')))
  const open = (sessionId: string) =>
    router.push({ pathname: '/chat/[id]', params: { id: sessionId, host: hostId } })
  return (
    <ScreenView>
      <NavBar title="后台活动" subtitle={host?.name} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <InlineError text={connectionError || resource.error} style={{ marginBottom: 8 }} />
        {missing > 0 ? (
          <Footnote style={{ paddingTop: 0, paddingBottom: 8 }}>
            有 {missing} 个会话的后台活动这次没读到，稍后会自动重试。
          </Footnote>
        ) : null}
        {resource.loading ? (
          <Loading />
        ) : resource.error && !resource.value ? null : groups.length === 0 ? (
          <EmptyState
            title="没有后台活动"
            detail="子 Agent 和后台命令开始后会显示在这里。"
          />
        ) : (
          <>
            {groups.map((group, groupIndex) => (
              <View key={group.sessionId}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`进入 ${group.title} 的后台活动`}
                  onPress={() => open(group.sessionId)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 30,
                    paddingTop: groupIndex === 0 ? 4 : 22,
                    paddingBottom: 8,
                    paddingHorizontal: 4,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text numberOfLines={1} style={[type.section, { flex: 1, color: colors.ink2 }]}>
                    {group.title}
                  </Text>
                  <Chevron />
                </Pressable>
                <Group>
                  {group.tasks.map((task, index) => (
                    <View key={task.taskId}>
                      {index > 0 && <Separator inset={40} />}
                      <TaskRow task={task} now={now} />
                    </View>
                  ))}
                </Group>
              </View>
            ))}
            <Footnote style={{ paddingTop: 10 }}>进入会话后可以停止</Footnote>
          </>
        )}
      </ScrollView>
    </ScreenView>
  )
}
