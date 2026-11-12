import type { ApiClient } from './client'
import { isAgent, sessionPath, type BackgroundSnapshot, type BackgroundTask } from './operations'
import { liveFor } from './subagentLive'
import type { ClientMessage, SubagentLive, SubagentStep } from './types'
import { describeStep } from '../ui/chat/steps'
import {
  loadTaskList,
  loadTeam,
  memberState,
  taskProgress,
  memberTasks,
  taskState,
  teamMembers,
  latestTeam,
  type TaskInfo,
  type TeamWorkbenchSessionTimeline,
} from '../ui/activity/activityData'
import { taskTitle } from '../ui/activity/taskLabels'
import { plural } from './plural'

/* ───────────── Data ───────────── */

export type ActivityData = {
  /** Session task list. */
  tasks: TaskInfo[]
  /** null when there is no team (404). */
  team: TeamWorkbenchSessionTimeline | null
  background: BackgroundTask[]
  /** At least one read has finished (success or failure). */
  loaded: boolean
  error: string
  /** Tasks with a stop request sent whose end has not been seen yet. */
  stopping: Record<string, true>
  stopError: string
}

export const emptyActivityData: ActivityData = {
  tasks: [],
  team: null,
  background: [],
  loaded: false,
  error: '',
  stopping: {},
  stopError: '',
}

/* ───────────── Derived ───────────── */

export type PlanTask = {
  id: string
  title: string
  state: 'done' | 'active' | 'waiting' | 'todo'
  /** In-progress task: what it is doing (activeForm). */
  detail?: string
  owner?: string
}
export type StepLine = {
  verb: string
  object?: string
  mono: boolean
  done: boolean
  error: boolean
}
export type SubagentRow = {
  id: string
  task: BackgroundTask
  title: string
  status: BackgroundTask['status']
  /** Start time (ms); absent if the computer did not provide it. */
  startedAt?: number
  /** "Read 5 files" / "8 tool calls"; not shown without data. */
  stats?: string
  /** Last two steps, only present with live data. */
  steps: StepLine[]
  stopping: boolean
}
export type CommandRow = {
  id: string
  task: BackgroundTask
  command: string
  status: BackgroundTask['status']
  startedAt?: number
  lastLine?: string
  stopping: boolean
}
export type TeamTask = {
  /** Unique within the list: the lead's own list and the team board each have their own numbering. */
  key: string
  /** Team board number (#3), referenced in dependency descriptions; the lead's own list has none. */
  ref?: string
  title: string
  state: PlanTask['state']
  detail?: string
  /** Numbers of unfinished prerequisite tasks. */
  waitingOn: string[]
}
export type TeamRow = {
  id: string
  name: string
  /** Two letters in the avatar; the lead is "L". */
  mark: string
  lead: boolean
  model?: string
  state: string
  detail?: string
  tone: 'run' | 'wait' | 'idle' | 'err'
  /** Each member is an agent; tasks it claims and drives itself hang under its name. */
  tasks: TeamTask[]
}
export type TeamModel = {
  name: string
  incarnationId?: string
  leadSessionId?: string
  members: TeamRow[]
  /** Tasks on the team board not yet claimed by anyone. */
  unassigned: TeamTask[]
  progress: { done: number; total: number }
  summary: string
}
export type ActivityProgress = {
  done: number
  total: number
  /** activeForm / title of the in-progress task, used for a one-line summary. */
  active?: string
}
export type SessionActivityModel = {
  progress: ActivityProgress
  tasks: PlanTask[]
  subagents: SubagentRow[]
  team: TeamModel | null
  commands: CommandRow[]
  /** Only running subagents + background commands. The capsule badge and sheet title share this number. */
  runningCount: number
  /** attention when approvals are pending, otherwise run. */
  tone: 'run' | 'attention'
  /** Whether the capsule should show. */
  capsuleVisible: boolean
  /** Whether the capsule spins. */
  active: boolean
}

const textOf = (value: string | undefined) => value?.trim() || undefined

export function planTasks(tasks: readonly TaskInfo[]): PlanTask[] {
  return tasks.map((task) => {
    const state = taskState(task, [...tasks])
    return {
      id: task.id,
      title: task.subject,
      state:
        state === 'Done' ? 'done' : state === 'In progress' ? 'active' : state === 'Waiting on dependencies' ? 'waiting' : 'todo',
      ...(state === 'In progress' && textOf(task.activeForm) ? { detail: textOf(task.activeForm) } : {}),
      ...(textOf(task.owner) ? { owner: textOf(task.owner) } : {}),
    }
  })
}

