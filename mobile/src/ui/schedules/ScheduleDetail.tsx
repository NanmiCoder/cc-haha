import { useCallback, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import type { ScheduledTask, TaskRun } from '../../core/operations'
import {
  newestFirst,
  nextDayLabel,
  nextRunAt,
  projectLabel,
  type RunSummary,
} from '../../core/schedulesView'
import { useFocusedResource } from '../../core/useFocusedResource'
import {
  Button,
  Card,
  EmptyState,
  Footnote,
  Group,
  InlineError,
  Loading,
  NavBar,
  ScreenView,
  SectionHeader,
  Separator,
  Switch,
  goBack,
  useColors,
} from '../kit'
import { Text } from '../Text'
import { ConfirmSheet } from '../activity/ConfirmSheet'
import { useNow } from '../activity/useNow'
import { EditTimeSheet } from './EditTimeSheet'
import { ActionButton, DangerRowButton, ScheduleLine } from './parts'
import { RunResultSheet } from './RunResultSheet'
import { RunRow } from './RunRow'
import { schedulePath } from './ScheduleList'
import { usePendingSwitches } from './usePendingSwitches'

const confirmCopy = {
  run: {
    title: '现在执行这个任务？',
    detail: '将在电脑上立即运行，可修改文件和执行命令。已有运行记录可从结果入口查看。',
    action: '立即运行',
  },
  delete: {
    title: '删除这个定时任务？',
    detail: '删除后不再触发后续执行。已经运行的任务与执行记录不会因此删除。',
    action: '确认删除',
  },
} as const

/** 定时任务详情（ScheduleDetail 稿）：执行内容、现在跑一次、改执行时间、最近运行、删除。 */
export function ScheduleDetail({ hostId, id }: { hostId: string; id: string }) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('正在连接电脑')
        const { tasks } = await client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks', {
          signal,
        })
        const task = tasks.find((item) => item.id === id) ?? null
        if (!task) return { task: null, runs: [] as RunSummary[] }
        const { runs } = await client.get<{ runs: RunSummary[] }>(
          `${schedulePath(id)}/runs?limit=20&summaryOnly=true`,
          { signal }
        )
        return { task, runs: newestFirst(runs ?? []) }
      },
      [client, id]
    ),
    5000
  )
  const [confirm, setConfirm] = useState<'run' | 'delete' | null>(null)
  // 关闭动画期间文案保持不变。
  const [copy, setCopy] = useState<'run' | 'delete'>('run')
  const ask = (action: 'run' | 'delete') => {
    setCopy(action)
    setConfirm(action)
  }
  const [editing, setEditing] = useState(false)
  const [editKey, setEditKey] = useState(0)
  const [result, setResult] = useState<TaskRun | null>(null)
  // 删除成功后返回列表；返回动画期间继续显示原内容，不闪“已不在电脑上”。
  const [leaving, setLeaving] = useState<ScheduledTask | null>(null)
  const task = resource.value?.task ?? leaving
  const runs = resource.value?.runs ?? []
  const latest = runs[0]
  const server = useMemo(
    () => new Map<string, boolean>(task ? [[task.id, task.enabled !== false]] : []),
    [task]
  )
  const switches = usePendingSwitches(server)
  const now = useNow(true, latest?.status === 'running' ? 1000 : 30000)
  if (resource.loading)
    return (
      <ScreenView>
        <NavBar backLabel="定时任务" />
        <Loading />
      </ScreenView>
    )
  if (!task)
    return (
      <ScreenView>
        <NavBar backLabel="定时任务" />
        <InlineError text={connectionError || resource.error} style={{ marginHorizontal: 16 }} />
        {resource.value ? (
          <EmptyState
            icon="clock"
            title="这个定时任务已不在电脑上"
            detail="可能已经在电脑上删除了。"
            action={
              <View style={{ alignItems: 'center' }}>
                <Button title="返回定时任务" variant="secondary" onPress={goBack} />
              </View>
            }
          />
        ) : null}
      </ScreenView>
    )
  const name = task.name || '未命名任务'
  const enabled = switches.value(task.id, task.enabled !== false)
  const next = enabled ? nextRunAt(task.cron, new Date(now)) : null
  const toggle = (value: boolean) => {
    if (!client) return
    void resource.run(async (signal) => {
      switches.set(task.id, value)
      try {
        return await client.request(schedulePath(task.id), {
          method: 'PUT',
          body: { enabled: value },
          signal,
        })
      } catch (e) {
        switches.drop(task.id)
        throw e
      }
    })
  }
  const confirmAction = () => {
    if (!client || !confirm) return
    const action = confirm
    void resource.run(
      (signal) =>
        client.request(`${schedulePath(task.id)}${action === 'run' ? '/run' : ''}`, {
          method: action === 'run' ? 'POST' : 'DELETE',
          ...(action === 'run' ? { body: {} } : {}),
          signal,
        }),
      () => {
        setConfirm(null)
        if (action === 'delete') {
          setLeaving(task)
          goBack()
        }
      }
    )
  }
  const saveCron = (cron: string) => {
    if (!client) return
    void resource.run(
      (signal) =>
        client.request(schedulePath(task.id), { method: 'PUT', body: { cron }, signal }),
      () => setEditing(false)
    )
  }
  const openRun = (run: RunSummary) => {
    if (run.sessionId) {
      router.push({ pathname: '/chat/[id]', params: { id: run.sessionId, host: hostId } })
      return
    }
    if (client)
      void resource.run(
        (signal) =>
          client.get<{ run: TaskRun }>(
            `/api/scheduled-tasks/runs/${encodeURIComponent(run.id)}`,
            { signal }
          ),
        (value) => setResult(value.run)
      )
  }
  // 弹层打开时错误显示在弹层里，页面不再重复。
  const sheetOpen = !!confirm || editing
  const pageError = connectionError || (sheetOpen ? '' : resource.error)
  return (
    <ScreenView>
      <NavBar backLabel="定时任务" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4, paddingBottom: 16 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ fontSize: 26, lineHeight: 32, fontWeight: '600', color: colors.ink }}>
              {name}
            </Text>
            <ScheduleLine
              cron={task.cron}
              size={14}
              extras={[
                projectLabel(task.folderPath),
                enabled ? (next ? `下次${nextDayLabel(next, new Date(now))}` : '') : '已暂停',
              ]}
            />
          </View>
          <View style={{ marginTop: 2 }}>
            <Switch
              label="启用"
              value={enabled}
              disabled={resource.busy || !client}
              onValueChange={toggle}
            />
          </View>
        </View>
        <InlineError text={pageError} style={{ marginBottom: 12 }} />
        <Card style={{ borderRadius: 16, gap: 6 }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>执行内容</Text>
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: colors.ink }}>
            {task.prompt}
          </Text>
        </Card>
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 12 }}>
          <ActionButton
            title="现在跑一次"
            primary
            play
            disabled={resource.busy || !client || latest?.status === 'running'}
            onPress={() => ask('run')}
          />
          <ActionButton
            title="改执行时间"
            disabled={resource.busy || !client}
            onPress={() => {
              setEditKey((value) => value + 1)
              setEditing(true)
            }}
          />
        </View>
        <SectionHeader title="最近运行" />
        <Group>
          {runs.length ? (
            runs.map((run, index) => (
              <View key={run.id}>
                {index > 0 && <Separator inset={34} />}
                <RunRow run={run} now={now} disabled={resource.busy} onPress={() => openRun(run)} />
              </View>
            ))
          ) : (
            <View style={{ height: 56, justifyContent: 'center', paddingHorizontal: 14 }}>
              <Text style={{ fontSize: 15, color: colors.ink3 }}>还没有执行记录</Text>
            </View>
          )}
        </Group>
        <DangerRowButton
          title="删除这个定时任务"
          disabled={resource.busy || !client}
          onPress={() => ask('delete')}
          style={{ marginTop: 22 }}
        />
        <Footnote>执行内容和高级配置在电脑上改。删除后不再触发，已有的运行记录会留着。</Footnote>
      </ScrollView>
      <ConfirmSheet
        visible={!!confirm}
        title={confirmCopy[copy].title}
        subject={name}
        detail={confirmCopy[copy].detail}
        confirmTitle={confirmCopy[copy].action}
        destructive={copy === 'delete'}
        busy={resource.busy}
        error={confirm ? resource.error : ''}
        onConfirm={confirmAction}
        onClose={() => setConfirm(null)}
      />
      <EditTimeSheet
        key={editKey}
        visible={editing}
        cron={task.cron}
        busy={resource.busy}
        error={editing ? resource.error : ''}
        onSave={saveCron}
        onClose={() => setEditing(false)}
      />
      <RunResultSheet run={result} onClose={() => setResult(null)} />
    </ScreenView>
  )
}
