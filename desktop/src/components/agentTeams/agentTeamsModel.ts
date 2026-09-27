import { AGENT_LIFECYCLE_TYPES } from '../../types/team'
import type {
  TeamMember,
  TeamWorkbenchMessage,
  TeamWorkbenchSnapshot,
  TeamWorkbenchTask,
} from '../../types/team'

export type WorkbenchTaskState = 'blocked' | 'open' | 'running' | 'completed'
export type WorkbenchPhase = 'forming' | 'running' | 'finishing' | 'completed'
export type MemberAvatarKey =
  | 'team-lead'
  | 'server-engineer'
  | 'ui-designer'
  | 'qa-engineer'
  | 'security-reviewer'
  | 'data-analyst'
  | 'release-engineer'
  | 'docs-coordinator'

export type PositionedWorkbenchTask = {
  task: TeamWorkbenchTask
  state: WorkbenchTaskState
  /**
   * How many dependencies deep the task sits, counted along its longest path.
   * This is the number that describes where a task falls in the plan; the task
   * id only records the order the lead happened to write the tasks down. Each
   * depth owns one left-to-right lane regardless of that authored order.
   */
  depth: number
  /** Stable vertical slot inside the dependency lane. */
  row: number
  x: number
  y: number
}

export type WorkbenchLane = {
  depth: number
  x: number
  y: number
  width: number
  height: number
  count: number
}

export type WorkbenchLayout = {
  tasks: PositionedWorkbenchTask[]
  byId: Map<string, PositionedWorkbenchTask>
  lanes: WorkbenchLane[]
  width: number
  height: number
  legendY: number
  columns: number
}

const LANE_WIDTH = 216
const LANE_GAP = 20
const TASK_WIDTH = 200
const TASK_HEIGHT = 92
const HORIZONTAL_PADDING = 32
const LANE_TOP = 410
const TASK_TOP = 442
const ROW_GAP = 14
const LEGEND_GAP = 12
const CANVAS_BOTTOM_PADDING = 46

const TASK_ID_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
})

function compareTaskIds(left: string, right: string): number {
  const naturalOrder = TASK_ID_COLLATOR.compare(left, right)
  if (naturalOrder !== 0) return naturalOrder
  return left < right ? -1 : left > right ? 1 : 0
}

const WORKER_AVATARS: Array<{
  key: Exclude<MemberAvatarKey, 'team-lead'>
  matches: RegExp
}> = [
  { key: 'release-engineer', matches: /release|\bbuild\b|package|deploy|\bops\b|\bci\b|ship/ },
  { key: 'security-reviewer', matches: /security|secure|audit|risk|threat|review/ },
  { key: 'qa-engineer', matches: /\bqa\b|test|quality|verify|verification/ },
  { key: 'ui-designer', matches: /\bui\b|\bux\b|frontend|desktop|design|theme|accessib/ },
  { key: 'server-engineer', matches: /server|backend|\bapi\b|runtime|watcher|service|contract/ },
  { key: 'data-analyst', matches: /data|research|analyst|replay|state|investigat|explor/ },
  { key: 'docs-coordinator', matches: /docs?|product|spec|writer|coordinat/ },
]

function stableHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

/**
 * Keeps a teammate's visual identity stable across snapshots while still
 * assigning the purpose-built occupational art when its role is known.
 */
export function getMemberAvatarKey(member: TeamMember, isLead = false): MemberAvatarKey {
  if (isLead) return 'team-lead'
  const identity = [member.name, member.role, member.agentId, member.currentTask]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const matched = WORKER_AVATARS.find(({ matches }) => matches.test(identity))
  if (matched) return matched.key
  return WORKER_AVATARS[stableHash(member.agentId) % WORKER_AVATARS.length]!.key
}