export function taskProgressOf(tasks: readonly PlanTask[], source: readonly TaskInfo[]): ActivityProgress {
  const active = source.find((task) => task.status === 'in_progress')
  return {
    done: tasks.filter((task) => task.state === 'done').length,
    total: tasks.length,
    ...(active ? { active: textOf(active.activeForm) ?? active.subject } : {}),
  }
}

export function stepLine(step: SubagentStep, workDir?: string | null): StepLine {
  const label = describeStep(
    { id: step.toolUseId, type: 'tool', text: '', toolName: step.toolName, input: step.input },
    workDir
  )
  return {
    verb: label.verb,
    object: label.object,
    mono: label.mono,
    done: step.done,
    error: step.isError === true,
  }
}

const parseStart = (value?: string) => {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/** Second line of a subagent card: while running prefer how many files were read; after finishing, how many tool calls. */
export function subagentStats(
  status: BackgroundTask['status'],
  live: { reads: number; toolUses?: number } | null
): string | undefined {
  if (!live) return undefined
  if (status === 'running') {
    if (live.reads > 0) return `Read ${plural(live.reads, 'file')}`
    if (live.toolUses) return `${live.toolUses} tool calls`
    return undefined
  }
  if (live.toolUses) return `${live.toolUses} tool calls`
  if (live.reads > 0) return `Read ${plural(live.reads, 'file')}`
  return undefined
}

const statusRank: Record<BackgroundTask['status'], number> = { running: 0, failed: 1, stopped: 2, completed: 3 }
/** Running ones first; the same state keeps the order given by the computer. */
function byStatus<T extends { status: BackgroundTask['status'] }>(rows: T[]) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => statusRank[a.row.status] - statusRank[b.row.status] || a.index - b.index)
    .map((entry) => entry.row)
}

export function subagentRows(
  background: readonly BackgroundTask[],
  live: Record<string, SubagentLive> | undefined,
  stopping: Record<string, true>,
  workDir?: string | null
): SubagentRow[] {
  return byStatus(
    background.filter(isAgent).map((task) => {
      const data = liveFor(live, task)
      return {
        id: task.taskId,
        task,
        title: taskTitle(task),
        status: task.status,
        startedAt: parseStart(task.startedAt),
        stats: subagentStats(task.status, data),
        steps:
          task.status === 'running' && data
            ? data.steps.slice(-2).map((step) => stepLine(step, workDir))
            : [],
        stopping: !!task.stopping || !!stopping[task.taskId],
      }
    })
  )
}

const lastLine = (text?: string) => {
  const lines = (text ?? '').split('\n').map((line) => line.trimEnd()).filter((line) => line.trim())
  return lines.at(-1)
}

export function commandRows(
  background: readonly BackgroundTask[],
  stopping: Record<string, true>
): CommandRow[] {
  return byStatus(
    background
      .filter((task) => !isAgent(task))
      .map((task) => ({
        id: task.taskId,
        task,
        command: taskTitle(task),
        status: task.status,
        startedAt: parseStart(task.startedAt),
        lastLine: lastLine(task.result || task.summary),
        stopping: !!task.stopping || !!stopping[task.taskId],
      }))
  )
}

/**
 * Two letters in the avatar: backend-dev → BD, reviewer → RE. Must not collide within a team: 
 * if taken, use the first letter plus a later letter (researcher gets RE first, so reviewer is RV).
 */
export function memberMark(name: string, taken: ReadonlySet<string> = new Set()) {
  const words = name.split(/[-_\s@.]+/).filter(Boolean)
  const word = words[0] ?? name
  const candidates = [
    words.length > 1 ? word[0]! + words[1]![0]! : word.slice(0, 2),
    ...[...word.slice(1)].map((letter) => word[0]! + letter),
  ].map((letters) => letters.toUpperCase())
  return candidates.find((mark) => !taken.has(mark)) ?? (candidates[0] || '?')
}

