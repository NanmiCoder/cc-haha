import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { useConnection } from '../../state/AppContext'
import type { SessionActivity } from '../../core/sessionActivity'
import {
  sectionSummaries,
  type CommandRow,
  type PlanTask,
  type StepLine,
  type SubagentRow,
  type TeamModel,
  type TeamRow,
} from '../../core/sessionActivityModel'
import type { BackgroundTask } from '../../core/operations'
import type { Host } from '../../core/types'
import { DetentSheet } from '../DetentSheet'
import { EmptyState, Icon, InlineError, Mono, Spinner, useColors, type IconName } from '../kit'
import { Text } from '../Text'
import { ConfirmSheet } from './ConfirmSheet'
import { TaskOutputSheet } from './TaskOutputSheet'
import { MemberCard, UnassignedCard } from './TeamMembers'
import { agentStatusText, clock } from './activityView'
import { useNow } from './useNow'

type Group = 'tasks' | 'subagents' | 'team' | 'commands'
type Confirm = { ids: string[]; all?: boolean; subject?: string }

/**
 * Running sheet: title row "Running · 32:35" + "Stop all" at top right, then groups by Tasks → Team →
 * → Subagents → Background commands, with sticky collapsible group headers. Half height cannot fit everything, so with tasks or a team the subagent
 * collapse by default. With a team all tasks hang under their members (the lead's are the session's own list) and are not listed separately.
 */
export function ActivitySheet({
  visible,
  onClose,
  activity,
  elapsed,
  onOpenAgent,
  host,
  sessionId,
  onStopTurn,
  launching,
  onOpenMember,
}: {
  visible: boolean
  onClose(): void
  activity: SessionActivity
  /** Duration this turn has run (e.g. 32:35); hidden when absent. */
  elapsed?: string
  /** Tap a subagent card: close the sheet first, then hand the task to the integrator to open the full-screen page. */
  onOpenAgent(task: BackgroundTask): void
  host: Pick<Host, 'id'>
  /** When passed, tapping a background command row shows its full output. */
  sessionId?: string
  /** Extra call after confirming "Stop all", used to stop the main agent's turn as well. */
  onStopTurn?(): void
  /** Number of members starting when the team plan is approved but members have not appeared yet. */
  launching?: number
  /** Tap a member card: close the sheet first, then the integrator opens its execution log. */
  onOpenMember?(team: TeamModel, member: TeamRow): void
}) {
  const colors = useColors()
  const { client } = useConnection(host.id)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [detail, setDetail] = useState<BackgroundTask | null>(null)
  const close = () => {
    setConfirm(null)
    setDetail(null)
    onClose()
  }
  // Team starting counts as running, same as the capsule.
  const active = activity.active || !!launching
  const running = [...activity.subagents, ...activity.commands].filter((row) => row.status === 'running')
  const allStopping = running.length > 0 && running.every((row) => row.stopping)
  const stop = () => {
    const request = confirm
    setConfirm(null)
    if (!request) return
    if (request.all) {
      activity.stopAll()
      onStopTurn?.()
    } else if (request.ids[0]) activity.stopTask(request.ids[0])
  }
  return (
    <DetentSheet
      visible={visible}
      onClose={close}
      scroll={false}
      left={
        <View
          accessibilityRole="header"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4 }}
        >
          {active ? <Spinner size={15} thickness={2.4} /> : null}
          <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.ink }}>
            {active ? 'Running' : 'Tasks'}
          </Text>
          {active && elapsed ? (
            <Mono style={{ fontSize: 15, color: colors.ink2 }}>{elapsed}</Mono>
          ) : null}
        </View>
      }
      right={
        running.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop all"
            accessibilityState={{ disabled: allStopping }}
            disabled={allStopping}
            onPress={() => setConfirm({ ids: running.map((row) => row.id), all: true })}
            style={({ pressed }) => ({
              height: 44,
              paddingHorizontal: 14,
              marginRight: -10,
              justifyContent: 'center',
              opacity: allStopping ? 0.45 : pressed ? 0.6 : 1,
            })}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.err }}>
              {allStopping ? 'Stopping' : 'Stop all'}
            </Text>
          </Pressable>
        ) : undefined
      }
    >
      <Content
        activity={activity}
        onOpenAgent={(task) => {
          close()
          onOpenAgent(task)
        }}
        onStop={(row) => setConfirm({ ids: [row.id], subject: row.command })}
        onOpenOutput={sessionId ? setDetail : undefined}
        launching={launching}
        onOpenMember={
          onOpenMember
            ? (team, member) => {
                close()
                onOpenMember(team, member)
              }
            : undefined
        }
      />
      {/* Nested sheets are placed in an absolutely positioned zero-size container: they must hang under this sheet to stack on top, without taking a gap slot. */}
      <View pointerEvents="box-none" style={{ position: 'absolute', width: 0, height: 0 }}>
        <ConfirmSheet
          visible={!!confirm}
          title={
            confirm?.all ? `Stop all ${confirm.ids.length} running activities?` : 'Stop this background activity?'
          }
          subject={confirm?.subject}
          detail="Modified files are kept; unfinished output may be incomplete."
          confirmTitle="Confirm stop"
          destructive
          onConfirm={stop}
          onClose={() => setConfirm(null)}
        />
        {sessionId ? (
          <TaskOutputSheet
            task={detail}
            client={client}
            sessionId={sessionId}
            onClose={() => setDetail(null)}
          />
        ) : null}
      </View>
    </DetentSheet>
  )
}