/**
 * Short family label for a model id or alias, used by compact UI chips.
 * 'claude-opus-4-8' -> 'opus', 'eu.anthropic.claude-sonnet-5' -> 'sonnet',
 * 'sonnet' -> 'sonnet'. Unrecognized values are returned trimmed and unchanged
 * rather than being forced into a family.
 *
 * A trailing context-window tag (`[1m]`) is a routing detail, not part of the
 * name a reader recognises, so it is dropped before matching.
 */
export function shortModelLabel(model: string): string {
  const untagged = model.trim().replace(/\[[^\]]*\]$/, '').trim()
  // A value that was nothing but a tag keeps its original form rather than
  // collapsing to an empty label.
  const trimmed = untagged || model.trim()
  if (!trimmed) return trimmed
  const lowered = trimmed.toLowerCase()
  if (lowered.includes('opus')) return 'opus'
  if (lowered.includes('sonnet')) return 'sonnet'
  if (lowered.includes('haiku')) return 'haiku'
  if (lowered.includes('fable')) return 'fable'
  return trimmed
}

export type MemberModelDisplay = {
  /** Short chip label, e.g. 'opus'. */
  label: string
  /** Full model id or alias, used for the hover tooltip. */
  full: string
  /** True when the member runs on the lead's model rather than one of its own. */
  inherited: boolean
}

/**
 * Model display for one member. Returns undefined when nothing is known, so
 * callers render no chip instead of an empty or 'undefined' label.
 *
 * `leadModel` is the lead member's model. Callers pass undefined for the lead
 * itself; a lead without an explicit model therefore renders no chip.
 */
export function resolveMemberModel(
  member: TeamMember,
  leadModel?: string,
): MemberModelDisplay | undefined {
  const memberModelRaw = member.model
  const memberModel = typeof memberModelRaw === 'string' ? memberModelRaw.trim() : ''
  if (memberModel && memberModel.toLowerCase() !== 'inherit') {
    return {
      label: shortModelLabel(memberModel),
      full: memberModel,
      inherited: false,
    }
  }
  const resolvedLead = typeof leadModel === 'string' ? leadModel.trim() : ''
  if (resolvedLead) {
    return {
      label: shortModelLabel(resolvedLead),
      full: resolvedLead,
      inherited: true,
    }
  }
  return undefined
}

function identityAliases(value: string): string[] {
  const normalized = value.trim().toLowerCase()
  const short = normalized.split('@')[0] ?? normalized
  return normalized === short ? [normalized] : [normalized, short]
}

function sameTeamMember(left: TeamMember, right: TeamMember): boolean {
  const leftAliases = [
    ...identityAliases(left.agentId),
    ...(left.name ? identityAliases(left.name) : []),
  ]
  const rightAliases = [
    ...identityAliases(right.agentId),
    ...(right.name ? identityAliases(right.name) : []),
  ]
  return leftAliases.some(alias => rightAliases.includes(alias))
}

/**
 * Team config is a mutable live roster, while the workbench is a run history.
 * Rebuild the roster by replaying snapshots so a teammate removed during
 * shutdown still owns its completed task and can reopen its transcript.
 */
export function snapshotWithHistoricalMembers(
  snapshots: TeamWorkbenchSnapshot[],
  selectedIndex: number,
): TeamWorkbenchSnapshot | undefined {
  const selected = snapshots[selectedIndex]
  if (!selected) return undefined

  let members: TeamMember[] = []
  for (const snapshot of snapshots.slice(0, selectedIndex + 1)) {
    const remaining = [...snapshot.team.members]
    members = members.map((historicalMember) => {
      const currentIndex = remaining.findIndex(member => sameTeamMember(historicalMember, member))
      if (currentIndex < 0) {
        return {
          ...historicalMember,
          status: historicalMember.status === 'error' ? 'error' : 'completed',
        }
      }
      const [currentMember] = remaining.splice(currentIndex, 1)
      const merged = { ...historicalMember, ...currentMember! }
      // A later frame can land with `model: undefined`, which would clobber a
      // model already learned from an earlier snapshot. Restore the historical
      // model when the incoming member has no model of its own.
      const currentModel = currentMember?.model
      const hasCurrentModel = typeof currentModel === 'string' && currentModel.trim() !== ''
      return hasCurrentModel ? merged : { ...merged, model: historicalMember.model }
    })
    members.push(...remaining)
  }

  return {
    ...selected,
    team: {
      ...selected.team,
      members,
    },
  }
}

