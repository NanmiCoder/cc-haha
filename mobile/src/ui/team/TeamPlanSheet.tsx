import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Pressable, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import {
  difficultyLabel,
  suggestionDiffers,
  teamPlanReview,
  teamRuntime,
  teamRuntimeConfig,
  teamRuntimeLabel,
  teamRuntimeSource,
  type TeamPlanMember,
  type TeamPlanRecord,
  type TeamPlanRuntime,
  type TeamPlanTask,
} from '../../core/teamPlan'
import { DetentSheet } from '../DetentSheet'
import { EffortControl } from '../EffortControl'
import { Button, Callout, Icon, InlineError, Mono, Sheet, TextButton, useColors } from '../kit'
import { ChoiceRow } from '../newtask/ChoiceRow'
import { RuntimeSheet } from '../RuntimePicker'
import { Text } from '../Text'
import { NoteInput, QuietButton } from '../decision/parts'
import type { TeamPlanController } from './useTeamPlan'

type Provider = { id: string; name: string }

/** 来源名只用于显示；读不到时退回 id，不影响审批。 */
function useProviderNames(client: ApiClient | null) {
  const [providers, setProviders] = useState<Provider[]>([])
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client
      .get<{ providers: Provider[] }>('/api/providers', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setProviders(value.providers ?? [])
      })
      .catch(() => {})
    return () => controller.abort()
  }, [client])
  return providers
}

function SectionTitle({ title, count, right }: { title: string; count?: number; right?: ReactNode }) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 10, paddingHorizontal: 4, minHeight: 36 }}>
      <Text accessibilityRole="header" style={{ flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.ink2 }}>
        {title}
        {count !== undefined ? <Text style={{ color: colors.ink3, fontWeight: '400' }}>{`  ${count}`}</Text> : null}
      </Text>
      {right}
    </View>
  )
}