/** `list` tasks in it, with dependencies resolved against `all`: a member's prerequisites often belong to others. */
function teamTasks(list: readonly TaskInfo[], all: readonly TaskInfo[], numbered: boolean): TeamTask[] {
  const open = (id: string) => all.some((other) => other.id === id && other.status !== 'completed')
  return list.map((task) => {
    const state = taskState(task, [...all])
    const detail = state === 'In progress' ? textOf(task.activeForm) : undefined
    return {
      key: `${numbered ? 'team' : 'own'}:${task.id}`,
      ...(numbered ? { ref: task.id } : {}),
      title: task.subject,
      state: state === 'Done' ? 'done' : state === 'In progress' ? 'active' : state === 'Waiting on dependencies' ? 'waiting' : 'todo',
      ...(detail ? { detail } : {}),
      waitingOn: state === 'Waiting on dependencies' ? task.blockedBy.filter(open) : [],
    }
  })
}

/**
 * A team appears only while "alive"; archived or deleted teams are not running. Tasks hang under members by owner, 
 * and under the lead is the session's own list (`ownTasks`) plus the board tasks it claimed.
 */
export function teamModel(
  timeline: TeamWorkbenchSessionTimeline | null,
  ownTasks: readonly TaskInfo[] = [],
  /** Member page: members and their records must still be viewable after the team wraps up and is archived. */
  options: { ended?: boolean } = {}
): TeamModel | null {
  const snapshot = latestTeam(timeline)
  if (!timeline || !snapshot) return null
  if (!options.ended && (snapshot.deletedAt || timeline.source !== 'live')) return null
  const board = snapshot.tasks
  const members = teamMembers(timeline)
  const claimed = new Set<string>()
  const marks = new Set<string>()
  const rows: TeamRow[] = members.map((member) => {
    const lead = snapshot.team.leadAgentId === member.agentId
    const state = memberState(member)
    const owned = memberTasks(member, board)
    for (const task of owned) claimed.add(task.id)
    const current = owned.find((task) => task.status === 'in_progress')
    const blocked = owned.find((task) => taskState(task, board) === 'Waiting on dependencies')
    const waiting = !current && !!blocked && state === 'Idle'
    const label = waiting ? 'Waiting on dependencies' : state
    const detail = current ? (textOf(current.activeForm) ?? current.subject) : undefined
    const name = lead ? 'Lead' : member.name || member.agentId
    const mark = lead ? 'L' : memberMark(name, marks)
    marks.add(mark)
    return {
      id: member.agentId,
      name,
      mark,
      lead,
      ...(textOf(member.model) ? { model: textOf(member.model) } : {}),
      state: label,
      detail,
      tone:
        label === 'Working'
          ? 'run'
          : label === 'Waiting on dependencies' || label === 'Waiting to retry'
            ? 'wait'
            : label === 'Error'
              ? 'err'
              : 'idle',
      tasks: [...(lead ? teamTasks(ownTasks, ownTasks, false) : []), ...teamTasks(owned, board, true)],
    }
  })
  rows.sort((a, b) => Number(b.lead) - Number(a.lead))
  const { completed, total } = taskProgress(board)
  const progress = { done: completed, total }
  return {
    name: snapshot.team.name,
    ...(snapshot.team.incarnationId ? { incarnationId: snapshot.team.incarnationId } : {}),
    ...(snapshot.team.leadSessionId ? { leadSessionId: snapshot.team.leadSessionId } : {}),
    members: rows,
    unassigned: teamTasks(board.filter((task) => !claimed.has(task.id)), board, true),
    progress,
    summary: [snapshot.team.name, progress.total ? `${progress.done}/${progress.total} done` : plural(rows.length, 'member')].join(' · '),
  }
}

/**
 * Stopping pauses the whole group but does not end the plan: the plan still says "running" while members may all have stopped or exited, 
 * so offering "Stop" then is meaningless (same as desktop areTeamMembersAllStopped). false when there is no roster to judge.
 */
export function teamMembersAllStopped(team: Pick<TeamModel, 'members'> | null | undefined) {
  const members = team?.members.filter((row) => !row.lead) ?? []
  return members.length > 0 && members.every((row) => row.state === 'Stopped' || row.state === 'Exited')
}

