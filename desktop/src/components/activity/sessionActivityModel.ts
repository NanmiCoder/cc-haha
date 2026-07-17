import type { BackgroundAgentTask, AgentTaskNotification, BackgroundAgentTaskUsage } from '../../types/chat'
import type { TaskSummaryItem, UIMessage } from '../../types/chat'
import type { CLITask, TaskStatus } from '../../types/cliTask'
import type { TeamMember } from '../../types/team'
import { createBackgroundTaskDismissKey } from '../../lib/backgroundTasks'

export type ActivityStatus = TaskStatus | BackgroundAgentTask['status'] | TeamMember['status']

export type ActivitySectionId = 'output' | 'tasks' | 'team' | 'backgroundTasks' | 'subagents' | 'sources'

export type ActivityRow = {
  id: string
  section: ActivitySectionId
  label: string
  status: ActivityStatus
  description?: string
  summary?: string
  toolUseId?: string
  taskId?: string
  taskType?: BackgroundAgentTask['taskType']
  workflowName?: string
  dismissKey?: string
  outputFile?: string
  usage?: BackgroundAgentTaskUsage
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
  tasks: CLITask[]
  completedAndDismissed: boolean
  backgroundTasks: BackgroundAgentTask[]
  dismissedBackgroundTaskKeys?: Set<string>
  agentNotifications: AgentTaskNotification[]
  teamMembers?: TeamMember[]
}

export const VISIBLE_ACTIVITY_SECTION_ORDER = [
  'tasks',
  'team',
  'backgroundTasks',
  'subagents',
  'sources',
] as const satisfies readonly ActivitySectionId[]

const BADGE_STATUSES = new Set<ActivityStatus>(['pending', 'in_progress', 'running', 'failed', 'error'])

const SECTION_META: Record<ActivitySectionId, Pick<ActivitySection, 'title' | 'emptyLabel'>> = {
  output: { title: 'Output', emptyLabel: 'No output' },
  tasks: { title: 'Tasks', emptyLabel: 'No tasks' },
  team: { title: 'Team', emptyLabel: 'No team members' },
  backgroundTasks: { title: 'Background Tasks', emptyLabel: 'No background tasks' },
  subagents: { title: 'SubAgents', emptyLabel: 'No SubAgents' },
  sources: { title: 'Sources', emptyLabel: 'No sources' },
}

