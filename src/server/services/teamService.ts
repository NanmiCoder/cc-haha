import { readLegacyTranscriptFiles } from './legacyTranscriptBudget.js'
/**
 * TeamService — 读取 CLI 生成的 Agent Teams 配置
 *
 * Team 配置存储在 ~/.claude/teams/{name}/config.json
 * 成员 transcript 存储为 JSONL 文件:
 *   - 有 sessionId 的成员: ~/.claude/projects/{project}/{sessionId}.jsonl
 *   - in-process 成员 (无 sessionId): ~/.claude/projects/{project}/{leadSessionId}/subagents/agent-*.jsonl
 * 成员发现: config.json + inboxes/ 目录 (解决并发写入丢失成员的问题)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { readTeamTranscriptProjection } from './teamTranscriptProjection.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import {
  sessionService,
  type MessageEntry as SessionMessageEntry,
  type SessionTaskNotification,
} from './sessionService.js'
import { localIndexCoordinator } from './localIndex/coordinator.js'
import { readSessionEntriesByLocator } from './localIndex/sessionEntries.js'
import { deserializeSourceFingerprint } from './localIndex/sourceFingerprint.js'
import type { LocalIndexGateway } from './localIndex/sessionIndex.js'
import {
  getCanonicalTeamTaskListId,
  readTaskListLifecycleState,
  readTaskListSnapshot,
  withTaskListLifecycleLock,
} from '../../utils/tasks.js'
import type { TaskListLifecycleState } from '../../utils/tasks.js'
import { cleanupTeamDirectories } from '../../utils/swarm/teamHelpers.js'
import type { TaskInfo } from './taskService.js'

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Whether a teammate is mid-turn right now. This is deliberately separate from
 * `status`, which answers whether the member is still part of the run at all.
 * Owning an `in_progress` task is not evidence of either: a teammate marks a
 * task started and can then finish its turn, and an umbrella task stays open
 * across every turn underneath it.
 */
export type TeamMemberActivity = 'active' | 'idle' | 'exited' | 'unknown'

export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
  model?: string
  color?: string
  backendType?: string
  status: 'running' | 'completed' | 'idle' | 'failed'
  /**
   * Absent on workbench archives written before this was recorded, which is why
   * readers fall back to `status` rather than assuming a member went quiet.
   */
  activity?: TeamMemberActivity
  joinedAt: number
  cwd: string
  sessionId?: string
}

export type TeamSummary = {
  name: string
  description?: string
  createdAt: number
  incarnationId: string
  memberCount: number
  activeMemberCount: number
}

export type TeamDetail = TeamSummary & {
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

export type TeamWorkbenchMessage = {
  id: string
  from: string
  to: string | '*'
  recipients: string[]
  kind: 'direct' | 'broadcast' | 'system'
  text: string
  summary?: string
  timestamp: string
  color?: string
  taskId?: string
  protocolType?: string
}

export type TeamWorkbenchSnapshot = {
  version: string
  generatedAt: string
  taskListRevision?: number
  terminalTaskFrameId?: string
  team: TeamDetail
  tasks: TaskInfo[]
  messages: TeamWorkbenchMessage[]
  deletedAt?: string
}

export type TeamWorkbenchSessionTimeline = {
  sessionId: string
  teamName: string
  incarnationId: string
  snapshots: TeamWorkbenchSnapshot[]
  source: 'live' | 'archive' | 'transcript'
}

export type TeamWorkbenchSessionLookup = {
  teamName?: string
  incarnationId?: string
  at?: number
}

export type TranscriptMessage = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  timestamp: string
  model?: string
  parentToolUseId?: string
  /**
   * Structured tool output the desktop transcript needs to render a result as
   * anything richer than plain text. Dropping it here degraded every member
   * tool call to its stringified body.
   */
  toolUseResult?: unknown
}

export type TeamTranscriptPage = {
  messages: TranscriptMessage[]
  /**
   * Physical `agent-<id>.jsonl` fragments that contributed to this member.
   * Empty means the member owns a root session transcript (or has no
   * transcript), not that fragment discovery is still pending.
   */
  ownerAgentIds: string[]
  /**
   * Terminal background-task notifications from the same cursor page as
   * `messages`. Consumers must merge deltas by `toolUseId`, and replace their
   * cache when `reset` is true.
   */
  taskNotifications: SessionTaskNotification[]
  /**
   * Where this member's work on each team task begins and ends, taken from the
   * `TaskUpdate` calls it made. Lets a member's conversation be read as the
   * sequence of tasks it worked through rather than one undifferentiated log.
   */
  taskAnchors: TeamTaskAnchor[]
  signature: string
  cursor: string
  afterOrdinal: number
  reset?: boolean
}

export type TeamTaskAnchor = {
  taskId: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Id of the transcript message carrying the `TaskUpdate` call. */
  messageId: string
  timestamp: string
}

export type TeamTranscriptPageOptions = {
  signature?: string
  cursor?: string
  afterOrdinal?: number
  leadSessionId?: string
  incarnationId?: string
}

type TranscriptCursor = {
  version: 2
  size: number
  ctimeMs: number
  fileIdentity: string | null
  firstWindowHash: string
  lastWindowHash: string
  afterOrdinal: number
}

type TranscriptFragmentProjection = {
  /** One owner for a single physical fragment. */
  ownerAgentId?: string
  /** Per-entry owners for a buffer assembled from several fragments. */
  ownerAgentIdByOrdinal?: Array<string | undefined>
  /** Always the complete incarnation-bounded owner set, including on deltas. */
  ownerAgentIds?: string[]
}

const CURSOR_WINDOW_BYTES = 64 * 1024
const MESSAGE_ENTRY_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
])
const PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE = 'cc-haha-task-notification'
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/i

const TEAM_WORKBENCH_ARCHIVE_SCHEMA_VERSION = 1
const TEAM_WORKBENCH_ARCHIVE_HISTORY_LIMIT = 200

/**
 * How recently a teammate must have written to its transcript to still count as
 * mid-turn. Only consulted for members whose backend does not record `isActive`,
 * so it is a fallback rather than the primary signal. It has to clear the
 * watcher's 3s poll by a wide margin, and stay under the gap a teammate leaves
 * while waiting on a single slow tool call.
 */
const TEAM_MEMBER_ACTIVE_WINDOW_MS = 15_000

type TeamWorkbenchArchiveEntry = {
  teamName: string
  incarnationId: string
  updatedAt: string
  snapshots: TeamWorkbenchSnapshot[]
  [key: string]: unknown
}

type TeamWorkbenchArchiveDocument = {
  schemaVersion: 1
  sessionId: string
  updatedAt: string
  teams: TeamWorkbenchArchiveEntry[]
  [key: string]: unknown
}

type ProjectedTeamState = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId: string
  members: Map<string, TeamMember>
  tasks: Map<string, TaskInfo>
  messages: TeamWorkbenchMessage[]
  updatedAt: string
  deletedAt?: string
}

function memberArchiveIdentity(member: TeamMember): string {
  return member.agentId || member.name
}

/**
 * CLI team config is a live roster and removes a teammate as soon as it exits.
 * A workbench archive is a run history, so dropping that member would also
 * orphan every durable task owner and make the member transcript unreachable.
 */
function carryForwardArchivedMembers(
  snapshot: TeamWorkbenchSnapshot,
  previous: TeamWorkbenchSnapshot | undefined,
): TeamWorkbenchSnapshot {
  if (!previous) return snapshot

  const currentByIdentity = new Map(
    snapshot.team.members.map(member => [memberArchiveIdentity(member), member]),
  )
  const historicalIdentities = new Set<string>()
  const members = previous.team.members.map((historicalMember) => {
    const identity = memberArchiveIdentity(historicalMember)
    historicalIdentities.add(identity)
    const currentMember = currentByIdentity.get(identity)
    if (currentMember) {
      return {
        ...historicalMember,
        ...currentMember,
        ...(currentMember.model === undefined && historicalMember.model !== undefined
          ? { model: historicalMember.model }
          : {}),
      }
    }
    return {
      ...historicalMember,
      status: historicalMember.status === 'failed'
        ? 'failed' as const
        : 'completed' as const,
      activity: 'exited' as const,
    }
  })
  for (const member of snapshot.team.members) {
    if (!historicalIdentities.has(memberArchiveIdentity(member))) members.push(member)
  }

  const team = {
    ...snapshot.team,
    memberCount: members.length,
    activeMemberCount: members.filter(member => member.status === 'running').length,
    members,
  }
  if (JSON.stringify(team) === JSON.stringify(snapshot.team)) return snapshot

  return {
    ...snapshot,
    version: hash(JSON.stringify({
      team,
      tasks: snapshot.tasks,
      messages: snapshot.messages,
      deletedAt: snapshot.deletedAt,
    })),
    team,
  }
}

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function physicalAgentIdFromTranscriptPath(filePath: string): string | undefined {
  return path.basename(filePath).match(/^agent-(.+)\.jsonl$/)?.[1]
}

/**
 * A CLI Team directory is a mutable name, not an identity. The same name can
 * be deleted and recreated (including under the same lead session), so every
 * durable join uses the creation tuple instead of the directory name alone.
 */
export function teamIncarnationId(
  team: Pick<TeamSummary, 'name' | 'createdAt'> & { leadSessionId?: string },
): string {
  return hash(JSON.stringify([
    team.name,
    team.leadSessionId ?? '',
    Number.isFinite(team.createdAt) ? team.createdAt : 0,
  ]))
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
}

function transcriptText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      const record = objectValue(block)
      return record && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXmlText(match[1].trim()) : undefined
}

function terminalTaskStatus(
  value: unknown,
): SessionTaskNotification['status'] | null {
  if (value === 'completed' || value === 'failed' || value === 'stopped') return value
  return value === 'killed' ? 'stopped' : null
}

function fragmentScopedId(ownerAgentId: string, value: string): string {
  return value.startsWith(`${ownerAgentId}/`)
    ? value
    : `${ownerAgentId}/${value}`
}

/**
 * Content identity of each parseable entry, positionally aligned with the
 * ordinals `parseTranscriptBufferPage` assigns. Unparseable lines are skipped on
 * both sides, so a rewritten snapshot stays comparable to the shorter one it
 * supersedes.
 *
 * A rewrite restamps the entry with the session and turn it was written into,
 * so these fields say where the record lives rather than what the teammate did.
 * They are the only fields observed to change across a rewritten chain, measured
 * over two real runs. Everything else
 * — `uuid`, `timestamp`, `message`, tool results — stays part of the identity,
 * so an unrecognised new field makes two entries look different and the pair is
 * simply not folded. Under-folding shows duplicates; over-folding would drop a
 * teammate's work, so the list stays a deny list rather than an allow list.
 */
const REWRITTEN_ENTRY_ENVELOPE_FIELDS = ['agentId', 'slug', 'cwd', 'promptId'] as const

function transcriptEntryIdentities(bytes: Buffer): string[] {
  const identities: string[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      for (const field of REWRITTEN_ENTRY_ENVELOPE_FIELDS) delete entry[field]
      identities.push(hash(JSON.stringify(entry, Object.keys(entry).sort())))
    } catch {
      // Keep this aligned with parseTranscriptBufferPage's ordinal rules.
    }
  }
  return identities
}

function isStrictPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length >= longer.length) return false
  return shorter.every((identity, index) => identity === longer[index])
}

/**
 * A teammate's `agent-<id>.jsonl` files are cumulative snapshots: each turn
 * rewrites the whole transcript into a new physical fragment, so one run leaves
 * a chain where every fragment repeats all of its predecessor's entries. Naive
 * concatenation replayed that history once per fragment (a ten-turn teammate
 * rendered its work ~8x over) because `fragmentScopedId` gives the same `uuid` a
 * different id in every fragment, which defeats id-based deduplication
 * downstream.
 *
 * Only a *strict* prefix of matching entry content is treated as superseded.
 * Independent resumes may reuse uuids while doing different work, so identity
 * has to come from the entries themselves; those fragments are all preserved
 * and keep their own scope.
 */
function dropSupersededTranscriptFragments<T extends { bytes: Buffer }>(
  fragments: T[],
): T[] {
  if (fragments.length < 2) return fragments
  const identities = fragments.map(fragment => transcriptEntryIdentities(fragment.bytes))
  return fragments.filter((_, index) => !identities.some((candidate, other) => (
    other !== index && isStrictPrefix(identities[index]!, candidate)
  )))
}

function projectFragmentContent(content: unknown, ownerAgentId: string): unknown {
  if (Array.isArray(content)) {
    return content.map(value => projectFragmentContent(value, ownerAgentId))
  }
  const block = objectValue(content)
  if (!block) return content
  if (block.type === 'tool_use' && typeof block.id === 'string') {
    return {
      ...block,
      id: fragmentScopedId(ownerAgentId, block.id),
      original_tool_use_id: stringValue(block.original_tool_use_id) ?? block.id,
    }
  }
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
    return {
      ...block,
      tool_use_id: fragmentScopedId(ownerAgentId, block.tool_use_id),
      original_tool_use_id:
        stringValue(block.original_tool_use_id) ?? block.tool_use_id,
      ...('content' in block
        ? { content: projectFragmentContent(block.content, ownerAgentId) }
        : {}),
    }
  }
  if ('content' in block) {
    const projectedContent = projectFragmentContent(block.content, ownerAgentId)
    if (projectedContent !== block.content) {
      return { ...block, content: projectedContent }
    }
  }
  return content
}

