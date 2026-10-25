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

const untitled = (row: DashboardRow) => row.session.title || '未命名任务'

/** 进行中：转圈 · 实时步骤（没有就写项目）· 走秒时长；卡住时换成琥珀虚线圈。 */
export function RunningRow({
  row,
  background,
  onPress,
}: {
  row: DashboardRow
  /** 这个会话正在跑的后台任务数；未知时不显示。 */
  background?: number
  onPress(): void
}) {
  const colors = useColors()
  const { activity } = row
  const project = projectOf(row.session)?.name
  const stalled = Boolean(activity?.stalled)
  const step = activity?.preview?.trim() || project || '正在处理'
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
                后台 {background}
              </Text>
            ) : null}
          </View>
        ) : null
      }
      accessibilityLabel={`${untitled(row)}，${stalled ? '没有进展' : '进行中'}，${step}${background ? `，后台 ${background} 项` : ''}`}
      onPress={onPress}
    />
  )
}

function StalledText({ row }: { row: DashboardRow }) {
  const now = useNow(30000)
  return <>{stalledLabel(row.activity, now)}</>
}

/** 最近：完成绿勾 / 出错红叹号 / 你停止了灰方块 / 未查看蓝点；没有记录的历史会话只写项目。 */
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
      accessibilityLabel={`${untitled(row)}，${line}`}
      onPress={onPress}
    />
  )
}

/** 搜索结果：所有状态共用一行，标题和项目名里的关键词高亮；不是实时视图，所以不转圈不呼吸。 */
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
          {stalled ? '没有进展' : '进行中'}
        </Text>
      </>
    )
    description = stalled ? '没有进展' : '进行中'
  } else {
    const outcome = settledOutcome(row.activity)
    glyph = <StatusGlyph status={outcomeGlyph[outcome]} />
    const lead = outcome === 'failed' ? '出错停下' : outcome === 'stopped' ? '你停止了' : ''
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
      accessibilityLabel={`${untitled(row)}，${description}`}
      onPress={onPress}
    />
  )
}

/** 断开前的快照：等待和运行的状态都已无法确认，只如实说明。 */
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
        subtitle="断开时在运行 · 状态未知"
      />
    )
  return <SettledRow row={row} />
}

/** 列表末尾的“显示更早的 N 个”。 */
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
        <Text style={{ fontSize: 15, color: colors.ink2 }}>显示更早的 {count} 个</Text>
      </View>
    </Pressable>
  )
}