function createEmptySections(): Record<ActivitySectionId, ActivitySection> {
  return {
    output: createSection('output'),
    tasks: createSection('tasks'),
    team: createSection('team'),
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
}

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

function normalizeTaskStatus(status: unknown): TaskSummaryItem['status'] {
  if (status === 'completed' || status === 'in_progress' || status === 'pending') return status
  return 'pending'
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

function buildAgentRowsFromMessages(messages: UIMessage[]): ActivityRow[] {
  const resultsByToolUseId = new Map<string, Extract<UIMessage, { type: 'tool_result' }>>()
  for (const message of messages) {
    if (message.type === 'tool_result') {
      resultsByToolUseId.set(message.toolUseId, message)
    }
  }

  const rows: ActivityRow[] = []
  for (const message of messages) {
    if (message.type !== 'tool_use' || message.toolName !== 'Agent') continue

    const result = resultsByToolUseId.get(message.toolUseId)
    const resultText = result ? stripAgentMetadata(extractTextContent(result.content)) : ''
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

function buildTaskRowsFromTaskTools(messages: UIMessage[]): ActivityRow[] {
  const resultsByToolUseId = new Map<string, Extract<UIMessage, { type: 'tool_result' }>>()
  for (const message of messages) {
    if (message.type === 'tool_result') {
      resultsByToolUseId.set(message.toolUseId, message)
    }
  }

  const rowsByTaskId = new Map<string, ActivityRow>()
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
      const taskId = stringField(input, 'taskId') || stringField(input, 'id')
      if (!taskId) continue

      const existing = rowsByTaskId.get(taskId)
      const activeForm = stringField(input, 'activeForm')
      const subject = stringField(input, 'subject')
      rowsByTaskId.set(taskId, {
        ...(existing ?? {
          id: taskId,
          section: 'tasks',
          label: subject || activeForm || `Task #${taskId}`,
          taskId,
          openable: false,
        }),
        status: normalizeTaskStatus(input.status),
        ...(activeForm && activeForm !== (existing?.label ?? subject) ? { description: activeForm } : {}),
      })
    }
  }

  return Array.from(rowsByTaskId.values())
}

function buildTaskRowsFromTurnMessages(messages: UIMessage[]): ActivityRow[] {
  let latestSummary: Extract<UIMessage, { type: 'task_summary' }> | undefined
  let latestTodoWrite: Extract<UIMessage, { type: 'tool_use' }> | undefined
  let latestTaskToolTimestamp = -Infinity

  for (const message of messages) {
    if (message.type === 'task_summary') {
      latestSummary = message
    } else if (message.type === 'tool_use' && message.toolName === 'TodoWrite') {
      latestTodoWrite = message
    } else if (message.type === 'tool_use' && (message.toolName === 'TaskCreate' || message.toolName === 'TaskUpdate')) {
      latestTaskToolTimestamp = Math.max(latestTaskToolTimestamp, message.timestamp)
    }
  }

  if (latestSummary?.tasks.length) {
    return dedupeTaskRows(latestSummary.tasks.map(buildTaskSummaryRow))
  }

  const input = latestTodoWrite?.input
  if (latestTodoWrite && isRecordValue(input) && Array.isArray(input.todos) && latestTodoWrite.timestamp >= latestTaskToolTimestamp) {
    return dedupeTaskRows(input.todos.map(buildTodoTaskRow))
  }

  return buildTaskRowsFromTaskTools(messages)
}

function mergeTaskRowsById(baseRows: ActivityRow[], liveRows: ActivityRow[]): ActivityRow[] {
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
    return mergeTaskRows(row, liveRow)
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
    status: 'completed',
    taskHistory: {
      completed,
      total: rows.length,
      turnCount: groups.length,
    },
    openable: false,
  }
}

function buildTaskRowsFromMessages(messages: UIMessage[], liveTasks: CLITask[]): ActivityRow[] {
  const liveRows = liveTasks.map(buildTaskRow)
  const taskTurnRows = splitMessagesIntoTurns(messages)
    .map((turn) => ({ turn, rows: buildTaskRowsFromTurnMessages(turn.messages) }))
    .filter((group) => group.rows.length > 0)

  if (taskTurnRows.length === 0) {
    return dedupeTaskRows(liveRows)
  }

  const currentGroup = taskTurnRows[taskTurnRows.length - 1]!
  const earlierGroups = taskTurnRows.slice(0, -1)
  const currentRows = dedupeTaskRows(mergeTaskRowsById(currentGroup.rows, liveRows))
  const historicalRow = buildHistoricalTasksRow(earlierGroups)

  return historicalRow ? [...currentRows, historicalRow] : currentRows
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
  sections.tasks.rows = buildTaskRowsFromMessages(input.messages ?? [], input.tasks)
  for (const row of sections.tasks.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  for (const member of input.teamMembers ?? []) {
    sections.team.rows.push(buildTeamRow(member))
  }
  for (const row of sections.team.rows) {
    if (isBadgeStatus(row.status)) {
      badgeCount += 1
    }
  }

  const subagentRowsByKey = new Map<string, ActivityRow>()
  const subagentKeyByTaskId = new Map<string, string>()
  const outputRowsByKey = new Map<string, ActivityRow>()
  const dismissedBackgroundTaskKeys = input.dismissedBackgroundTaskKeys ?? new Set<string>()
  const dismissedNotificationKeys = new Set<string>()
  const dismissedNotificationTaskIds = new Set<string>()
  const visibleBackgroundTaskIds = new Set<string>()

  for (const row of buildAgentRowsFromMessages(input.messages ?? [])) {
    subagentRowsByKey.set(row.id, mergeSubagentRow(subagentRowsByKey.get(row.id), row))
  }

  for (const task of input.backgroundTasks) {
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