export function capsuleVisible(input: {
  runningCount: number
  progress: ActivityProgress
  turnActive: boolean
}) {
  const { runningCount, progress, turnActive } = input
  if (runningCount > 0) return true
  if (progress.total === 0) return false
  // List all done and this turn ended: all run-related UI disappears.
  return turnActive || progress.done < progress.total
}

export function deriveActivity(
  data: Pick<ActivityData, 'tasks' | 'team' | 'background' | 'stopping'>,
  options: {
    live?: Record<string, SubagentLive>
    pendingApprovals?: number
    turnActive?: boolean
    workDir?: string | null
  } = {}
): SessionActivityModel {
  const team = teamModel(data.team, data.tasks)
  const board = latestTeam(data.team)?.tasks ?? []
  // While the team runs, progress follows the team board and tasks hang under members; otherwise the session's own list comes first.
  const source = team && board.length ? board : data.tasks.length ? data.tasks : board
  const listed = planTasks(source)
  const tasks = team ? [] : listed
  const progress = taskProgressOf(listed, source)
  const teamWorking = team?.members.some((row) => !row.lead && row.tone === 'run') === true
  const subagents = subagentRows(data.background, options.live, data.stopping, options.workDir)
  const commands = commandRows(data.background, data.stopping)
  const runningCount =
    subagents.filter((row) => row.status === 'running').length +
    commands.filter((row) => row.status === 'running').length
  const turnActive = options.turnActive === true
  return {
    progress,
    tasks,
    subagents,
    team,
    commands,
    runningCount,
    tone: (options.pendingApprovals ?? 0) > 0 ? 'attention' : 'run',
    capsuleVisible: teamWorking || capsuleVisible({ runningCount, progress, turnActive }),
    active: turnActive || runningCount > 0 || teamWorking,
  }
}

/** One-liner on the right of the group title. */
export function sectionSummaries(model: SessionActivityModel) {
  const count = (rows: { status: BackgroundTask['status'] }[], finishedLabel: string) => {
    const running = rows.filter((row) => row.status === 'running').length
    const finished = rows.length - running
    return [running ? `${running} running` : '', finished ? `${finished} ${finishedLabel}` : '']
      .filter(Boolean)
      .join(' · ')
  }
  const inProgress = model.tasks.filter((task) => task.state === 'active').length
  return {
    tasks: [`${model.progress.done}/${model.progress.total} done`, inProgress ? `${inProgress} in progress` : '']
      .filter(Boolean)
      .join(' · '),
    subagents: count(model.subagents, 'done'),
    team: model.team?.summary ?? '',
    commands: count(model.commands, 'ended'),
  }
}

/* ───────────── Reading and polling ───────────── */

export type ActivityFetchResult = {
  tasks?: TaskInfo[]
  /** undefined = not read this time; null = no team. */
  team?: TeamWorkbenchSessionTimeline | null
  background?: BackgroundTask[]
  errors: string[]
}
export type ActivityFetcher = (
  signal: AbortSignal,
  options: { team: boolean }
) => Promise<ActivityFetchResult>

const reason = (error: unknown) => (error instanceof Error ? error.message : 'Failed to load')

/** Fetch three datasets in one place; one failing does not affect the others, and old data is kept. */
export function createActivityFetcher(client: ApiClient, sessionId: string): ActivityFetcher {
  return async (signal, options) => {
    const [tasks, team, background] = await Promise.allSettled([
      loadTaskList(client, sessionId, signal),
      options.team ? loadTeam(client, sessionId, signal) : Promise.resolve(undefined),
      client.get<BackgroundSnapshot>(`${sessionPath(sessionId)}/background-tasks`, { signal }),
    ])
    const errors: string[] = []
    const result: ActivityFetchResult = { errors }
    if (tasks.status === 'fulfilled') result.tasks = tasks.value
    else errors.push(`Tasks: ${reason(tasks.reason)}`)
    if (team.status === 'fulfilled') {
      if (team.value !== undefined) result.team = team.value
    } else errors.push(`Team: ${reason(team.reason)}`)
    if (background.status === 'fulfilled') result.background = background.value.tasks ?? []
    else errors.push(`Background: ${reason(background.reason)}`)
    return result
  }
}

export const ACTIVE_POLL_MS = 3500
/** When there is no team, wait this long before asking again to avoid a 404 every round. */
export const TEAM_RECHECK_MS = 15_000
export const STOP_TIMEOUT_MS = 15_000