/** 卡片里的一行设置：左边名称，右边当前值（可带一行小字）和箭头。 */
function SettingRow({
  label,
  value,
  detail,
  onPress,
  disabled,
  danger,
}: {
  label: string
  value: string
  detail?: string
  onPress?(): void
  disabled?: boolean
  danger?: boolean
}) {
  const colors = useColors()
  const inactive = disabled || !onPress
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}：${[value, detail].filter(Boolean).join('，')}`}
      accessibilityState={{ disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 46,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: detail ? 7 : 0,
        backgroundColor: pressed ? colors.fill : 'transparent',
      })}
    >
      <Text style={{ width: 64, fontSize: 14, color: colors.ink3 }}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'flex-end', gap: 1 }}>
        <Text
          numberOfLines={1}
          ellipsizeMode="middle"
          style={{ fontSize: 15, lineHeight: 20, color: danger ? colors.err : inactive ? colors.ink3 : colors.ink }}
        >
          {value}
        </Text>
        {detail ? (
          <Text numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      {inactive ? null : <Icon name="chevron-right" size={15} color={colors.chevron} strokeWidth={2.2} />}
    </Pressable>
  )
}

const Hair = ({ inset = 14 }: { inset?: number }) => {
  const colors = useColors()
  return <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: inset }} />
}

function Tag({ text }: { text: string }) {
  const colors = useColors()
  return (
    <View style={{ borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: colors.fill }}>
      <Text style={{ fontSize: 12, lineHeight: 16, color: colors.ink2 }}>{text}</Text>
    </View>
  )
}

function MemberCard({
  member,
  index,
  plan,
  providers,
  client,
  locked,
  onModel,
  onAgent,
  onRuntime,
}: {
  member: TeamPlanMember
  index: number
  plan: TeamPlanRecord
  providers: Provider[]
  client: ApiClient | null
  locked: boolean
  onModel(): void
  onAgent(): void
  onRuntime(runtime: TeamPlanRuntime): void
}) {
  const colors = useColors()
  const [briefOpen, setBriefOpen] = useState(false)
  const difficulty = difficultyLabel(member)
  const agents = Object.keys(plan.agentCatalog ?? {})
  const runtime = teamRuntimeConfig(member.runtime)
  return (
    <View style={{ gap: 6 }}>
      <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: member.reason ? 10 : 8, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Mono style={{ fontSize: 12, color: colors.ink3 }}>{String(index + 1).padStart(2, '0')}</Mono>
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }}>
              {member.name}
            </Text>
            {difficulty ? <Tag text={difficulty} /> : null}
          </View>
          {member.reason ? (
            <Text numberOfLines={3} style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
              {member.reason}
            </Text>
          ) : null}
        </View>
        <Hair />
        <SettingRow
          label="模型"
          value={member.runtime.modelId}
          detail={teamRuntimeSource(member.runtime, providers)}
          disabled={locked || !client}
          onPress={onModel}
        />
        <Hair />
        <EffortControl
          client={client}
          runtime={runtime}
          disabled={locked}
          onApply={(value) => onRuntime(teamRuntime(value))}
          trigger={({ open, disabled, label }) => (
            <SettingRow label="思考强度" value={label} disabled={disabled} onPress={open} />
          )}
        />
        <Hair />
        <SettingRow
          label="Agent"
          value={member.agentType}
          disabled={locked || agents.length < 2}
          onPress={onAgent}
        />
        <Hair />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`职责说明，${briefOpen ? '收起' : '展开'}`}
          accessibilityState={{ expanded: briefOpen }}
          onPress={() => setBriefOpen((value) => !value)}
          style={({ pressed }) => ({
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 14,
            backgroundColor: pressed ? colors.fill : 'transparent',
          })}
        >
          <Text style={{ flex: 1, fontSize: 14, color: colors.ink3 }}>职责说明</Text>
          <Icon name={briefOpen ? 'chevron-up' : 'chevron-down'} size={15} color={colors.chevron} strokeWidth={2.2} />
        </Pressable>
        {briefOpen ? (
          <Text selectable style={{ paddingHorizontal: 14, paddingBottom: 14, fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
            {member.prompt}
          </Text>
        ) : null}
      </View>
      {suggestionDiffers(member) ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: colors.ink3 }}>
            建议：{teamRuntimeLabel(member.suggestedRuntime!, providers)}
          </Text>
          <TextButton title="恢复" disabled={locked} onPress={() => onRuntime(member.suggestedRuntime!)} />
        </View>
      ) : null}
    </View>
  )
}

function TaskList({
  tasks,
  members,
  locked,
  onOwner,
}: {
  tasks: TeamPlanTask[]
  members: TeamPlanMember[]
  locked: boolean
  onOwner(task: TeamPlanTask): void
}) {
  const colors = useColors()
  if (!tasks.length)
    return <Text style={{ paddingHorizontal: 4, fontSize: 14, color: colors.ink3 }}>尚未分配任务</Text>
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
      {tasks.map((task, index) => {
        const owner = members.find((member) => member.id === task.ownerId)
        const dependencies = task.dependencies
          .map((id) => tasks.find((row) => row.id === id)?.subject ?? id)
          .join('、')
        return (
          <View key={task.id}>
            {index > 0 ? <Hair inset={0} /> : null}
            <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, gap: 4 }}>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Mono style={{ fontSize: 12, lineHeight: 21, color: colors.ink3 }}>{String(index + 1).padStart(2, '0')}</Mono>
                <Text style={{ flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '500', color: colors.ink }}>{task.subject}</Text>
              </View>
              {task.description ? (
                <Text numberOfLines={3} style={{ marginLeft: 28, fontSize: 13, lineHeight: 19, color: colors.ink2 }}>
                  {task.description}
                </Text>
              ) : null}
              {dependencies ? (
                <Text numberOfLines={2} style={{ marginLeft: 28, fontSize: 12.5, lineHeight: 18, color: colors.ink3 }}>
                  前置任务：{dependencies}
                </Text>
              ) : null}
            </View>
            <SettingRow
              label="负责人"
              value={owner?.name ?? '未分配'}
              danger={!owner}
              disabled={locked}
              onPress={() => onOwner(task)}
            />
          </View>
        )
      })}
    </View>
  )
}

/**
 * 队长提交的团队方案，从底部弹出逐个确认。每项改动直接保存到电脑（和桌面端一样只能改
 * 模型、Agent 预设和任务负责人；成员名写在其他成员的任务书里，改名会让它们找不到彼此，
 * 所以不在这里改）。由页面持有开关，入口卡片重挂载不会把它关掉或重复弹出。
 */
export function TeamPlanSheet({
  visible,
  onClose,
  plan,
  team,
  client,
  ready,
  leaderRuntime,
}: {
  visible: boolean
  onClose(): void
  plan: TeamPlanRecord
  team: TeamPlanController
  client: ApiClient | null
  ready: boolean
  /** 队长当前的模型（会话正在用的）；拿不到时用方案里记录的。 */
  leaderRuntime?: TeamPlanRuntime
}) {
  const colors = useColors()
  const providers = useProviderNames(client)
  const [picker, setPicker] = useState<
    | { kind: 'model'; member: TeamPlanMember }
    | { kind: 'all' }
    | { kind: 'agent'; member: TeamPlanMember }
    | { kind: 'owner'; task: TeamPlanTask }
    | null
  >(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const review = teamPlanReview(plan)
  const locked = !ready || team.pending !== null
  const leader = leaderRuntime ?? plan.leaderRuntime
  // 给运行中的团队追加成员：已经在跑的成员不受这次确认或取消的影响。
  const addition = !!plan.parentPlanId
  const agents = Object.entries(plan.agentCatalog ?? {})

  const setRuntime = (member: TeamPlanMember, runtime: TeamPlanRuntime) =>
    void team.edit({ members: [{ id: member.id, runtime }] })
  const cancel = () =>
    Alert.alert(
      addition ? '不追加这些成员？' : '取消这个团队？',
      addition
        ? '已经在跑的成员不受影响，队长会收到通知。'
        : '成员还没有启动，取消后队长会收到通知，可以重新规划。',
      [
        { text: '再想想', style: 'cancel' },
        { text: addition ? '不追加' : '取消团队', style: 'destructive', onPress: () => void team.act('cancel') },
      ]
    )

  const footer = (
    <View style={{ gap: 10 }}>
      {feedbackOpen ? (
        <NoteInput
          accessibilityLabel="调整意见"
          placeholder="告诉队长要怎么调整分工"
          autoFocus
          minHeight={72}
          value={feedback}
          onChangeText={setFeedback}
          editable={!locked}
        />
      ) : null}
      <InlineError text={team.error} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          title={feedbackOpen ? '退回给队长' : '退回调整'}
          variant="secondary"
          size="lg"
          style={{ flex: 1 }}
          disabled={locked || (feedbackOpen && !feedback.trim())}
          busy={team.pending === 'return'}
          onPress={() => {
            if (!feedbackOpen) setFeedbackOpen(true)
            else void team.act('return', feedback.trim())
          }}
        />
        <Button
          title="确认并启动"
          size="lg"
          style={{ flex: 1.4 }}
          disabled={locked || !!review.blocker}
          busy={team.pending === 'approve'}
          onPress={() => void team.act('approve')}
        />
      </View>
      <QuietButton title={addition ? '不追加这些成员' : '取消团队'} disabled={locked} onPress={cancel} />
    </View>
  )

  return (
    <DetentSheet
      visible={visible}
      onClose={onClose}
      title={addition ? '追加成员' : 'Agent 团队'}
      left={<TextButton title="稍后" onPress={onClose} />}
      initialDetent="full"
      footer={footer}
    >
      <View style={{ gap: 4, paddingHorizontal: 4 }}>
        <Mono numberOfLines={1} style={{ fontSize: 13, color: colors.ink3 }}>{plan.teamName}</Mono>
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
          {addition
            ? '团队已经在跑，确认后这些成员才会加入。改动只对这次生效，每个成员单独计费。'
            : '确认每个成员的模型和分工后再启动。改动只对这次团队生效，每个成员单独计费。'}
        </Text>
      </View>
      {review.blocker ? <Callout>{review.blocker}</Callout> : null}

      <SectionTitle
        title="成员"
        count={plan.members.length}
        right={
          plan.members.length > 1 ? (
            <TextButton title="统一模型" disabled={locked || !client} onPress={() => setPicker({ kind: 'all' })} />
          ) : null
        }
      />
      {plan.members.map((member, index) => (
        <MemberCard
          key={member.id}
          member={member}
          index={index}
          plan={plan}
          providers={providers}
          client={client}
          locked={locked}
          onModel={() => setPicker({ kind: 'model', member })}
          onAgent={() => setPicker({ kind: 'agent', member })}
          onRuntime={(runtime) => setRuntime(member, runtime)}
        />
      ))}
      <Text style={{ paddingHorizontal: 4, fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
        队长：{teamRuntimeLabel(leader, providers)}
      </Text>

      <SectionTitle title="任务分配" count={plan.tasks.length} />
      <TaskList
        tasks={plan.tasks}
        members={plan.members}
        locked={locked}
        onOwner={(task) => setPicker({ kind: 'owner', task })}
      />

      <RuntimeSheet
        visible={picker?.kind === 'model' || picker?.kind === 'all'}
        onClose={() => setPicker(null)}
        title={picker?.kind === 'model' ? `${picker.member.name} 的模型` : '所有成员的模型'}
        client={client}
        initial={
          picker?.kind === 'model'
            ? teamRuntimeConfig(picker.member.runtime)
            : teamRuntimeConfig(plan.members[0]?.runtime ?? leader)
        }
        busy={locked}
        onApply={(value) => {
          const runtime = teamRuntime(value)
          const target = picker
          setPicker(null)
          if (target?.kind === 'model') setRuntime(target.member, runtime)
          else void team.edit({ members: plan.members.map((member) => ({ id: member.id, runtime })) })
        }}
      />
      <Sheet
        visible={picker?.kind === 'agent'}
        onClose={() => setPicker(null)}
        title="Agent 预设"
      >
        <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
          {agents.map(([agentType, snapshot], index) => (
            <View key={agentType}>
              {index > 0 ? <Hair /> : null}
              <ChoiceRow
                title={agentType}
                detail={snapshot.description?.trim() || undefined}
                selected={picker?.kind === 'agent' && picker.member.agentType === agentType}
                disabled={locked}
                onPress={() => {
                  const target = picker
                  setPicker(null)
                  if (target?.kind === 'agent' && target.member.agentType !== agentType)
                    void team.edit({ members: [{ id: target.member.id, agentType }] })
                }}
              />
            </View>
          ))}
        </View>
        <Text style={{ paddingHorizontal: 4, fontSize: 13, lineHeight: 19, color: colors.ink3 }}>
          换预设后，没手动改过模型的成员会改用该预设建议的模型。
        </Text>
      </Sheet>
      <Sheet visible={picker?.kind === 'owner'} onClose={() => setPicker(null)} title="负责人">
        {picker?.kind === 'owner' ? (
          <Text numberOfLines={2} style={{ paddingHorizontal: 4, fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
            {picker.task.subject}
          </Text>
        ) : null}
        <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
          {plan.members.map((member, index) => (
            <View key={member.id}>
              {index > 0 ? <Hair /> : null}
              <ChoiceRow
                title={member.name}
                detail={member.agentType}
                selected={picker?.kind === 'owner' && picker.task.ownerId === member.id}
                disabled={locked}
                onPress={() => {
                  const target = picker
                  setPicker(null)
                  if (target?.kind === 'owner' && target.task.ownerId !== member.id)
                    void team.edit({ tasks: [{ id: target.task.id, ownerId: member.id }] })
                }}
              />
            </View>
          ))}
        </View>
      </Sheet>
    </DetentSheet>
  )
}
