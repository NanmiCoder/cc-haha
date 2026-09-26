import type { BackgroundAgentTask, AgentTaskNotification, BackgroundAgentTaskUsage } from '../../types/chat'
import type { TaskSummaryItem, UIMessage } from '../../types/chat'
import type { CLITask, TaskStatus } from '../../types/cliTask'
import type { TeamMember } from '../../types/team'
import {
  EMPTY_TEAM_LIFECYCLE_CURSOR,
  isTeamLifecycleScopedAt,
  updateTeamLifecycleCursor,
} from '../../lib/teamLifecycleScope'
import {
  createBackgroundTaskDismissKey,
  isVisibleSessionBackgroundTask,
} from '../../lib/backgroundTasks'
import { toAgentIdRef } from '../../api/subagents'
import type { WorkflowAgentEvent, WorkflowRun } from '../../types/workflow'

export type ActivityStatus = TaskStatus | BackgroundAgentTask['status'] | TeamMember['status']

export type ActivitySectionId = 'output' | 'tasks' | 'team' | 'workflow' | 'backgroundTasks' | 'subagents' | 'sources'

export type ActivityRow = {
  id: string
  section: ActivitySectionId
  label: string
  status: ActivityStatus
  cached?: boolean
  description?: string
  summary?: string
  toolUseId?: string
  /**
   * Phase this row belongs to, for sections that group. A workflow is phases
   * of N agents, and the grouping is the only thing that makes a fan-out
   * readable — twelve flat rows say nothing about which stage they belong to.
   */
  group?: string
  /** Set on a group's header row; agents under it carry `group` instead. */
  groupProgress?: { done: number; total: number }
  taskId?: string
  /** Structured owner for a canonical Agent Teams DAG row. */
  teamTaskListId?: string
  taskType?: BackgroundAgentTask['taskType']
  workflowName?: string
  /** Persisted Agent Teams launch identity for routing this row to the
   * incarnation-scoped member run instead of the ordinary subagent endpoint. */
  teamName?: string
  teamMemberName?: string
  teamStartedAt?: number
  dismissKey?: string
  outputFile?: string
  usage?: BackgroundAgentTaskUsage
  /**
   * First event that started the task. Together with `updatedAt` this is the
   * fallback span for tasks that never report `usage.durationMs` — which is
   * every shell background task, since the CLI sends no usage for them.
   */
  startedAt?: number
  updatedAt?: number | string
  member?: TeamMember
  taskHistory?: {
    completed: number
    total: number
    turnCount: number
  }
  openable: boolean
}

export type ActivitySection = {
  id: ActivitySectionId
  title: string
  emptyLabel: string
  rows: ActivityRow[]
}

export type SessionActivityModel = {
  sessionId: string
  badgeCount: number
  sections: Record<ActivitySectionId, ActivitySection>
}

export type BuildSessionActivityModelInput = {
  sessionId: string
  messages?: UIMessage[]
  /**
   * Session transcripts can contain forwarded child-tool activity. A session
   * owns only root messages, while an agent detail transcript owns the
   * parent-linked messages forwarded for that agent run.
   */
  runScope?: 'session' | 'agent'
  /**
   * Agent Teams coordinates through one shared task list. In that scope the
   * caller supplies the member-owned projection via `tasks`; Task* transcript
   * events must not recreate the whole shared list in this run.
   */
  taskScope?: 'run' | 'team' | 'team-session'
  /** Explicit lifecycle windows cover the live gap before TeamCreate appears
   * in history and truncated transcripts that no longer contain that call. */
  teamTaskWindows?: Array<{ startedAt: number; endedAt?: number }>
  tasks: CLITask[]
  /** Canonical shared DAG for the team owned by this session. These rows sit
   * beside run-local tasks while bypassing transcript reconstruction, so
   * member updates cannot leak into the lead run and stale lead events cannot
   * override runtime task status. */
  teamTasks?: CLITask[]
  completedAndDismissed: boolean
  isForegroundTurnActive?: boolean
  backgroundTasks: BackgroundAgentTask[]
  dismissedBackgroundTaskKeys?: Set<string>
  agentNotifications: AgentTaskNotification[]
  teamMembers?: TeamMember[]
  /** AgentTeam has its own strip/workbench in a main session. Set false at
   * that ownership boundary so transcript spawn rows cannot affect Activity. */
  includeTeamActivity?: boolean
  /** Live workflow runs for this session, newest first. */
  workflowRuns?: WorkflowRun[]
}

export type BuildMainSessionActivityModelInput = Omit<
  BuildSessionActivityModelInput,
  'runScope' | 'taskScope' | 'teamTasks' | 'teamMembers' | 'includeTeamActivity'
>

/**
 * Ordered by how directly each section answers "what is this turn doing":
 * the plan first, then the agents working it, then the processes it left
 * running. Background tasks outlive the turn, so they sit last.
 */
export const VISIBLE_ACTIVITY_SECTION_ORDER = [
  'tasks',
  // A running workflow is the turn's whole shape, so it sits above the
  // individual agents it spawned rather than among them.
  'workflow',
  'subagents',
  'team',
  'backgroundTasks',
  'sources',
] as const satisfies readonly ActivitySectionId[]

const BADGE_STATUSES = new Set<ActivityStatus>(['pending', 'in_progress', 'running', 'failed', 'error'])

const SECTION_META: Record<ActivitySectionId, Pick<ActivitySection, 'title' | 'emptyLabel'>> = {
  output: { title: 'Output', emptyLabel: 'No output' },
  tasks: { title: 'Tasks', emptyLabel: 'No tasks' },
  team: { title: 'Team', emptyLabel: 'No team members' },
  workflow: { title: 'Workflow', emptyLabel: 'No workflow running' },
  backgroundTasks: { title: 'Background Tasks', emptyLabel: 'No background tasks' },
  subagents: { title: 'SubAgents', emptyLabel: 'No SubAgents' },
  sources: { title: 'Sources', emptyLabel: 'No sources' },
}