function projectFragmentToolUseResult(
  value: unknown,
  ownerAgentId: string,
): unknown {
  const result = objectValue(value)
  if (!result) return value
  const backgroundTaskId = stringValue(result.backgroundTaskId)
  const snakeBackgroundTaskId = stringValue(result.background_task_id)
  if (!backgroundTaskId && !snakeBackgroundTaskId) return value
  return {
    ...result,
    ...(backgroundTaskId
      ? { backgroundTaskId: fragmentScopedId(ownerAgentId, backgroundTaskId) }
      : {}),
    ...(snakeBackgroundTaskId
      ? { background_task_id: fragmentScopedId(ownerAgentId, snakeBackgroundTaskId) }
      : {}),
  }
}

function projectFragmentTaskNotification(
  notification: SessionTaskNotification,
  ownerAgentId: string | undefined,
): SessionTaskNotification {
  if (!ownerAgentId) return notification
  return {
    ...notification,
    taskId: fragmentScopedId(ownerAgentId, notification.taskId),
    toolUseId: fragmentScopedId(ownerAgentId, notification.toolUseId),
  }
}

/**
 * The `TaskUpdate` calls a teammate makes are the only durable record of when
 * it started and finished a given task, and they sit in the transcript it is
 * already streaming.
 */
function taskAnchorsFromMessage(message: TranscriptMessage): TeamTaskAnchor[] {
  if (!Array.isArray(message.content)) return []
  const anchors: TeamTaskAnchor[] = []
  for (const block of message.content) {
    const tool = objectValue(block)
    if (tool?.type !== 'tool_use' || stringValue(tool.name) !== 'TaskUpdate') continue
    const input = objectValue(tool.input)
    const taskId = stringValue(input?.taskId)
    const status = taskStatus(input?.status)
    if (!taskId || !status) continue
    anchors.push({ taskId, status, messageId: message.id, timestamp: message.timestamp })
  }
  return anchors
}

function taskNotificationFromEntry(
  entry: Record<string, unknown>,
  ownerAgentId?: string,
): SessionTaskNotification | null {
  const timestamp = stringValue(entry.timestamp)
  if (entry.type === PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE) {
    const notification = objectValue(entry.taskNotification)
    if (!notification) return null
    const toolUseId = stringValue(notification.toolUseId)
    const status = terminalTaskStatus(notification.status)
    if (!toolUseId || !status) return null
    const taskId = stringValue(notification.taskId) ?? toolUseId
    const summary = stringValue(notification.summary)
    const result = stringValue(notification.result)
    const outputFile = stringValue(notification.outputFile)
    const notificationTimestamp = stringValue(notification.timestamp) ?? timestamp
    return projectFragmentTaskNotification({
      taskId,
      toolUseId,
      status,
      ...(summary ? { summary } : {}),
      ...(result ? { result } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(notificationTimestamp ? { timestamp: notificationTimestamp } : {}),
    }, ownerAgentId)
  }

  const message = objectValue(entry.message)
  if (entry.type !== 'user' || message?.role !== 'user') return null
  const xml = transcriptText(message.content).match(TASK_NOTIFICATION_BLOCK_RE)?.[0]
  if (!xml) return null
  const toolUseId = readXmlTag(xml, 'tool-use-id')
  const status = terminalTaskStatus(readXmlTag(xml, 'status'))
  if (!toolUseId || !status) return null
  const taskId = readXmlTag(xml, 'task-id') ?? toolUseId
  const summary = readXmlTag(xml, 'summary')
  const result = readXmlTag(xml, 'result')
  const outputFile = readXmlTag(xml, 'output-file')
  return projectFragmentTaskNotification({
    taskId,
    toolUseId,
    status,
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
    ...(outputFile ? { outputFile } : {}),
    ...(timestamp ? { timestamp } : {}),
  }, ownerAgentId)
}

function timestampOrNow(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return value
  return new Date().toISOString()
}

function addUnique(values: string[], additions: string[]): string[] {
  return [...new Set([...values, ...additions])]
}

function taskStatus(value: unknown): TaskInfo['status'] | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : undefined
}

type ProjectedToolResult = {
  value: Record<string, unknown>
  isError: boolean
  timestamp?: string
}

function resultRecordsByToolUseId(
  messages: SessionMessageEntry[],
): Map<string, ProjectedToolResult> {
  const results = new Map<string, ProjectedToolResult>()
  for (const message of messages) {
    if (message.type !== 'tool_result') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      const record = objectValue(block)
      const toolUseId = stringValue(record?.tool_use_id)
      if (!toolUseId) continue
      const structured = objectValue(message.toolUseResult)
      const previous = results.get(toolUseId)
      results.set(toolUseId, {
        value: structured ?? record!,
        isError: previous?.isError === true || record?.is_error === true,
        timestamp: message.timestamp || previous?.timestamp,
      })
    }
  }
  return results
}

function ensureProjectedTask(
  team: ProjectedTeamState,
  id: string,
): TaskInfo {
  const existing = team.tasks.get(id)
  if (existing) return existing
  const task: TaskInfo = {
    id,
    subject: `Task #${id}`,
    description: '',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    taskListId: team.name,
  }
  team.tasks.set(id, task)
  return task
}

function applyProjectedTaskUpdate(task: TaskInfo, input: Record<string, unknown>): void {
  const subject = stringValue(input.subject)
  const description = stringValue(input.description)
  const activeForm = stringValue(input.activeForm)
  const owner = stringValue(input.owner)
  const status = taskStatus(input.status)
  if (subject) task.subject = subject
  if (description !== undefined) task.description = description
  if (activeForm !== undefined) task.activeForm = activeForm
  if (owner !== undefined) task.owner = owner
  if (status) task.status = status
  task.blocks = addUnique(task.blocks, stringArray(input.addBlocks))
  task.blockedBy = addUnique(task.blockedBy, stringArray(input.addBlockedBy))
  const metadata = objectValue(input.metadata)
  if (metadata) task.metadata = { ...(task.metadata ?? {}), ...metadata }
}

function replaceProjectedTaskList(
  tasks: Map<string, TaskInfo>,
  rawTasks: unknown[],
  taskListId: string,
  edgeShape: 'complete' | 'blockedBy-only' = 'complete',
): void {
  const listedTaskRecords = rawTasks
    .map(rawTask => objectValue(rawTask))
    .filter((record): record is Record<string, unknown> => (
      record !== null && stringValue(record.id) !== undefined
    ))
  // TaskList historically serializes only blockedBy. Treat that shape as a
  // complete edge projection when every task carries the field: clear the
  // stale forward edges first, then finalizeProjectedTaskEdges rebuilds them
  // from the authoritative reverse edges. Older partial results that omitted
  // blockedBy entirely retain their best-effort compatibility behavior.
  const rebuildEdgesFromBlockedBy = edgeShape === 'blockedBy-only' &&
    listedTaskRecords.every(record => Array.isArray(record.blockedBy))
  const listedIds = new Set<string>()
  for (const record of listedTaskRecords) {
    const id = stringValue(record?.id)
    if (!id) continue
    listedIds.add(id)
    const task = tasks.get(id) ?? {
      id,
      subject: `Task #${id}`,
      description: '',
      status: 'pending' as const,
      blocks: [],
      blockedBy: [],
      taskListId,
    }
    const status = taskStatus(record.status)
    const subject = stringValue(record.subject)
    const description = typeof record.description === 'string'
      ? record.description
      : undefined
    const activeForm = stringValue(record.activeForm)
    const owner = stringValue(record.owner)
    if (status) task.status = status
    if (subject) task.subject = subject
    if (description !== undefined) task.description = description
    if (activeForm !== undefined) task.activeForm = activeForm
    // TaskList and TeamDelete terminal frames are authoritative full-list
    // reads. An omitted owner must clear a stale archived assignment.
    task.owner = owner
    if (rebuildEdgesFromBlockedBy) {
      task.blocks = []
      task.blockedBy = stringArray(record.blockedBy)
    } else {
      if (Array.isArray(record.blocks)) task.blocks = stringArray(record.blocks)
      if (Array.isArray(record.blockedBy)) task.blockedBy = stringArray(record.blockedBy)
    }
    const metadata = objectValue(record.metadata)
    if (metadata) task.metadata = metadata
    tasks.set(id, task)
  }
  for (const id of tasks.keys()) {
    if (!listedIds.has(id)) tasks.delete(id)
  }
}

function finalizeProjectedTaskEdges(tasks: Map<string, TaskInfo>): void {
  for (const task of tasks.values()) {
    for (const blockedId of task.blocks) {
      const blocked = tasks.get(blockedId)
      if (blocked) blocked.blockedBy = addUnique(blocked.blockedBy, [task.id])
    }
    for (const blockerId of task.blockedBy) {
      const blocker = tasks.get(blockerId)
      if (blocker) blocker.blocks = addUnique(blocker.blocks, [task.id])
    }
  }
}

const TEAM_CREATE_TRANSCRIPT_CLOCK_SKEW_MS = 5_000

type OrderedSessionMessage = {
  message: SessionMessageEntry
  index: number
}

type TranscriptTeamCreation = {
  position: number
  teamName: string
  startedAt: number
  completedAt: number
}

function orderedSessionMessages(
  messages: SessionMessageEntry[],
): OrderedSessionMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => (
      Date.parse(left.message.timestamp) - Date.parse(right.message.timestamp) ||
      left.index - right.index
    ))
}

function successfulToolResult(
  result: ProjectedToolResult | undefined,
): boolean {
  return Boolean(
    result &&
    !result.isError &&
    result.value.success !== false,
  )
}

function transcriptTeamCreations(
  ordered: OrderedSessionMessage[],
  results: ReturnType<typeof resultRecordsByToolUseId>,
): TranscriptTeamCreation[] {
  const creations: TranscriptTeamCreation[] = []
  for (let position = 0; position < ordered.length; position++) {
    const message = ordered[position]?.message
    if (message?.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const tool = objectValue(block)
      if (tool?.type !== 'tool_use' || stringValue(tool.name) !== 'TeamCreate') continue
      const toolUseId = stringValue(tool.id)
      if (!toolUseId) continue
      const result = results.get(toolUseId)
      if (!result || !successfulToolResult(result)) continue
      const input = objectValue(tool.input) ?? {}
      // TeamCreate may uniquify a requested name. The successful result owns
      // the durable identity used by the config, task list, and archive.
      const teamName = stringValue(result.value.team_name) ?? stringValue(input.team_name)
      const startedAt = Date.parse(message.timestamp)
      const completedAt = result.timestamp ? Date.parse(result.timestamp) : startedAt
      if (!teamName || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)) continue
      creations.push({ position, teamName, startedAt, completedAt })
    }
  }
  return creations
}

function transcriptCreationDistance(
  creation: TranscriptTeamCreation,
  createdAt: number,
): number {
  const lower = Math.min(creation.startedAt, creation.completedAt)
  const upper = Math.max(creation.startedAt, creation.completedAt)
  if (createdAt < lower) return lower - createdAt
  if (createdAt > upper) return createdAt - upper
  return 0
}

function transcriptTeamLifecycleEnd(
  creation: TranscriptTeamCreation,
  ordered: OrderedSessionMessage[],
  results: ReturnType<typeof resultRecordsByToolUseId>,
  creations: TranscriptTeamCreation[],
): number {
  const nextCreationPosition = creations.find(candidate => (
    candidate.position > creation.position
  ))?.position ?? ordered.length
  for (let position = creation.position + 1; position < nextCreationPosition; position++) {
    const message = ordered[position]?.message
    if (message?.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const tool = objectValue(block)
      if (tool?.type !== 'tool_use' || stringValue(tool.name) !== 'TeamDelete') continue
      const toolUseId = stringValue(tool.id)
      if (!toolUseId) continue
      const result = results.get(toolUseId)
      const input = objectValue(tool.input)
      const deletedTeamName = stringValue(input?.team_name) ?? stringValue(result?.value.team_name)
      if (
        successfulToolResult(result) &&
        (!deletedTeamName || deletedTeamName === creation.teamName)
      ) return position + 1
    }
  }
  return nextCreationPosition
}