/**
 * Resolves the same persisted teammate identity for the DAG, communication
 * feed, and member transcript. A sender can be serialized as either its bare
 * name or full `name@team` id, but it must keep one visual character.
 */
export function resolveTeamMemberIdentity(
  team: TeamWorkbenchSnapshot['team'],
  value: string,
): { member: TeamMember; isLead: boolean } {
  const aliases = identityAliases(value)
  const member = team.members.find((candidate) => {
    const candidateAliases = [
      ...identityAliases(candidate.agentId),
      ...(candidate.name ? identityAliases(candidate.name) : []),
    ]
    return aliases.some((alias) => candidateAliases.includes(alias))
  }) ?? {
    agentId: value,
    name: value,
    role: value,
    status: 'idle' as const,
  }
  const leadAliases = team.leadAgentId ? identityAliases(team.leadAgentId) : []
  const memberAliases = [
    ...identityAliases(member.agentId),
    ...(member.name ? identityAliases(member.name) : []),
  ]
  const isLead = aliases.includes('team-lead')
    || leadAliases.some((alias) => aliases.includes(alias) || memberAliases.includes(alias))

  return { member, isLead }
}

export type MemberWorkState = 'working' | 'idle' | 'stopped' | 'exited' | 'error'

/**
 * What the member itself is doing, which is never what its tasks say. A task
 * stays `in_progress` from the moment a teammate claims it until the teammate
 * remembers to close it -- across turn boundaries, and for umbrella tasks
 * across the whole run -- so reading activity off the task list reported every
 * member as permanently working.
 *
 * The lead has no runner writing turn markers for it, so its caller supplies
 * whether its session is streaming.
 */
export function getMemberWorkState(
  member: TeamMember,
  options: { isLead?: boolean; leadIsStreaming?: boolean } = {},
): MemberWorkState {
  if (member.status === 'completed' || member.activity === 'exited') return 'exited'
  if (member.status === 'error') return 'error'
  if (options.isLead) return options.leadIsStreaming ? 'working' : 'idle'
  if (member.activity === 'active') return 'working'
  if (member.activity === 'idle') return 'idle'
  // `unknown` means the backend records no turn markers and left no transcript
  // to date, so fall back to the coarser roster status.
  return member.status === 'running' ? 'working' : 'idle'
}

export type TaskOwnerAttribution = {
  identity: string
  /** True when the name was recovered from the mailbox rather than recorded. */
  inferred: boolean
}

/**
 * Who did a task. `task.owner` is authoritative, but runs archived before
 * batch-closed tasks recorded an owner left some finished work attributed to
 * nobody. The assignment envelope that reached a teammate's inbox names the
 * same person, so it recovers the answer for that history. The result is marked
 * inferred so the UI can present it as a reconstruction rather than as fact.
 */
export function inferTaskOwner(
  task: TeamWorkbenchTask,
  snapshot: TeamWorkbenchSnapshot,
): TaskOwnerAttribution | undefined {
  const owner = task.owner?.trim()
  if (owner) return { identity: owner, inferred: false }

  // Messages are stored in send order. A task can be reassigned before it is
  // completed, so the last matching envelope is the only one that describes
  // its final owner in this frame.
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const assignment = snapshot.messages[index]!
    if (
      assignment.protocolType !== 'task_assignment' ||
      assignment.taskId !== task.id
    ) continue
    const recipient = assignment.recipients[0]?.trim()
    if (recipient) return { identity: recipient, inferred: true }
  }
  return undefined
}

