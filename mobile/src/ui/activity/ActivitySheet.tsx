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
  type TeamRow,
} from '../../core/sessionActivityModel'
import type { BackgroundTask } from '../../core/operations'
import type { Host } from '../../core/types'
import { DetentSheet } from '../DetentSheet'
import { EmptyState, Icon, InlineError, Mono, Spinner, useColors, type IconName } from '../kit'
import { Text } from '../Text'
import { ConfirmSheet } from './ConfirmSheet'
import { TaskOutputSheet } from './TaskOutputSheet'
import { agentStatusText, clock } from './activityView'
import { useNow } from './useNow'

type Group = 'tasks' | 'subagents' | 'team' | 'commands'
type Confirm = { ids: string[]; all?: boolean; subject?: string }

/**
 * 运行中底单：标题行「运行中 · 32:35」+ 右上「全部停止」，下面按 任务 → 子 Agent →
 * 团队 → 后台命令分组，组标题粘顶、可折叠。半高放不下，所以有任务时默认只展开
 * 任务和后台命令，子 Agent 和团队点开再看。
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
}: {
  visible: boolean
  onClose(): void
  activity: SessionActivity
  /** 本轮已运行时长（如 32:35）；没有就不显示。 */
  elapsed?: string
  /** 点子 Agent 卡：底单先关闭，再把任务交给整合者去开全屏页。 */
  onOpenAgent(task: BackgroundTask): void
  host: Pick<Host, 'id'>
  /** 传入后，点后台命令行可以看它的完整输出。 */
  sessionId?: string
  /** 「全部停止」确认后额外调用，用来同时停掉主 Agent 这一轮。 */
  onStopTurn?(): void
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
          {activity.active ? <Spinner size={15} thickness={2.4} /> : null}
          <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.ink }}>
            {activity.active ? '运行中' : '任务'}
          </Text>
          {activity.active && elapsed ? (
            <Mono style={{ fontSize: 15, color: colors.ink2 }}>{elapsed}</Mono>
          ) : null}
        </View>
      }
      right={
        running.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="全部停止"
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
              {allStopping ? '停止中' : '全部停止'}
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
      />
      {/* 嵌套的弹层放在绝对定位的零尺寸容器里：它们要挂在这张底单下面才能叠出来，又不能占一格 gap。 */}
      <View pointerEvents="box-none" style={{ position: 'absolute', width: 0, height: 0 }}>
        <ConfirmSheet
          visible={!!confirm}
          title={
            confirm?.all ? `停止全部 ${confirm.ids.length} 项运行中的活动？` : '停止这项后台活动？'
          }
          subject={confirm?.subject}
          detail="已修改的文件会保留，尚未完成的输出可能不完整。"
          confirmTitle="确认停止"
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

/* ───────────── 内容 ───────────── */

function Content({
  activity,
  onOpenAgent,
  onStop,
  onOpenOutput,
}: {
  activity: SessionActivity
  onOpenAgent(task: BackgroundTask): void
  onStop(row: CommandRow): void
  onOpenOutput?(task: BackgroundTask): void
}) {
  const now = useNow(activity.runningCount > 0)
  const summaries = sectionSummaries(activity)
  const hasTasks = activity.tasks.length > 0
  // 半高放不下全部：有任务时子 Agent 和团队默认折起来。
  const [open, setOpen] = useState<Partial<Record<Group, boolean>>>({})
  const isOpen = (group: Group) =>
    open[group] ?? (group === 'subagents' || group === 'team' ? !hasTasks : true)
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
      '任务',
      summaries.tasks,
      <>
        <ProgressBar done={activity.progress.done} total={activity.progress.total} />
        <TaskCard tasks={activity.tasks} />
      </>
    )
  if (activity.subagents.length)
    section(
      'subagents',
      '子 Agent',
      summaries.subagents,
      <View style={{ gap: 8 }}>
        {activity.subagents.map((row) => (
          <SubagentCard key={row.id} row={row} now={now} onPress={() => onOpenAgent(row.task)} />
        ))}
      </View>
    )
  if (activity.team)
    section('team', `团队`, summaries.team, <TeamCard members={activity.team.members} />)
  if (activity.commands.length)
    section(
      'commands',
      '后台命令',
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
          title={activity.loading ? '正在读取…' : '没有任务或后台活动'}
          detail={activity.loading ? undefined : '任务清单、子 Agent、团队和后台命令开始后会显示在这里。'}
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
      accessibilityLabel={`${label}，${summary}`}
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

/* ───────────── 任务 ───────────── */

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
  const status = done ? '已完成' : active ? '进行中' : task.state === 'waiting' ? '等待依赖' : '待开始'
  return (
    <View
      accessible
      accessibilityLabel={[task.title, status, active ? task.detail : '', task.owner].filter(Boolean).join('，')}
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
            {['等待依赖', task.owner].filter(Boolean).join(' · ')}
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

/* ───────────── 子 Agent ───────────── */

const stepIcon = (verb: string): IconName =>
  verb === '运行' ? 'terminal' : verb === '搜索' || verb === '查找' || verb === '搜网页' ? 'search' : 'file'

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
  const status = row.stopping && running ? '停止中' : agentStatusText(row.status)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.title}，${status}${time ? `，已运行 ${time}` : ''}${row.stats ? `，${row.stats}` : ''}，打开对话`}
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

/* ───────────── 团队 ───────────── */

function TeamCard({ members }: { members: TeamRow[] }) {
  const colors = useColors()
  return (
    <View style={[card(colors), { paddingVertical: 2 }]}>
      {members.map((member, index) => {
        const tint = member.tone === 'run' ? colors.runTint : colors.fill
        const ink = member.tone === 'run' ? colors.run : member.tone === 'err' ? colors.err : colors.ink3
        const icon: IconName = member.lead ? 'users' : member.tone === 'wait' ? 'clock' : 'cpu'
        return (
          <View key={member.id}>
            {index > 0 ? <View style={{ height: 1, marginLeft: 44, backgroundColor: colors.hair }} /> : null}
            <View
              accessible
              accessibilityLabel={[member.name, member.state, member.detail].filter(Boolean).join('，')}
              style={{ minHeight: 52, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
              <View
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: tint, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name={icon} size={15} color={member.tone === 'run' ? colors.run : colors.ink2} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color: colors.ink }}>
                  {member.name}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: ink }}>
                  {[member.state, member.detail].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </View>
          </View>
        )
      })}
    </View>
  )
}

/* ───────────── 后台命令 ───────────── */

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
          accessibilityLabel={`查看 ${row.command} 的输出`}
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
          accessibilityLabel={`停止 ${row.command}`}
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
              {row.stopping ? '停止中' : '停止'}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  )
}
