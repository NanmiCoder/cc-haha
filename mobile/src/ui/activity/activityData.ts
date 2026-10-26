import { ApiError, type ApiClient } from '../../core/client'
import { normalizeHistory } from '../../core/chat'
import type { HistoryEntry } from '../../core/types'
// Minimal read-only wire contracts from server/api/{agents,teams}. Keep service
// implementations out of the mobile TypeScript and native module graphs.
export type TaskInfo = {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
  taskListId: string
}
export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
  model?: string
  status: 'running' | 'idle' | 'completed' | 'failed'
  activity?: 'active' | 'idle' | 'exited' | 'stopped' | 'unknown'
  lastError?: string
  autoRetry?: { attempt: number; max: number; nextAt: number }
}
export type TeamWorkbenchSnapshot = {
  version: string
  generatedAt: string
  deletedAt?: string
  team: {
    name: string
    incarnationId?: string
    leadSessionId?: string
    leadAgentId?: string
    createdAt: number
    members: TeamMember[]
  }
  tasks: TaskInfo[]
  messages: { id: string; from: string; to: string; recipients?: string[]; kind: string; text: string; summary?: string; timestamp: string }[]
}
export type TeamWorkbenchSessionTimeline = {
  sessionId: string
  teamName: string
  incarnationId: string
  source: 'live' | 'archive' | 'transcript'
  snapshots: TeamWorkbenchSnapshot[]
}
export async function loadTaskList(client: ApiClient, sessionId: string, signal: AbortSignal) {
  const response = await client.get<{ tasks: TaskInfo[] }>(`/api/tasks/lists/${encodeURIComponent(sessionId)}`, { signal })
  return response.tasks
}
export async function loadTeam(client: ApiClient, sessionId: string, signal: AbortSignal) {
  try {
    return await client.get<TeamWorkbenchSessionTimeline>(`/api/teams/session/${encodeURIComponent(sessionId)}/workbench`, { signal })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}
export function latestTeam(timeline: TeamWorkbenchSessionTimeline | null | undefined) {
  return timeline?.snapshots.at(-1) ?? null
}
export function taskProgress(tasks: TaskInfo[]) {
  return { completed: tasks.filter((task) => task.status === 'completed').length, total: tasks.length }
}
export function taskState(task: TaskInfo, tasks: TaskInfo[]) {
  if (task.status === 'completed') return '已完成'
  if (task.status === 'in_progress') return '进行中'
  return task.blockedBy.some((id) => tasks.some((other) => other.id === id && other.status !== 'completed')) ? '等待依赖' : '待开始'
}
export function memberState(member: TeamMember) {
  if (member.status === 'completed' || member.activity === 'exited') return '已退出'
  if (member.activity === 'active') return '工作中'
  if (member.activity === 'stopped') return '已停止'
  if (member.autoRetry) return '等待重试'
  if (member.status === 'failed') return '遇到错误'
  if (member.activity === 'idle') return '空闲'
  return member.status === 'running' ? '工作中' : '空闲'
}
export function memberTasks(member: TeamMember, tasks: TaskInfo[]) {
  const aliases = [member.agentId, member.name, member.agentId.split('@')[0]]
  return tasks.filter((task) => task.owner && aliases.includes(task.owner))
}
export function teamIdentity(snapshot: TeamWorkbenchSnapshot) {
  return snapshot.team.incarnationId || `${snapshot.team.name}:${snapshot.team.leadSessionId}:${snapshot.team.createdAt}`
}
/** Keep departed members inspectable in archived frames without mixing incarnations. */
export function teamMembers(timeline: TeamWorkbenchSessionTimeline) {
  const latest = latestTeam(timeline)
  if (!latest) return []
  const members = new Map<string, TeamMember>()
  for (const frame of timeline.snapshots) {
    if (teamIdentity(frame) !== teamIdentity(latest)) continue
    for (const member of frame.team.members) members.set(member.agentId, member)
  }
  const current = new Set(latest.team.members.map((member) => member.agentId))
  return [...members.values()].map((member) => current.has(member.agentId) && !latest.deletedAt ? member : { ...member, activity: 'exited' as const })
}
export async function loadMemberTranscript(client: ApiClient, snapshot: { team: Pick<TeamWorkbenchSnapshot['team'], 'name' | 'incarnationId' | 'leadSessionId'> }, member: Pick<TeamMember, 'agentId'>, signal: AbortSignal) {
  const params = new URLSearchParams({ incremental: 'true' })
  if (snapshot.team.leadSessionId) params.set('leadSessionId', snapshot.team.leadSessionId)
  if (snapshot.team.incarnationId) params.set('incarnationId', snapshot.team.incarnationId)
  const response = await client.get<{ messages: HistoryEntry[] }>(`/api/teams/${encodeURIComponent(snapshot.team.name)}/members/${encodeURIComponent(member.agentId)}/transcript?${params}`, { signal })
  return normalizeHistory(response.messages)
    .map((message) => message.text || (message.result ? JSON.stringify(message.result) : ''))
    .filter(Boolean).join('\n\n')
}

/** Team protocol envelopes describe status; do not expose their JSON as a message. */
export function teamMessageText(message: TeamWorkbenchSnapshot['messages'][number]) {
  if (message.summary?.trim()) return message.summary
  try {
    const body: unknown = JSON.parse(message.text)
    if (body && typeof body === 'object') {
      const value = body as Record<string, unknown>
      if (typeof value.text === 'string') return value.text
      if (typeof value.message === 'string') return value.message
      const labels: Record<string, string> = {
        idle_notification: '成员当前空闲',
        shutdown_request: '请求成员结束工作',
        shutdown_approved: '成员已结束工作',
        shutdown_rejected: '成员仍需继续工作',
        task_completed: '任务已完成',
      }
      return typeof value.type === 'string' ? (labels[value.type] || '团队状态已更新') : '团队状态已更新'
    }
  } catch { /* Ordinary human-readable communication. */ }
  return message.text
}