function createEmptySections(): Record<ActivitySectionId, ActivitySection> {
  return {
    output: createSection('output'),
    tasks: createSection('tasks'),
    team: createSection('team'),
    workflow: createSection('workflow'),
    backgroundTasks: createSection('backgroundTasks'),
    subagents: createSection('subagents'),
    sources: createSection('sources'),
  }
}

function createSection(id: ActivitySectionId): ActivitySection {
  return {
    id,
    title: SECTION_META[id].title,
    emptyLabel: SECTION_META[id].emptyLabel,
    rows: [],
  }
}

export function getVisibleActivitySections(model: SessionActivityModel): ActivitySection[] {
  return VISIBLE_ACTIVITY_SECTION_ORDER
    .map((sectionId) => model.sections[sectionId])
    .filter((section) => section.rows.length > 0)
}

export function hasVisibleSessionActivity(model: SessionActivityModel): boolean {
  return getVisibleActivitySections(model).length > 0
}

function isBadgeStatus(status: ActivityStatus): boolean {
  return BADGE_STATUSES.has(status)
}

function activityKey(task: Pick<BackgroundAgentTask, 'taskId' | 'toolUseId'>): string {
  return task.toolUseId ?? task.taskId
}

function notificationKey(notification: Pick<AgentTaskNotification, 'taskId' | 'toolUseId'>): string {
  return notification.toolUseId ?? notification.taskId
}

function isAgentLikeBackgroundTask(task: BackgroundAgentTask): boolean {
  return Boolean(task.taskType?.includes('agent'))
}

function backgroundLabel(task: BackgroundAgentTask): string {
  return task.description || task.workflowName || task.taskId
}

function notificationLabel(notification: AgentTaskNotification): string {
  return notification.taskId
}

function buildTaskRow(task: CLITask): ActivityRow {
  return {
    id: task.id,
    section: 'tasks',
    label: task.subject,
    status: task.status,
    description: task.description,
    taskId: task.id,
    openable: false,
  }
}

function buildTeamTaskRow(task: CLITask): ActivityRow {
  return {
    ...buildTaskRow(task),
    id: `team-task:${task.taskListId}:${task.id}`,
    teamTaskListId: task.taskListId,
  }
}

function buildTaskSummaryRow(task: TaskSummaryItem, index: number): ActivityRow {
  return {
    id: task.id || `summary-task-${index + 1}`,
    section: 'tasks',
    label: task.subject || task.activeForm || `Task ${index + 1}`,
    status: task.status,
    description: task.activeForm && task.activeForm !== task.subject ? task.activeForm : undefined,
    taskId: task.id,
    openable: false,
  }
}

function buildTodoTaskRow(todo: { content?: unknown; status?: unknown; activeForm?: unknown }, index: number): ActivityRow {
  const status = todo.status === 'completed' || todo.status === 'in_progress' || todo.status === 'pending'
    ? todo.status
    : 'pending'
  const label = typeof todo.content === 'string' && todo.content.trim()
    ? todo.content.trim()
    : typeof todo.activeForm === 'string' && todo.activeForm.trim()
      ? todo.activeForm.trim()
      : `Task ${index + 1}`
  const activeForm = typeof todo.activeForm === 'string' && todo.activeForm.trim()
    ? todo.activeForm.trim()
    : ''

  return {
    id: `todo-${index + 1}`,
    section: 'tasks',
    label,
    status,
    description: activeForm && activeForm !== label ? activeForm : undefined,
    openable: false,
  }
}

function normalizeTaskRowText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function taskRowDedupeKey(row: ActivityRow): string {
  return `text:${normalizeTaskRowText(row.label)}`
}

function mergeTaskRows(existing: ActivityRow, row: ActivityRow): ActivityRow {
  const existingDescription = existing.description ?? ''
  const nextDescription = row.description ?? ''

  return {
    ...existing,
    status: row.status,
    description: nextDescription.length > existingDescription.length ? nextDescription : existing.description,
    summary: existing.summary || row.summary,
    taskId: existing.taskId || row.taskId,
    updatedAt: row.updatedAt ?? existing.updatedAt,
  }
}

function dedupeTaskRows(rows: ActivityRow[]): ActivityRow[] {
  const rowsByKey = new Map<string, ActivityRow>()

  for (const row of rows) {
    const key = taskRowDedupeKey(row)
    const existing = rowsByKey.get(key)
    rowsByKey.set(key, existing ? mergeTaskRows(existing, row) : row)
  }

  return Array.from(rowsByKey.values())
}

type TaskMessageTurn = {
  id: string
  index: number
  messages: UIMessage[]
}

type TaskTurnRows = {
  turn: TaskMessageTurn
  rows: ActivityRow[]
  confirmedStatuses: Map<string, TaskStatus>
}

type BuiltTaskRows = Pick<TaskTurnRows, 'rows' | 'confirmedStatuses'>

function splitMessagesIntoTurns(messages: UIMessage[]): TaskMessageTurn[] {
  const turns: TaskMessageTurn[] = []
  let current: TaskMessageTurn = { id: 'turn-0', index: 0, messages: [] }
  let nextIndex = 1

  for (const message of messages) {
    if (message.type === 'user_text') {
      if (current.messages.length > 0) {
        turns.push(current)
      }
      current = {
        id: message.transcriptMessageId || message.id || `turn-${nextIndex}`,
        index: nextIndex,
        messages: [message],
      }
      nextIndex += 1
      continue
    }

    current.messages.push(message)
  }

  if (current.messages.length > 0) {
    turns.push(current)
  }

  return turns
}

