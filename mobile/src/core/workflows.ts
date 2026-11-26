import { ApiError, type ApiClient } from './client'
import type { BackgroundTask } from './operations'
import type { ServerEvent } from './types'

/** Cap kept in sync with the CLI's own progress-row budget. */
const MAX_PROGRESS_ROWS = 500

export type WorkflowAgentRunState = 'start' | 'progress' | 'done' | 'error'

export type WorkflowAgentEvent = {
  type: 'workflow_agent'
  index: number
  label: string
  state: WorkflowAgentRunState
  phaseIndex?: number
  phaseTitle?: string
  agentType?: string
  model?: string
  agentId?: string
  queuedAt?: number
  startedAt?: number
  lastProgressAt?: number
  durationMs?: number
  tokens?: number
  toolCalls?: number
  cached?: boolean
  skipped?: boolean
  blocked?: boolean
  error?: string
  resultPreview?: string
  lastToolName?: string
}

export type WorkflowPhaseEvent = {
  type: 'workflow_phase'
  index: number
  title: string
  kind?: 'meta' | 'script'
}

export type WorkflowProgressEvent = WorkflowAgentEvent | WorkflowPhaseEvent

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** One live workflow run tracked in mobile chat state (root session only). */
export type WorkflowLiveRun = {
  taskId: string
  runId?: string
  workflowName: string
  description?: string
  status: WorkflowRunStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  progress: WorkflowProgressEvent[]
  result?: string
  error?: string
}

/** Disk-reconstructed run returned by `GET /api/workflows/session-runs/:sessionId`. */
export type ReconstructedWorkflowRun = {
  runId: string
  taskId: string
  ownerAgentId?: string
  workflowName: string
  status: WorkflowRunStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  result?: string
  error?: string
  progress?: WorkflowProgressEvent[]
  agents: {
    agentId: string
    label: string
    phaseIndex: number
    phaseTitle?: string
    agentIndex: number
    state: WorkflowAgentRunState
    error?: string
    skipped?: boolean
  }[]
}

export type WorkflowPhaseMeta = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowRunDetail = {
  runId: string
  sessionId: string
  workflowName: string
  startedAt: number
  completedAgents: number
  status: WorkflowRunStatus | 'unknown'
  description?: string
  phases?: WorkflowPhaseMeta[]
  agents?: { key: string; agentId: string; result: unknown }[]
  progress?: WorkflowProgressEvent[]
  result?: unknown
  error?: string
}

/* ───────────── Agent ID reference (matches desktop subagents.ts) ───────────── */

export const AGENT_ID_REF_PREFIX = 'agent:'

export function isAgentIdRef(ref: string): boolean {
  if (!ref.startsWith(AGENT_ID_REF_PREFIX)) return false
  const agentId = readAgentIdRef(ref)
  return agentId.length > 0 && !agentId.includes('/')
}

export function toAgentIdRef(agentId: string): string {
  return `${AGENT_ID_REF_PREFIX}${agentId}`
}

export function readAgentIdRef(ref: string): string {
  return ref.slice(AGENT_ID_REF_PREFIX.length)
}

/* ───────────── Live WebSocket reducer ───────────── */

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeStatus(value: string | undefined): WorkflowRunStatus {
  switch (value) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
    case 'stopped':
      return 'stopped'
    default:
      return 'running'
  }
}

function readProgress(value: unknown): WorkflowProgressEvent[] {
  if (!Array.isArray(value)) return []
  const rows: WorkflowProgressEvent[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const index = readNumber(row.index)
    if (index === undefined) continue
    if (row.type === 'workflow_phase' && typeof row.title === 'string') {
      rows.push({
        type: 'workflow_phase',
        index,
        title: row.title,
        ...(row.kind === 'meta' || row.kind === 'script' ? { kind: row.kind } : {}),
      })
      continue
    }
    if (row.type === 'workflow_agent' && typeof row.label === 'string') {
      rows.push({ ...(row as unknown as WorkflowAgentEvent), index })
    }
  }
  return rows
}

