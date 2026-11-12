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

/** Background activity of the whole computer: grouped by session, read-only; tap a session to enter its background activity and stop there. */
export function HostActivity({ hostId }: { hostId: string }) {
  const colors = useColors()
  const { client, host, error: connectionError } = useConnection(hostId)
  const { snapshot } = useDashboard()
  // The snapshot goes into a ref: home refreshes do not rebuild polling, and the next 3-second poll naturally reads the latest sessions.
  const current = snapshot?.hostId === hostId ? snapshot : null
  const snapshotRef = useRef(current)
  useEffect(() => {
    snapshotRef.current = current
  }, [current])
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('Connecting to computer')
        const sessions = await activeSessions(client, snapshotRef.current, signal)
        const groups = await loadHostBackgroundTasks(
          client,
          sessions.map((session) => session.id),
          signal
        )
        // When no session could be read do not say "no background activity"; treat it as a load failure; explain when some could not be read.
        if (sessions.length && !groups.length)
          throw new Error('Cannot read background activity; check the computer connection and retry.')
        const titles = new Map(sessions.map((session) => [session.id, session.title]))
        return {
          missing: sessions.length - groups.length,
          groups: groups
            .filter((group) => group.tasks.length > 0)
            .map((group) => ({ ...group, title: titles.get(group.sessionId) ?? 'Untitled session' })),
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
      <NavBar title="Background activity" subtitle={host?.name} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <InlineError text={connectionError || resource.error} style={{ marginBottom: 8 }} />
        {missing > 0 ? (
          <Footnote style={{ paddingTop: 0, paddingBottom: 8 }}>
            Background activity of {missing} sessions could not be read this time; it will retry automatically.
          </Footnote>
        ) : null}
        {resource.loading ? (
          <Loading />
        ) : resource.error && !resource.value ? null : groups.length === 0 ? (
          <EmptyState
            title="No background activity"
            detail="Subagents and background commands show up here once they start."
          />
        ) : (
          <>
            {groups.map((group, groupIndex) => (
              <View key={group.sessionId}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open background activity of ${group.title}`}
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
            <Footnote style={{ paddingTop: 10 }}>Can stop after entering the session</Footnote>
          </>
        )}
      </ScrollView>
    </ScreenView>
  )
}