/* ───────────── Content ───────────── */

function Content({
  activity,
  onOpenAgent,
  onStop,
  onOpenOutput,
  launching,
  onOpenMember,
}: {
  activity: SessionActivity
  onOpenAgent(task: BackgroundTask): void
  onStop(row: CommandRow): void
  onOpenOutput?(task: BackgroundTask): void
  launching?: number
  onOpenMember?(team: TeamModel, member: TeamRow): void
}) {
  const now = useNow(activity.runningCount > 0)
  const summaries = sectionSummaries(activity)
  const hasTasks = activity.tasks.length > 0
  const team = activity.team
  // Half height cannot fit everything: when there are tasks or a team, subagents collapse by default.
  const [open, setOpen] = useState<Partial<Record<Group, boolean>>>({})
  const isOpen = (group: Group) =>
    open[group] ?? (group === 'subagents' ? !(hasTasks || team || launching) : true)
  const toggle = (group: Group) => setOpen((value) => ({ ...value, [group]: !isOpen(group) }))
  const children: React.ReactNode[] = []
  const stickyHeaderIndices: number[] = []
  const section = (group: Group, label: string, summary: string, body: React.ReactNode) => {
    stickyHeaderIndices.push(children.length)
    children.push(
      <GroupHeader
        key={`${group}:header`}
        label={label}
        summary={summary}
        open={isOpen(group)}
        onPress={() => toggle(group)}
      />
    )
    if (isOpen(group)) children.push(<View key={`${group}:body`}>{body}</View>)
  }
  if (hasTasks)
    section(
      'tasks',
      'Tasks',
      summaries.tasks,
      <>
        <ProgressBar done={activity.progress.done} total={activity.progress.total} />
        <TaskCard tasks={activity.tasks} />
      </>
    )
  // With a team all tasks are under members, and the team takes the tasks' place on top.
  if (team || launching)
    section(
      'team',
      'Team',
      team ? summaries.team : 'Starting',
      <>
        {team?.progress.total ? <ProgressBar done={team.progress.done} total={team.progress.total} /> : null}
        <View style={{ gap: 8 }}>
          {team?.members.map((member) => (
            <MemberCard
              key={member.id}
              row={member}
              onOpen={!member.lead && onOpenMember ? () => onOpenMember(team, member) : undefined}
            />
          ))}
          {team?.unassigned.length ? <UnassignedCard tasks={team.unassigned} /> : null}
          {/* The lead creates the team before submitting the plan: while starting the team may only have the lead, and placeholder rows follow existing members. */}
          {launching ? <LaunchingCard count={launching} /> : null}
        </View>
      </>
    )
  if (activity.subagents.length)
    section(
      'subagents',
      'Subagent',
      summaries.subagents,
      <View style={{ gap: 8 }}>
        {activity.subagents.map((row) => (
          <SubagentCard key={row.id} row={row} now={now} onPress={() => onOpenAgent(row.task)} />
        ))}
      </View>
    )
  if (activity.commands.length)
    section(
      'commands',
      'Background commands',
      summaries.commands,
      <CommandCard
        rows={activity.commands}
        now={now}
        onStop={onStop}
        onOpen={onOpenOutput ? (row) => onOpenOutput(row.task) : undefined}
      />
    )
  const empty = children.length === 0
  return (
    <>
      <InlineError text={activity.stopError || (activity.loading ? '' : activity.error)} />
      {empty ? (
        <EmptyState
          icon="list-checks"
          title={activity.loading ? 'Loading…' : 'No tasks or background activity'}
          detail={activity.loading ? undefined : 'Task lists, subagents, teams and background commands show up here once they start.'}
        />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          stickyHeaderIndices={stickyHeaderIndices}
          showsVerticalScrollIndicator
          contentContainerStyle={{ paddingBottom: 34 }}
        >
          {children}
        </ScrollView>
      )}
    </>
  )
}