export function getWorkbenchTaskState(
  task: TeamWorkbenchTask,
  tasksById: Map<string, TeamWorkbenchTask>,
): WorkbenchTaskState {
  if (task.status === 'completed') return 'completed'
  if (task.status === 'in_progress') return 'running'
  // A dependency the task list no longer contains was deleted, and the runtime
  // treats a blocker it cannot find as resolved -- it only refuses to claim a
  // task while a blocker is still open. Reading a missing blocker as unfinished
  // stranded such a task in `blocked` forever, and disagreed with `taskDepths`,
  // which has always ignored dependencies outside the list.
  const hasOpenDependency = task.blockedBy.some((dependencyId) => {
    const dependency = tasksById.get(dependencyId)
    return dependency !== undefined && dependency.status !== 'completed'
  })
  return hasOpenDependency ? 'blocked' : 'open'
}

/** Longest dependency path with deterministic fallbacks for missing nodes/cycles. */
function taskDepths(tasks: TeamWorkbenchTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()

  const depthOf = (taskId: string): number => {
    const cached = depths.get(taskId)
    if (cached !== undefined) return cached
    if (visiting.has(taskId)) return 0
    const task = byId.get(taskId)
    if (!task) return 0

    visiting.add(taskId)
    const dependencies = task.blockedBy
      .filter((dependencyId) => byId.has(dependencyId))
      .sort(compareTaskIds)
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(depthOf))
    visiting.delete(taskId)
    depths.set(taskId, depth)
    return depth
  }

  for (const task of tasks) depthOf(task.id)
  return depths
}

export function layoutWorkbenchTasks(
  tasks: TeamWorkbenchTask[],
  requestedWidth: number,
): WorkbenchLayout {
  const sortedTasks = tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => (
      compareTaskIds(left.task.id, right.task.id) || left.index - right.index
    ))
    .map(({ task }) => task)
  const depths = taskDepths(sortedTasks)
  const byLayer = new Map<number, TeamWorkbenchTask[]>()

  for (const task of sortedTasks) {
    const depth = depths.get(task.id) ?? 0
    const layer = byLayer.get(depth)
    if (layer) layer.push(task)
    else byLayer.set(depth, [task])
  }

  const columns = sortedTasks.length === 0
    ? 0
    : Math.max(...Array.from(depths.values())) + 1
  const naturalWidth = HORIZONTAL_PADDING * 2
    + columns * LANE_WIDTH
    + Math.max(0, columns - 1) * LANE_GAP
  const minimumWidth = Number.isFinite(requestedWidth)
    ? Math.max(0, Math.round(requestedWidth))
    : 0
  const width = Math.max(naturalWidth, minimumWidth)
  const startX = (width - naturalWidth) / 2 + HORIZONTAL_PADDING
  const maxRows = Math.max(0, ...Array.from(byLayer.values(), layer => layer.length))
  const taskStackHeight = maxRows === 0
    ? 0
    : maxRows * TASK_HEIGHT + (maxRows - 1) * ROW_GAP
  const laneHeight = (TASK_TOP - LANE_TOP) * 2 + taskStackHeight
  const lanes: WorkbenchLane[] = Array.from({ length: columns }, (_, depth) => ({
    depth,
    x: startX + depth * (LANE_WIDTH + LANE_GAP),
    y: LANE_TOP,
    width: LANE_WIDTH,
    height: laneHeight,
    count: byLayer.get(depth)?.length ?? 0,
  }))

  const tasksById = new Map(sortedTasks.map((task) => [task.id, task]))
  const positioned: PositionedWorkbenchTask[] = []
  for (const lane of lanes) {
    const layer = byLayer.get(lane.depth) ?? []
    layer.forEach((task, row) => {
      positioned.push({
        task,
        state: getWorkbenchTaskState(task, tasksById),
        depth: lane.depth,
        row,
        x: lane.x + (LANE_WIDTH - TASK_WIDTH) / 2,
        y: TASK_TOP + row * (TASK_HEIGHT + ROW_GAP),
      })
    })
  }

  return {
    tasks: positioned,
    byId: new Map(positioned.map((task) => [task.task.id, task])),
    lanes,
    width,
    height: LANE_TOP + laneHeight + CANVAS_BOTTOM_PADDING,
    legendY: LANE_TOP + laneHeight + LEGEND_GAP,
    columns,
  }
}

