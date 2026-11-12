import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Text } from '../Text'
import { StatusGlyph, Spinner, useColors, type StatusKind } from '../kit'
import { relativeLabel, type DashboardRow } from '../../core/dashboard'
import {
  decisionAction,
  outcomeLine,
  pendingWhileOffline,
  projectOf,
  settledOutcome,
  stalledLabel,
  type Outcome,
} from './homeModel'
import { Elapsed, Highlight, PlainDot, TaskRow, TimeLabel, useNow } from './parts'

const outcomeGlyph: Record<Outcome, StatusKind> = {
  done: 'done',
  review: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'idle',
}

const untitled = (row: DashboardRow) => row.session.title || 'Untitled task'

/** In progress: spinner · live step (project if none) · ticking duration; when stuck it becomes an amber dashed ring. */
export function RunningRow({
  row,
  background,
  onPress,
}: {
  row: DashboardRow
  /** Number of background tasks running in this session; hidden when unknown. */
  background?: number
  onPress(): void
}) {
  const colors = useColors()
  const { activity } = row
  const project = projectOf(row.session)?.name
  const stalled = Boolean(activity?.stalled)
  const step = activity?.preview?.trim() || project || 'Working'
  return (
    <TaskRow
      glyph={stalled ? <StatusGlyph status="stalled" /> : <Spinner />}
      title={untitled(row)}
      subtitle={stalled ? <StalledText row={row} /> : step}
      subtitleMono={!stalled}
      subtitleColor={stalled ? colors.attn : undefined}
      trailing={
        activity?.startedAt || background ? (
          <View style={{ alignItems: 'flex-end', gap: 3 }}>
            {activity?.startedAt ? <Elapsed since={activity.startedAt} /> : null}
            {background ? (
              <Text style={{ fontSize: 12, lineHeight: 18, color: colors.ink3 }}>
                background {background}
              </Text>
            ) : null}
          </View>
        ) : null
      }
      accessibilityLabel={`${untitled(row)}, ${stalled ? 'No progress' : 'In progress'}, ${step}${background ? `, ${background} in background` : ''}`}
      onPress={onPress}
    />
  )
}

function StalledText({ row }: { row: DashboardRow }) {
  const now = useNow(30000)
  return <>{stalledLabel(row.activity, now)}</>
}

/** Recent: green check for done / red exclamation for error / grey square for you stopped / blue dot for unviewed; history sessions without records only show the project. */
export function SettledRow({ row, onPress }: { row: DashboardRow; onPress?(): void }) {
  const colors = useColors()
  const outcome = settledOutcome(row.activity)
  const line = outcomeLine(outcome, projectOf(row.session)?.name)
  return (
    <TaskRow
      glyph={<StatusGlyph status={outcomeGlyph[outcome]} />}
      title={untitled(row)}
      titleWeight={outcome === 'review' ? '600' : '500'}
      subtitle={line}
      subtitleColor={outcome === 'failed' ? colors.err : undefined}
      trailing={
        onPress ? (
          <TimeLabel text={relativeLabel(row.session.modifiedAt)} unread={outcome === 'review'} />
        ) : null
      }
      accessibilityLabel={`${untitled(row)}, ${line}`}
      onPress={onPress}
    />
  )
}

/** Search results: all states share one row, with keywords highlighted in title and project name; not a live view, so no spinning or breathing. */
export function SearchRow({
  row,
  query,
  onPress,
}: {
  row: DashboardRow
  query: string
  onPress(): void
}) {
  const colors = useColors()
  const state = row.activity?.activityState
  const project = projectOf(row.session)?.name
  const projectNode = project ? <Highlight text={project} query={query} /> : null
  let glyph: ReactNode
  let subtitle: ReactNode
  let subtitleColor: string | undefined
  let description: string
  if (state === 'waiting') {
    const action = decisionAction(row.activity)
    glyph = <PlainDot />
    subtitle = (
      <>
        {projectNode}
        {projectNode ? ' · ' : ''}
        <Text style={{ color: colors.attn }}>{action}</Text>
      </>
    )
    description = action
  } else if (state === 'running') {
    const stalled = Boolean(row.activity?.stalled)
    glyph = <StatusGlyph status={stalled ? 'stalled' : 'running'} />
    subtitle = (
      <>
        {projectNode}
        {projectNode ? ' · ' : ''}
        <Text style={{ color: stalled ? colors.attn : colors.run }}>
          {stalled ? 'No progress' : 'In progress'}
        </Text>
      </>
    )
    description = stalled ? 'No progress' : 'In progress'
  } else {
    const outcome = settledOutcome(row.activity)
    glyph = <StatusGlyph status={outcomeGlyph[outcome]} />
    const lead = outcome === 'failed' ? 'Stopped with error' : outcome === 'stopped' ? 'You stopped' : ''
    const tail = outcomeLine(outcome, null)
    subtitle = lead ? (
      <>
        {lead}
        {projectNode ? ' · ' : ''}
        {projectNode}
      </>
    ) : (
      <>
        {projectNode}
        {projectNode && tail ? ' · ' : ''}
        {tail}
      </>
    )
    subtitleColor = outcome === 'failed' ? colors.err : undefined
    description = outcomeLine(outcome, project)
  }
  return (
    <TaskRow
      glyph={glyph}
      title={<Highlight text={untitled(row)} query={query} />}
      subtitle={subtitle}
      subtitleColor={subtitleColor}
      trailing={<TimeLabel text={relativeLabel(row.session.modifiedAt)} />}
      accessibilityLabel={`${untitled(row)}, ${description}`}
      onPress={onPress}
    />
  )
}

/** Snapshot from before disconnecting: waiting and running states can no longer be confirmed, so just say so. */
export function OfflineRow({ row }: { row: DashboardRow }) {
  const state = row.activity?.activityState
  if (state === 'waiting')
    return (
      <TaskRow
        glyph={<PlainDot />}
        title={untitled(row)}
        subtitle={pendingWhileOffline(row.activity)}
      />
    )
  if (state === 'running')
    return (
      <TaskRow
        glyph={<StatusGlyph status="idle" />}
        title={untitled(row)}
        subtitle="Was running when disconnected · status unknown"
      />
    )
  return <SettledRow row={row} />
}

/** "Show N earlier" at the end of the list. */
export function MoreRow({ count, onPress }: { count: number; onPress(): void }) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 14,
        paddingLeft: 40,
        justifyContent: 'center',
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <View>
        <Text style={{ fontSize: 15, color: colors.ink2 }}>Show {count} earlier</Text>
      </View>
    </Pressable>
  )
}