function cloneTask(task: TaskInfo): TaskInfo {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

/**
 * Replays only successful task mutations that completed after the last disk
 * snapshot and before the next Team incarnation. TeamDelete can remove the
 * task directory before TeamWatcher observes its final contents, while the
 * lead transcript still has the durable TaskUpdate/TaskList results.
 */
type ReconciledArchivedTasks = {
  tasks: TaskInfo[]
  taskListRevision?: number
  terminalTaskFrameId?: string
}

function terminalLifecycleTasks(
  snapshot: TeamWorkbenchSnapshot,
  lifecycle: TaskListLifecycleState | undefined,
): ReconciledArchivedTasks | null {
  if (!lifecycle) return null
  const terminal = [...lifecycle.terminals].reverse().find(receipt => (
    receipt.identity.teamName === snapshot.team.name &&
    receipt.identity.createdAt === snapshot.team.createdAt &&
    receipt.identity.leadSessionId === snapshot.team.leadSessionId
  ))
  if (!terminal) return null
  return {
    tasks: terminal.tasks
      .filter(task => !task.metadata?._internal)
      .map(task => ({
        ...task,
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
        taskListId: snapshot.team.name,
        ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
      }))
      .sort((left, right) => {
        const leftNumber = Number.parseInt(left.id, 10)
        const rightNumber = Number.parseInt(right.id, 10)
        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
          return leftNumber - rightNumber
        }
        return left.id.localeCompare(right.id)
      }),
    taskListRevision: terminal.revision,
    terminalTaskFrameId: terminal.frameId,
  }
}

function preferTerminalTaskFrame(
  transcript: ReconciledArchivedTasks | null,
  lifecycle: ReconciledArchivedTasks | null,
): ReconciledArchivedTasks | null {
  if (!lifecycle) return transcript
  if (!transcript) return lifecycle
  if (
    transcript.taskListRevision !== undefined &&
    lifecycle.taskListRevision !== undefined &&
    transcript.taskListRevision > lifecycle.taskListRevision
  ) return transcript
  return {
    ...lifecycle,
    terminalTaskFrameId: transcript.terminalTaskFrameId ??
      lifecycle.terminalTaskFrameId,
  }
}

function reconcileArchivedTasksFromTranscript(
  snapshot: TeamWorkbenchSnapshot,
  messages: SessionMessageEntry[],
): ReconciledArchivedTasks | null {
  const snapshotGeneratedAt = Date.parse(snapshot.generatedAt)
  const snapshotRevision = Number.isSafeInteger(snapshot.taskListRevision) &&
    (snapshot.taskListRevision ?? -1) >= 0
    ? snapshot.taskListRevision
    : undefined
  const teamCreatedAt = snapshot.team.createdAt
  if (!Number.isFinite(snapshotGeneratedAt) || !Number.isFinite(teamCreatedAt)) return null

  const results = resultRecordsByToolUseId(messages)
  const ordered = orderedSessionMessages(messages)
  const creations = transcriptTeamCreations(ordered, results)
  const creation = creations
    .filter(candidate => candidate.teamName === snapshot.team.name)
    .map(candidate => ({
      candidate,
      distance: transcriptCreationDistance(candidate, teamCreatedAt),
    }))
    .filter(candidate => candidate.distance <= TEAM_CREATE_TRANSCRIPT_CLOCK_SKEW_MS)
    .sort((left, right) => (
      left.distance - right.distance ||
      Math.abs(left.candidate.startedAt - teamCreatedAt) -
        Math.abs(right.candidate.startedAt - teamCreatedAt)
    ))[0]?.candidate
  if (!creation) return null

  const endPosition = transcriptTeamLifecycleEnd(creation, ordered, results, creations)
  const tasks = new Map(snapshot.tasks.map(task => [task.id, cloneTask(task)]))
  let changed = false

  type ReplayEvent = {
    name: string
    toolUseId: string
    input: Record<string, unknown>
    result: ProjectedToolResult
    replayAt: number
    revision?: number
    order: number
  }
  const replayEvents: ReplayEvent[] = []

  for (let position = creation.position; position < endPosition; position++) {
    const message = ordered[position]?.message
    if (message?.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]
      const tool = objectValue(block)
      if (tool?.type !== 'tool_use') continue
      const toolUseId = stringValue(tool.id)
      const name = stringValue(tool.name)
      const input = objectValue(tool.input) ?? {}
      if (!toolUseId || !name) continue
      const result = results.get(toolUseId)
      if (!result || !successfulToolResult(result)) continue
      const startedAt = Date.parse(message.timestamp)
      const completedAt = result.timestamp ? Date.parse(result.timestamp) : Number.NaN
      const causalMarker = name === 'TaskList' || name === 'TeamDelete'
        ? stringValue(result.value.taskListSnapshotAt)
        : stringValue(result.value.taskListMutationAt)
      const rawRevision = name === 'TaskList' || name === 'TeamDelete'
        ? result.value.taskListSnapshotRevision
        : result.value.taskListMutationRevision
      const revision = typeof rawRevision === 'number' &&
        Number.isSafeInteger(rawRevision) && rawRevision >= 0
        ? rawRevision
        : undefined
      const causalAt = causalMarker ? Date.parse(causalMarker) : Number.NaN
      const hasCausalMarker = Number.isFinite(causalAt)
      // New tool results carry the task-list lock timestamp. Legacy results
      // lack it, so only replay operations whose invocation and completion are
      // both strictly after the locked disk snapshot; a cross-boundary result
      // is ambiguous and must not overwrite the known snapshot.
      if (snapshotRevision !== undefined && revision !== undefined) {
        if (
          revision < snapshotRevision ||
          (revision === snapshotRevision && name !== 'TeamDelete')
        ) continue
      } else if (hasCausalMarker) {
        if (causalAt <= snapshotGeneratedAt) continue
      } else if (
        !Number.isFinite(startedAt) ||
        !Number.isFinite(completedAt) ||
        startedAt <= snapshotGeneratedAt ||
        completedAt <= snapshotGeneratedAt
      ) continue
      replayEvents.push({
        name,
        toolUseId,
        input,
        result,
        replayAt: hasCausalMarker ? causalAt : completedAt,
        revision,
        order: position * 1_000 + blockIndex,
      })
    }
  }

  const allEventsHaveRevision = replayEvents.every(
    event => event.revision !== undefined,
  )
  replayEvents.sort((left, right) => {
    if (allEventsHaveRevision) {
      return left.revision! - right.revision! || left.order - right.order
    }
    return left.replayAt - right.replayAt || left.order - right.order
  })

  let appliedRevision = snapshotRevision
  let terminalTaskFrameId: string | undefined
  for (const { name, toolUseId, input, result, revision } of replayEvents) {
    if (revision !== undefined) {
      appliedRevision = Math.max(appliedRevision ?? revision, revision)
    }
    if (name === 'TaskCreate') {
      const resultTask = objectValue(result.value.task)
      const id = stringValue(resultTask?.id)
      if (!id) continue
      const task = tasks.get(id) ?? {
        id,
        subject: `Task #${id}`,
        description: '',
        status: 'pending' as const,
        blocks: [],
        blockedBy: [],
        taskListId: snapshot.team.name,
      }
      applyProjectedTaskUpdate(task, input)
      task.subject = stringValue(resultTask?.subject) ?? task.subject
      const resultDescription = stringValue(resultTask?.description)
      if (resultDescription !== undefined) task.description = resultDescription
      tasks.set(id, task)
      changed = true
      continue
    }

    if (name === 'TaskUpdate') {
      const id = stringValue(input.taskId)
      if (!id) continue
      if (input.status === 'deleted') {
        changed = tasks.delete(id) || changed
        continue
      }
      const task = tasks.get(id) ?? {
        id,
        subject: `Task #${id}`,
        description: '',
        status: 'pending' as const,
        blocks: [],
        blockedBy: [],
        taskListId: snapshot.team.name,
      }
      applyProjectedTaskUpdate(task, input)
      tasks.set(id, task)
      changed = true
      continue
    }

    const authoritativeTasks = name === 'TaskList'
      ? result.value.tasks
      : name === 'TeamDelete'
        ? result.value.finalTasks
        : undefined
    if (Array.isArray(authoritativeTasks)) {
      replaceProjectedTaskList(
        tasks,
        authoritativeTasks,
        snapshot.team.name,
        name === 'TaskList' ? 'blockedBy-only' : 'complete',
      )
      if (name === 'TeamDelete') terminalTaskFrameId = toolUseId
      changed = true
    }
  }

  if (!changed) return null
  finalizeProjectedTaskEdges(tasks)
  return {
    tasks: [...tasks.values()].sort((left, right) => {
      const leftNumber = Number.parseInt(left.id, 10)
      const rightNumber = Number.parseInt(right.id, 10)
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber
      }
      return left.id.localeCompare(right.id)
    }),
    ...(appliedRevision !== undefined
      ? { taskListRevision: appliedRevision }
      : {}),
    ...(terminalTaskFrameId ? { terminalTaskFrameId } : {}),
  }
}

/**
 * Rebuilds a read-only final workbench from durable transcript identities.
 * This is the migration path for Team runs created before workbench archives
 * existed; new runs are archived directly from their live snapshot instead.
 */
export function projectTeamWorkbenchesFromTranscript(
  sessionId: string,
  messages: SessionMessageEntry[],
): TeamWorkbenchSnapshot[] {
  const results = resultRecordsByToolUseId(messages)
  const ordered = messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => (
      Date.parse(left.message.timestamp) - Date.parse(right.message.timestamp) ||
      left.index - right.index
    ))
  // A lead session may delete and recreate the same Team name. Keep each
  // creation as its own ordered incarnation instead of keying history by the
  // mutable display name.
  const teams: ProjectedTeamState[] = []
  let currentTeam: ProjectedTeamState | null = null

  for (const { message } of ordered) {
    const timestamp = timestampOrNow(message.timestamp)
    if (message.type === 'user' && currentTeam) {
      const team = currentTeam
      const text = transcriptText(message.content)
      const teammatePattern = /<teammate-message\s+teammate_id="([^"]+)"(?:\s+color="([^"]+)")?[^>]*>([\s\S]*?)<\/teammate-message>/g
      for (const match of text.matchAll(teammatePattern)) {
        const body = match[3]?.trim()
        if (!body) continue
        team.messages.push({
          id: `${message.id}:teammate:${team.messages.length}`,
          from: match[1]!,
          to: 'team-lead',
          recipients: ['team-lead'],
          kind: 'direct',
          text: body,
          timestamp,
          ...(match[2] ? { color: match[2] } : {}),
        })
        team.updatedAt = timestamp
      }
    }

    if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const tool = objectValue(block)
      if (tool?.type !== 'tool_use') continue
      const toolUseId = stringValue(tool.id)
      const name = stringValue(tool.name)
      const input = objectValue(tool.input) ?? {}
      if (!toolUseId || !name) continue
      const toolResult = results.get(toolUseId)
      const result = toolResult?.value ?? {}

      if (name === 'TeamCreate') {
        if (toolResult && !successfulToolResult(toolResult)) continue
        const teamName = stringValue(result.team_name) ?? stringValue(input.team_name)
        if (!teamName) continue
        const leadAgentId = stringValue(result.lead_agent_id) ?? `team-lead@${teamName}`
        const team: ProjectedTeamState = {
          name: teamName,
          description: stringValue(input.description),
          createdAt: Date.parse(timestamp),
          leadAgentId,
          leadSessionId: sessionId,
          members: new Map(),
          tasks: new Map(),
          messages: [],
          updatedAt: timestamp,
        }
        team.members.set(leadAgentId, {
          agentId: leadAgentId,
          name: 'team-lead',
          agentType: stringValue(input.agent_type) ?? 'team-lead',
          status: 'completed',
          activity: 'exited',
          joinedAt: team.createdAt,
          cwd: stringValue(message.cwd) ?? '',
          sessionId,
        })
        teams.push(team)
        currentTeam = team
        continue
      }

      const explicitTeamName = stringValue(input.team_name)
      const team = currentTeam && (!explicitTeamName || currentTeam.name === explicitTeamName)
        ? currentTeam
        : [...teams].reverse().find(candidate => candidate.name === explicitTeamName)
      if (!team) continue
      const teamName = team.name
      team.updatedAt = timestamp
      // Old transcripts may omit tool results, so keep best-effort replay for
      // that shape. An explicit non-error failure (`success: false`) is still
      // authoritative and must never mutate the reconstructed Team.
      if (toolResult && !successfulToolResult(toolResult)) continue

      if (name === 'TeamDelete') {
        if (Array.isArray(result.finalTasks)) {
          replaceProjectedTaskList(team.tasks, result.finalTasks, teamName)
        }
        team.deletedAt = timestamp
        if (currentTeam === team) currentTeam = null
        continue
      }

      if (name === 'Agent') {
        const memberName = stringValue(input.name)
        if (!memberName) continue
        const agentId = stringValue(result.agent_id) ??
          stringValue(result.teammate_id) ??
          `${memberName}@${teamName}`
        team.members.set(agentId, {
          agentId,
          name: memberName,
          agentType: stringValue(result.agent_type) ?? stringValue(input.subagent_type),
          model: stringValue(result.model),
          color: stringValue(result.color),
          backendType: stringValue(result.tmux_session_name) === 'in-process'
            ? 'in-process'
            : undefined,
          status: 'completed',
          activity: 'exited',
          joinedAt: Date.parse(timestamp),
          cwd: stringValue(message.cwd) ?? '',
        })
        continue
      }

      if (name === 'TaskCreate') {
        const resultTask = objectValue(result.task)
        const id = stringValue(resultTask?.id)
        if (!id) continue
        const task = ensureProjectedTask(team, id)
        applyProjectedTaskUpdate(task, input)
        task.subject = stringValue(resultTask?.subject) ?? task.subject
        continue
      }

      if (name === 'TaskUpdate') {
        const id = stringValue(input.taskId)
        if (!id) continue
        if (input.status === 'deleted') {
          team.tasks.delete(id)
          continue
        }
        applyProjectedTaskUpdate(ensureProjectedTask(team, id), input)
        continue
      }

      if (name === 'TaskList') {
        if (!Array.isArray(result.tasks)) continue
        replaceProjectedTaskList(team.tasks, result.tasks, teamName, 'blockedBy-only')
        continue
      }

      if (name === 'SendMessage') {
        const text = stringValue(input.message) ?? stringValue(input.content)
        if (!text) continue
        const target = stringValue(input.to) ?? stringValue(input.recipient) ?? 'team-lead'
        const broadcast = target === '*' || input.type === 'broadcast'
        const recipients = broadcast
          ? [...team.members.values()].map((member) => member.name ?? member.agentId)
              .filter((memberName) => memberName !== 'team-lead')
          : [target]
        team.messages.push({
          id: toolUseId,
          from: 'team-lead',
          to: broadcast ? '*' : target,
          recipients,
          kind: broadcast ? 'broadcast' : 'direct',
          text,
          summary: stringValue(input.summary),
          timestamp,
        })
      }
    }
  }

  return teams.map((team) => {
    finalizeProjectedTaskEdges(team.tasks)
    const members = [...team.members.values()]
    const tasks = [...team.tasks.values()].sort((left, right) => {
      const leftNumber = Number.parseInt(left.id, 10)
      const rightNumber = Number.parseInt(right.id, 10)
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
      return left.id.localeCompare(right.id)
    })
    const generatedAt = team.updatedAt
    const detail: TeamDetail = {
      name: team.name,
      description: team.description,
      createdAt: team.createdAt,
      incarnationId: teamIncarnationId(team),
      memberCount: members.length,
      activeMemberCount: 0,
      leadAgentId: team.leadAgentId,
      leadSessionId: team.leadSessionId,
      members,
    }
    const canonical = JSON.stringify({ team: detail, tasks, messages: team.messages })
    return {
      version: `transcript:${hash(canonical)}`,
      generatedAt,
      deletedAt: team.deletedAt ?? generatedAt,
      team: detail,
      tasks,
      messages: team.messages.sort((left, right) => (
        left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id)
      )),
    }
  })
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeTranscriptCursor(value: string | undefined): TranscriptCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TranscriptCursor
    if (
      parsed.version === 2 &&
      Number.isSafeInteger(parsed.size) && parsed.size >= 0 &&
      Number.isFinite(parsed.ctimeMs) && parsed.ctimeMs >= 0 &&
      Number.isSafeInteger(parsed.afterOrdinal) && parsed.afterOrdinal >= -1 &&
      (parsed.fileIdentity === null || typeof parsed.fileIdentity === 'string') &&
      typeof parsed.firstWindowHash === 'string' &&
      typeof parsed.lastWindowHash === 'string'
    ) return parsed
  } catch {
    // Treat malformed client cursors as a reset request.
  }
  return null
}

