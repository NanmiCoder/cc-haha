import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import { useFocusedResource } from '../../core/useFocusedResource'
import { Button, Footnote, Group, InlineError, Loading, Mono, SectionHeader, Separator, Sheet, TextButton, useColors } from '../kit'
import { Text } from '../Text'
import { latestTeam, loadMemberTranscript, loadTaskList, loadTeam, memberState, memberTasks, taskProgress, taskState, teamMessageText, teamIdentity, teamMembers, type TaskInfo, type TeamMember, type TeamWorkbenchSnapshot, type TeamWorkbenchSessionTimeline } from './activityData'

export function WorkSections({ client, sessionId }: { client: ApiClient | null; sessionId: string }) {
  return <>
    <TaskSection key={`tasks:${client?.host.id}:${sessionId}`} client={client} sessionId={sessionId} />
    <TeamSection key={`team:${client?.host.id}:${sessionId}`} client={client} sessionId={sessionId} />
  </>
}
function TaskSection({ client, sessionId }: { client: ApiClient | null; sessionId: string }) {
  const resource = useFocusedResource(useCallback((signal: AbortSignal) => {
    if (!client) throw new Error('正在连接电脑')
    return loadTaskList(client, sessionId, signal)
  }, [client, sessionId]), 3000)
  const [selected, setSelected] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const tasks = resource.value ?? []
  const progress = taskProgress(tasks)
  const selectedTask = tasks.find((task) => task.id === selected)
  const rows = tasks.filter((task) => showCompleted || task.status !== 'completed')
  return <View>
    <SectionHeader title={`任务 · ${progress.completed}/${progress.total}`} />
    <InlineError text={resource.error} />
    {resource.error && <TextButton title="重试任务列表" onPress={() => void resource.refresh()} />}
    {resource.loading && !resource.value ? <Loading /> : tasks.length ? <>
      <Group>{rows.map((task, index) => <View key={task.id}>
        {index > 0 && <Separator />}
        <WorkRow title={task.subject} detail={[taskState(task, tasks), task.owner].filter(Boolean).join(' · ')} onPress={() => setSelected(task.id)} />
      </View>)}</Group>
      {progress.completed > 0 && <TextButton title={showCompleted ? '收起已完成任务' : `查看 ${progress.completed} 项已完成任务`} onPress={() => setShowCompleted((value) => !value)} />}
    </> : !resource.error && <Footnote>这个会话还没有任务清单。</Footnote>}
    <Sheet visible={!!selectedTask} title={selectedTask?.subject} onClose={() => setSelected(null)}>
      {selectedTask && <TaskDetails task={selectedTask} tasks={tasks} />}
    </Sheet>
  </View>
}
function TeamSection({ client, sessionId }: { client: ApiClient | null; sessionId: string }) {
  const resource = useFocusedResource(useCallback((signal: AbortSignal) => {
    if (!client) throw new Error('正在连接电脑')
    return loadTeam(client, sessionId, signal)
  }, [client, sessionId]), 4000)
  return <View>
    <InlineError text={resource.error ? `团队：${resource.error}` : ''} />
    {resource.error && <TextButton title="重试团队状态" onPress={() => void resource.refresh()} />}
    {resource.value && <TeamPanel key={latestTeam(resource.value) ? teamIdentity(latestTeam(resource.value)!) : 'empty'} client={client} timeline={resource.value} />}
  </View>
}
function TeamPanel({ client, timeline }: { client: ApiClient | null; timeline: TeamWorkbenchSessionTimeline }) {
  const colors = useColors()
  const snapshot = latestTeam(timeline)
  const [selected, setSelected] = useState<string | null>(null)
  if (!snapshot) return null
  const members = teamMembers(timeline)
  const member = members.find((entry) => entry.agentId === selected)
  const progress = taskProgress(snapshot.tasks)
  const active = members.filter((entry) => memberState(entry) === '工作中').length
  return <View>
    <SectionHeader title={`团队 · ${snapshot.team.name}`} />
    <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2, paddingBottom: 10 }}>
      {progress.completed}/{progress.total} 项任务完成 · {active} 人工作中{snapshot.deletedAt || timeline.source !== 'live' ? ' · 历史记录' : ''}
    </Text>
    <Group>{members.map((entry, index) => <View key={entry.agentId}>
      {index > 0 && <Separator />}
      <WorkRow title={entry.name || entry.agentId} detail={[memberState(entry), entry.agentType, memberTasks(entry, snapshot.tasks).find((task) => task.status === 'in_progress')?.subject].filter(Boolean).join(' · ')} onPress={() => setSelected(entry.agentId)} />
    </View>)}</Group>
    {snapshot.tasks.length > 0 && <View style={{ paddingTop: 10, gap: 6 }}>
      {snapshot.tasks.map((task) => <Text key={task.id} style={{ fontSize: 13, lineHeight: 19, color: colors.ink2 }}>
        {taskState(task, snapshot.tasks)} · {task.subject}{task.owner ? ` · ${task.owner}` : ''}
      </Text>)}
    </View>}
    <Sheet visible={!!member} title={member?.name || member?.agentId} onClose={() => setSelected(null)}>
      {member && <MemberDetails key={`${teamIdentity(snapshot)}:${member.agentId}`} client={client} member={member} snapshot={snapshot} />}
    </Sheet>
  </View>
}
function MemberDetails({ client, member, snapshot }: { client: ApiClient | null; member: TeamMember; snapshot: TeamWorkbenchSnapshot }) {
  const colors = useColors()
  const [showTranscript, setShowTranscript] = useState(false)
  const tasks = memberTasks(member, snapshot.tasks)
  const aliases = [member.agentId, member.name]
  const messages = snapshot.messages.filter((message) => aliases.includes(message.from) || (message.to && aliases.includes(message.to)) || message.recipients?.some((recipient) => aliases.includes(recipient))).slice(-8)
  return <View style={{ gap: 12 }}>
    <Text style={{ color: colors.ink, fontSize: 16 }}>{memberState(member)}{member.agentType ? ` · ${member.agentType}` : ''}</Text>
    {!!member.model && <Footnote>{member.model}</Footnote>}
    {!!member.lastError && <InlineError text={member.lastError} />}
    {!!member.autoRetry && <Footnote>第 {member.autoRetry.attempt}/{member.autoRetry.max} 次自动重试</Footnote>}
    <SectionHeader title={`负责的任务 · ${tasks.length}`} />
    {tasks.length ? tasks.map((task) => <TaskDetails key={task.id} task={task} tasks={snapshot.tasks} />) : <Footnote>暂未分配任务。</Footnote>}
    <SectionHeader title="最近通信" />
    {messages.length ? messages.map((message) => <View key={message.id} style={{ gap: 4, padding: 10, borderRadius: 10, backgroundColor: colors.fill }}>
      <Footnote>{message.from} → {message.to || '团队'}</Footnote>
      <Text selectable style={{ fontSize: 14, lineHeight: 21, color: colors.ink }}>{teamMessageText(message)}</Text>
    </View>) : <Footnote>还没有通信记录。</Footnote>}
    <Button title={showTranscript ? '收起执行记录' : '查看执行记录'} variant="secondary" onPress={() => setShowTranscript((value) => !value)} />
    {showTranscript && <MemberTranscript client={client} snapshot={snapshot} member={member} />}
  </View>
}
function MemberTranscript({ client, snapshot, member }: { client: ApiClient | null; snapshot: TeamWorkbenchSnapshot; member: TeamMember }) {
  const colors = useColors()
  const { name, incarnationId, leadSessionId } = snapshot.team
  const { agentId } = member
  const resource = useFocusedResource(useCallback((signal: AbortSignal) => {
    if (!client) throw new Error('正在连接电脑')
    return loadMemberTranscript(client, { team: { name, incarnationId, leadSessionId } }, { agentId }, signal)
  }, [client, name, incarnationId, leadSessionId, agentId]), memberState(member) === '工作中' ? 4000 : 0)
  return <View style={{ gap: 10 }}>
    <InlineError text={resource.error} />
    {resource.loading && !resource.value ? <Loading /> : <Mono selectable style={{ fontSize: 12, lineHeight: 19, color: colors.ink }}>{resource.value || '暂时没有执行记录。'}</Mono>}
    <TextButton title="刷新执行记录" onPress={() => void resource.refresh()} />
  </View>
}
function TaskDetails({ task, tasks }: { task: TaskInfo; tasks: TaskInfo[] }) {
  const colors = useColors()
  return <View style={{ gap: 6 }}>
    <Text style={{ fontSize: 16, lineHeight: 23, color: colors.ink }}>{task.subject}</Text>
    <Footnote>{taskState(task, tasks)}{task.owner ? ` · ${task.owner}` : ''}</Footnote>
    {!!task.description && <Text selectable style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>{task.description}</Text>}
    {task.blockedBy.length > 0 && <Footnote>依赖：{task.blockedBy.map((id) => tasks.find((other) => other.id === id)?.subject || `#${id}（已移除）`).join('、')}</Footnote>}
  </View>
}
function WorkRow({ title, detail, onPress }: { title: string; detail: string; onPress(): void }) {
  const colors = useColors()
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${detail}，查看详情`} onPress={onPress}
    style={({ pressed }) => ({ padding: 14, minHeight: 58, gap: 5, opacity: pressed ? 0.65 : 1 })}>
    <Text style={{ fontSize: 16, lineHeight: 23, color: colors.ink }}>{title}</Text>
    <Text style={{ fontSize: 13, lineHeight: 19, color: colors.ink2 }}>{detail}</Text>
  </Pressable>
}
