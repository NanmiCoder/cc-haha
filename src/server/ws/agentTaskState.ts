/**
 * Agent and background-task lifecycle state for the session WebSocket handler.
 *
 * Moved verbatim out of `handler.ts` as the first cut of that file. This slice was
 * chosen because it is provably closed: these functions read and write only the lifecycle
 * containers declared here and call nothing outside them, so relocating them cannot
 * change behavior. The functions that emit stop bookends stayed behind on purpose —
 * they reach into the broadcast layer and the socket registry, so moving them would
 * have required injecting dependencies rather than moving code.
 *
 * All lifecycle containers are per-session and released by `clearAgentRuntimeState`, which
 * `cleanupSessionRuntimeState` calls. `src/server/__tests__/sessionStateCleanup.test.ts`
 * follows that closure across this module boundary.
 *
 * The slice needs no imports: every helper it uses is declared inside it.
 */

export type AgentTaskType = 'local_agent' | 'remote_agent'

export type ActiveNonAgentTaskState = {
  taskId: string
  taskType?: string
  toolUseId: string
  description?: string
  ownerAgentId?: string
  terminalStatus?: 'stopped' | 'failed'
  terminalSummary?: string
  terminalMessage?: boolean
  stopRequested?: boolean
  localStopConfirmed?: boolean
  finalizationRetryCount?: number
  finalizationRetryTimer?: ReturnType<typeof setTimeout>
  finalization?: Promise<boolean>
  stopFailureMessage?: string
}

export type ActiveAgentTaskState = {
  taskId: string
  taskType: AgentTaskType
  toolUseId: string
  remoteSessionId?: string
  description?: string
  ownerAgentId?: string
  stopIntent: boolean
  stopRequested: boolean
  localStopConfirmed: boolean
  bookendPending: boolean
  finalizationRetryCount: number
  finalizationRetryTimer?: ReturnType<typeof setTimeout>
  finalization?: Promise<boolean>
  remoteArchive?: Promise<boolean>
  remoteArchiveError?: string
  stopFailureMessage?: string
}

export const activeBackgroundTaskIds = new Map<string, Set<string>>()

export const activeAgentTasks = new Map<string, Map<string, ActiveAgentTaskState>>()

export const activeNonAgentTasks = new Map<string, Map<string, ActiveNonAgentTaskState>>()

export const authoritativeStoppedTaskIds = new Map<string, Set<string>>()

type OfficialSdkTaskState = {
  runId?: string
  status: string
  taskType?: string
  toolUseId?: string
  description?: string
  backgrounded?: boolean
}
/** Retain ended generations so late terminal/progress frames cannot corrupt a resumed task. */
export const officialSdkTaskStates = new Map<string, Map<string, OfficialSdkTaskState>>()

export const agentStopRequestedSessions = new Set<string>()

export const nonAgentStopRequestedSessions = new Set<string>()

export const runtimeExitStoppedSessions = new Set<string>()

export const runtimeExitFailedSessions = new Set<string>()

export type CliBackgroundTaskLifecycle = {
  taskId: string
  running: boolean
  taskType?: string
  toolUseId?: string
  remoteSessionId?: string
  description?: string
  ownerAgentId?: string
  status?: string
  suppressForward?: boolean
  runId?: string
  newRun?: boolean
  backgrounded?: boolean
}