function mergeProgress(
  existing: WorkflowProgressEvent[],
  incoming: WorkflowProgressEvent[]
): WorkflowProgressEvent[] {
  if (incoming.length === 0) return existing
  const next = [...existing]
  const indexByKey = new Map<string, number>()
  for (let i = 0; i < next.length; i += 1) {
    const row = next[i]!
    indexByKey.set(`${row.type}:${row.index}`, i)
  }
  for (const row of incoming) {
    const key = `${row.type}:${row.index}`
    const at = indexByKey.get(key)
    if (at === undefined) {
      indexByKey.set(key, next.length)
      next.push(row)
    } else {
      next[at] = row
    }
  }
  return next.length > MAX_PROGRESS_ROWS ? next.slice(next.length - MAX_PROGRESS_ROWS) : next
}

/**
 * Reduce workflow `system_notification` events (`task_started` / `task_progress` /
 * `task_notification`) into root-session live workflow runs. Returns the same
 * object reference when nothing changed.
 */
export function reduceWorkflowRuns(
  runs: Record<string, WorkflowLiveRun> | undefined,
  event: ServerEvent,
  now: () => number = Date.now
): Record<string, WorkflowLiveRun> | undefined {
  if (event.type !== 'system_notification') return runs
  if (
    event.subtype !== 'task_started' &&
    event.subtype !== 'task_progress' &&
    event.subtype !== 'task_notification'
  ) {
    return runs
  }
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return runs
  const payload = event.data as Record<string, unknown>
  if (readString(payload.owner_agent_id)) return runs

  const taskId = readString(payload.task_id)
  if (!taskId) return runs

  const existing = runs?.[taskId]
  const taskType = readString(payload.task_type)
  const workflowName = readString(payload.workflow_name)
  const runId = readString(payload.workflow_run_id)
  const progress = readProgress(payload.workflow_progress)
  const isWorkflowEvent =
    Boolean(existing) ||
    taskType === 'local_workflow' ||
    Boolean(workflowName) ||
    Boolean(runId) ||
    progress.length > 0
  if (!isWorkflowEvent) return runs

  const terminal = event.subtype === 'task_notification'
  const status: WorkflowRunStatus = terminal
    ? normalizeStatus(readString(payload.status))
    : 'running'
  const summary = readString(payload.summary)
  const description = terminal ? undefined : (summary ?? readString(payload.description))
  const result = readString(payload.result)
  const error =
    readString(payload.error) ?? (status === 'failed' || status === 'stopped' ? summary : undefined)

  const timestamp = now()

  // Handle resumed attempt: same logical runId, fresh taskId.
  if (!existing && runId && runs) {
    const sameRunEntries = Object.entries(runs).filter(
      ([candidateKey, run]) => candidateKey !== taskId && run.runId === runId
    )
    if (sameRunEntries.length > 0) {
      const startsReplacement =
        event.subtype === 'task_started' ||
        (event.subtype === 'task_progress' &&
          sameRunEntries.every(([, run]) => run.status !== 'running'))
      if (!startsReplacement) return runs
      const nextRuns: Record<string, WorkflowLiveRun> = { ...runs }
      for (const [candidateKey] of sameRunEntries) delete nextRuns[candidateKey]
      nextRuns[taskId] = {
        taskId,
        runId,
        workflowName: workflowName ?? '工作流',
        ...(description ? { description } : {}),
        status,
        startedAt: timestamp,
        updatedAt: timestamp,
        ...(status !== 'running' ? { endedAt: timestamp } : {}),
        progress: mergeProgress([], progress),
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      }
      return nextRuns
    }
  }

  const base: WorkflowLiveRun = existing ?? {
    taskId,
    ...(runId ? { runId } : {}),
    workflowName: workflowName ?? '工作流',
    ...(description ? { description } : {}),
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    progress: [],
  }

  // A terminal run must not be revived by a late progress event.
  if (base.status !== 'running' && status === 'running') return runs

  const nextProgress = mergeProgress(base.progress, progress)
  const nextStatus = status
  const isTerminal = nextStatus !== 'running'
  const nextRun: WorkflowLiveRun = {
    ...base,
    runId: runId ?? base.runId,
    workflowName: workflowName ?? base.workflowName,
    description: description ?? base.description,
    status: nextStatus,
    updatedAt: timestamp,
    endedAt: isTerminal ? (base.endedAt ?? timestamp) : undefined,
    progress: nextProgress,
    result: result ?? base.result,
    error: error ?? base.error,
  }

  const changed =
    !existing ||
    base.progress !== nextRun.progress ||
    base.status !== nextRun.status ||
    base.result !== nextRun.result ||
    base.error !== nextRun.error ||
    base.workflowName !== nextRun.workflowName ||
    base.description !== nextRun.description ||
    base.runId !== nextRun.runId
  if (!changed) return runs

  return { ...(runs ?? {}), [taskId]: nextRun }
}