function memberNames(member: TeamMember): string[] {
  return [
    member.agentId,
    member.agentId.split('@')[0] ?? '',
    member.name ?? '',
  ].filter(Boolean)
}

export function taskOwnedByMember(
  task: TeamWorkbenchTask,
  member: TeamMember,
): boolean {
  if (!task.owner) return false
  return memberNames(member).includes(task.owner)
}

export function runningTaskForMember(
  tasks: TeamWorkbenchTask[],
  member: TeamMember,
): TeamWorkbenchTask | undefined {
  return tasks.find((task) => task.status === 'in_progress' && taskOwnedByMember(task, member))
}

/**
 * The one task a member is on right now, which is what decides where its
 * character stands on the map.
 *
 * A member routinely owns several open tasks at once: the umbrella task its
 * lead assigned stays `in_progress` for the whole run while the member works
 * through the smaller tasks it created underneath. Picking the first owned task
 * therefore parked every member on its umbrella, because the task list is
 * ordered by id and the umbrella was created first. Reading the snapshot
 * history instead -- which task most recently *became* `in_progress` -- follows
 * the member through its actual work.
 */
export function currentTaskForMember(
  snapshots: TeamWorkbenchSnapshot[],
  selectedIndex: number,
  member: TeamMember,
): TeamWorkbenchTask | undefined {
  const selected = snapshots[selectedIndex]
  if (!selected) return undefined
  const running = selected.tasks.filter((task) => (
    task.status === 'in_progress' && taskOwnedByMember(task, member)
  ))
  if (running.length <= 1) return running[0]

  const startedBefore = new Set<string>()
  let latest: TeamWorkbenchTask | undefined
  for (const snapshot of snapshots.slice(0, selectedIndex + 1)) {
    for (const task of snapshot.tasks) {
      if (task.status !== 'in_progress') continue
      if (!startedBefore.has(task.id)) {
        startedBefore.add(task.id)
        const match = running.find((candidate) => candidate.id === task.id)
        if (match) latest = match
      }
    }
  }
  if (latest) return latest

  // A timeline that starts mid-run (an archive opened cold) never witnessed the
  // transitions. A task that blocks nothing is a leaf the member is doing now,
  // whereas an umbrella task exists to hold others up.
  return running.find((task) => task.blocks.length === 0) ??
    running[running.length - 1]
}

export function getWorkbenchPhase(snapshot: TeamWorkbenchSnapshot): WorkbenchPhase {
  if (snapshot.deletedAt) return 'completed'
  if (snapshot.tasks.length === 0) return 'forming'
  if (snapshot.tasks.every((task) => task.status === 'completed')) return 'finishing'
  return 'running'
}