function GroupHeader({
  label,
  summary,
  open,
  onPress,
}: {
  label: string
  summary: string
  open: boolean
  onPress(): void
}) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${summary}`}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={{
        height: 40,
        paddingHorizontal: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.sheet,
      }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.ink2 }}>{label}</Text>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.ink3 }}>
        {summary}
      </Text>
      <View style={{ marginLeft: 'auto' }}>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.ink3} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const colors = useColors()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: 4, borderRadius: 2, backgroundColor: colors.fill, overflow: 'hidden', marginHorizontal: 4, marginBottom: 8 }}
    >
      <View
        style={{
          height: 4,
          borderRadius: 2,
          backgroundColor: colors.ok,
          width: `${total ? Math.round((done / total) * 100) : 0}%`,
        }}
      />
    </View>
  )
}

const card = (colors: ReturnType<typeof useColors>) => ({
  backgroundColor: colors.card,
  borderRadius: 16,
  boxShadow: `0 0 0 1px ${colors.hair}`,
})

/* ───────────── Tasks ───────────── */

function TaskCard({ tasks }: { tasks: PlanTask[] }) {
  const colors = useColors()
  return (
    <View style={[card(colors), { paddingVertical: 4 }]}>
      {tasks.map((task, index) => (
        <View key={task.id}>
          {index > 0 && tasks[index - 1].state !== 'active' && task.state !== 'active' ? (
            <View style={{ height: 1, marginLeft: 44, backgroundColor: colors.hair }} />
          ) : null}
          <TaskLine task={task} />
        </View>
      ))}
    </View>
  )
}

function TaskLine({ task }: { task: PlanTask }) {
  const colors = useColors()
  const active = task.state === 'active'
  const done = task.state === 'done'
  const status = done ? 'Done' : active ? 'In progress' : task.state === 'waiting' ? 'Waiting on dependencies' : 'Not started'
  return (
    <View
      accessible
      accessibilityLabel={[task.title, status, active ? task.detail : '', task.owner].filter(Boolean).join(', ')}
      style={{
        minHeight: active ? 56 : 40,
        borderRadius: active ? 12 : 0,
        paddingHorizontal: 12,
        paddingVertical: active ? 8 : 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: active ? colors.runTint : undefined,
      }}
    >
      <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
        {done ? (
          <View
            style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.ok, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="check" size={13} color={colors.card} strokeWidth={3} />
          </View>
        ) : active ? (
          <Spinner size={20} thickness={2.2} />
        ) : (
          <View style={{ width: 20, height: 20, borderRadius: 10, boxShadow: `inset 0 0 0 1.75px ${colors.faint}` }} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 15,
            lineHeight: 20,
            fontWeight: active ? '600' : '400',
            color: done ? colors.ink3 : colors.ink,
            textDecorationLine: done ? 'line-through' : 'none',
          }}
        >
          {task.title}
        </Text>
        {active && task.detail ? (
          <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: colors.run }}>
            {task.detail}
          </Text>
        ) : null}
      </View>
      {task.state === 'waiting' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <Icon name="clock" size={13} color={colors.ink3} />
          <Text style={{ fontSize: 12, color: colors.ink3 }}>
            {['Waiting on dependencies', task.owner].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : task.owner && !done ? (
        <Text numberOfLines={1} style={{ maxWidth: 110, flexShrink: 0, fontSize: 12, color: colors.ink3 }}>
          {task.owner}
        </Text>
      ) : null}
    </View>
  )
}

/* ───────────── Subagents ───────────── */

const stepIcon = (verb: string): IconName =>
  verb === 'Run' ? 'terminal' : verb === 'Search' || verb === 'Find' || verb === 'Web search' ? 'search' : 'file'

function SubagentCard({ row, now, onPress }: { row: SubagentRow; now: number; onPress(): void }) {
  const colors = useColors()
  const running = row.status === 'running'
  const tone =
    row.status === 'running'
      ? colors.run
      : row.status === 'completed'
        ? colors.ok
        : row.status === 'failed'
          ? colors.err
          : colors.ink3
  const time = running ? clock(row.startedAt, now) : ''
  const status = row.stopping && running ? 'Stopping' : agentStatusText(row.status)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${status}${time ? `, running for ${time}` : ''}${row.stats ? `, ${row.stats}` : ''}, open conversation`}
      onPress={onPress}
      style={({ pressed }) => [card(colors), { paddingHorizontal: 14, paddingVertical: 12, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={{ height: 24, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {running ? (
          <Spinner size={15} thickness={2.4} />
        ) : (
          <Icon
            name={row.status === 'completed' ? 'circle-check' : row.status === 'failed' ? 'circle-alert' : 'x'}
            size={16}
            color={tone}
            strokeWidth={2.2}
          />
        )}
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.ink }}>
          {row.title}
        </Text>
        <Text style={{ flexShrink: 0, fontSize: 13, color: tone }}>{status}</Text>
        <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {time ? <Mono style={{ fontSize: 13, color: colors.ink3 }}>{time}</Mono> : null}
          <Icon name="chevron-right" size={15} color={colors.ink3} strokeWidth={2.2} />
        </View>
      </View>
      {row.stats ? (
        <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3, paddingLeft: 23, paddingTop: 1 }}>
          {row.stats}
        </Text>
      ) : null}
      {row.steps.length ? (
        <View
          style={{
            marginLeft: 23,
            marginTop: 8,
            paddingTop: 8,
            gap: 6,
            borderTopWidth: 1,
            borderTopColor: colors.hair,
          }}
        >
          {row.steps.map((step, index) => (
            <StepRow key={`${index}:${step.verb}:${step.object ?? ''}`} step={step} current={index === row.steps.length - 1 && !step.done} />
          ))}
        </View>
      ) : null}
    </Pressable>
  )
}

