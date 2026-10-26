import type { ApiClient } from './client'
import { isAgent, sessionPath, type BackgroundSnapshot, type BackgroundTask } from './operations'
import { liveFor } from './subagentLive'
import type { ClientMessage, SubagentLive, SubagentStep } from './types'
import { describeStep } from '../ui/chat/steps'
import {
  loadTaskList,
  loadTeam,
  memberState,
  memberTasks,
  taskState,
  teamMembers,
  latestTeam,
  type TaskInfo,
  type TeamWorkbenchSessionTimeline,
} from '../ui/activity/activityData'
import { taskTitle } from '../ui/activity/taskLabels'

/* ───────────── 数据 ───────────── */

export type ActivityData = {
  /** 会话任务清单。 */
  tasks: TaskInfo[]
  /** 没有团队（404）时为 null。 */
  team: TeamWorkbenchSessionTimeline | null
  background: BackgroundTask[]
  /** 至少有一次读取结束（成功或失败）。 */
  loaded: boolean
  error: string
  /** 已发出停止请求、还没看到结束的任务。 */
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

/* ───────────── 派生 ───────────── */

export type PlanTask = {
  id: string
  title: string
  state: 'done' | 'active' | 'waiting' | 'todo'
  /** 进行中的任务：正在做什么（activeForm）。 */
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
  /** 开始时间（毫秒）；电脑没给就没有。 */
  startedAt?: number
  /** “已读取 5 个文件” / “8 次工具调用”；没有数据就不显示。 */
  stats?: string
  /** 最近两步，只在有实时数据时才有。 */
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
export type TeamRow = {
  id: string
  name: string
  lead: boolean
  state: string
  detail?: string
  tone: 'run' | 'wait' | 'idle' | 'err'
}
export type TeamModel = { name: string; members: TeamRow[]; summary: string }
export type ActivityProgress = {
  done: number
  total: number
  /** 进行中任务的 activeForm / 标题，用于一句话概括。 */
  active?: string
}
export type SessionActivityModel = {
  progress: ActivityProgress
  tasks: PlanTask[]
  subagents: SubagentRow[]
  team: TeamModel | null
  commands: CommandRow[]
  /** 仅 running 的子 Agent + 后台命令。胶囊角标和底单标题共用这个数。 */
  runningCount: number
  /** 有待审批时 attention，其余 run。 */
  tone: 'run' | 'attention'
  /** 胶囊是否应该出现。 */
  capsuleVisible: boolean
  /** 胶囊里是否转圈。 */
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
        state === '已完成' ? 'done' : state === '进行中' ? 'active' : state === '等待依赖' ? 'waiting' : 'todo',
      ...(state === '进行中' && textOf(task.activeForm) ? { detail: textOf(task.activeForm) } : {}),
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

/** 子 Agent 卡的第二行：运行中优先说读了几个文件，结束后说调用了几次工具。 */
export function subagentStats(
  status: BackgroundTask['status'],
  live: { reads: number; toolUses?: number } | null
): string | undefined {
  if (!live) return undefined
  if (status === 'running') {
    if (live.reads > 0) return `已读取 ${live.reads} 个文件`
    if (live.toolUses) return `${live.toolUses} 次工具调用`
    return undefined
  }
  if (live.toolUses) return `${live.toolUses} 次工具调用`
  if (live.reads > 0) return `已读取 ${live.reads} 个文件`
  return undefined
}

const statusRank: Record<BackgroundTask['status'], number> = { running: 0, failed: 1, stopped: 2, completed: 3 }
/** 运行中的排前面，同一状态保持电脑给出的先后顺序。 */
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

/** 团队只在“活着”时出现；归档、已删除的团队不属于运行中。 */
export function teamModel(timeline: TeamWorkbenchSessionTimeline | null): TeamModel | null {
  const snapshot = latestTeam(timeline)
  if (!timeline || !snapshot || snapshot.deletedAt || timeline.source !== 'live') return null
  const members = teamMembers(timeline)
  const rows: TeamRow[] = members.map((member) => {
    const state = memberState(member)
    const owned = memberTasks(member, snapshot.tasks)
    const current = owned.find((task) => task.status === 'in_progress')
    const blocked = owned.find((task) => taskState(task, snapshot.tasks) === '等待依赖')
    const waiting = !current && !!blocked && state === '空闲'
    const label = waiting ? '等待依赖' : state
    const detail = current ? (textOf(current.activeForm) ?? current.subject) : undefined
    return {
      id: member.agentId,
      name: snapshot.team.leadAgentId === member.agentId ? '队长' : member.name || member.agentId,
      lead: snapshot.team.leadAgentId === member.agentId,
      state: label,
      detail,
      tone:
        label === '工作中'
          ? 'run'
          : label === '等待依赖' || label === '等待重试'
            ? 'wait'
            : label === '遇到错误'
              ? 'err'
              : 'idle',
    }
  })
  const working = rows.filter((row) => row.state === '工作中' && !row.lead).map((row) => row.name)
  return {
    name: snapshot.team.name,
    members: rows,
    summary: [`${rows.length} 人`, working.length ? `${working.slice(0, 2).join('、')} 工作中` : '']
      .filter(Boolean)
      .join(' · '),
  }
}

export function capsuleVisible(input: {
  runningCount: number
  progress: ActivityProgress
  turnActive: boolean
}) {
  const { runningCount, progress, turnActive } = input
  if (runningCount > 0) return true
  if (progress.total === 0) return false
  // 清单全部完成且这一轮已经结束：运行相关的界面全部消失。
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
  const team = teamModel(data.team)
  // 会话自己的任务清单优先；它为空时用团队的任务看板。
  const source = data.tasks.length ? data.tasks : (latestTeam(data.team)?.tasks ?? [])
  const tasks = planTasks(source)
  const progress = taskProgressOf(tasks, source)
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
    capsuleVisible: capsuleVisible({ runningCount, progress, turnActive }),
    active: turnActive || runningCount > 0,
  }
}

/** 分组标题右侧的一句话。 */
export function sectionSummaries(model: SessionActivityModel) {
  const count = (rows: { status: BackgroundTask['status'] }[], finishedLabel: string) => {
    const running = rows.filter((row) => row.status === 'running').length
    const finished = rows.length - running
    return [running ? `${running} 运行中` : '', finished ? `${finished} ${finishedLabel}` : '']
      .filter(Boolean)
      .join(' · ')
  }
  const inProgress = model.tasks.filter((task) => task.state === 'active').length
  return {
    tasks: [`${model.progress.done}/${model.progress.total} 完成`, inProgress ? `${inProgress} 进行中` : '']
      .filter(Boolean)
      .join(' · '),
    subagents: count(model.subagents, '已完成'),
    team: model.team?.summary ?? '',
    commands: count(model.commands, '已结束'),
  }
}

/* ───────────── 读取与轮询 ───────────── */

export type ActivityFetchResult = {
  tasks?: TaskInfo[]
  /** undefined = 这次没读；null = 没有团队。 */
  team?: TeamWorkbenchSessionTimeline | null
  background?: BackgroundTask[]
  errors: string[]
}
export type ActivityFetcher = (
  signal: AbortSignal,
  options: { team: boolean }
) => Promise<ActivityFetchResult>

const reason = (error: unknown) => (error instanceof Error ? error.message : '读取失败')

/** 一处拉取三份数据；某一份失败不影响其余，旧数据保留。 */
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
    else errors.push(`任务：${reason(tasks.reason)}`)
    if (team.status === 'fulfilled') {
      if (team.value !== undefined) result.team = team.value
    } else errors.push(`团队：${reason(team.reason)}`)
    if (background.status === 'fulfilled') result.background = background.value.tasks ?? []
    else errors.push(`后台：${reason(background.reason)}`)
    return result
  }
}

