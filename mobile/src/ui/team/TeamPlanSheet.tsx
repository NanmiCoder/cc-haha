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

/** The source name is display only; falls back to the id when unavailable, without affecting approval. */
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

/** A settings row in the card: name on the left, current value (optionally with a small line) and chevron on the right. */
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
      accessibilityLabel={`${label}: ${[value, detail].filter(Boolean).join(', ')}`}
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
          label="Model"
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
            <SettingRow label="Thinking effort" value={label} disabled={disabled} onPress={open} />
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
          accessibilityLabel={`Responsibilities, ${briefOpen ? 'Collapse' : 'Expand'}`}
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
          <Text style={{ flex: 1, fontSize: 14, color: colors.ink3 }}>Responsibilities</Text>
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
            Suggested: {teamRuntimeLabel(member.suggestedRuntime!, providers)}
          </Text>
          <TextButton title="Restore" disabled={locked} onPress={() => onRuntime(member.suggestedRuntime!)} />
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
    return <Text style={{ paddingHorizontal: 4, fontSize: 14, color: colors.ink3 }}>No tasks assigned yet</Text>
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
      {tasks.map((task, index) => {
        const owner = members.find((member) => member.id === task.ownerId)
        const dependencies = task.dependencies
          .map((id) => tasks.find((row) => row.id === id)?.subject ?? id)
          .join(', ')
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
                  Prerequisites: {dependencies}
                </Text>
              ) : null}
            </View>
            <SettingRow
              label="Owner"
              value={owner?.name ?? 'Unassigned'}
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
 * Team plan submitted by the lead, popped up from the bottom to confirm item by item. Each change saves directly to the computer (like desktop only
 * model, agent preset and task owner can be changed; member names are written in other members' briefs, and renaming would make them unable to find each other, 
 * so they are not changed here). The page owns the toggle, so remounting the entry card neither closes it nor pops it twice.
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
  /** The lead's current model (in use by the session); falls back to the one recorded in the plan. */
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
  // Adding members to a running team: members already running are unaffected by this approval or cancellation.
  const addition = !!plan.parentPlanId
  const agents = Object.entries(plan.agentCatalog ?? {})

  const setRuntime = (member: TeamPlanMember, runtime: TeamPlanRuntime) =>
    void team.edit({ members: [{ id: member.id, runtime }] })
  const cancel = () =>
    Alert.alert(
      addition ? 'Not add these members?' : 'Cancel this team?',
      addition
        ? 'Members already running are unaffected; the lead will be notified.'
        : 'Members have not started yet; after canceling the lead is notified and can replan.',
      [
        { text: 'Think again', style: 'cancel' },
        { text: addition ? 'Do not add' : 'Cancel team', style: 'destructive', onPress: () => void team.act('cancel') },
      ]
    )

  const footer = (
    <View style={{ gap: 10 }}>
      {feedbackOpen ? (
        <NoteInput
          accessibilityLabel="Feedback"
          placeholder="Tell the lead how to adjust the division of work"
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
          title={feedbackOpen ? 'Send back to the lead' : 'Send back for changes'}
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
          title="Approve and launch"
          size="lg"
          style={{ flex: 1.4 }}
          disabled={locked || !!review.blocker}
          busy={team.pending === 'approve'}
          onPress={() => void team.act('approve')}
        />
      </View>
      <QuietButton title={addition ? 'Do not add these members' : 'Cancel team'} disabled={locked} onPress={cancel} />
    </View>
  )

  return (
    <DetentSheet
      visible={visible}
      onClose={onClose}
      title={addition ? 'Add members' : 'Agent Team'}
      left={<TextButton title="Later" onPress={onClose} />}
      initialDetent="full"
      footer={footer}
    >
      <View style={{ gap: 4, paddingHorizontal: 4 }}>
        <Mono numberOfLines={1} style={{ fontSize: 13, color: colors.ink3 }}>{plan.teamName}</Mono>
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>
          {addition
            ? 'The team is already running; these members join only after approval. Changes apply only this time, and each member is billed separately.'
            : 'Confirm each member’s model and role before launching. Changes apply only to this team, and each member is billed separately.'}
        </Text>
      </View>
      {review.blocker ? <Callout>{review.blocker}</Callout> : null}

      <SectionTitle
        title="Members"
        count={plan.members.length}
        right={
          plan.members.length > 1 ? (
            <TextButton title="Same model for all" disabled={locked || !client} onPress={() => setPicker({ kind: 'all' })} />
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
        Lead: {teamRuntimeLabel(leader, providers)}
      </Text>

      <SectionTitle title="Task assignment" count={plan.tasks.length} />
      <TaskList
        tasks={plan.tasks}
        members={plan.members}
        locked={locked}
        onOwner={(task) => setPicker({ kind: 'owner', task })}
      />

      <RuntimeSheet
        visible={picker?.kind === 'model' || picker?.kind === 'all'}
        onClose={() => setPicker(null)}
        title={picker?.kind === 'model' ? `${picker.member.name} ’s model` : 'Model for all members'}
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
        title="Agent Preset"
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
          After changing the preset, members whose model was not changed manually switch to the model suggested by the preset.
        </Text>
      </Sheet>
      <Sheet visible={picker?.kind === 'owner'} onClose={() => setPicker(null)} title="Owner">
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