function parseTaskStatus(status: unknown): TaskSummaryItem['status'] | undefined {
  if (status === 'completed' || status === 'in_progress' || status === 'pending') return status
  return undefined
}

function taskIdFromInput(input: Record<string, unknown>): string {
  return stringField(input, 'taskId') || stringField(input, 'id')
}

function isDeletedStatus(input: Record<string, unknown>): boolean {
  return stringField(input, 'status') === 'deleted'
}

function collectToolResults(
  messages: UIMessage[],
): Map<string, Extract<UIMessage, { type: 'tool_result' }>> {
  const resultsByToolUseId = new Map<string, Extract<UIMessage, { type: 'tool_result' }>>()
  for (const message of messages) {
    if (message.type === 'tool_result') {
      resultsByToolUseId.set(message.toolUseId, message)
    }
  }
  return resultsByToolUseId
}

function keepSessionRunMessage(message: UIMessage): boolean {
  return !(
    (message.type === 'tool_use' || message.type === 'tool_result') &&
    message.parentToolUseId
  )
}

function projectMessagesToRun(messages: UIMessage[], runScope: 'session' | 'agent'): UIMessage[] {
  return runScope === 'agent' ? messages : messages.filter(keepSessionRunMessage)
}

function explicitSuccessFlag(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = explicitSuccessFlag(item)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  if (isRecordValue(value)) {
    if (typeof value.success === 'boolean') return value.success
    if ('content' in value) return explicitSuccessFlag(value.content)
    if ('text' in value) return explicitSuccessFlag(value.text)
    return undefined
  }
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return explicitSuccessFlag(JSON.parse(text))
  } catch {
    return undefined
  }
}

function teamLifecycleSucceeded(
  result: Extract<UIMessage, { type: 'tool_result' }> | undefined,
): boolean {
  if (!result || result.isError) return false
  return explicitSuccessFlag(result.content) !== false
}

function projectMessagesToTaskScope(
  messages: UIMessage[],
  taskScope: 'run' | 'team' | 'team-session',
  teamTaskWindows: Array<{ startedAt: number; endedAt?: number }>,
): UIMessage[] {
  if (taskScope === 'run') return messages

  const sharedTaskToolUseIds = new Set<string>()
  const resultsByToolUseId = collectToolResults(messages)
  let transcriptTeamCursor = EMPTY_TEAM_LIFECYCLE_CURSOR
  for (const message of messages) {
    if (taskScope === 'team-session' && message.type === 'tool_use') {
      const lifecycleSucceeded = teamLifecycleSucceeded(
        resultsByToolUseId.get(message.toolUseId),
      )
      if (message.toolName === 'TeamCreate' && lifecycleSucceeded) {
        transcriptTeamCursor = updateTeamLifecycleCursor(
          true,
          message.timestamp,
        )
      }
      if (message.toolName === 'TeamDelete' && lifecycleSucceeded) {
        transcriptTeamCursor = updateTeamLifecycleCursor(
          false,
          message.timestamp,
        )
      }
    }
    if (
      message.type === 'tool_use' &&
      (message.toolName === 'TaskCreate' || message.toolName === 'TaskUpdate') &&
      (
        taskScope === 'team' ||
        (
          isTeamLifecycleScopedAt(
            message.timestamp,
            transcriptTeamCursor,
            teamTaskWindows,
          )
        )
      )
    ) {
      sharedTaskToolUseIds.add(message.toolUseId)
    }
  }

  return messages.filter((message) => {
    if (
      message.type === 'tool_use' &&
      (message.toolName === 'TaskCreate' || message.toolName === 'TaskUpdate')
    ) {
      return !sharedTaskToolUseIds.has(message.toolUseId)
    }
    return message.type !== 'tool_result' || !sharedTaskToolUseIds.has(message.toolUseId)
  })
}

/**
 * TaskUpdate 的 deleted 是删除动作而非状态，删除可能发生在创建它的那一轮之后，
 * 所以要跨轮次收集，避免已删任务留在历史统计里。
 */
function collectDeletedTaskIds(messages: UIMessage[]): Set<string> {
  const deletedTaskIds = new Set<string>()
  const resultsByToolUseId = collectToolResults(messages)

  for (const message of messages) {
    if (message.type !== 'tool_use' || message.toolName !== 'TaskUpdate') continue

    const input = isRecordValue(message.input) ? message.input : {}
    if (!isDeletedStatus(input)) continue
    if (!isSuccessfulTaskUpdate(input, resultsByToolUseId.get(message.toolUseId))) continue

    const taskId = taskIdFromInput(input)
    if (taskId) deletedTaskIds.add(taskId)
  }

  return deletedTaskIds
}

