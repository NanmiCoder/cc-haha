import { ApiError, type ApiClient } from '../../core/client'
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
  if (task.status === 'completed') return 'Done'
  if (task.status === 'in_progress') return 'In progress'
  return task.blockedBy.some((id) => tasks.some((other) => other.id === id && other.status !== 'completed')) ? 'Waiting on dependencies' : 'Not started'
}
export function memberState(member: TeamMember) {
  if (member.status === 'completed' || member.activity === 'exited') return 'Exited'
  if (member.activity === 'active') return 'Working'
  if (member.activity === 'stopped') return 'Stopped'
  if (member.autoRetry) return 'Waiting to retry'
  if (member.status === 'failed') return 'Error'
  if (member.activity === 'idle') return 'Idle'
  return member.status === 'running' ? 'Working' : 'Idle'
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
const LOCAL_COMMAND = /^\s*(?:<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>\s*)+$/

/** Local commands the runtime ran on the member's behalf at startup (/model and its output): not its own work, and shown raw they are just a pile of tags. */
export function isLocalCommandEntry(entry: HistoryEntry) {
  if (entry.type !== 'user') return false
  const text =
    typeof entry.content === 'string'
      ? entry.content
      : Array.isArray(entry.content)
        ? entry.content.map((block: { type?: string; text?: string }) => (block?.type === 'text' ? (block.text ?? '') : '')).join('')
        : ''
  return LOCAL_COMMAND.test(text)
}

/** A member's recent execution records (raw entries, normalized by the same pipeline as the page and main conversation). */
export async function loadMemberHistory(client: ApiClient, team: { name: string; incarnationId?: string; leadSessionId?: string }, agentId: string, signal: AbortSignal) {
  const params = new URLSearchParams()
  if (team.leadSessionId) params.set('leadSessionId', team.leadSessionId)
  if (team.incarnationId) params.set('incarnationId', team.incarnationId)
  const query = params.toString()
  const response = await client.get<{ messages?: HistoryEntry[] }>(`/api/teams/${encodeURIComponent(team.name)}/members/${encodeURIComponent(agentId)}/transcript${query ? `?${query}` : ''}`, { signal })
  return (response.messages ?? []).filter((entry) => !isLocalCommandEntry(entry))
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
        idle_notification: 'Member is currently idle',
        shutdown_request: 'Requested the member to stop working',
        shutdown_approved: 'Member has finished working',
        shutdown_rejected: 'Member still needs to keep working',
        task_completed: 'Task completed',
      }
      return typeof value.type === 'string' ? (labels[value.type] || 'Team status updated') : 'Team status updated'
    }
  } catch { /* Ordinary human-readable communication. */ }
  return message.text
}