export type PollInput = {
  enabled: boolean
  /** Page in foreground and the current screen has focus. */
  visible: boolean
  turnActive: boolean
  backgroundIds: number
  running: number
  teamActive: boolean
  /** Team plan approved but members not all in place yet. */
  teamLaunching?: boolean
}
/** Interval to the next poll; null = no polling (idle, page hidden or disabled). */
export function pollDelay(input: PollInput): number | null {
  if (!input.enabled || !input.visible) return null
  return input.turnActive || input.backgroundIds > 0 || input.running > 0 || input.teamActive || input.teamLaunching
    ? ACTIVE_POLL_MS
    : null
}

export type ActivityConfig = {
  enabled: boolean
  visible: boolean
  turnActive: boolean
  /** Fingerprint of currently active background task IDs; reread immediately on change. */
  backgroundKey: string
  /** `planId:state` of the team plan; on change (e.g. just approved) reread together with the team immediately. */
  teamPlanKey?: string
  /** Team launching: read the team every time so members show as soon as they are in place. */
  teamLaunching?: boolean
}
export type ActivityTimers = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
export type ActivityStoreDeps = {
  fetch: ActivityFetcher
  /** Sent to the computer via the session WebSocket; returns false if not sent. */
  send(message: ClientMessage): boolean
  timers?: ActivityTimers
  now?(): number
}

const defaultTimers: ActivityTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * The single source of the three activity datasets: read at intervals only while running/with background tasks, stop when the page is hidden or idle; 
 * config changes (starting to run, background tasks changing, returning to foreground) trigger an immediate read, and overlapping reads merge into one.
 */
export class ActivityStore {
  #data: ActivityData = emptyActivityData
  #config: ActivityConfig = { enabled: false, visible: true, turnActive: false, backgroundKey: '' }
  #listeners = new Set<() => void>()
  #timers: ActivityTimers
  #now: () => number
  #poll: unknown
  #controller?: AbortController
  #inFlight = false
  #pending = false
  #forceTeam = false
  #teamAbsentAt?: number
  #stopTimers = new Map<string, unknown>()

  #send?: (message: ClientMessage) => boolean

  /** Send function passed by the page, taking priority over the default from construction. */
  setSender(send: ((message: ClientMessage) => boolean) | undefined) {
    this.#send = send
  }