function cursorForBuffer(
  bytes: Buffer,
  fileIdentity: string | null,
  ctimeMs: number,
  afterOrdinal: number,
): TranscriptCursor {
  return {
    version: 2,
    size: bytes.length,
    ctimeMs,
    fileIdentity,
    firstWindowHash: hash(bytes.subarray(0, Math.min(bytes.length, CURSOR_WINDOW_BYTES))),
    lastWindowHash: hash(bytes.subarray(Math.max(0, bytes.length - CURSOR_WINDOW_BYTES))),
    afterOrdinal,
  }
}

function bufferPreservesCursorPrefix(
  bytes: Buffer,
  cursor: TranscriptCursor,
  fileIdentity: string | null,
): boolean {
  if (bytes.length <= cursor.size) return false
  if (
    cursor.fileIdentity !== null &&
    fileIdentity !== null &&
    cursor.fileIdentity !== fileIdentity
  ) return false
  const firstEnd = Math.min(cursor.size, CURSOR_WINDOW_BYTES)
  const lastStart = Math.max(0, cursor.size - CURSOR_WINDOW_BYTES)
  return hash(bytes.subarray(0, firstEnd)) === cursor.firstWindowHash &&
    hash(bytes.subarray(lastStart, cursor.size)) === cursor.lastWindowHash
}

function sameTranscriptFileSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

/** Raw config.json structure written by CLI */
type TeamFileRaw = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    backendType?: string
    isActive?: boolean
    mode?: string
  }>
}

// ─── Service ───────────────────────────────────────────────────────────────

export class TeamService {
  private readonly sessionLocator: Pick<typeof sessionService, 'findSessionFile'>
  private readonly sessionReader: Pick<typeof sessionService, 'getSessionMessages'> | undefined
  private readonly localIndexGateway: LocalIndexGateway
  private readonly targetedEntryReader: typeof readSessionEntriesByLocator
  private readonly archiveWriteLocks = new Map<string, Promise<unknown>>()

  constructor(options: {
    sessionLocator?: Pick<typeof sessionService, 'findSessionFile'>
    sessionReader?: Pick<typeof sessionService, 'getSessionMessages'>
    localIndexGateway?: LocalIndexGateway
    targetedEntryReader?: typeof readSessionEntriesByLocator
  } = {}) {
    this.sessionLocator = options.sessionLocator ?? sessionService
    this.sessionReader = options.sessionReader
    this.localIndexGateway = options.localIndexGateway ?? localIndexCoordinator
    this.targetedEntryReader = options.targetedEntryReader ?? readSessionEntriesByLocator
  }

  private async readTeamHistory(sessionId: string): Promise<SessionMessageEntry[]> {
    // Injected fixture readers keep the migration/replay seam. Production never
    // routes periodic workbench polling through the canonical full transcript.
    if (this.sessionReader) return this.sessionReader.getSessionMessages(sessionId)
    const found = await this.sessionLocator.findSessionFile(sessionId)
    if (!found) return []
    const projection = await readTeamTranscriptProjection(found.filePath).catch(() => {
      throw new ApiError(503, 'Team history is changing; retry shortly', 'TEAM_HISTORY_INCOMPLETE')
    })
    if (!projection.complete) {
      throw new ApiError(503, 'Team history projection is incomplete; existing workbench state was preserved', 'TEAM_HISTORY_INCOMPLETE')
    }
    return projection.messages
  }

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getTeamsDir(): string {
    return path.join(this.getConfigDir(), 'teams')
  }