function parseCreatedTaskResult(content: unknown): { id: string; subject?: string } | null {
  const text = extractTextContent(content)
  const match = text.match(/Task\s+#([^\s:]+)\s+created\s+successfully(?::\s*(.+))?/i)
  if (!match?.[1]) return null

  return {
    id: match[1],
    subject: match[2]?.trim(),
  }
}

function parseUpdatedTaskResult(content: unknown): { id: string } | null {
  const match = extractTextContent(content).trimStart().match(/^Updated task #([^\s]+)(?:\s|$)/i)
  return match?.[1] ? { id: match[1] } : null
}

function isSuccessfulTaskUpdate(
  input: Record<string, unknown>,
  result: Extract<UIMessage, { type: 'tool_result' }> | undefined,
): boolean {
  if (!result || result.isError) return false
  const taskId = taskIdFromInput(input)
  return Boolean(taskId && parseUpdatedTaskResult(result.content)?.id === taskId)
}

function buildTaskToolRow(
  id: string,
  input: Record<string, unknown>,
  index: number,
  result?: { subject?: string } | null,
): ActivityRow {
  const subject = stringField(input, 'subject') || result?.subject || `Task #${id || index + 1}`
  const description = stringField(input, 'description')

  return {
    id,
    section: 'tasks',
    label: subject,
    status: 'pending',
    description: description && description !== subject ? description : undefined,
    taskId: id,
    openable: false,
  }
}

function buildTeamRow(member: TeamMember): ActivityRow {
  return {
    id: member.agentId,
    section: 'team',
    label: member.role || member.name || member.agentId,
    status: member.status,
    description: member.currentTask,
    member,
    openable: true,
  }
}

function buildBackgroundRow(task: BackgroundAgentTask, section: ActivitySectionId): ActivityRow {
  return {
    id: activityKey(task),
    section,
    label: backgroundLabel(task),
    status: task.status,
    description: task.description,
    summary: task.summary,
    toolUseId: task.toolUseId,
    taskId: task.taskId,
    taskType: task.taskType,
    workflowName: task.workflowName,
    dismissKey: createBackgroundTaskDismissKey(task),
    outputFile: task.outputFile,
    usage: task.usage,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    openable: Boolean(task.toolUseId),
  }
}

function buildNotificationRow(notification: AgentTaskNotification): ActivityRow {
  return {
    id: notificationKey(notification),
    section: 'subagents',
    label: notificationLabel(notification),
    status: notification.status,
    summary: notification.summary,
    toolUseId: notification.toolUseId,
    taskId: notification.taskId,
    outputFile: notification.outputFile,
    usage: notification.usage,
    updatedAt: notification.timestamp,
    openable: Boolean(notification.toolUseId),
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const fieldValue = value[key]
  return typeof fieldValue === 'string' ? fieldValue.trim() : ''
}

function compactText(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(extractTextContent).filter(Boolean).join('\n')
  if (!isRecordValue(value)) return ''

  const directText = stringField(value, 'text') ||
    stringField(value, 'message') ||
    stringField(value, 'summary') ||
    stringField(value, 'result') ||
    stringField(value, 'error')
  if (directText) return directText

  if ('content' in value) return extractTextContent(value.content)
  return ''
}

function stripAgentMetadata(text: string): string {
  return text
    .replace(/^\s*agentId:.*(?:\r?\n)?/gm, '')
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function agentToolLabel(toolCall: Extract<UIMessage, { type: 'tool_use' }>): string {
  const input = isRecordValue(toolCall.input) ? toolCall.input : {}
  return compactText(
    stringField(input, 'description') ||
      stringField(input, 'prompt') ||
      stringField(input, 'task') ||
      stringField(input, 'subagent_type') ||
      'Agent',
    120,
  )
}

function parseToolResultRecord(
  result: Extract<UIMessage, { type: 'tool_result' }> | undefined,
): Record<string, unknown> | null {
  if (!result || result.isError) return null
  if (isRecordValue(result.content)) return result.content

  const text = extractTextContent(result.content).trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecordValue(parsed) ? parsed : null
  } catch {
    return null
  }
}

function updatedActiveTeamName(
  toolCall: Extract<UIMessage, { type: 'tool_use' }>,
  result: Extract<UIMessage, { type: 'tool_result' }> | undefined,
): string | null | undefined {
  const output = parseToolResultRecord(result)
  if (!output) return undefined

  if (toolCall.toolName === 'TeamCreate') {
    if (output.success === false) return undefined
    return stringField(output, 'team_name') || undefined
  }
  if (toolCall.toolName === 'TeamDelete' && output.success === true) {
    return null
  }
  return undefined
}

type TeamSpawnIdentity = {
  memberName: string
  teamName?: string
}

function teamSpawnIdentity(
  toolCall: Extract<UIMessage, { type: 'tool_use' }>,
  result: Extract<UIMessage, { type: 'tool_result' }> | undefined,
  activeTeamName: string | undefined,
  teamScoped: boolean,
): TeamSpawnIdentity | null {
  const input = isRecordValue(toolCall.input) ? toolCall.input : {}
  const inputMemberName = stringField(input, 'name')
  const inputTeamName = stringField(input, 'team_name')
  if (inputMemberName && (inputTeamName || teamScoped)) {
    return {
      memberName: inputMemberName,
      ...((inputTeamName || (teamScoped && activeTeamName))
        ? { teamName: inputTeamName || activeTeamName }
        : {}),
    }
  }

  const output = parseToolResultRecord(result)
  if (stringField(output ?? {}, 'status') === 'teammate_spawned') {
    const memberName = stringField(output ?? {}, 'name') || inputMemberName
    if (!memberName) return null
    const outputTeamName = stringField(output ?? {}, 'team_name')
    return {
      memberName,
      ...((outputTeamName || activeTeamName)
        ? { teamName: outputTeamName || activeTeamName }
        : {}),
    }
  }

  const fields = new Map<string, string>()
  for (const line of extractTextContent(result?.content).split(/\r?\n/)) {
    const match = /^\s*([a-z_]+):\s*(\S.*?)\s*$/.exec(line)
    const key = match?.[1]
    const value = match?.[2]
    if (key && value) fields.set(key, value)
  }
  const resultTeamName = fields.get('team_name')
  if (!fields.get('agent_id') || !fields.get('name') || !resultTeamName) return null
  return {
    memberName: fields.get('name')!,
    teamName: resultTeamName,
  }
}

function buildAgentRowsFromMessages(
  messages: UIMessage[],
  teamTaskWindows: Array<{ startedAt: number; endedAt?: number }>,
): ActivityRow[] {
  const resultsByToolUseId = new Map<string, Extract<UIMessage, { type: 'tool_result' }>>()
  const toolCallsByToolUseId = new Map<string, Extract<UIMessage, { type: 'tool_use' }>>()
  for (const message of messages) {
    if (message.type === 'tool_result') {
      resultsByToolUseId.set(message.toolUseId, message)
    } else if (message.type === 'tool_use') {
      toolCallsByToolUseId.set(message.toolUseId, message)
    }
  }

  const rows: ActivityRow[] = []
  let activeTeamName: string | undefined
  let transcriptTeamCursor = EMPTY_TEAM_LIFECYCLE_CURSOR
  for (const message of messages) {
    if (message.type === 'tool_result') {
      const toolCall = toolCallsByToolUseId.get(message.toolUseId)
      if (toolCall) {
        const updatedTeamName = updatedActiveTeamName(toolCall, message)
        if (updatedTeamName !== undefined) activeTeamName = updatedTeamName ?? undefined
      }
      continue
    }
    if (message.type !== 'tool_use') continue

    const result = resultsByToolUseId.get(message.toolUseId)
    const lifecycleSucceeded = teamLifecycleSucceeded(result)
    if (message.toolName === 'TeamCreate' && lifecycleSucceeded) {
      transcriptTeamCursor = updateTeamLifecycleCursor(true, message.timestamp)
    } else if (message.toolName === 'TeamDelete' && lifecycleSucceeded) {
      transcriptTeamCursor = updateTeamLifecycleCursor(false, message.timestamp)
    }
    if (message.toolName !== 'Agent') continue

    const resultText = result ? stripAgentMetadata(extractTextContent(result.content)) : ''
    const teamIdentity = teamSpawnIdentity(
      message,
      result,
      activeTeamName,
      isTeamLifecycleScopedAt(
        message.timestamp,
        transcriptTeamCursor,
        teamTaskWindows,
      ),
    )
    // Agent inputs stream before their ownership fields. Until the input is
    // complete, treating an unknown owner as direct makes Team members flash
    // through the main session's SubAgents section.
    if (message.isPending && !teamIdentity) continue
    if (teamIdentity) {
      rows.push({
        id: message.toolUseId,
        section: 'team',
        label: teamIdentity.memberName,
        status: message.status === 'stopped'
          ? 'stopped'
          : result?.isError
            ? 'failed'
            : 'running',
        description: agentToolLabel(message),
        summary: resultText ? compactText(resultText) : undefined,
        toolUseId: message.toolUseId,
        taskType: 'in_process_teammate',
        ...(teamIdentity.teamName ? { teamName: teamIdentity.teamName } : {}),
        teamMemberName: teamIdentity.memberName,
        ...(teamIdentity.teamName ? { teamStartedAt: message.timestamp } : {}),
        updatedAt: result?.timestamp ?? message.timestamp,
        openable: Boolean(teamIdentity.teamName),
      })
      continue
    }
    rows.push({
      id: message.toolUseId,
      section: 'subagents',
      label: agentToolLabel(message),
      status: message.status === 'stopped'
        ? 'stopped'
        : result?.isError
          ? 'failed'
          : result
            ? 'completed'
            : 'running',
      summary: resultText ? compactText(resultText) : undefined,
      toolUseId: message.toolUseId,
      taskType: 'local_agent',
      updatedAt: result?.timestamp ?? message.timestamp,
      openable: true,
    })
  }

  return rows
}

function buildTaskRowsFromTaskTools(
  messages: UIMessage[],
  resultsByToolUseId = collectToolResults(messages),
): BuiltTaskRows {

  const rowsByTaskId = new Map<string, ActivityRow>()
  const confirmedStatuses = new Map<string, TaskStatus>()
  let createIndex = 0

  for (const message of messages) {
    if (message.type !== 'tool_use') continue

    if (message.toolName === 'TaskCreate') {
      const input = isRecordValue(message.input) ? message.input : {}
      const result = parseCreatedTaskResult(resultsByToolUseId.get(message.toolUseId)?.content)
      const taskId = result?.id || stringField(input, 'taskId') || stringField(input, 'id') || `${createIndex + 1}`
      const row = buildTaskToolRow(taskId, input, createIndex, result)
      rowsByTaskId.set(taskId, row)
      createIndex += 1
      continue
    }

    if (message.toolName === 'TaskUpdate') {
      const input = isRecordValue(message.input) ? message.input : {}
      const taskId = taskIdFromInput(input)
      if (!taskId) continue
      // TaskUpdate reports benign failures such as "Task not found" with
      // isError=false, so only its positive result is authoritative.
      if (!isSuccessfulTaskUpdate(input, resultsByToolUseId.get(message.toolUseId))) continue

      // deleted 不是一种任务状态：CLI 侧 TaskUpdateTool 会真的删掉任务文件
      if (isDeletedStatus(input)) {
        rowsByTaskId.delete(taskId)
        confirmedStatuses.delete(taskId)
        continue
      }

      const existing = rowsByTaskId.get(taskId)
      const activeForm = stringField(input, 'activeForm')
      const subject = stringField(input, 'subject')
      const status = parseTaskStatus(input.status) ?? existing?.status ?? 'pending'
      rowsByTaskId.set(taskId, {
        ...(existing ?? {
          id: taskId,
          section: 'tasks',
          label: subject || activeForm || `Task #${taskId}`,
          taskId,
          openable: false,
        }),
        status,
        ...(activeForm && activeForm !== (existing?.label ?? subject) ? { description: activeForm } : {}),
      })
      const confirmedStatus = parseTaskStatus(input.status)
      if (confirmedStatus) confirmedStatuses.set(taskId, confirmedStatus)
    }
  }

  return {
    rows: Array.from(rowsByTaskId.values()),
    confirmedStatuses,
  }
}

function buildTaskRowsFromTurnMessages(
  messages: UIMessage[],
  resultsByToolUseId = collectToolResults(messages),
): BuiltTaskRows {
  let latestSummary: Extract<UIMessage, { type: 'task_summary' }> | undefined
  let latestTodoWrite: Extract<UIMessage, { type: 'tool_use' }> | undefined
  let latestTodoWriteIndex = -1
  let latestTaskToolIndex = -1

  for (const [index, message] of messages.entries()) {
    if (message.type === 'task_summary') {
      latestSummary = message
    } else if (message.type === 'tool_use' && message.toolName === 'TodoWrite') {
      latestTodoWrite = message
      latestTodoWriteIndex = index
    } else if (message.type === 'tool_use' && message.toolName === 'TaskCreate') {
      latestTaskToolIndex = index
    } else if (message.type === 'tool_use' && message.toolName === 'TaskUpdate') {
      const input = isRecordValue(message.input) ? message.input : {}
      if (isSuccessfulTaskUpdate(input, resultsByToolUseId.get(message.toolUseId))) {
        latestTaskToolIndex = index
      }
    }
  }

  if (latestSummary?.tasks.length) {
    return {
      rows: dedupeTaskRows(latestSummary.tasks.map(buildTaskSummaryRow)),
      confirmedStatuses: new Map(),
    }
  }

  const input = latestTodoWrite?.input
  if (latestTodoWrite && isRecordValue(input) && Array.isArray(input.todos) && latestTodoWriteIndex >= latestTaskToolIndex) {
    return {
      rows: dedupeTaskRows(input.todos.map(buildTodoTaskRow)),
      confirmedStatuses: new Map(),
    }
  }

  return buildTaskRowsFromTaskTools(messages, resultsByToolUseId)
}

function mergeTaskRowsById(
  baseRows: ActivityRow[],
  liveRows: ActivityRow[],
  confirmedStatuses: Map<string, TaskStatus>,
): ActivityRow[] {
  const liveRowsById = new Map<string, ActivityRow>()
  for (const row of liveRows) {
    if (row.taskId || row.id) {
      liveRowsById.set(row.taskId ?? row.id, row)
    }
  }

  const usedLiveIds = new Set<string>()
  const mergedRows = baseRows.map((row) => {
    const id = row.taskId ?? row.id
    const liveRow = liveRowsById.get(id)
    if (!liveRow) return row
    usedLiveIds.add(id)
    const mergedRow = mergeTaskRows(row, liveRow)
    const confirmedStatus = confirmedStatuses.get(id)
    return confirmedStatus ? { ...mergedRow, status: confirmedStatus } : mergedRow
  })

  for (const row of liveRows) {
    const id = row.taskId ?? row.id
    if (!usedLiveIds.has(id)) {
      mergedRows.push(row)
    }
  }

  return mergedRows
}

function buildHistoricalTasksRow(groups: TaskTurnRows[]): ActivityRow | null {
  const rows = groups.flatMap((group) => group.rows)
  if (rows.length === 0) return null

  const completed = rows.filter((row) => row.status === 'completed').length

  return {
    id: `task-history-${groups[0]?.turn.id ?? 'turn'}-${groups.length}-${rows.length}`,
    section: 'tasks',
    label: 'Earlier tasks',
    status: completed === rows.length ? 'completed' : 'stopped',
    taskHistory: {
      completed,
      total: rows.length,
      turnCount: groups.length,
    },
    openable: false,
  }
}

function buildTaskRowsFromMessages(
  runMessages: UIMessage[],
  liveTasks: CLITask[],
  taskScope: 'run' | 'team' | 'team-session',
  teamTaskWindows: Array<{ startedAt: number; endedAt?: number }>,
): ActivityRow[] {
  const taskMessages = projectMessagesToTaskScope(runMessages, taskScope, teamTaskWindows)
  const deletedTaskIds = collectDeletedTaskIds(taskMessages)
  const resultsByToolUseId = collectToolResults(taskMessages)
  const isSessionTaskRow = (row: ActivityRow) => row.taskId
    ? !deletedTaskIds.has(row.taskId)
    : true
  // 任务列表要等 tool_result 到达后才异步刷新，这中间 liveTasks 里还留着已删的任务
  const liveRows = liveTasks.map(buildTaskRow).filter(isSessionTaskRow)
  const taskTurnRows = splitMessagesIntoTurns(taskMessages)
    .map((turn) => {
      const builtRows = buildTaskRowsFromTurnMessages(turn.messages, resultsByToolUseId)
      return {
        turn,
        rows: builtRows.rows.filter(isSessionTaskRow),
        confirmedStatuses: builtRows.confirmedStatuses,
      }
    })
    .filter((group) => group.rows.length > 0)

  if (taskTurnRows.length === 0) {
    return dedupeTaskRows(liveRows)
  }

  const currentGroup = taskTurnRows[taskTurnRows.length - 1]!
  const earlierGroups = taskTurnRows.slice(0, -1)
  const currentRows = dedupeTaskRows(mergeTaskRowsById(
    currentGroup.rows,
    liveRows,
    currentGroup.confirmedStatuses,
  ))
  const historicalRow = buildHistoricalTasksRow(earlierGroups)

  return historicalRow ? [...currentRows, historicalRow] : currentRows
}

function sealUnfinishedTaskRows(rows: ActivityRow[]): ActivityRow[] {
  return rows.map((row) => row.status === 'pending' || row.status === 'in_progress'
    ? { ...row, status: 'stopped' }
    : row)
}

function mergeSubagentRow(existing: ActivityRow | undefined, row: ActivityRow): ActivityRow {
  if (!existing) return row

  return {
    ...existing,
    id: row.id,
    section: 'subagents',
    label: existing.label === 'Agent' ? row.label : existing.label,
    status: row.status,
    description: existing.description ?? row.description,
    summary: row.summary ?? existing.summary,
    toolUseId: row.toolUseId ?? existing.toolUseId,
    taskId: existing.taskId ?? row.taskId,
    taskType: existing.taskType ?? row.taskType,
    workflowName: existing.workflowName ?? row.workflowName,
    dismissKey: existing.dismissKey ?? row.dismissKey,
    outputFile: existing.outputFile ?? row.outputFile,
    usage: existing.usage ?? row.usage,
    updatedAt: row.updatedAt ?? existing.updatedAt,
    member: existing.member ?? row.member,
    openable: existing.openable || row.openable,
  }
}

function mergeNotificationRow(existing: ActivityRow | undefined, notification: AgentTaskNotification): ActivityRow {
  const notificationRow = buildNotificationRow(notification)

  return {
    ...existing,
    id: notificationRow.id,
    section: notificationRow.section,
    label: existing?.label || notification.taskId,
    status: notification.status,
    description: existing?.description,
    summary: notification.summary ?? existing?.summary,
    toolUseId: notification.toolUseId ?? existing?.toolUseId,
    taskId: notification.taskId,
    taskType: existing?.taskType,
    workflowName: existing?.workflowName,
    dismissKey: existing?.dismissKey,
    outputFile: notification.outputFile ?? existing?.outputFile,
    usage: notification.usage ?? existing?.usage,
    updatedAt: notification.timestamp ?? existing?.updatedAt,
    openable: Boolean(notification.toolUseId ?? existing?.toolUseId),
  }
}

/**
 * Flatten a workflow run into phase headers each followed by its agents.
 *
 * The agents are ordinary subagents, so every row carries the reference the
 * existing subagent page opens with — there is nothing workflow-specific to
 * render for one of them. An agent that has not been given a concurrency slot
 * yet has no transcript to open, so it is listed but not openable.
 */
function buildWorkflowRows(run: WorkflowRun): ActivityRow[] {
  const phaseTitles = new Map<number, string>()
  const agentsByPhase = new Map<number, WorkflowAgentEvent[]>()

  for (const event of run.progress) {
    if (event.type === 'workflow_phase') {
      if (!phaseTitles.has(event.index)) phaseTitles.set(event.index, event.title)
      if (!agentsByPhase.has(event.index)) agentsByPhase.set(event.index, [])
      continue
    }
    const phaseIndex = event.phaseIndex ?? 0
    if (!phaseTitles.has(phaseIndex)) {
      phaseTitles.set(phaseIndex, event.phaseTitle ?? '')
    }
    const bucket = agentsByPhase.get(phaseIndex) ?? []
    bucket.push(event)
    agentsByPhase.set(phaseIndex, bucket)
  }

  const rows: ActivityRow[] = []
  for (const [phaseIndex, title] of [...phaseTitles.entries()].sort(([a], [b]) => a - b)) {
    const agents = (agentsByPhase.get(phaseIndex) ?? [])
      .slice()
      .sort((a, b) => a.index - b.index)
    if (agents.length === 0 && !title) continue
    // Agents emitted before any `phase()` call — and every agent of a run
    // recorded before phases were persisted — have no title. The run's name
    // says more about them than "Phase 0" does, and it also tells two runs in
    // the same session apart.
    const groupLabel = title || run.workflowName
    const done = agents.filter(
      agent => agent.state === 'done' || agent.state === 'error',
    ).length

    rows.push({
      id: `${run.taskId}-phase-${phaseIndex}`,
      section: 'workflow',
      label: groupLabel,
      status: workflowPhaseStatus(agents),
      groupProgress: { done, total: agents.length },
      workflowName: run.workflowName,
      openable: false,
    })

    for (const agent of agents) {
      rows.push({
        id: `${run.taskId}-agent-${agent.index}`,
        section: 'workflow',
        label: agent.label,
        status: workflowAgentStatus(agent),
        cached: agent.cached,
        group: groupLabel,
        summary: agent.resultPreview,
        toolUseId: agent.agentId ? toAgentIdRef(agent.agentId) : undefined,
        taskType: 'local_agent',
        workflowName: run.workflowName,
        usage: agent.tokens ? { totalTokens: agent.tokens } : undefined,
        openable: Boolean(agent.agentId),
      })
    }
  }

  return rows
}

function workflowAgentStatus(agent: WorkflowAgentEvent): ActivityStatus {
  if (agent.state === 'done') return 'completed'
  if (agent.state === 'error') return 'failed'
  if (agent.state === 'progress') return 'running'
  return 'pending'
}

function workflowPhaseStatus(agents: WorkflowAgentEvent[]): ActivityStatus {
  if (agents.length === 0) return 'pending'
  if (agents.some(agent => agent.state === 'progress')) return 'running'
  if (agents.every(agent => agent.state === 'done' || agent.state === 'error')) {
    return agents.some(agent => agent.state === 'error') ? 'failed' : 'completed'
  }
  return agents.some(agent => agent.state === 'done' || agent.state === 'error')
    ? 'running'
    : 'pending'
}

function buildOutputRow(key: string, outputFile: string): ActivityRow {
  return {
    id: `output-${key}`,
    section: 'output',
    label: outputFile,
    status: 'completed',
    outputFile,
    openable: true,
  }
}

export function buildSessionActivityModel(input: BuildSessionActivityModelInput): SessionActivityModel {
  const sections = createEmptySections()
  let badgeCount = 0
  const includeTeamActivity = input.includeTeamActivity !== false
  const runMessages = projectMessagesToRun(input.messages ?? [], input.runScope ?? 'session')
  const runTaskRows = buildTaskRowsFromMessages(
    runMessages,
    input.tasks,
    input.taskScope ?? 'run',
    input.teamTaskWindows ?? [],
  )
  const settledRunTaskRows = input.isForegroundTurnActive === false
    ? sealUnfinishedTaskRows(runTaskRows)
    : runTaskRows
  const teamTaskRows = includeTeamActivity
    ? input.teamTasks?.map(buildTeamTaskRow) ?? []
    : []
  sections.tasks.rows = [...settledRunTaskRows, ...teamTaskRows]
  for (const row of sections.tasks.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  for (const run of input.workflowRuns ?? []) {
    sections.workflow.rows.push(...buildWorkflowRows(run))
  }
  for (const row of sections.workflow.rows) {
    if (isBadgeStatus(row.status) && !row.groupProgress) {
      badgeCount += 1
    }
  }

  if (includeTeamActivity) {
    for (const member of input.teamMembers ?? []) {
      sections.team.rows.push(buildTeamRow(member))
    }
  }

  const subagentRowsByKey = new Map<string, ActivityRow>()
  const subagentKeyByTaskId = new Map<string, string>()
  const outputRowsByKey = new Map<string, ActivityRow>()
  const dismissedBackgroundTaskKeys = input.dismissedBackgroundTaskKeys ?? new Set<string>()
  const dismissedNotificationKeys = new Set<string>()
  const dismissedNotificationTaskIds = new Set<string>()
  const visibleBackgroundTaskIds = new Set<string>()
  const hiddenChildTaskIds = new Set<string>()
  const knownTeamMemberNames = new Set(
    (input.teamMembers ?? []).flatMap((member) => [
      member.name,
      member.agentId.split('@')[0],
    ]).filter((name): name is string => Boolean(name)),
  )
  const teamLaunchRowsByMember = new Map<string, ActivityRow>()
  for (const row of buildAgentRowsFromMessages(runMessages, input.teamTaskWindows ?? [])) {
    if (row.section === 'team') {
      if (!includeTeamActivity) continue
      if (row.teamMemberName && knownTeamMemberNames.has(row.teamMemberName)) continue
      const key = row.teamName && row.teamMemberName
        ? `${row.teamName}:${row.teamMemberName}`
        : row.id
      teamLaunchRowsByMember.set(key, row)
      continue
    }
    subagentRowsByKey.set(row.id, mergeSubagentRow(subagentRowsByKey.get(row.id), row))
  }
  sections.team.rows.push(...teamLaunchRowsByMember.values())
  for (const row of sections.team.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  for (const task of input.backgroundTasks) {
    if (!isVisibleSessionBackgroundTask(task)) {
      hiddenChildTaskIds.add(task.taskId)
      continue
    }

    const dismissKey = createBackgroundTaskDismissKey(task)
    if (task.status !== 'running' && dismissedBackgroundTaskKeys.has(dismissKey)) {
      const key = activityKey(task)
      dismissedNotificationKeys.add(key)
      if (!task.toolUseId) {
        dismissedNotificationTaskIds.add(task.taskId)
      }
      continue
    }

    const key = activityKey(task)
    const sectionId: ActivitySectionId = isAgentLikeBackgroundTask(task) ? 'subagents' : 'backgroundTasks'
    const row = buildBackgroundRow(task, sectionId)
    visibleBackgroundTaskIds.add(task.taskId)

    if (sectionId === 'subagents') {
      subagentRowsByKey.set(key, mergeSubagentRow(subagentRowsByKey.get(key), row))
      subagentKeyByTaskId.set(task.taskId, key)
    } else {
      sections.backgroundTasks.rows.push(row)
    }

    if (task.outputFile) {
      outputRowsByKey.set(key, buildOutputRow(key, task.outputFile))
    }
  }

  for (const notification of input.agentNotifications) {
    if (hiddenChildTaskIds.has(notification.taskId)) continue

    const key = notificationKey(notification)
    if (
      dismissedNotificationKeys.has(key) ||
      (!visibleBackgroundTaskIds.has(notification.taskId) && dismissedNotificationTaskIds.has(notification.taskId))
    ) {
      continue
    }

    const existingKey = subagentRowsByKey.has(key) ? key : subagentKeyByTaskId.get(notification.taskId)
    if (!existingKey) {
      if (notification.outputFile) {
        outputRowsByKey.set(key, buildOutputRow(key, notification.outputFile))
      }
      continue
    }
    const mergedRow = mergeNotificationRow(
      subagentRowsByKey.get(existingKey),
      notification,
    )

    if (existingKey && existingKey !== key) {
      subagentRowsByKey.delete(existingKey)
      outputRowsByKey.delete(existingKey)
    }

    subagentRowsByKey.set(key, mergedRow)
    subagentKeyByTaskId.set(notification.taskId, key)

    if (mergedRow.outputFile) {
      outputRowsByKey.set(key, buildOutputRow(key, mergedRow.outputFile))
    }
  }

  sections.subagents.rows = Array.from(subagentRowsByKey.values())
  sections.output.rows = Array.from(outputRowsByKey.values())

  for (const row of sections.subagents.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  for (const row of sections.backgroundTasks.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  return {
    sessionId: input.sessionId,
    badgeCount,
    sections,
  }
}

/**
 * Main-session Activity is the lead agent's run projection. AgentTeam owns a
 * separate strip/workbench, so its shared DAG, roster and launch rows cannot
 * enter this model or affect the toolbar badge/auto-open state.
 */
export function buildMainSessionActivityModel(
  input: BuildMainSessionActivityModelInput,
): SessionActivityModel {
  return buildSessionActivityModel({
    ...input,
    runScope: 'session',
    taskScope: 'team-session',
    includeTeamActivity: false,
  })
}