/**
 * Reconcile live running workflows against an authoritative `session_state`
 * snapshot of `activeBackgroundTaskIds`: any live run still marked `running`
 * whose `taskId` is no longer active on the server is pruned so a missed
 * terminal WS event cannot leave it stuck forever.
 */
export function pruneInactiveRunningWorkflows(
  runs: Record<string, WorkflowLiveRun> | undefined,
  activeBackgroundTaskIds: readonly string[]
): Record<string, WorkflowLiveRun> | undefined {
  if (!runs) return runs
  const active = new Set(activeBackgroundTaskIds)
  let changed = false
  const next: Record<string, WorkflowLiveRun> = {}
  for (const [taskId, run] of Object.entries(runs)) {
    if (run.status === 'running' && !active.has(taskId)) {
      changed = true
      continue
    }
    next[taskId] = run
  }
  if (!changed) return runs
  return Object.keys(next).length > 0 ? next : undefined
}

/* ───────────── Reconstructed run conversion ───────────── */

export function reconstructedToLiveRun(run: ReconstructedWorkflowRun): WorkflowLiveRun {
  const progress: WorkflowProgressEvent[] = run.progress?.length
    ? run.progress.slice(-MAX_PROGRESS_ROWS)
    : []

  if (progress.length === 0) {
    const phases = new Map<number, string | undefined>()
    for (const agent of run.agents) {
      if (!phases.has(agent.phaseIndex)) phases.set(agent.phaseIndex, agent.phaseTitle)
    }
    for (const [index, title] of [...phases.entries()].sort(([a], [b]) => a - b)) {
      progress.push({ type: 'workflow_phase', index, title: title ?? '' })
    }
    for (const agent of run.agents) {
      progress.push({
        type: 'workflow_agent',
        index: agent.agentIndex,
        label: agent.label,
        state: agent.state,
        phaseIndex: agent.phaseIndex,
        ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
        agentId: agent.agentId,
        ...(agent.error ? { error: agent.error } : {}),
        ...(agent.skipped ? { skipped: true } : {}),
      })
    }
  }

  return {
    taskId: run.taskId,
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    progress,
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
  }
}

/* ───────────── Activity model (running workflows) ───────────── */

export type WorkflowAgentStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'pending'

export type WorkflowAgentRow = {
  id: string
  index: number
  label: string
  status: WorkflowAgentStatus
  agentId?: string
  cached?: boolean
  error?: string
  openable: boolean
}

export type WorkflowPhaseRow = {
  id: string
  index: number
  title: string
  done: number
  total: number
  agents: WorkflowAgentRow[]
}

export type WorkflowActivityRun = {
  taskId: string
  runId?: string
  workflowName: string
  status: WorkflowRunStatus
  startedAt: number
  phases: WorkflowPhaseRow[]
  doneAgents: number
  totalAgents: number
  runningAgents: number
}

export function workflowAgentStatus(agent: WorkflowAgentEvent): WorkflowAgentStatus {
  if (agent.skipped) return 'skipped'
  if (agent.state === 'done') return 'completed'
  if (agent.state === 'error') return 'failed'
  if (agent.state === 'progress') return 'running'
  return 'pending'
}