export const ACTIVE_POLL_MS = 3500
/** 没有团队时隔这么久才再问一次，避免每轮都吃一个 404。 */
export const TEAM_RECHECK_MS = 15_000
export const STOP_TIMEOUT_MS = 15_000

export type PollInput = {
  enabled: boolean
  /** 页面在前台且当前屏幕有焦点。 */
  visible: boolean
  turnActive: boolean
  backgroundIds: number
  running: number
  teamActive: boolean
}
/** 下一次轮询的间隔；null = 不轮询（空闲、页面不可见或未启用）。 */
export function pollDelay(input: PollInput): number | null {
  if (!input.enabled || !input.visible) return null
  return input.turnActive || input.backgroundIds > 0 || input.running > 0 || input.teamActive
    ? ACTIVE_POLL_MS
    : null
}

export type ActivityConfig = {
  enabled: boolean
  visible: boolean
  turnActive: boolean
  /** 当前活动后台任务 id 的指纹；变化就立刻重读。 */
  backgroundKey: string
}
export type ActivityTimers = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
export type ActivityStoreDeps = {
  fetch: ActivityFetcher
  /** 通过会话 WebSocket 发给电脑；没发出去返回 false。 */
  send(message: ClientMessage): boolean
  timers?: ActivityTimers
  now?(): number
}

const defaultTimers: ActivityTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 三份活动数据的唯一来源：只在运行/有后台任务时按间隔读，页面不可见或空闲时停下；
 * 配置变化（开始运行、后台任务增减、回到前台）立即补读一次，重叠的读取合并成一次。
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

  /** 页面传入的发送函数，优先于构造时的默认发送函数。 */
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
    if (!next.enabled) {
      this.#halt()
      return
    }
    if (!next.visible) {
      this.#clearPoll()
      return
    }
    if (
      !previous.enabled ||
      !previous.visible ||
      previous.turnActive !== next.turnActive ||
      previous.backgroundKey !== next.backgroundKey
    )
      void this.refresh()
    else this.#schedule()
  }

  /** 立即读一次。用户手动刷新时 forceTeam 也重新探测团队。 */
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
      // 被 halt 掉的旧请求不能动新请求的状态。
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
    // 已经不在运行的任务不再算“停止中”。
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
      error: result.errors.join('；'),
      stopping,
      // 提示只在还有任务在跑时有意义。
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

  /** 发出单项停止；没发出去时返回 false 并写明原因。 */
  stopTask(taskId: string) {
    return this.#stop([taskId])
  }

  /** 停止所有仍在运行的子 Agent 和后台命令。 */
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
      this.#set({ stopError: '连接已断开，请重新连接后再停止。' })
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
          this.#set({ stopping, stopError: '电脑没有回应停止请求，刷新后看看任务状态。' })
        }, STOP_TIMEOUT_MS)
      )
    }
    return sent.length === targets.length
  }
}