export function getWorkbenchProgress(snapshot: TeamWorkbenchSnapshot) {
  const total = snapshot.tasks.length
  const completed = snapshot.tasks.filter((task) => task.status === 'completed').length
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

/**
 * A workbench message is either something a teammate wrote or a protocol
 * signal the runtime emitted. The feed used to print the latter as raw JSON
 * (`{"type":"idle_notification",...}`), which is both unreadable and the
 * opposite of what the transcript does — `extractVisibleTeammateMessageContents`
 * has always dropped these payloads from chat. Classifying here lets the feed
 * render a sentence and de-emphasise it instead.
 */
export type WorkbenchMessageBody =
  | { kind: 'text'; text: string }
  | { kind: 'assignment'; taskId?: string; subject?: string; selfClaim: boolean }
  | { kind: 'lifecycle'; type: string; detail?: string }

/**
 * Protocol payloads the feed states in words rather than dumping verbatim.
 *
 * `task_assignment` is deliberately absent: it records a task being picked up,
 * which is the first half of everything a team does. Filing it with shutdown
 * and idle chatter hid it behind a collapsed toggle and left the feed reporting
 * "0 messages" for a team that had just handed out all of its work.
 */
const NARRATED_PROTOCOL_TYPES = new Set([
  ...AGENT_LIFECYCLE_TYPES,
  'shutdown_response',
])

const LIFECYCLE_DETAIL_FIELDS = ['idleReason', 'reason', 'detail', 'message'] as const
const READABLE_BODY_FIELDS = ['message', 'content', 'text', 'summary', 'reason'] as const

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function firstNonEmptyString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = record[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export function parseWorkbenchMessageBody(
  message: Pick<TeamWorkbenchMessage, 'text' | 'protocolType'> &
    Partial<Pick<TeamWorkbenchMessage, 'from' | 'recipients'>>,
): WorkbenchMessageBody {
  const raw = message.text?.trim() ?? ''
  const senderAliases = identityAliases(message.from ?? '')
  const selfClaim = Boolean(message.recipients?.some((recipient) => (
    identityAliases(recipient).some((alias) => senderAliases.includes(alias))
  )))
  const payload = parseJsonObject(raw)
  const payloadType = typeof payload?.type === 'string' ? payload.type : undefined
  const type = message.protocolType ?? payloadType

  if (type === 'task_assignment') {
    // A teammate that claims its own next task addresses the envelope to
    // itself, which is what separates picking work up from being handed it.
    // The server projects a structured assignment to `text = subject` while
    // retaining `protocolType`; archives can still contain the original JSON.
    const structuredSubject = payloadType === 'task_assignment' && typeof payload?.subject === 'string'
      ? payload.subject.trim()
      : ''
    const subject = structuredSubject || (
      message.protocolType === 'task_assignment' && payloadType !== 'task_assignment'
        ? raw
        : ''
    )
    return {
      kind: 'assignment',
      selfClaim,
      ...(typeof payload?.taskId === 'string' ? { taskId: payload.taskId } : {}),
      ...(subject ? { subject } : {}),
    }
  }

  if (type && NARRATED_PROTOCOL_TYPES.has(type)) {
    return {
      kind: 'lifecycle',
      type,
      ...(payload ? { detail: firstNonEmptyString(payload, LIFECYCLE_DETAIL_FIELDS) } : {}),
    }
  }

  // An unrecognised JSON payload still beats raw braces: surface whichever
  // field actually carries prose, and only fall back to the literal text when
  // nothing readable is in there.
  if (payload) {
    return { kind: 'text', text: firstNonEmptyString(payload, READABLE_BODY_FIELDS) ?? raw }
  }
  return { kind: 'text', text: raw }
}

/**
 * Wall-clock time the message was sent. The feed previously stamped every row
 * with `T+{snapshotIndex}`, which is identical for every message in a snapshot
 * and therefore carries no information at all.
 */
export function formatWorkbenchMessageTime(timestamp: string): string {
  const time = new Date(timestamp)
  return Number.isNaN(time.getTime())
    ? ''
    : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function memberInitials(member: TeamMember): string {
  const source = member.name || member.role || member.agentId.split('@')[0] || 'AG'
  const words = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (words.length > 1
    ? words.slice(0, 2).map((word) => word[0]).join('')
    : source.slice(0, 2)
  ).toUpperCase()
}

export const WORKBENCH_TASK_WIDTH = TASK_WIDTH
export const WORKBENCH_TASK_HEIGHT = TASK_HEIGHT
