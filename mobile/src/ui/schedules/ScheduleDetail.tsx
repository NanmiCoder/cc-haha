import { useCallback, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useConnection } from '../../state/AppContext'
import type { ScheduledTask, TaskRun } from '../../core/operations'
import type { scheduleUpdate } from '../../core/scheduleDraft'
import {
  newestFirst,
  nextRunAt,
  projectLabel,
  taskNextRunLabel,
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
    title: 'Run this task now?',
    detail: 'It will run on the computer immediately and can modify files and run commands. Existing run records are available from the results entry.',
    action: 'Run now',
  },
  delete: {
    title: 'Delete this scheduled task?',
    detail: 'After deletion later runs no longer trigger. Tasks already run and their records are not deleted.',
    action: 'Confirm delete',
  },
} as const

/** Scheduled task details (ScheduleDetail design): task content, run now, change run time, recent runs, delete. */
export function ScheduleDetail({ hostId, id }: { hostId: string; id: string }) {
  const colors = useColors()
  const { client, error: connectionError } = useConnection(hostId)
  const resource = useFocusedResource(
    useCallback(
      async (signal: AbortSignal) => {
        if (!client) throw new Error('Connecting to computer')
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
  // Text stays unchanged during the close animation.
  const [copy, setCopy] = useState<'run' | 'delete'>('run')
  const ask = (action: 'run' | 'delete') => {
    setCopy(action)
    setConfirm(action)
  }
  const [editing, setEditing] = useState(false)
  const [editKey, setEditKey] = useState(0)
  const [result, setResult] = useState<TaskRun | null>(null)
  // After successful deletion go back to the list; keep the original content during the back animation without flashing "no longer on the computer".
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
        <NavBar backLabel="Scheduled task" />
        <Loading />
      </ScreenView>
    )
  if (!task)
    return (
      <ScreenView>
        <NavBar backLabel="Scheduled task" />
        <InlineError text={connectionError || resource.error} style={{ marginHorizontal: 16 }} />
        {resource.value ? (
          <EmptyState
            icon="clock"
            title="This scheduled task is no longer on the computer"
            detail="It may have been deleted on the computer."
            action={
              <View style={{ alignItems: 'center' }}>
                <Button title="Back to scheduled tasks" variant="secondary" onPress={goBack} />
              </View>
            }
          />
        ) : null}
      </ScreenView>
    )
  const name = task.name || 'Untitled task'
  const enabled = switches.value(task.id, task.enabled !== false)
  const next = enabled ? nextRunAt(task, new Date(now)) : null
  const toggle = (value: boolean) => {
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
  const saveSchedule = (update: NonNullable<ReturnType<typeof scheduleUpdate>>) => {
    if (!client) return
    void resource.run(
      (signal) =>
        client.request(schedulePath(task.id), { method: 'PUT', body: update, signal }),
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
  // When a sheet is open errors show in the sheet and are not repeated on the page.
  const sheetOpen = !!confirm || editing
  const pageError = connectionError || (sheetOpen ? '' : resource.error)
  return (
    <ScreenView>
      <NavBar backLabel="Scheduled task" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4, paddingBottom: 16 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={{ fontSize: 26, lineHeight: 32, fontWeight: '600', color: colors.ink }}>
              {name}
            </Text>
            <ScheduleLine
              task={task}
              size={14}
              extras={[
                task.execution?.kind === 'session' ? 'Existing session' : projectLabel(task.folderPath),
                task.scheduleState === 'completed' ? 'Done' : enabled ? (next ? `Next ${taskNextRunLabel(task, next, new Date(now))}` : '') : 'Paused',
              ]}
            />
          </View>
          <View style={{ marginTop: 2 }}>
            <Switch
              label="Enabled"
              value={enabled}
              disabled={resource.busy || !client}
              onValueChange={toggle}
            />
          </View>
        </View>
        <InlineError text={pageError} style={{ marginBottom: 12 }} />
        <Card style={{ borderRadius: 16, gap: 6 }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>Task content</Text>
          <Text selectable style={{ fontSize: 16, lineHeight: 24, color: colors.ink }}>
            {task.prompt}
          </Text>
        </Card>
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 12 }}>
          <ActionButton
            title="Run now"
            primary
            play
            disabled={resource.busy || !client || latest?.status === 'running'}
            onPress={() => ask('run')}
          />
          <ActionButton
            title="Change run time"
            disabled={resource.busy || !client}
            onPress={() => {
              setEditKey((value) => value + 1)
              setEditing(true)
            }}
          />
        </View>
        <SectionHeader title="Recent runs" />
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
              <Text style={{ fontSize: 15, color: colors.ink3 }}>No runs yet</Text>
            </View>
          )}
        </Group>
        <DangerRowButton
          title="Delete this scheduled task"
          disabled={resource.busy || !client}
          onPress={() => ask('delete')}
          style={{ marginTop: 22 }}
        />
        <Footnote>Edit task content and advanced settings on the computer. After deletion it no longer triggers; existing run records are kept.</Footnote>
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
        task={task}
        busy={resource.busy}
        error={editing ? resource.error : ''}
        onSave={saveSchedule}
        onClose={() => setEditing(false)}
      />
      <RunResultSheet run={result} onClose={() => setResult(null)} />
    </ScreenView>
  )
}
