import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import type { ScheduledTask } from '../../core/operations'
import { latestByTask, type RunSummary } from '../../core/schedulesView'
import { useFocusedResource } from '../../core/useFocusedResource'
import {
  Button,
  EmptyState,
  Footnote,
  Group,
  IconButton,
  InlineError,
  LargeTitle,
  Loading,
  NavBar,
  ScreenView,
  Separator,
  useColors,
} from '../kit'
import { useNow } from '../activity/useNow'
import { NewScheduleSheet } from './NewScheduleSheet'
import { ScheduleRow } from './ScheduleRow'
import { usePendingSwitches } from './usePendingSwitches'

export const schedulePath = (id: string) => `/api/scheduled-tasks/${encodeURIComponent(id)}`

/** 定时任务列表（Schedules 稿）：每 5 秒刷新，开关即时生效，点行看详情。 */
export function ScheduleList({ hostId }: { hostId: string }) {
  const colors = useColors()
  const { host, client, error: connectionError } = useConnection(hostId)
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        const [tasks, runs] = await Promise.all([
          client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks', { signal }),
          client.get<{ runs: RunSummary[] }>(
            '/api/scheduled-tasks/runs?limit=100&summaryOnly=true',
            { signal }
          ),
        ])
        return { tasks: tasks.tasks, runs: runs.runs }
      },
      [client]
    ),
    5000
  )
  const [creating, setCreating] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const now = useNow(true, 30000)
  const tasks = resource.value?.tasks
  const runs = useMemo(() => latestByTask(resource.value?.runs ?? []), [resource.value])
  const server = useMemo(
    () => new Map((tasks ?? []).map((task) => [task.id, task.enabled !== false])),
    [tasks]
  )
  const switches = usePendingSwitches(server)
  const toggle = (task: ScheduledTask, value: boolean) => {
    if (!client) return
    void resource.run(async (signal) => {
      switches.set(task.id, value)
      try {
        return await client.request(schedulePath(task.id), {
          method: 'PUT',
          body: { enabled: value, ...(task.revision === undefined ? {} : { expectedRevision: task.revision }) },
          signal,
        })
      } catch (e) {
        switches.drop(task.id)
        throw e
      }
    })
  }
  const openCreate = () => setCreating(true)
  return (
    <ScreenView>
      <NavBar
        right={
          <IconButton icon="plus" label="新建定时任务" strokeWidth={2} onPress={openCreate} />
        }
      />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.ink3}
            onRefresh={() => {
              setRefreshing(true)
              void resource.refresh().finally(() => setRefreshing(false))
            }}
          />
        }
      >
        <LargeTitle
          title="定时任务"
          subtitle={`${host?.name ?? '电脑'} 开着、cc-haha 在运行时，按计划指定的时区执行`}
          style={{ paddingBottom: 16 }}
        />
        <InlineError text={connectionError || resource.error} style={{ marginBottom: 12 }} />
        {resource.loading ? (
          <Loading />
        ) : tasks?.length ? (
          <>
            <Group>
              {tasks.map((task, index) => (
                <View key={task.id}>
                  {index > 0 && <Separator />}
                  <ScheduleRow
                    task={task}
                    run={runs.get(task.id)}
                    enabled={switches.value(task.id, task.enabled !== false)}
                    now={new Date(now)}
                    disabled={resource.busy || !client}
                    onOpen={() =>
                      router.push({
                        pathname: '/schedule/[id]',
                        params: { id: task.id, host: hostId },
                      })
                    }
                    onToggle={(value) => toggle(task, value)}
                  />
                </View>
              ))}
            </Group>
            <Footnote style={{ paddingTop: 10 }}>点开任务可修改执行计划。执行内容可在电脑上继续编辑。</Footnote>
          </>
        ) : tasks ? (
          <EmptyState
            icon="clock"
            title="还没有定时任务"
            detail="选一个时间，到点后由这台电脑执行。"
            action={
              <View style={{ alignItems: 'center' }}>
                <Button title="新建" icon="plus" onPress={openCreate} disabled={!client} />
              </View>
            }
          />
        ) : null}
      </ScrollView>
      <NewScheduleSheet
        visible={creating}
        client={client}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false)
          void resource.refresh()
        }}
      />
    </ScreenView>
  )
}