  private getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects')
  }

  private getWorkbenchArchiveDir(): string {
    return path.join(this.getConfigDir(), 'cc-haha', 'agent-teams')
  }

  private getWorkbenchArchivePath(sessionId: string): string {
    return path.join(this.getWorkbenchArchiveDir(), `${hash(sessionId)}.json`)
  }

  // ── List all teams ──────────────────────────────────────────────────────

  async listTeams(): Promise<TeamSummary[]> {
    const teamsDir = this.getTeamsDir()

    try {
      await fs.access(teamsDir)
    } catch {
      return []
    }

    const entries = await fs.readdir(teamsDir, { withFileTypes: true })
    const teams: TeamSummary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      try {
        const config = await this.loadTeamConfig(entry.name)
        // Include inbox-discovered members in the count
        const inboxNames = await this.discoverInboxMembers(entry.name)
        const configNames = new Set(config.members.map((m) => m.name))
        const extraCount = inboxNames.filter((n) => !configNames.has(n)).length
        const summary = this.toSummary(config)
        summary.memberCount += extraCount
        summary.activeMemberCount += extraCount // assume running if newly discovered
        teams.push(summary)
      } catch {
        // Skip malformed team directories
      }
    }

    return teams
  }

  // ── Get team detail ─────────────────────────────────────────────────────

  async getTeam(name: string): Promise<TeamDetail> {
    const config = await this.loadTeamConfig(name)
    const now = Date.now()
    const lastWrites = config.leadSessionId
      ? await this.discoverSubagentLastWrites(config.leadSessionId)
      : new Map<string, number>()

    const members: TeamMember[] = config.members.map((m) => ({
      agentId: m.agentId,
      name: m.name,
      agentType: m.agentType,
      ...(m.model ? { model: m.model } : {}),
      color: m.color,
      backendType: m.backendType,
      status: this.deriveStatus(m.isActive),
      activity: this.deriveActivity(m.isActive, lastWrites.get(m.name), now),
      joinedAt: m.joinedAt,
      cwd: m.cwd,
      sessionId: m.sessionId,
    }))

    // Discover members from inboxes/ that aren't in config.json (race condition fix)
    const inboxNames = await this.discoverInboxMembers(name)
    const configNames = new Set(config.members.map((m) => m.name))

    for (const inboxName of inboxNames) {
      if (!configNames.has(inboxName)) {
        members.push({
          agentId: `${inboxName}@${name}`,
          name: inboxName,
          agentType: 'general-purpose',
          status: 'running', // assume running since we can see their inbox
          // Having an inbox says a member exists, never that it is mid-turn.
          activity: this.deriveActivity(undefined, lastWrites.get(inboxName), now),
          joinedAt: config.createdAt,
          cwd: config.members[0]?.cwd || '',
        })
      }
    }

    for (const subagentName of lastWrites.keys()) {
      if (
        !configNames.has(subagentName) &&
        !members.some((member) => member.name === subagentName)
      ) {
        members.push({
          agentId: `${subagentName}@${name}`,
          name: subagentName,
          status: 'running',
          activity: this.deriveActivity(undefined, lastWrites.get(subagentName), now),
          joinedAt: config.createdAt,
          cwd: config.members[0]?.cwd || '',
        })
      }
    }

    return {
      ...this.toSummary(config),
      leadAgentId: config.leadAgentId,
      leadSessionId: config.leadSessionId,
      memberCount: members.length,
      activeMemberCount: members.filter(
        (m) => m.status === 'running',
      ).length,
      members,
    }
  }

  // ── Get member transcript ───────────────────────────────────────────────

  async getMemberTranscript(
    teamName: string,
    agentId: string,
  ): Promise<TranscriptMessage[]> {
    return (await this.getMemberTranscriptPage(teamName, agentId)).messages
  }

  async getMemberTranscriptPage(
    teamName: string,
    agentId: string,
    options: TeamTranscriptPageOptions = {},
  ): Promise<TeamTranscriptPage> {
    let config: TeamFileRaw | null = null
    let configError: unknown
    let memberName: string | null = null
    let memberSessionId: string | undefined
    let leadSessionId = options.leadSessionId
    let transcriptStartedAt: number | undefined
    let transcriptEndedAt: number | undefined

    try {
      config = await this.loadTeamConfig(teamName)
      const configIncarnationId = teamIncarnationId(config)
      if (
        options.incarnationId &&
        options.incarnationId !== configIncarnationId
      ) {
        throw ApiError.notFound(
          `Team incarnation not found: ${options.incarnationId}`,
        )
      }
      memberName = await this.resolveMemberName(config, teamName, agentId)
      const configMember = config.members.find((candidate) => candidate.agentId === agentId)
      memberSessionId = configMember?.sessionId
      leadSessionId = config.leadSessionId ?? leadSessionId
      transcriptStartedAt = config.createdAt
    } catch (error) {
      configError = error
    }

    // A live team config is only the current roster. Members disappear from it
    // during shutdown before the team directory itself is removed, so a
    // successful config load can still require the durable archive identity.
    if (!memberName && leadSessionId) {
      const archive = await this.readArchiveDocument(leadSessionId)
      const archivedEntry = this.archiveEntryForTeam(
        archive,
        teamName,
        options.incarnationId,
      )
      const archivedSnapshot = archivedEntry?.snapshots.at(-1)
      const archivedMember = archivedEntry?.snapshots
        .slice()
        .reverse()
        .flatMap(snapshot => snapshot.team.members)
        .find((candidate) => (
          candidate.agentId === agentId || candidate.name === agentId
        ))
      memberName = archivedMember?.name ?? null
      memberSessionId = archivedMember?.sessionId
      leadSessionId = archivedSnapshot?.team.leadSessionId ?? leadSessionId
      transcriptStartedAt = archivedSnapshot?.team.createdAt
      const deletedAt = archivedSnapshot?.deletedAt
        ? Date.parse(archivedSnapshot.deletedAt)
        : undefined
      const nextIncarnationStartedAt = archive?.teams
        .filter((entry) => entry.teamName === teamName)
        .map((entry) => entry.snapshots.at(-1)?.team.createdAt)
        .filter((createdAt): createdAt is number => (
          Number.isFinite(createdAt) &&
          Number.isFinite(transcriptStartedAt) &&
          createdAt! > transcriptStartedAt!
        ))
        .sort((left, right) => left - right)[0]
      transcriptEndedAt = [deletedAt, nextIncarnationStartedAt]
        .filter((value): value is number => Number.isFinite(value))
        .sort((left, right) => left - right)[0]
    }

    if (!memberName) {
      if (configError && !leadSessionId) throw configError
      throw ApiError.notFound(
        `Team member not found: ${agentId} in team ${teamName}`,
      )
    }

    let transcriptPath: string | null = null
    let transcriptOwnerAgentId: string | undefined

    // Try config.json member with sessionId first. SessionService uses the
    // scalar session index for this lookup when it is ready.
    if (memberSessionId) {
      transcriptPath = (await this.sessionLocator.findSessionFile(memberSessionId))?.filePath ??
        await this.findTranscriptFile(memberSessionId)
      if (
        transcriptPath &&
        !await this.transcriptBelongsToIncarnation(
          transcriptPath,
          transcriptStartedAt,
          transcriptEndedAt,
        )
      ) {
        transcriptPath = null
      }
    }

    // Fallback: aggregate every in-process transcript fragment for this member.
    // A teammate can be resumed many times and each resume owns a new agent-*.jsonl
    // file. Treating only the newest fragment as the conversation made the member
    // page lose its earlier messages and often left it looking empty.
    if (!transcriptPath && leadSessionId) {
      const subagentPaths = await this.findSubagentTranscripts(
        leadSessionId,
        memberName,
        transcriptStartedAt,
        transcriptEndedAt,
      )
      if (subagentPaths.length === 1) {
        transcriptPath = subagentPaths[0] ?? null
        transcriptOwnerAgentId = transcriptPath
          ? physicalAgentIdFromTranscriptPath(transcriptPath)
          : undefined
      } else if (subagentPaths.length > 1) {
        return this.parseTranscriptFragmentsPage(
          subagentPaths.map(filePath => ({
            filePath,
            ownerAgentId: physicalAgentIdFromTranscriptPath(filePath),
          })),
          options,
        )
      }
    }

    // Out-of-process teammates own root session JSONL files rather than lead
    // subagent fragments. Team and agent identity are persisted on those
    // entries, so archived workbenches can still open the real execution log.
    if (!transcriptPath) {
      const teammatePaths = await this.findTeammateSessionTranscripts(
        teamName,
        memberName,
        transcriptStartedAt,
        transcriptEndedAt,
      )
      if (teammatePaths.length === 1) {
        transcriptPath = teammatePaths[0] ?? null
      } else if (teammatePaths.length > 1) {
        return this.parseTranscriptFragmentsPage(
          teammatePaths.map(filePath => ({ filePath })),
          options,
        )
      }
    }

    if (!transcriptPath) {
      return {
        messages: [],
        ownerAgentIds: [],
        taskNotifications: [],
        taskAnchors: [],
        signature: 'missing',
        cursor: encodeTranscriptCursor(cursorForBuffer(Buffer.alloc(0), null, 0, -1)),
        afterOrdinal: -1,
      }
    }

    const projection: TranscriptFragmentProjection = transcriptOwnerAgentId
      ? {
          ownerAgentId: transcriptOwnerAgentId,
          ownerAgentIds: [transcriptOwnerAgentId],
        }
      : { ownerAgentIds: [] }
    const indexed = await this.readIndexedTranscriptPage(
      transcriptPath,
      options,
      projection,
    )
    if (indexed) return indexed
    return this.parseTranscriptFilePage(transcriptPath, options, projection)
  }

  async sendMemberMessage(
    teamName: string,
    agentId: string,
    content: string,
  ): Promise<void> {
    const text = content.trim()
    if (!text) {
      throw ApiError.badRequest('content (string) is required in request body')
    }

    const config = await this.loadTeamConfig(teamName)
    const recipientName = await this.resolveMemberName(
      config,
      teamName,
      agentId,
    )

    if (!recipientName) {
      throw ApiError.notFound(
        `Team member not found: ${agentId} in team ${teamName}`,
      )
    }

    await writeToMailbox(
      recipientName,
      {
        from: 'user',
        text,
        timestamp: new Date().toISOString(),
      },
      teamName,
    )
  }

  // ── Get Agent Teams workbench snapshot ──────────────────────────────────────

  /**
   * Join the three CLI-owned Agent Teams surfaces behind one read-only contract:
   * team membership, the shared task box, and teammate mailboxes. The desktop
   * must not know where any of these files live, and this method never marks an
   * inbox entry as read or otherwise mutates CLI state.
   */
  async getWorkbench(name: string): Promise<TeamWorkbenchSnapshot> {
    return withTaskListLifecycleLock(getCanonicalTeamTaskListId(name), async () => {
      const config = await this.loadTeamConfig(name)
      const taskListId = getCanonicalTeamTaskListId(config.name)
      const discoveredTeam = await this.getTeam(name)
      const rosterIds = new Set(config.members.map((member) => member.agentId))
      const members = discoveredTeam.members.filter((member) => rosterIds.has(member.agentId))
      const team = {
        ...discoveredTeam,
        memberCount: members.length,
        activeMemberCount: members.filter((member) => member.status === 'running').length,
        members,
      }
      const taskSnapshot = await readTaskListSnapshot(taskListId)
      const tasks: TaskInfo[] = taskSnapshot.tasks
        .filter(task => !task.metadata?._internal)
        .map(task => ({ ...task, taskListId }))
        .sort((left, right) => {
          const leftNumber = Number.parseInt(left.id, 10)
          const rightNumber = Number.parseInt(right.id, 10)
          if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
            return leftNumber - rightNumber
          }
          return left.id.localeCompare(right.id)
        })
      const messages = await this.readWorkbenchMessages(name)
      const canonical = JSON.stringify({ team, tasks, messages })

      const snapshot: TeamWorkbenchSnapshot = {
        version: hash(canonical),
        // This is the task-list replay boundary, captured after the locked read.
        // It orders transcript tail repair against the mutable DAG rather than
        // against unrelated roster or mailbox I/O.
        generatedAt: taskSnapshot.capturedAt,
        taskListRevision: taskSnapshot.revision,
        team,
        tasks,
        messages,
      }
      await this.archiveWorkbenchSnapshot(snapshot)
      return snapshot
    })
  }

  /**
   * Resolve the newest Team workbench associated with a lead session. Live
   * state wins; otherwise a durable archive or a one-time transcript migration
   * makes the completed Team available after CLI cleanup and app restarts.
   */
  async getWorkbenchForSession(
    sessionId: string,
    lookup: TeamWorkbenchSessionLookup = {},
  ): Promise<TeamWorkbenchSessionTimeline | null> {
    const liveTeams = await this.listTeams()
    const liveIncarnations = new Set<string>()
    for (const summary of liveTeams) {
      try {
        const team = await this.getTeam(summary.name)
        if (team.leadSessionId !== sessionId) continue
        const snapshot = await this.getWorkbench(team.name)
        liveIncarnations.add(snapshot.team.incarnationId)
      } catch {
        // Another CLI process can remove a team between list and detail reads.
      }
    }

    let archive = await this.readArchiveDocument(sessionId)
    let archived = this.archiveEntryForLookup(archive, lookup)
    const archivedLatest = archived?.snapshots.at(-1)
    let shouldRefreshArchive = Boolean(
      archivedLatest?.deletedAt && !archivedLatest.terminalTaskFrameId,
    )
    if (
      archivedLatest &&
      !archivedLatest.deletedAt &&
      !liveIncarnations.has(archivedLatest.team.incarnationId)
    ) {
      try {
        const lifecycle = await readTaskListLifecycleState(
          getCanonicalTeamTaskListId(archivedLatest.team.name),
        )
        shouldRefreshArchive = Boolean(
          terminalLifecycleTasks(archivedLatest, lifecycle),
        )
      } catch {
        // Malformed lifecycle state is never evidence that a live archive
        // frame ended; legacy transcript/watcher paths remain available.
      }
    }
    if (archived && shouldRefreshArchive) {
      await this.markWorkbenchArchiveDeleted(
        archived.teamName,
        sessionId,
        archived.incarnationId,
      )
      archive = await this.readArchiveDocument(sessionId)
      archived = this.archiveEntryForLookup(archive, lookup)
    }
    if (archived) {
      return {
        sessionId,
        teamName: archived.teamName,
        incarnationId: archived.incarnationId,
        snapshots: archived.snapshots,
        source: liveIncarnations.has(archived.incarnationId) ? 'live' : 'archive',
      }
    }

    let messages: SessionMessageEntry[]
    try {
      messages = await this.readTeamHistory(sessionId)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TEAM_HISTORY_INCOMPLETE') throw error
      return null
    }
    const projected = projectTeamWorkbenchesFromTranscript(sessionId, messages)
    for (const snapshot of projected) {
      await this.archiveWorkbenchSnapshot(snapshot)
    }
    archive = await this.readArchiveDocument(sessionId)
    const migrated = this.archiveEntryForLookup(archive, lookup)
    if (!migrated) return null
    return {
      sessionId,
      teamName: migrated.teamName,
      incarnationId: migrated.incarnationId,
      snapshots: migrated.snapshots,
      source: 'transcript',
    }
  }

  async archiveWorkbenchSnapshot(snapshot: TeamWorkbenchSnapshot): Promise<void> {
    const normalizedSnapshot: TeamWorkbenchSnapshot = {
      ...snapshot,
      team: {
        ...snapshot.team,
        incarnationId: snapshot.team.incarnationId || teamIncarnationId(snapshot.team),
      },
    }
    const sessionId = normalizedSnapshot.team.leadSessionId
    if (!sessionId) return
    const incarnationId = normalizedSnapshot.team.incarnationId
    const filePath = this.getWorkbenchArchivePath(sessionId)
    await this.withArchiveWriteLock(filePath, async () => {
      const current = await this.readArchiveDocument(sessionId) ?? {
        schemaVersion: TEAM_WORKBENCH_ARCHIVE_SCHEMA_VERSION,
        sessionId,
        updatedAt: normalizedSnapshot.generatedAt,
        teams: [],
      }
      const teams = [...current.teams]
      const index = teams.findIndex((entry) => entry.incarnationId === incarnationId)
      const existing = index >= 0 ? teams[index] : undefined
      const snapshotWithRoster = carryForwardArchivedMembers(
        normalizedSnapshot,
        existing?.snapshots.at(-1),
      )
      const latest = existing?.snapshots.at(-1)
      const incomingAt = Date.parse(snapshotWithRoster.generatedAt)
      const latestAt = latest ? Date.parse(latest.generatedAt) : Number.NEGATIVE_INFINITY
      const incomingRevision = snapshotWithRoster.taskListRevision
      const latestRevision = latest?.taskListRevision
      const comparableRevisions = Number.isSafeInteger(incomingRevision) &&
        Number.isSafeInteger(latestRevision)
      // Archive entries are a monotonic state machine. A delayed watcher read
      // must never move the replay boundary backward, and no live snapshot may
      // resurrect an incarnation after its deletion tombstone was committed.
      if (
        (latest?.deletedAt && !snapshotWithRoster.deletedAt) ||
        (comparableRevisions && incomingRevision! < latestRevision!) ||
        (
          (
            !comparableRevisions ||
            incomingRevision === latestRevision
          ) &&
          Number.isFinite(incomingAt) &&
          Number.isFinite(latestAt) &&
          (
            incomingAt < latestAt ||
            (
              incomingAt === latestAt &&
              latest?.version !== snapshotWithRoster.version
            )
          )
        )
      ) return
      const snapshots = latest?.version === snapshotWithRoster.version
        ? [...existing.snapshots.slice(0, -1), snapshotWithRoster]
        : [...(existing?.snapshots ?? []), snapshotWithRoster]
            .slice(-TEAM_WORKBENCH_ARCHIVE_HISTORY_LIMIT)
      const nextEntry: TeamWorkbenchArchiveEntry = {
        ...(existing ?? {}),
        teamName: snapshotWithRoster.team.name,
        incarnationId,
        updatedAt: snapshotWithRoster.generatedAt,
        snapshots,
      }
      if (index >= 0) teams[index] = nextEntry
      else teams.push(nextEntry)
      await this.writeArchiveDocument(filePath, {
        ...current,
        schemaVersion: TEAM_WORKBENCH_ARCHIVE_SCHEMA_VERSION,
        sessionId,
        updatedAt: normalizedSnapshot.generatedAt,
        teams,
      })
    })
  }

  async markWorkbenchArchiveDeleted(
    teamName: string,
    sessionId: string | undefined,
    incarnationId?: string,
  ): Promise<void> {
    if (!sessionId) return
    let messages: SessionMessageEntry[] | undefined
    let lifecycle: TaskListLifecycleState | undefined
    try {
      messages = await this.readTeamHistory(sessionId)
    } catch {
      // The archive tombstone must still be written when a legacy or partially
      // persisted lead transcript cannot be read.
    }
    try {
      lifecycle = await readTaskListLifecycleState(
        getCanonicalTeamTaskListId(teamName),
      )
    } catch {
      // A malformed lifecycle receipt is never trusted. Transcript repair and
      // the last archived snapshot remain available as legacy fallbacks.
    }
    const filePath = this.getWorkbenchArchivePath(sessionId)
    await this.withArchiveWriteLock(filePath, async () => {
      const current = await this.readArchiveDocument(sessionId)
      const entry = this.archiveEntryForTeam(current, teamName, incarnationId)
      const latest = entry?.snapshots.at(-1)
      if (!current || !entry || !latest) return
      const base = latest.deletedAt
        ? [...entry.snapshots].reverse().find(snapshot => !snapshot.deletedAt)
        : latest
      if (!base) return
      const transcriptReconciled = messages
        ? reconcileArchivedTasksFromTranscript(base, messages)
        : null
      const reconciled = preferTerminalTaskFrame(
        transcriptReconciled,
        terminalLifecycleTasks(base, lifecycle),
      )

      if (latest.deletedAt) {
        // A watcher can observe directory deletion before the TeamDelete tool
        // result is durable. The tombstone remains terminal, but a later GET
        // or mark may enrich its payload from that authoritative final frame.
        if (!reconciled?.terminalTaskFrameId) return
        if (
          latest.terminalTaskFrameId === reconciled.terminalTaskFrameId &&
          (latest.taskListRevision ?? -1) >=
            (reconciled.taskListRevision ?? -1)
        ) return
        if (
          latest.taskListRevision !== undefined &&
          reconciled.taskListRevision !== undefined &&
          reconciled.taskListRevision < latest.taskListRevision
        ) return
        const enriched: TeamWorkbenchSnapshot = {
          ...latest,
          version: `${base.version}:tasks:${hash(JSON.stringify(reconciled.tasks))}:deleted`,
          tasks: reconciled.tasks,
          ...(reconciled.taskListRevision !== undefined
            ? { taskListRevision: reconciled.taskListRevision }
            : {}),
          terminalTaskFrameId: reconciled.terminalTaskFrameId,
        }
        const index = current.teams.indexOf(entry)
        const teams = [...current.teams]
        teams[index] = {
          ...entry,
          snapshots: [...entry.snapshots.slice(0, -1), enriched],
        }
        await this.writeArchiveDocument(filePath, { ...current, teams })
        return
      }

      const reconciledLatest = reconciled
        ? {
            ...latest,
            version: `${latest.version}:tasks:${hash(JSON.stringify(reconciled.tasks))}`,
            tasks: reconciled.tasks,
            ...(reconciled.taskListRevision !== undefined
              ? { taskListRevision: reconciled.taskListRevision }
              : {}),
            ...(reconciled.terminalTaskFrameId
              ? { terminalTaskFrameId: reconciled.terminalTaskFrameId }
              : {}),
          }
        : latest

      const deletedAt = new Date().toISOString()
      const tombstone: TeamWorkbenchSnapshot = {
        ...reconciledLatest,
        version: `${reconciledLatest.version}:deleted`,
        generatedAt: deletedAt,
        deletedAt,
        team: {
          ...reconciledLatest.team,
          activeMemberCount: 0,
          members: reconciledLatest.team.members.map((member) => ({
            ...member,
            status: 'completed' as const,
            activity: 'exited' as const,
          })),
        },
      }
      const index = current.teams.indexOf(entry)
      const teams = [...current.teams]
      teams[index] = {
        ...entry,
        updatedAt: deletedAt,
        snapshots: [...entry.snapshots, tombstone]
          .slice(-TEAM_WORKBENCH_ARCHIVE_HISTORY_LIMIT),
      }
      await this.writeArchiveDocument(filePath, {
        ...current,
        updatedAt: deletedAt,
        teams,
      })
    })
  }

  private latestArchiveEntry(
    document: TeamWorkbenchArchiveDocument | null,
  ): TeamWorkbenchArchiveEntry | null {
    if (!document) return null
    return [...document.teams]
      .filter((entry) => entry.snapshots.length > 0)
      .sort((left, right) => (
        this.archiveEntryCreatedAt(right) - this.archiveEntryCreatedAt(left) ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.teamName.localeCompare(left.teamName)
      ))[0] ?? null
  }

  private archiveEntryForTeam(
    document: TeamWorkbenchArchiveDocument | null,
    teamName: string,
    incarnationId?: string,
  ): TeamWorkbenchArchiveEntry | null {
    if (!document) return null
    if (incarnationId) {
      return document.teams.find((entry) => (
        entry.teamName === teamName && entry.incarnationId === incarnationId
      )) ?? null
    }
    return [...document.teams]
      .filter((entry) => entry.teamName === teamName && entry.snapshots.length > 0)
      .sort((left, right) => (
        this.archiveEntryCreatedAt(right) - this.archiveEntryCreatedAt(left) ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      ))[0] ?? null
  }

  private archiveEntryForLookup(
    document: TeamWorkbenchArchiveDocument | null,
    lookup: TeamWorkbenchSessionLookup,
  ): TeamWorkbenchArchiveEntry | null {
    if (!document) return null
    if (lookup.incarnationId) {
      return document.teams.find((entry) => (
        entry.incarnationId === lookup.incarnationId &&
        (!lookup.teamName || entry.teamName === lookup.teamName) &&
        entry.snapshots.length > 0
      )) ?? null
    }

    let candidates = document.teams.filter((entry) => (
      entry.snapshots.length > 0 &&
      (!lookup.teamName || entry.teamName === lookup.teamName)
    ))
    if (lookup.at !== undefined && Number.isFinite(lookup.at)) {
      candidates = candidates.filter((entry) => {
        const startedAt = this.archiveEntryCreatedAt(entry)
        const deletedAt = entry.snapshots.at(-1)?.deletedAt
          ? Date.parse(entry.snapshots.at(-1)!.deletedAt!)
          : Number.POSITIVE_INFINITY
        const nextStartedAt = document.teams
          .filter((candidate) => (
            candidate.teamName === entry.teamName &&
            candidate.incarnationId !== entry.incarnationId
          ))
          .map(candidate => this.archiveEntryCreatedAt(candidate))
          .filter(candidateStartedAt => candidateStartedAt > startedAt)
          .sort((left, right) => left - right)[0] ?? Number.POSITIVE_INFINITY
        const endedAt = Math.min(
          Number.isFinite(deletedAt) ? deletedAt : Number.POSITIVE_INFINITY,
          nextStartedAt,
        )
        return startedAt <= lookup.at! && lookup.at! < endedAt
      })
    }
    return [...candidates].sort((left, right) => (
      this.archiveEntryCreatedAt(right) - this.archiveEntryCreatedAt(left) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    ))[0] ?? null
  }

  private archiveEntryCreatedAt(entry: TeamWorkbenchArchiveEntry): number {
    const createdAt = entry.snapshots.at(-1)?.team.createdAt
    return Number.isFinite(createdAt) ? createdAt! : 0
  }

  private async readArchiveDocument(
    sessionId: string,
  ): Promise<TeamWorkbenchArchiveDocument | null> {
    try {
      const raw = JSON.parse(
        await fs.readFile(this.getWorkbenchArchivePath(sessionId), 'utf8'),
      ) as Record<string, unknown>
      if (
        raw.schemaVersion !== TEAM_WORKBENCH_ARCHIVE_SCHEMA_VERSION ||
        raw.sessionId !== sessionId ||
        !Array.isArray(raw.teams)
      ) return null
      const groupedTeams = new Map<string, TeamWorkbenchArchiveEntry>()
      for (const value of raw.teams) {
        const entry = objectValue(value)
        const teamName = stringValue(entry?.teamName)
        const updatedAt = stringValue(entry?.updatedAt)
        if (!entry || !teamName || !updatedAt || !Array.isArray(entry.snapshots)) continue

        for (const snapshotValue of entry.snapshots) {
          const record = objectValue(snapshotValue)
          const teamRecord = objectValue(record?.team)
          if (
            !record ||
            !teamRecord ||
            !stringValue(record.version) ||
            !stringValue(record.generatedAt) ||
            !Array.isArray(record.tasks) ||
            !Array.isArray(record.messages)
          ) continue
          const createdAt = typeof teamRecord.createdAt === 'number'
            ? teamRecord.createdAt
            : Number(teamRecord.createdAt)
          const incarnationId = stringValue(teamRecord.incarnationId) ?? teamIncarnationId({
            name: stringValue(teamRecord.name) ?? teamName,
            createdAt: Number.isFinite(createdAt) ? createdAt : 0,
            leadSessionId: stringValue(teamRecord.leadSessionId),
          })
          const rawSnapshot = {
            ...record,
            team: {
              ...teamRecord,
              incarnationId,
            },
          } as TeamWorkbenchSnapshot
          const key = `${teamName}\u0000${incarnationId}`
          const existing = groupedTeams.get(key)
          const snapshot = carryForwardArchivedMembers(
            rawSnapshot,
            existing?.snapshots.at(-1),
          )
          const snapshots = existing?.snapshots.at(-1)?.version === snapshot.version
            ? existing.snapshots
            : [...(existing?.snapshots ?? []), snapshot]
          groupedTeams.set(key, {
            ...(existing ?? entry),
            teamName,
            incarnationId,
            updatedAt: snapshot.generatedAt,
            snapshots,
          })
        }
      }
      const teams = [...groupedTeams.values()]
      return {
        ...raw,
        schemaVersion: TEAM_WORKBENCH_ARCHIVE_SCHEMA_VERSION,
        sessionId,
        updatedAt: stringValue(raw.updatedAt) ?? teams.at(-1)?.updatedAt ?? new Date(0).toISOString(),
        teams,
      }
    } catch {
      return null
    }
  }

  private async writeArchiveDocument(
    filePath: string,
    document: TeamWorkbenchArchiveDocument,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await fs.rename(temporaryPath, filePath)
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {})
      throw error
    }
  }

  private async withArchiveWriteLock<T>(
    filePath: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.archiveWriteLocks.get(filePath) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.archiveWriteLocks.set(filePath, next)
    try {
      return await next
    } finally {
      if (this.archiveWriteLocks.get(filePath) === next) {
        this.archiveWriteLocks.delete(filePath)
      }
    }
  }

  // ── Delete team ─────────────────────────────────────────────────────────

  async deleteTeam(name: string): Promise<void> {
    return withTaskListLifecycleLock(
      getCanonicalTeamTaskListId(name),
      async () => {
      const config = await this.loadTeamConfig(name)

      const remainingTeammates = config.members.filter(
        member => member.agentId !== config.leadAgentId,
      )
      const lead = config.members.find(
        member => member.agentId === config.leadAgentId,
      )
      if (lead?.isActive !== false || remainingTeammates.length > 0) {
        throw ApiError.conflict(
          `Cannot delete team "${name}": lead is active or teammates remain registered`,
        )
      }

      await this.getWorkbench(name)
      await cleanupTeamDirectories(config.name)
      await this.markWorkbenchArchiveDeleted(
        config.name,
        config.leadSessionId,
        teamIncarnationId(config),
      )
      },
    )
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async loadTeamConfig(name: string): Promise<TeamFileRaw> {
    const configPath = path.join(this.getTeamsDir(), name, 'config.json')

    try {
      const raw = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(raw) as TeamFileRaw
    } catch {
      throw ApiError.notFound(`Team not found: ${name}`)
    }
  }

  /**
   * Discover member names from the inboxes/ directory.
   * Each file `{name}.json` in inboxes/ represents a team member.
   * Excludes the team-lead inbox since the leader is already in config.
   */
  private async discoverInboxMembers(teamName: string): Promise<string[]> {
    const inboxDir = path.join(this.getTeamsDir(), teamName, 'inboxes')

    try {
      const files = await fs.readdir(inboxDir)
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .filter((name) => name !== 'team-lead')
    } catch {
      return []
    }
  }

  private async readWorkbenchMessages(
    teamName: string,
  ): Promise<TeamWorkbenchMessage[]> {
    const inboxDir = path.join(this.getTeamsDir(), teamName, 'inboxes')
    let files: string[]
    try {
      files = (await fs.readdir(inboxDir)).filter((file) => file.endsWith('.json'))
    } catch {
      return []
    }

    type InboxMessage = {
      id?: unknown
      from?: unknown
      text?: unknown
      timestamp?: unknown
      color?: unknown
      summary?: unknown
    }
    type MessageAccumulator = {
      from: string
      text: string
      timestamp: string
      color?: string
      summary?: string
      recipients: Set<string>
    }

    const grouped = new Map<string, MessageAccumulator>()
    const occurrenceByRecipientAndContent = new Map<string, number>()
    for (const file of files.sort()) {
      const recipient = file.replace(/\.json$/, '')
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(inboxDir, file), 'utf8'))
        if (!Array.isArray(parsed)) continue

        for (const raw of parsed as InboxMessage[]) {
          if (
            typeof raw?.from !== 'string' ||
            typeof raw.text !== 'string' ||
            typeof raw.timestamp !== 'string'
          ) continue
          const messageId = typeof raw.id === 'string' && raw.id ? raw.id : undefined
          const summary = typeof raw.summary === 'string' ? raw.summary : undefined
          const color = typeof raw.color === 'string' ? raw.color : undefined
          const timestampSecond = raw.timestamp.slice(0, 19)
          const contentKey = hash(JSON.stringify([
            raw.from,
            raw.text,
            timestampSecond,
            summary ?? '',
            color ?? '',
          ]))
          // New envelopes carry a stable upstream ID, shared by every copy of a
          // broadcast. The occurrence fallback is only for legacy mailbox data
          // written before IDs were introduced.
          const occurrenceKey = `${recipient}\u0000${contentKey}`
          const occurrence = occurrenceByRecipientAndContent.get(occurrenceKey) ?? 0
          occurrenceByRecipientAndContent.set(occurrenceKey, occurrence + 1)
          const key = messageId ? `mailbox:${messageId}` : `legacy:${contentKey}:${occurrence}`
          const existing = grouped.get(key)
          if (existing) {
            existing.recipients.add(recipient)
            if (raw.timestamp < existing.timestamp) existing.timestamp = raw.timestamp
          } else {
            grouped.set(key, {
              from: raw.from,
              text: raw.text,
              timestamp: raw.timestamp,
              ...(summary ? { summary } : {}),
              ...(color ? { color } : {}),
              recipients: new Set([recipient]),
            })
          }
        }
      } catch {
        // A mailbox can be between its truncate and rename while the CLI is
        // writing it. The watcher will invalidate the snapshot again.
      }
    }

    return Array.from(grouped.entries())
      .map(([id, message]) => this.toWorkbenchMessage(id, message))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
  }

  private toWorkbenchMessage(
    id: string,
    message: {
      from: string
      text: string
      timestamp: string
      color?: string
      summary?: string
      recipients: Set<string>
    },
  ): TeamWorkbenchMessage {
    const recipients = Array.from(message.recipients).sort()
    let protocolType: string | undefined
    let taskId: string | undefined
    let text = message.text

    try {
      const structured = JSON.parse(message.text) as Record<string, unknown>
      if (typeof structured.type === 'string') protocolType = structured.type
      if (typeof structured.taskId === 'string') taskId = structured.taskId
      if (typeof structured.subject === 'string') text = structured.subject
      else if (typeof structured.reason === 'string') text = structured.reason
    } catch {
      // Ordinary teammate prose is the common path.
    }

    const isSystem = Boolean(protocolType)
    const isBroadcast = !isSystem && recipients.length > 1
    return {
      id,
      from: message.from,
      to: isBroadcast ? '*' : recipients[0] ?? '*',
      recipients,
      kind: isSystem ? 'system' : isBroadcast ? 'broadcast' : 'direct',
      text,
      timestamp: message.timestamp,
      ...(message.summary ? { summary: message.summary } : {}),
      ...(message.color ? { color: message.color } : {}),
      ...(taskId ? { taskId } : {}),
      ...(protocolType ? { protocolType } : {}),
    }
  }

  private toSummary(config: TeamFileRaw): TeamSummary {
    const activeMemberCount = config.members.filter(
      (m) => m.isActive === undefined || m.isActive === true,
    ).length

    return {
      name: config.name,
      description: config.description,
      createdAt: config.createdAt,
      incarnationId: teamIncarnationId(config),
      memberCount: config.members.length,
      activeMemberCount,
    }
  }

  private deriveStatus(
    isActive: boolean | undefined,
  ): 'running' | 'completed' | 'idle' | 'failed' {
    if (isActive === false) return 'idle'
    // isActive === undefined || isActive === true
    return 'running'
  }

  /**
   * `isActive` is written by the in-process runner around each turn, so when it
   * is present it is the strongest possible answer and costs nothing -- the
   * config has already been read. It is absent for backends that do not run
   * teammates in-process and for a member that has not taken its first turn, so
   * a recent write to the member's own transcript stands in. Saying `unknown`
   * is better than guessing `active`, which is what made every member look busy
   * for the whole run.
   */
  private deriveActivity(
    isActive: boolean | undefined,
    lastWriteMs: number | undefined,
    now: number,
  ): TeamMemberActivity {
    if (isActive === true) return 'active'
    if (isActive === false) return 'idle'
    if (lastWriteMs === undefined) return 'unknown'
    return now - lastWriteMs < TEAM_MEMBER_ACTIVE_WINDOW_MS ? 'active' : 'idle'
  }

  private async resolveMemberName(
    config: TeamFileRaw,
    teamName: string,
    agentId: string,
  ): Promise<string | null> {
    const configMember = config.members.find((m) => m.agentId === agentId)
    if (configMember?.name) {
      return configMember.name
    }

    const parsedName = agentId.includes('@') ? agentId.split('@')[0]! : agentId
    const inboxNames = await this.discoverInboxMembers(teamName)
    if (inboxNames.includes(parsedName)) {
      return parsedName
    }

    if (config.leadSessionId) {
      const subagentNames = await this.discoverSubagentMembers(
        config.leadSessionId,
      )
      if (subagentNames.includes(parsedName)) {
        return parsedName
      }
    }

    return null
  }

  private async discoverSubagentMembers(leadSessionId: string): Promise<string[]> {
    return [...(await this.discoverSubagentLastWrites(leadSessionId)).keys()]
  }

  /**
   * One walk of the lead's subagent transcripts that answers both "who is on
   * this team" and "when did each of them last write". The sidecar metadata is
   * tried before the transcript head because it is two orders of magnitude
   * smaller, and the `stat` an activity probe needs rides along on a directory
   * this method already has to open.
   */
  private async discoverSubagentLastWrites(
    leadSessionId: string,
  ): Promise<Map<string, number>> {
    const projectsDir = this.getProjectsDir()
    const lastWrites = new Map<string, number>()

    try {
      await fs.access(projectsDir)
    } catch {
      return lastWrites
    }

    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const projEntry of projectEntries) {
      if (!projEntry.isDirectory()) continue

      const subagentsDir = path.join(
        projectsDir,
        projEntry.name,
        leadSessionId,
        'subagents',
      )

      let files: string[]
      try {
        files = await fs.readdir(subagentsDir)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(subagentsDir, file)
        const discoveredName = await this.extractSubagentMetadataName(filePath) ??
          await this.extractSubagentName(filePath)
        if (!discoveredName || discoveredName === 'team-lead') continue
        let mtimeMs = 0
        try {
          mtimeMs = (await fs.stat(filePath)).mtimeMs
        } catch {
          // A fragment can vanish while a finished team is being opened.
        }
        lastWrites.set(
          discoveredName,
          Math.max(lastWrites.get(discoveredName) ?? 0, mtimeMs),
        )
      }
    }

    return lastWrites
  }

  /** Search ~/.claude/projects/ for a JSONL file matching the sessionId. */
  private async findTranscriptFile(
    sessionId: string,
  ): Promise<string | null> {
    const projectsDir = this.getProjectsDir()

    try {
      await fs.access(projectsDir)
    } catch {
      return null
    }

    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue

      const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // Not in this project directory
      }
    }

    return null
  }

  /**
   * Search subagents directory for a specific member's transcript.
   * Path: ~/.claude/projects/{project}/{leadSessionId}/subagents/agent-*.jsonl
   *
   * Matches only persisted agent identity. Prompt text can legitimately mention
   * several teammates and cannot distinguish one execution transcript from another.
   */
  private async findSubagentTranscripts(
    leadSessionId: string,
    memberName: string,
    startedAt?: number,
    endedAt?: number,
  ): Promise<string[]> {
    const projectsDir = this.getProjectsDir()

    try {
      await fs.access(projectsDir)
    } catch {
      return []
    }

    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const projEntry of projectEntries) {
      if (!projEntry.isDirectory()) continue

      const subagentsDir = path.join(
        projectsDir,
        projEntry.name,
        leadSessionId,
        'subagents',
      )

      let files: string[]
      try {
        files = await fs.readdir(subagentsDir)
      } catch {
        continue
      }

      const matches: Array<{ path: string; mtime: number }> = []

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue

        const filePath = path.join(subagentsDir, file)

        try {
          const metadataName = await this.extractSubagentMetadataName(filePath)
          const structuredName = await this.extractSubagentName(filePath)
          if (
            metadataName === memberName ||
            structuredName === memberName
          ) {
            if (!await this.transcriptBelongsToIncarnation(filePath, startedAt, endedAt)) {
              continue
            }
            const stat = await fs.stat(filePath)
            matches.push({ path: filePath, mtime: stat.mtimeMs })
          }
        } catch {
          // Skip unreadable files
        }
      }

      if (matches.length > 0) {
        return matches
          .sort((left, right) => left.mtime - right.mtime || left.path.localeCompare(right.path))
          .map(match => match.path)
      }
    }

    return []
  }

  private async findTeammateSessionTranscripts(
    teamName: string,
    memberName: string,
    startedAt?: number,
    endedAt?: number,
  ): Promise<string[]> {
    const projectsDir = this.getProjectsDir()
    const readDirectoryEntries = async (directory: string) => {
      try {
        return await fs.readdir(directory, { withFileTypes: true })
      } catch {
        return []
      }
    }
    const projectEntries = await readDirectoryEntries(projectsDir)
    if (projectEntries.length === 0) return []

    const matches: Array<{ path: string; mtime: number }> = []
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue
      const projectDir = path.join(projectsDir, projectEntry.name)
      const transcriptEntries = await readDirectoryEntries(projectDir)

      for (const transcriptEntry of transcriptEntries) {
        if (!transcriptEntry.isFile() || !transcriptEntry.name.endsWith('.jsonl')) continue
        const filePath = path.join(projectDir, transcriptEntry.name)
        const identity = await this.extractTeammateSessionIdentity(filePath)
        if (identity?.teamName !== teamName || identity.agentName !== memberName) continue
        if (!await this.transcriptBelongsToIncarnation(filePath, startedAt, endedAt)) continue
        try {
          const stat = await fs.stat(filePath)
          matches.push({ path: filePath, mtime: stat.mtimeMs })
        } catch {
          // The session may disappear while a completed team is being opened.
        }
      }
    }

    return matches
      .sort((left, right) => left.mtime - right.mtime || left.path.localeCompare(right.path))
      .map((match) => match.path)
  }

  /**
   * Legacy teammate transcripts persist only the mutable team name. Their
   * first durable timestamp is the strongest available incarnation boundary:
   * a late write to an old file must not make that file part of a recreated
   * team merely because its mtime is new.
   */
  private async transcriptBelongsToIncarnation(
    filePath: string,
    startedAt?: number,
    endedAt?: number,
  ): Promise<boolean> {
    if (!Number.isFinite(startedAt)) return true
    let firstTimestamp: number | undefined
    try {
      const head = await this.readTranscriptHead(filePath)
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          const parsed = typeof entry.timestamp === 'string'
            ? Date.parse(entry.timestamp)
            : Number.NaN
          if (Number.isFinite(parsed)) {
            firstTimestamp = parsed
            break
          }
        } catch {
          // Ignore a partial bounded-preview line.
        }
      }
      if (firstTimestamp === undefined) {
        const stat = await fs.stat(filePath)
        firstTimestamp = stat.birthtimeMs || stat.ctimeMs
      }
    } catch {
      return false
    }

    return firstTimestamp >= startedAt! && (
      !Number.isFinite(endedAt) || firstTimestamp < endedAt!
    )
  }

  private async extractTeammateSessionIdentity(
    filePath: string,
  ): Promise<{ teamName: string; agentName: string } | null> {
    try {
      const head = await this.readTranscriptHead(filePath)
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          const teamName = stringValue(entry.teamName)
          const agentName = stringValue(entry.agentName)
          if (teamName && agentName) return { teamName, agentName }
        } catch {
          // Ignore a partial final line in the bounded preview window.
        }
      }
      return null
    } catch {
      return null
    }
  }

  private async extractSubagentMetadataName(filePath: string): Promise<string | null> {
    try {
      const metadataPath = filePath.replace(/\.jsonl$/, '.meta.json')
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<string, unknown>
      return typeof metadata.agentType === 'string' && metadata.agentType.trim()
        ? metadata.agentType
        : null
    } catch {
      return null
    }
  }

  private async readTranscriptHead(filePath: string): Promise<string> {
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const { bytesRead } = await fd.read(buf, 0, 8192, 0)
      return buf.toString('utf-8', 0, bytesRead)
    } finally {
      await fd.close()
    }
  }

  private async extractSubagentName(filePath: string): Promise<string | null> {
    try {
      const head = await this.readTranscriptHead(filePath)
      const lines = head.split('\n').filter((line) => line.trim().length > 0)

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (typeof entry.agentName === 'string' && entry.agentName.trim()) {
            return entry.agentName
          }
          if (typeof entry.agentId === 'string' && entry.agentId.includes('@')) {
            return entry.agentId.split('@')[0] ?? null
          }
        } catch {
          // Ignore partial or non-JSON lines in the preview window.
        }
      }
      return null
    } catch {
      return null
    }
  }

  private fileIdentity(stat: { dev: number; ino: number }): string | null {
    return process.platform === 'win32' || stat.ino === 0
      ? null
      : `${stat.dev}:${stat.ino}`
  }

  private transcriptMessageFromEntry(
    entry: Record<string, unknown>,
    ownerAgentId?: string,
  ): TranscriptMessage | null {
    const entryType = entry.type as string | undefined
    if (!entryType || !MESSAGE_ENTRY_TYPES.has(entryType) || entry.isMeta) return null
    const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
      ? entry.message as Record<string, unknown>
      : null
    const content = message && 'content' in message
      ? message.content
      : entry.content ?? entry.message ?? null
    const model = typeof entry.model === 'string'
      ? entry.model
      : typeof message?.model === 'string'
        ? message.model
        : undefined
    const transcriptMessage: TranscriptMessage = {
      id: (entry.uuid as string) || crypto.randomUUID(),
      type: entryType as TranscriptMessage['type'],
      content,
      timestamp: (entry.timestamp as string) || new Date().toISOString(),
      ...(typeof entry.parentToolUseId === 'string'
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(model ? { model } : {}),
      ...(entry.toolUseResult !== undefined ? { toolUseResult: entry.toolUseResult } : {}),
    }
    if (!ownerAgentId) return transcriptMessage
    return {
      ...transcriptMessage,
      id: fragmentScopedId(ownerAgentId, transcriptMessage.id),
      content: projectFragmentContent(transcriptMessage.content, ownerAgentId),
      ...(transcriptMessage.parentToolUseId
        ? {
            parentToolUseId: fragmentScopedId(
              ownerAgentId,
              transcriptMessage.parentToolUseId,
            ),
          }
        : {}),
      ...(transcriptMessage.toolUseResult !== undefined
        ? {
            toolUseResult: projectFragmentToolUseResult(
              transcriptMessage.toolUseResult,
              ownerAgentId,
            ),
          }
        : {}),
    }
  }

  private async filePreservesCursorPrefix(
    filePath: string,
    cursor: TranscriptCursor,
  ): Promise<boolean> {
    let handle: fs.FileHandle | undefined
    try {
      const stat = await fs.stat(filePath)
      const identity = this.fileIdentity(stat)
      if (stat.size <= cursor.size) return false
      if (
        cursor.fileIdentity !== null &&
        identity !== null &&
        cursor.fileIdentity !== identity
      ) return false

      handle = await fs.open(filePath, 'r')
      const firstLength = Math.min(cursor.size, CURSOR_WINDOW_BYTES)
      const lastStart = Math.max(0, cursor.size - CURSOR_WINDOW_BYTES)
      const lastLength = cursor.size - lastStart
      const first = Buffer.alloc(firstLength)
      const last = Buffer.alloc(lastLength)
      if (firstLength > 0) await handle.read(first, 0, firstLength, 0)
      if (lastLength > 0) await handle.read(last, 0, lastLength, lastStart)
      return hash(first) === cursor.firstWindowHash &&
        hash(last) === cursor.lastWindowHash
    } catch {
      return false
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  private async readIndexedTranscriptPage(
    filePath: string,
    options: TeamTranscriptPageOptions,
    projection: TranscriptFragmentProjection = {},
  ): Promise<TeamTranscriptPage | null> {
    try {
      if (
        this.localIndexGateway.getMode() !== 'on' ||
        !this.localIndexGateway.isSessionScopeReady() ||
        !this.localIndexGateway.getSessionEntryLocators
      ) return null
      const page = this.localIndexGateway.getSessionEntryLocators(filePath)
      if (!page) return null
      // A pending source can contain a valid final JSON object without a
      // newline. Locators intentionally exclude that tail, while the legacy
      // canonical parser includes it, so never serve a partial indexed page.
      if (
        page.source.state !== 'ready' ||
        page.source.indexedBytes !== page.source.size
      ) return null
      const fingerprint = deserializeSourceFingerprint(page.source.fingerprint)
      if (!fingerprint) return null
      const currentStat = await fs.stat(filePath)
      const currentIdentity = this.fileIdentity(currentStat)

      const currentAfterOrdinal = page.entries.at(-1)?.ordinal ?? -1
      const signature = hash(page.source.fingerprint)
      const previousCursor = decodeTranscriptCursor(options.cursor)
      let afterOrdinal = options.afterOrdinal ?? -1
      let reset = false
      if (options.cursor !== undefined && !previousCursor) {
        afterOrdinal = -1
        reset = true
      } else if (afterOrdinal >= 0 && (!options.signature || !previousCursor)) {
        afterOrdinal = -1
        reset = true
      } else if (afterOrdinal > currentAfterOrdinal) {
        afterOrdinal = -1
        reset = true
      } else if (previousCursor && previousCursor.afterOrdinal !== afterOrdinal) {
        afterOrdinal = -1
        reset = true
      } else if (options.signature) {
        if (options.signature === signature) {
          const snapshotMatches = previousCursor &&
            previousCursor.size === currentStat.size &&
            previousCursor.ctimeMs === currentStat.ctimeMs &&
            (
              previousCursor.fileIdentity === null ||
              currentIdentity === null ||
              previousCursor.fileIdentity === currentIdentity
            )
          if (!snapshotMatches) {
            afterOrdinal = -1
            reset = true
          }
        } else {
          const appendProven = previousCursor &&
            currentStat.size > previousCursor.size &&
            await this.filePreservesCursorPrefix(filePath, previousCursor)
          if (!appendProven) {
            afterOrdinal = -1
            reset = true
          }
        }
      }

      if (currentStat.size !== fingerprint.size) {
        return null
      }

      const selected = page.entries.filter(locator =>
        locator.ordinal > afterOrdinal && (
          MESSAGE_ENTRY_TYPES.has(locator.entryType) ||
          locator.entryType === PERSISTED_TASK_NOTIFICATION_ENTRY_TYPE
        ),
      )
      const result = await this.targetedEntryReader({
        transcriptPath: filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: path.basename(path.dirname(filePath)),
        page: { source: page.source, entries: selected },
      })
      if (!result) return null
      const statAfterRead = await fs.stat(filePath)
      if (!sameTranscriptFileSnapshot(currentStat, statAfterRead)) return null

      const messages = result.entries
        .map(entry => this.transcriptMessageFromEntry(entry, projection.ownerAgentId))
        .filter((message): message is TranscriptMessage => message !== null)
      const taskNotifications = new Map<string, SessionTaskNotification>()
      for (const entry of result.entries) {
        const notification = taskNotificationFromEntry(entry, projection.ownerAgentId)
        if (notification) taskNotifications.set(notification.toolUseId, notification)
      }
      const cursor = encodeTranscriptCursor({
        version: 2,
        size: fingerprint.size,
        ctimeMs: currentStat.ctimeMs,
        fileIdentity: currentIdentity,
        firstWindowHash: fingerprint.firstWindowHash,
        lastWindowHash: fingerprint.lastWindowHash,
        afterOrdinal: currentAfterOrdinal,
      })
      return {
        messages,
        ownerAgentIds: projection.ownerAgentIds ?? [],
        taskNotifications: [...taskNotifications.values()],
        signature,
        cursor,
        afterOrdinal: currentAfterOrdinal,
        ...(reset ? { reset: true } : {}),
      }
    } catch {
      return null
    }
  }

  /** Canonical parser used for legacy reads and every degraded/stale fallback. */
  private async parseTranscriptFilePage(
    filePath: string,
    options: TeamTranscriptPageOptions,
    projection: TranscriptFragmentProjection = {},
  ): Promise<TeamTranscriptPage> {
    const source = (await readLegacyTranscriptFiles([filePath]))[0]!
    const { bytes, stat } = source
    return this.parseTranscriptBufferPage(
      bytes,
      options,
      stat.ctimeMs,
      this.fileIdentity(stat),
      projection,
    )
  }

  private async parseTranscriptFragmentsPage(
    sources: Array<{ filePath: string; ownerAgentId?: string }>,
    options: TeamTranscriptPageOptions,
  ): Promise<TeamTranscriptPage> {
    const boundedFiles = await readLegacyTranscriptFiles(sources.map(source => source.filePath))
    const allFragments = sources.map((source, index) => ({
      ...source,
      bytes: boundedFiles[index]!.bytes,
      ctimeMs: boundedFiles[index]!.stat.ctimeMs,
    }))
    const fragments = dropSupersededTranscriptFragments(allFragments)
    const ownerAgentIdByOrdinal: Array<string | undefined> = []
    for (const fragment of fragments) {
      for (const line of fragment.bytes.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          JSON.parse(line)
          ownerAgentIdByOrdinal.push(fragment.ownerAgentId)
        } catch {
          // Keep this aligned with parseTranscriptBufferPage's ordinal rules.
        }
      }
    }
    const bytes = Buffer.concat(fragments.flatMap((fragment, index) => (
      index === fragments.length - 1
        ? [fragment.bytes]
        : [fragment.bytes, Buffer.from('\n')]
    )))
    return this.parseTranscriptBufferPage(
      bytes,
      options,
      Math.max(0, ...fragments.map(fragment => fragment.ctimeMs)),
      null,
      {
        ownerAgentIdByOrdinal,
        ownerAgentIds: [...new Set(fragments
          .map(fragment => fragment.ownerAgentId)
          .filter((ownerAgentId): ownerAgentId is string => Boolean(ownerAgentId)))],
      },
    )
  }

  private parseTranscriptBufferPage(
    bytes: Buffer,
    options: TeamTranscriptPageOptions,
    ctimeMs: number,
    identity: string | null,
    projection: TranscriptFragmentProjection = {},
  ): TeamTranscriptPage {
    const entries: Array<{
      ordinal: number
      message?: TranscriptMessage
      taskNotification?: SessionTaskNotification
      taskAnchors?: TeamTaskAnchor[]
    }> = []
    let ordinal = -1
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        ordinal += 1
        const ownerAgentId = projection.ownerAgentIdByOrdinal?.[ordinal] ??
          projection.ownerAgentId
        const message = this.transcriptMessageFromEntry(entry, ownerAgentId)
        const taskNotification = taskNotificationFromEntry(entry, ownerAgentId)
        const taskAnchors = message ? taskAnchorsFromMessage(message) : []
        if (message || taskNotification) {
          entries.push({
            ordinal,
            ...(message ? { message } : {}),
            ...(taskNotification ? { taskNotification } : {}),
            ...(taskAnchors.length > 0 ? { taskAnchors } : {}),
          })
        }
      } catch {
        // Skip unparseable lines
      }
    }
    const currentAfterOrdinal = ordinal
    const signature = hash(bytes)
    const previousCursor = decodeTranscriptCursor(options.cursor)
    let afterOrdinal = options.afterOrdinal ?? -1
    let reset = false
    if (options.cursor !== undefined && !previousCursor) {
      afterOrdinal = -1
      reset = true
    } else if (afterOrdinal >= 0 && !options.signature) {
      afterOrdinal = -1
      reset = true
    } else if (afterOrdinal > currentAfterOrdinal) {
      afterOrdinal = -1
      reset = true
    } else if (previousCursor && previousCursor.afterOrdinal !== afterOrdinal) {
      afterOrdinal = -1
      reset = true
    } else if (options.signature) {
      if (options.signature === signature) {
        const snapshotMismatch = previousCursor &&
          (
            previousCursor.size !== bytes.length ||
            previousCursor.ctimeMs !== ctimeMs ||
            (
              previousCursor.fileIdentity !== null &&
              identity !== null &&
              previousCursor.fileIdentity !== identity
            )
          )
        if (snapshotMismatch) {
          afterOrdinal = -1
          reset = true
        }
      } else {
        const appendProven = previousCursor &&
          bytes.length > previousCursor.size &&
          bufferPreservesCursorPrefix(bytes, previousCursor, identity)
        if (!appendProven) {
          afterOrdinal = -1
          reset = true
        }
      }
    }
    const cursor = encodeTranscriptCursor(cursorForBuffer(
      bytes,
      identity,
      ctimeMs,
      currentAfterOrdinal,
    ))
    return {
      messages: entries
        .filter((entry): entry is typeof entry & { message: TranscriptMessage } => (
          entry.ordinal > afterOrdinal && entry.message !== undefined
        ))
        .map(entry => entry.message),
      ownerAgentIds: projection.ownerAgentIds ?? [],
      taskAnchors: entries
        .filter(entry => entry.ordinal > afterOrdinal && entry.taskAnchors !== undefined)
        .flatMap(entry => entry.taskAnchors!),
      taskNotifications: [...entries
        .filter((entry): entry is typeof entry & { taskNotification: SessionTaskNotification } => (
          entry.ordinal > afterOrdinal && entry.taskNotification !== undefined
        ))
        .reduce((notifications, entry) => {
          notifications.set(entry.taskNotification.toolUseId, entry.taskNotification)
          return notifications
        }, new Map<string, SessionTaskNotification>())
        .values()],
      signature,
      cursor,
      afterOrdinal: currentAfterOrdinal,
      ...(reset ? { reset: true } : {}),
    }
  }
}

export const teamService = new TeamService()