export function workflowAgentStatusText(status: WorkflowAgentStatus): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'skipped':
      return '跳过'
    case 'pending':
      return '待开始'
  }
}

export function workflowRunStatusText(status: WorkflowRunStatus): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'stopped':
      return '已停止'
  }
}

export function buildWorkflowPhases(run: Pick<WorkflowLiveRun, 'taskId' | 'workflowName' | 'progress'>): WorkflowPhaseRow[] {
  const phaseTitles = new Map<number, string>()
  const agentsByPhase = new Map<number, WorkflowAgentEvent[]>()

  for (const event of run.progress) {
    if (event.type === 'workflow_phase') {
      if (!phaseTitles.has(event.index) || (!phaseTitles.get(event.index) && event.title)) {
        phaseTitles.set(event.index, event.title)
      }
      if (!agentsByPhase.has(event.index)) agentsByPhase.set(event.index, [])
      continue
    }
    const phaseIndex = event.phaseIndex ?? 0
    if (!phaseTitles.has(phaseIndex) || (!phaseTitles.get(phaseIndex) && event.phaseTitle)) {
      phaseTitles.set(phaseIndex, event.phaseTitle ?? '')
    }
    const bucket = agentsByPhase.get(phaseIndex) ?? []
    bucket.push(event)
    agentsByPhase.set(phaseIndex, bucket)
  }

  const phases: WorkflowPhaseRow[] = []
  for (const [phaseIndex, title] of [...phaseTitles.entries()].sort(([a], [b]) => a - b)) {
    const rawAgents = (agentsByPhase.get(phaseIndex) ?? []).slice().sort((a, b) => a.index - b.index)
    if (rawAgents.length === 0 && !title) continue
    const agents: WorkflowAgentRow[] = rawAgents.map((agent) => ({
      id: `${run.taskId}-agent-${agent.index}`,
      index: agent.index,
      label: agent.label,
      status: workflowAgentStatus(agent),
      ...(agent.agentId ? { agentId: agent.agentId } : {}),
      ...(agent.cached ? { cached: true } : {}),
      ...(agent.error ? { error: agent.error } : {}),
      openable: Boolean(agent.agentId),
    }))
    const done = agents.filter(
      (agent) => agent.status === 'completed' || agent.status === 'failed' || agent.status === 'skipped'
    ).length
    phases.push({
      id: `${run.taskId}-phase-${phaseIndex}`,
      index: phaseIndex,
      title: title || run.workflowName,
      done,
      total: agents.length,
      agents,
    })
  }
  return phases
}

function toActivityRun(run: WorkflowLiveRun): WorkflowActivityRun {
  const phases = buildWorkflowPhases(run)
  const allAgents = phases.flatMap((phase) => phase.agents)
  return {
    taskId: run.taskId,
    ...(run.runId ? { runId: run.runId } : {}),
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt,
    phases,
    doneAgents: allAgents.filter(
      (agent) => agent.status === 'completed' || agent.status === 'failed' || agent.status === 'skipped'
    ).length,
    totalAgents: allAgents.length,
    runningAgents: allAgents.filter((agent) => agent.status === 'running').length,
  }
}

function terminalWorkflowTaskIds(
  reconstructed?: readonly ReconstructedWorkflowRun[],
  background?: readonly BackgroundTask[]
): Set<string> {
  const ids = new Set<string>()
  for (const run of reconstructed ?? []) {
    if (!run.ownerAgentId && run.status !== 'running') ids.add(run.taskId)
  }
  for (const task of background ?? []) {
    if (task.taskType === 'local_workflow' && task.status !== 'running') ids.add(task.taskId)
  }
  return ids
}

/**
 * True when at least one live WS workflow run is still `running` and has not
 * already been reported terminal by the server's reconstructed runs or
 * background-task snapshot.
 */