  constructor(private readonly deps: ActivityStoreDeps) {
    this.#timers = deps.timers ?? defaultTimers
    this.#now = deps.now ?? Date.now
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  getSnapshot = () => this.#data

  #set(patch: Partial<ActivityData>) {
    this.#data = { ...this.#data, ...patch }
    for (const listener of [...this.#listeners]) listener()
  }

  configure(next: ActivityConfig) {
    const previous = this.#config
    this.#config = next
    // Plan state changed (e.g. just approved): the next read includes the team, even if the page is hidden right now.
    if ((previous.teamPlanKey ?? '') !== (next.teamPlanKey ?? '')) this.#forceTeam = true
    if (!next.enabled) {
      this.#halt()
      return
    }
    if (!next.visible) {
      this.#clearPoll()
      return
    }
    if (
      this.#forceTeam ||
      !previous.enabled ||
      !previous.visible ||
      previous.turnActive !== next.turnActive ||
      previous.backgroundKey !== next.backgroundKey ||
      previous.teamLaunching !== next.teamLaunching
    )
      void this.refresh()
    else this.#schedule()
  }

  /** Read once immediately. On manual refresh forceTeam also re-probes the team. */
  async refresh(options: { forceTeam?: boolean } = {}) {
    if (!this.#config.enabled) return
    if (options.forceTeam) this.#forceTeam = true
    if (this.#inFlight) {
      this.#pending = true
      return
    }
    this.#clearPoll()
    this.#inFlight = true
    const controller = new AbortController()
    this.#controller = controller
    const includeTeam =
      this.#forceTeam ||
      this.#config.teamLaunching === true ||
      this.#teamAbsentAt === undefined ||
      this.#now() - this.#teamAbsentAt >= TEAM_RECHECK_MS
    this.#forceTeam = false
    try {
      const result = await this.deps.fetch(controller.signal, { team: includeTeam })
      if (controller.signal.aborted) return
      this.#apply(result)
    } catch (error) {
      if (!controller.signal.aborted) this.#set({ loaded: true, error: reason(error) })
    } finally {
      // Old requests that were halted must not touch the new request's state.
      if (this.#controller === controller) {
        this.#inFlight = false
        this.#controller = undefined
        if (this.#config.enabled) {
          if (this.#pending) {
            this.#pending = false
            void this.refresh()
          } else this.#schedule()
        }
      }
    }
  }

  #apply(result: ActivityFetchResult) {
    const background = result.background ?? this.#data.background
    if (result.team === null) this.#teamAbsentAt = this.#now()
    else if (result.team) this.#teamAbsentAt = undefined
    // Tasks no longer running no longer count as "stopping".
    const running = new Set(background.filter((task) => task.status === 'running').map((task) => task.taskId))
    const stopping = { ...this.#data.stopping }
    for (const id of Object.keys(stopping))
      if (!running.has(id)) {
        delete stopping[id]
        this.#clearStopTimer(id)
      }
    this.#set({
      tasks: result.tasks ?? this.#data.tasks,
      team: result.team === undefined ? this.#data.team : result.team,
      background,
      loaded: true,
      error: result.errors.join('; '),
      stopping,
      // The message only matters while tasks are still running.
      stopError: running.size ? this.#data.stopError : '',
    })
  }

  #schedule() {
    this.#clearPoll()
    const config = this.#config
    const data = this.#data
    const delay = pollDelay({
      enabled: config.enabled,
      visible: config.visible,
      turnActive: config.turnActive,
      backgroundIds: config.backgroundKey ? config.backgroundKey.split('\n').length : 0,
      running: data.background.filter((task) => task.status === 'running').length,
      teamActive: !!data.team && teamModel(data.team)?.members.some((row) => row.tone === 'run') === true,
      teamLaunching: config.teamLaunching,
    })
    if (delay === null) return
    this.#poll = this.#timers.set(() => {
      this.#poll = undefined
      void this.refresh()
    }, delay)
  }

  #clearPoll() {
    if (this.#poll !== undefined) this.#timers.clear(this.#poll)
    this.#poll = undefined
  }

  #clearStopTimer(id: string) {
    const timer = this.#stopTimers.get(id)
    if (timer !== undefined) this.#timers.clear(timer)
    this.#stopTimers.delete(id)
  }

  #halt() {
    this.#clearPoll()
    this.#controller?.abort()
    this.#controller = undefined
    this.#inFlight = false
    this.#pending = false
    for (const id of [...this.#stopTimers.keys()]) this.#clearStopTimer(id)
  }

  dispose() {
    this.#config = { ...this.#config, enabled: false }
    this.#halt()
    this.#listeners.clear()
  }

  /** Send a single stop; returns false with the reason when not sent. */
  stopTask(taskId: string) {
    return this.#stop([taskId])
  }

  /** Stop all subagents and background commands still running. */
  stopAll() {
    const ids = this.#data.background
      .filter((task) => task.status === 'running' && !task.stopping)
      .map((task) => task.taskId)
    return this.#stop(ids)
  }

  #stop(ids: string[]) {
    const targets = ids.filter(
      (id) =>
        !this.#data.stopping[id] &&
        this.#data.background.some((task) => task.taskId === id && task.status === 'running')
    )
    if (!targets.length) return true
    const sent: string[] = []
    for (const id of targets) if ((this.#send ?? this.deps.send)({ type: 'stop_background_task', taskId: id })) sent.push(id)
    if (sent.length < targets.length) {
      this.#set({ stopError: 'Connection lost; reconnect before stopping.' })
      if (!sent.length) return false
    }
    this.#set({
      stopping: { ...this.#data.stopping, ...Object.fromEntries(sent.map((id) => [id, true as const])) },
      ...(sent.length === targets.length ? { stopError: '' } : {}),
    })
    for (const id of sent) {
      this.#clearStopTimer(id)
      this.#stopTimers.set(
        id,
        this.#timers.set(() => {
          this.#stopTimers.delete(id)
          if (!this.#data.stopping[id]) return
          const stopping = { ...this.#data.stopping }
          delete stopping[id]
          this.#set({ stopping, stopError: 'The computer did not respond to the stop request; refresh to check the task status.' })
        }, STOP_TIMEOUT_MS)
      )
    }
    return sent.length === targets.length
  }
}