export function getOfficialSdkTaskLifecycles(sessionId: string, value: unknown): {
  lifecycles: CliBackgroundTaskLifecycle[]
  stale?: boolean
  snapshot?: boolean
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const frame = value as Record<string, any>
  if (frame.cc_haha_agent_sdk !== true || frame.type !== 'system') return null
  const snapshot = frame.subtype === 'background_tasks_changed'
  if (!snapshot && !['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(frame.subtype)) return null
  const string = (entry: unknown) => typeof entry === 'string' && entry.length > 0 ? entry : undefined
  const object = (entry: unknown): entry is Record<string, any> => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  if (snapshot && (!Array.isArray(frame.tasks) || frame.tasks.some((entry: unknown) => !object(entry) || !string(entry.task_id)))) return null
  if (!snapshot && (!string(frame.task_id) || frame.subtype === 'task_updated' && !object(frame.patch))) return null
  const states = officialSdkTaskStates.get(sessionId) ?? new Map<string, OfficialSdkTaskState>()
  officialSdkTaskStates.set(sessionId, states)
  const lifecycles: CliBackgroundTaskLifecycle[] = []
  const terminal = (status: string) => ['completed', 'failed', 'killed', 'stopped'].includes(status)
  let stale = false
  function apply(entry: Record<string, any>, subtype: string) {
    const taskId = entry.task_id as string
    const previous = states.get(taskId)
    const runId = string(entry.run_id)
    if (previous?.runId && (!runId || runId < previous.runId)) { stale = true; return }
    const newRun = Boolean(previous && (runId && runId !== previous.runId ||
      !runId && !previous.runId && subtype === 'task_started' && terminal(previous.status)))
    const patch = subtype === 'task_updated' ? entry.patch : entry
    const status = ['pending', 'running', 'completed', 'failed', 'killed', 'paused', 'stopped'].includes(patch.status)
      ? patch.status as string : subtype === 'task_notification' ? 'completed'
        : !newRun && previous ? previous.status : 'running'
    if (previous && !newRun && terminal(previous.status) && !terminal(status)) { stale = true; return }
    // A terminal same-run task cannot be resurrected by a duplicate start/progress/snapshot.
    if (previous && !newRun && terminal(previous.status) && subtype !== 'task_notification' && subtype !== 'task_updated') { stale = true; return }
    const next: OfficialSdkTaskState = {
      ...previous, runId, status,
      ...(typeof patch.task_type === 'string' ? { taskType: patch.task_type } : {}),
      ...(typeof patch.tool_use_id === 'string' ? { toolUseId: patch.tool_use_id } : {}),
      ...(typeof patch.description === 'string' ? { description: patch.description } : {}),
      ...(typeof patch.is_backgrounded === 'boolean' ? { backgrounded: patch.is_backgrounded } : {}),
      ...(snapshot ? { backgrounded: true } : {}),
    }
    states.set(taskId, next)
    lifecycles.push({ taskId, running: !terminal(status), status, runId, newRun,
      taskType: next.taskType, toolUseId: next.toolUseId, description: next.description,
      backgrounded: next.backgrounded })
  }
  if (snapshot) {
    const present = new Set<string>(frame.tasks.map((entry: Record<string, any>) => entry.task_id))
    for (const [taskId, state] of states) {
      if (present.has(taskId) || terminal(state.status) || state.backgrounded === false) continue
      states.set(taskId, { ...state, status: 'completed' })
      lifecycles.push({ taskId, running: false, status: 'completed', runId: state.runId })
    }
    for (const entry of frame.tasks) apply(entry, 'task_started')
  } else apply(frame, frame.subtype)
  return { lifecycles, ...(snapshot ? { snapshot: true } : stale ? { stale: true } : {}) }
}

export function getCliBackgroundTaskLifecycle(cliMsg: any): CliBackgroundTaskLifecycle | null {
  if (cliMsg?.type !== 'system') return null
  const taskId = typeof cliMsg.task_id === 'string' ? cliMsg.task_id.trim() : ''
  if (!taskId) return null
  const optionalString = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  const taskType = typeof cliMsg.task_type === 'string' && cliMsg.task_type.trim()
    ? cliMsg.task_type.trim()
    : undefined
  const toolUseId = optionalString(cliMsg.tool_use_id)
  const remoteSessionId = optionalString(cliMsg.remote_session_id)
  const description = optionalString(cliMsg.description) ??
    optionalString(cliMsg.message) ??
    optionalString(cliMsg.title)
  const ownerAgentId = optionalString(cliMsg.owner_agent_id)

  if (cliMsg.subtype === 'task_started') {
    return { taskId, running: true, taskType, toolUseId, remoteSessionId, description, ownerAgentId }
  }

  if (cliMsg.subtype === 'task_notification' && cliMsg.status === 'running') {
    return { taskId, running: true, taskType, toolUseId, remoteSessionId, description, ownerAgentId }
  }

  if (
    cliMsg.subtype === 'task_notification' &&
    (cliMsg.status === 'completed' ||
      cliMsg.status === 'failed' ||
      cliMsg.status === 'stopped' ||
      cliMsg.status === 'killed')
  ) {
    return { taskId, running: false, status: cliMsg.status, ownerAgentId }
  }

  return null
}

export function isAgentTaskType(taskType: string | undefined): taskType is AgentTaskType {
  return taskType === 'local_agent' || taskType === 'remote_agent'
}

export function untrackCliBackgroundTask(sessionId: string, taskId: string): void {
  const taskIds = activeBackgroundTaskIds.get(sessionId)
  taskIds?.delete(taskId)
  if (taskIds?.size === 0) activeBackgroundTaskIds.delete(sessionId)

  const sessionAgentTasks = activeAgentTasks.get(sessionId)
  const agentTask = sessionAgentTasks?.get(taskId)
  if (agentTask?.finalizationRetryTimer !== undefined) {
    clearTimeout(agentTask.finalizationRetryTimer)
  }
  sessionAgentTasks?.delete(taskId)
  if (sessionAgentTasks?.size === 0) activeAgentTasks.delete(sessionId)

  const sessionNonAgentTasks = activeNonAgentTasks.get(sessionId)
  const nonAgentTask = sessionNonAgentTasks?.get(taskId)
  if (nonAgentTask) clearAgentStopFinalizationRetry(nonAgentTask)
  sessionNonAgentTasks?.delete(taskId)
  if (sessionNonAgentTasks?.size === 0) activeNonAgentTasks.delete(sessionId)
}

export function clearAgentRuntimeState(
  sessionId: string,
  options?: { preserveRetryableStops?: boolean },
): void {
  const retryableStops = options?.preserveRetryableStops
    ? new Map(
        [...(activeAgentTasks.get(sessionId)?.entries() ?? [])].filter(([, task]) =>
          task.stopIntent && task.localStopConfirmed && Boolean(task.stopFailureMessage),
        ),
      )
    : new Map<string, ActiveAgentTaskState>()

  const retryableNonAgentStops = options?.preserveRetryableStops
    ? new Map([...(activeNonAgentTasks.get(sessionId)?.entries() ?? [])]
        .filter(([, task]) => task.localStopConfirmed))
    : new Map<string, ActiveNonAgentTaskState>()
  for (const task of activeAgentTasks.get(sessionId)?.values() ?? []) {
    clearAgentStopFinalizationRetry(task)
  }
  for (const task of activeNonAgentTasks.get(sessionId)?.values() ?? []) {
    clearAgentStopFinalizationRetry(task)
  }
  activeBackgroundTaskIds.delete(sessionId)
  activeAgentTasks.delete(sessionId)
  activeNonAgentTasks.delete(sessionId)
  authoritativeStoppedTaskIds.delete(sessionId)
  officialSdkTaskStates.delete(sessionId)
  agentStopRequestedSessions.delete(sessionId)
  nonAgentStopRequestedSessions.delete(sessionId)
  runtimeExitStoppedSessions.delete(sessionId)
  runtimeExitFailedSessions.delete(sessionId)

  if (retryableNonAgentStops.size > 0) {
    activeNonAgentTasks.set(sessionId, retryableNonAgentStops)
  }
  if (retryableStops.size > 0) {
    activeAgentTasks.set(sessionId, retryableStops)
    activeBackgroundTaskIds.set(sessionId, new Set(retryableStops.keys()))
    agentStopRequestedSessions.add(sessionId)
  }
}

export function markTaskAuthoritativelyStopped(sessionId: string, taskId: string): void {
  let taskIds = authoritativeStoppedTaskIds.get(sessionId)
  if (!taskIds) {
    taskIds = new Set()
    authoritativeStoppedTaskIds.set(sessionId, taskIds)
  }
  taskIds.add(taskId)
  const nativeTask = officialSdkTaskStates.get(sessionId)?.get(taskId)
  if (nativeTask) nativeTask.status = 'stopped'
}

export function hasActiveBackgroundTasks(sessionId: string): boolean {
  const taskIds = activeBackgroundTaskIds.get(sessionId)
  if (!taskIds || taskIds.size === 0) return false
  const sessionAgentTasks = activeAgentTasks.get(sessionId)
  return [...taskIds].some((taskId) => {
    const agentTask = sessionAgentTasks?.get(taskId)
    if (agentTask) return !agentTask.localStopConfirmed || agentTask.bookendPending
    return !activeNonAgentTasks.get(sessionId)?.get(taskId)?.localStopConfirmed
  })
}

export function clearAgentStopFinalizationRetry(task: { finalizationRetryTimer?: ReturnType<typeof setTimeout> }): void {
  if (task.finalizationRetryTimer === undefined) return
  clearTimeout(task.finalizationRetryTimer)
  task.finalizationRetryTimer = undefined
}

export function markActiveAgentsStopping(sessionId: string): void {
  for (const task of activeAgentTasks.get(sessionId)?.values() ?? []) {
    task.stopIntent = true
    task.stopRequested = true
  }
}