export function hasActiveLiveWorkflow(
  live: Record<string, WorkflowLiveRun> | undefined,
  reconstructed?: readonly ReconstructedWorkflowRun[],
  background?: readonly BackgroundTask[]
): boolean {
  if (!live) return false
  const terminal = terminalWorkflowTaskIds(reconstructed, background)
  return Object.values(live).some(
    (run) => run.status === 'running' && !terminal.has(run.taskId)
  )
}

/**
 * Combine live WebSocket runs, disk-reconstructed runs, and `local_workflow`
 * background tasks into active (running) workflow views for the Activity Sheet.
 */
export function buildWorkflowActivityRuns(input: {
  live?: Record<string, WorkflowLiveRun>
  reconstructed?: readonly ReconstructedWorkflowRun[]
  background?: readonly BackgroundTask[]
}): WorkflowActivityRun[] {
  const merged = new Map<string, WorkflowLiveRun>()
  const byRunId = new Map<string, string>()
  const terminalTaskIds = terminalWorkflowTaskIds(input.reconstructed, input.background)

  const put = (run: WorkflowLiveRun, prefer: boolean) => {
    const existingKey =
      (run.runId ? byRunId.get(run.runId) : undefined) ?? (merged.has(run.taskId) ? run.taskId : undefined)
    if (existingKey && !prefer) return
    if (existingKey && existingKey !== run.taskId) merged.delete(existingKey)
    merged.set(run.taskId, run)
    if (run.runId) byRunId.set(run.runId, run.taskId)
  }

  for (const run of input.reconstructed ?? []) {
    if (run.ownerAgentId) continue
    put(reconstructedToLiveRun(run), false)
  }
  for (const run of Object.values(input.live ?? {})) {
    // Authoritative server terminal state for the exact same taskId wins over
    // a stale live `running` entry (e.g., after a missed terminal WS event).
    // A resumed run gets a fresh taskId and still replaces the older attempt.
    if (run.status === 'running' && terminalTaskIds.has(run.taskId)) continue
    put(run, true)
  }

  // If a `local_workflow` task is running in background-tasks before any
  // progress or reconstruction arrives, show a placeholder so it never disappears.
  for (const task of input.background ?? []) {
    if (task.taskType !== 'local_workflow' || task.status !== 'running') continue
    if (merged.has(task.taskId)) continue
    const started = task.startedAt ? Date.parse(task.startedAt) : NaN
    const startedAt = Number.isFinite(started) ? started : 0
    put(
      {
        taskId: task.taskId,
        workflowName: task.description?.trim() || '工作流',
        status: 'running',
        startedAt,
        updatedAt: startedAt,
        progress: [],
      },
      false
    )
  }

  return [...merged.values()]
    .filter((run) => run.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(toActivityRun)
}

/* ───────────── History model (finished workflows) ───────────── */

export type WorkflowHistoryPhase = {
  index: number
  title: string
}

export type WorkflowHistoryRun = {
  id: string
  runId: string
  taskId: string
  workflowName: string
  status: Exclude<WorkflowRunStatus, 'running'>
  startedAt: number
  endedAt?: number
  error?: string
  phases: WorkflowHistoryPhase[]
}

export function extractHistoryPhases(
  run: Pick<WorkflowLiveRun, 'workflowName' | 'progress'> | ReconstructedWorkflowRun
): WorkflowHistoryPhase[] {
  const phaseTitles = new Map<number, string>()
  const progress = run.progress ?? []

  for (const event of progress) {
    if (event.type === 'workflow_phase') {
      if (!phaseTitles.has(event.index) || (!phaseTitles.get(event.index) && event.title)) {
        phaseTitles.set(event.index, event.title.trim())
      }
      continue
    }
    const index = event.phaseIndex ?? 0
    const title = event.phaseTitle?.trim() ?? ''
    if (!phaseTitles.has(index) || (!phaseTitles.get(index) && title)) {
      phaseTitles.set(index, title)
    }
  }

  if (phaseTitles.size === 0 && 'agents' in run) {
    for (const agent of run.agents) {
      const title = agent.phaseTitle?.trim() ?? ''
      if (!phaseTitles.has(agent.phaseIndex) || (!phaseTitles.get(agent.phaseIndex) && title)) {
        phaseTitles.set(agent.phaseIndex, title)
      }
    }
  }

  const sorted = [...phaseTitles.entries()].sort(([a], [b]) => a - b)
  const named = sorted.filter(([, title]) => title.length > 0)
  if (named.length > 0) {
    return sorted.map(([index, title], position) => ({
      index,
      title: title || `阶段 ${position + 1}`,
    }))
  }
  if (sorted.length > 0) {
    return sorted.map(([index], position) => ({
      index,
      title: sorted.length === 1 ? run.workflowName : `阶段 ${position + 1}`,
    }))
  }
  return []
}

/**
 * Finished workflow runs for the session's "Workflow 记录" sheet.
 * Disk reconstruction is authoritative; recently finished live runs fill in any
 * gap before disk persistence finishes.
 */
export function buildWorkflowHistoryRuns(input: {
  reconstructed?: readonly ReconstructedWorkflowRun[]
  live?: Record<string, WorkflowLiveRun>
}): WorkflowHistoryRun[] {
  const byKey = new Map<string, WorkflowHistoryRun>()
  const keyByRunId = new Map<string, string>()
  const keyByTaskId = new Map<string, string>()

  for (const run of input.reconstructed ?? []) {
    if (run.ownerAgentId || run.status === 'running') continue
    const key = run.runId || run.taskId
    byKey.set(key, {
      id: key,
      runId: run.runId,
      taskId: run.taskId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
      phases: extractHistoryPhases(run),
    })
    if (run.runId) keyByRunId.set(run.runId, key)
    if (run.taskId) keyByTaskId.set(run.taskId, key)
  }

  for (const run of Object.values(input.live ?? {})) {
    if (run.status === 'running') continue
    const existingKey =
      (run.runId ? keyByRunId.get(run.runId) : undefined) ?? keyByTaskId.get(run.taskId)
    const livePhases = extractHistoryPhases(run)
    if (existingKey) {
      const existing = byKey.get(existingKey)!
      byKey.set(existingKey, {
        ...existing,
        ...(existing.endedAt === undefined && run.endedAt !== undefined
          ? { endedAt: run.endedAt }
          : {}),
        ...(!existing.error && run.error ? { error: run.error } : {}),
        ...(existing.phases.length === 0 && livePhases.length > 0 ? { phases: livePhases } : {}),
      })
      continue
    }
    const key = run.runId || run.taskId
    byKey.set(key, {
      id: key,
      runId: run.runId ?? run.taskId,
      taskId: run.taskId,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
      phases: livePhases,
    })
    if (run.runId) keyByRunId.set(run.runId, key)
    if (run.taskId) keyByTaskId.set(run.taskId, key)
  }

  return [...byKey.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/* ───────────── Read-only API loaders ───────────── */

export async function loadSessionWorkflowRuns(
  client: ApiClient,
  sessionId: string,
  signal?: AbortSignal
): Promise<ReconstructedWorkflowRun[]> {
  const response = await client.get<{ runs?: ReconstructedWorkflowRun[] }>(
    `/api/workflows/session-runs/${encodeURIComponent(sessionId)}`,
    { signal }
  )
  return (response.runs ?? []).filter((run) => !run.ownerAgentId)
}

export async function loadSessionWorkflowRunsSafe(
  client: ApiClient,
  sessionId: string,
  signal?: AbortSignal
): Promise<ReconstructedWorkflowRun[]> {
  try {
    return await loadSessionWorkflowRuns(client, sessionId, signal)
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return []
    throw error
  }
}

export async function loadWorkflowRunDetail(
  client: ApiClient,
  sessionId: string,
  runId: string,
  signal?: AbortSignal
): Promise<WorkflowRunDetail | null> {
  try {
    return await client.get<WorkflowRunDetail>(
      `/api/workflows/runs/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}`,
      { signal }
    )
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null
    throw error
  }
}