function StepRow({ step, current }: { step: StepLine; current: boolean }) {
  const colors = useColors()
  const text = [step.verb, step.object].filter(Boolean).join(' ')
  const style = { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 16, color: current ? colors.ink : colors.ink3 }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      {current ? (
        <Spinner size={13} thickness={2.4} />
      ) : (
        <Icon name={step.error ? 'circle-alert' : stepIcon(step.verb)} size={13} color={step.error ? colors.err : colors.ink3} strokeWidth={1.9} />
      )}
      {step.mono ? (
        <Mono numberOfLines={1} style={style}>
          {text}
        </Mono>
      ) : (
        <Text numberOfLines={1} style={style}>
          {text}
        </Text>
      )}
    </View>
  )
}

/* ───────────── Team ───────────── */

/** Placeholder after plan approval and before members appear in the team. */
function LaunchingCard({ count }: { count: number }) {
  const colors = useColors()
  return (
    <View
      accessible
      accessibilityLabel={`${count} members getting in place`}
      style={[card(colors), { minHeight: 52, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }]}
    >
      <Spinner size={18} thickness={2.4} />
      <Text style={{ fontSize: 15, color: colors.ink }}>{`${count} members getting in place`}</Text>
    </View>
  )
}

/* ───────────── Background commands ───────────── */

function CommandCard({
  rows,
  now,
  onStop,
  onOpen,
}: {
  rows: CommandRow[]
  now: number
  onStop(row: CommandRow): void
  onOpen?(row: CommandRow): void
}) {
  const colors = useColors()
  return (
    <View style={[card(colors), { paddingHorizontal: 14, paddingVertical: 12, gap: 10 }]}>
      {rows.map((row, index) => (
        <View key={row.id}>
          {index > 0 ? <View style={{ height: 1, backgroundColor: colors.hair, marginBottom: 10 }} /> : null}
          <CommandLine row={row} now={now} onStop={() => onStop(row)} onOpen={onOpen ? () => onOpen(row) : undefined} />
        </View>
      ))}
    </View>
  )
}

function CommandLine({
  row,
  now,
  onStop,
  onOpen,
}: {
  row: CommandRow
  now: number
  onStop(): void
  onOpen?(): void
}) {
  const colors = useColors()
  const running = row.status === 'running'
  const time = running ? clock(row.startedAt, now) : ''
  const finishedTone =
    row.status === 'completed' ? colors.ok : row.status === 'failed' ? colors.err : colors.ink3
  const body = (
    <View style={{ gap: 4 }}>
      <View style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {running ? (
          <Spinner size={15} thickness={2.4} />
        ) : (
          <Icon
            name={row.status === 'completed' ? 'circle-check' : row.status === 'failed' ? 'circle-alert' : 'x'}
            size={16}
            color={finishedTone}
            strokeWidth={2.2}
          />
        )}
        <Mono numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: '500', color: colors.ink }}>
          {row.command}
        </Mono>
        {running ? (
          time ? <Mono style={{ fontSize: 13, color: colors.ink3 }}>{time}</Mono> : null
        ) : (
          <Text style={{ fontSize: 13, color: finishedTone }}>{agentStatusText(row.status)}</Text>
        )}
        {running ? <View style={{ width: row.stopping ? 82 : 66 }} /> : null}
      </View>
      {row.lastLine ? (
        <Mono numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3, paddingLeft: 25 }}>
          {row.lastLine}
        </Mono>
      ) : null}
    </View>
  )
  return (
    <View>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View output of ${row.command}`}
          onPress={onOpen}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {running ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop ${row.command}`}
          accessibilityState={{ disabled: row.stopping, busy: row.stopping }}
          disabled={row.stopping}
          onPress={onStop}
          style={({ pressed }) => ({
            position: 'absolute',
            right: -6,
            top: -6,
            height: 44,
            justifyContent: 'center',
            opacity: row.stopping ? 0.5 : pressed ? 0.6 : 1,
          })}
        >
          <View
            style={{
              height: 30,
              paddingHorizontal: 12,
              borderRadius: 15,
              backgroundColor: colors.errSoft,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors.err }} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.err }}>
              {row.stopping ? 'Stopping' : 'Stop'}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}
