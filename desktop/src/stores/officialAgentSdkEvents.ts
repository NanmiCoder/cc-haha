import type { BackgroundAgentTask } from '@/types/chat'

export type OfficialSdkBackgroundTask = BackgroundAgentTask & {
  nativeTask?: boolean
  runId?: string
  nativeStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused' | 'stopped'
  isBackgrounded?: boolean
  ambient?: boolean
  skipTranscript?: boolean
  parentTaskId?: string
  subagentType?: string
  spawnDepth?: number
  endedAt?: number
  totalPausedMs?: number
  error?: string
  /** A level snapshot proved the run ended; its terminal bookend may arrive later. */
  completionInferred?: boolean
}

type TaskMap = Record<string, OfficialSdkBackgroundTask>
const eventSubtypes = new Set(['task_started', 'task_progress', 'task_notification', 'task_updated'])

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function nativeStatus(value: unknown): OfficialSdkBackgroundTask['nativeStatus'] {
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' ||
    value === 'killed' || value === 'paused' || value === 'stopped' ? value : undefined
}
function displayStatus(value: OfficialSdkBackgroundTask['nativeStatus']): BackgroundAgentTask['status'] {
  return value === 'failed' ? 'failed' : value === 'completed' ? 'completed'
    : value === 'killed' || value === 'stopped' ? 'stopped' : 'running'
}

function applyTask(current: TaskMap, subtype: string, frame: Record<string, unknown>, now: number, snapshot = false): TaskMap {
  const taskId = nonEmptyString(frame.task_id)
  if (!taskId) return current
  const runId = nonEmptyString(frame.run_id)
  const previous = current[taskId]
  // Run ids have one documented ordering rule: plain string comparison.
  // Never parse them as timestamps/UUIDs or let legacy frames downgrade a run.
  if (previous?.runId && (!runId || runId < previous.runId)) return current
  const newRun = Boolean(runId && previous?.runId && runId > previous.runId)
  const legacyRestart = !runId && !previous?.runId && subtype === 'task_started' && previous?.status !== 'running'
  const fresh = newRun || legacyRestart
  const patch = subtype === 'task_updated' ? record(frame.patch) : frame
  if (!patch) return current
  const nextNativeStatus = nativeStatus(patch.status)
  const terminal = nextNativeStatus === 'completed' || nextNativeStatus === 'failed' ||
    nextNativeStatus === 'killed' || nextNativeStatus === 'stopped' || subtype === 'task_notification'
  // A duplicate start/progress/snapshot for an ended run cannot reopen it.
  // Metadata-only patches may still supply useful final description/duration.
  if (previous && !fresh && previous.status !== 'running' &&
    !terminal && (subtype !== 'task_updated' || nextNativeStatus !== undefined || snapshot)) return current
  const base: OfficialSdkBackgroundTask = previous && !fresh ? previous : {
    taskId, status: 'running', startedAt: now, updatedAt: now,
    ...(previous ? {
      toolUseId: previous.toolUseId, taskType: previous.taskType,
      parentTaskId: previous.parentTaskId, subagentType: previous.subagentType,
      workflowName: previous.workflowName, workflowRunId: previous.workflowRunId,
      isBackgrounded: previous.isBackgrounded, ambient: previous.ambient,
      skipTranscript: previous.skipTranscript, description: previous.description,
    } : {}),
  }
  const task: OfficialSdkBackgroundTask = {
    ...base, nativeTask: true, taskId, updatedAt: now,
    ...(runId ? { runId } : {}),
  }
  if (nextNativeStatus) {
    task.nativeStatus = nextNativeStatus
    task.status = displayStatus(nextNativeStatus)
  } else if (subtype === 'task_notification') {
    task.nativeStatus = 'completed'
    task.status = 'completed'
  } else if (fresh || !previous) {
    task.nativeStatus = 'running'
    task.status = 'running'
  }
  if (terminal) task.completionInferred = false
  const textFields = {
    tool_use_id: 'toolUseId', description: 'description', task_type: 'taskType',
    subagent_type: 'subagentType', parent_task_id: 'parentTaskId',
    workflow_name: 'workflowName', workflow_run_id: 'workflowRunId', prompt: 'prompt',
    result: 'result', summary: 'summary', last_tool_name: 'lastToolName',
    output_file: 'outputFile', error: 'error',
  } as const
  for (const [wire, local] of Object.entries(textFields)) {
    if (typeof patch[wire] === 'string') task[local] = patch[wire]
  }
  const boolFields = { is_backgrounded: 'isBackgrounded', ambient: 'ambient', skip_transcript: 'skipTranscript' } as const
  for (const [wire, local] of Object.entries(boolFields)) {
    if (typeof patch[wire] === 'boolean') task[local] = patch[wire]
  }
  const numberFields = { end_time: 'endedAt', total_paused_ms: 'totalPausedMs', spawn_depth: 'spawnDepth' } as const
  for (const [wire, local] of Object.entries(numberFields)) {
    const value = finite(patch[wire])
    if (value !== undefined) task[local] = value
  }
  const usage = record(patch.usage)
  if (usage) {
    const totals = { totalTokens: finite(usage.total_tokens), toolUses: finite(usage.tool_uses), durationMs: finite(usage.duration_ms) }
    task.usage = { ...task.usage, ...Object.fromEntries(Object.entries(totals).filter(([, value]) => value !== undefined)) }
  }
  if (snapshot) task.isBackgrounded = true
  if (task.skipTranscript) task.ambient = true
  return { ...current, [taskId]: task }
}

/**
 * Reducer for the native SDK task stream. Returns null for unrelated/invalid
 * events; unchanged maps retain identity for stale frames. Call before the
 * repository's legacy task reducer, which does not understand run_id or patch.
 */
export function applyOfficialSdkTaskEvent(
  current: TaskMap,
  subtype: string,
  data: unknown,
  now: number,
): TaskMap | null {
  const frame = record(data)
  if (!frame) return null
  if (eventSubtypes.has(subtype)) return applyTask(current, subtype, frame, now)
  if (subtype !== 'background_tasks_changed' || !Array.isArray(frame.tasks)) return null
  const entries = frame.tasks.map(record)
  // A corrupt replacement must never accidentally clear all current activity.
  if (entries.some(entry => !entry || !nonEmptyString(entry.task_id))) return null
  const present = new Set(entries.map(entry => entry!.task_id as string))
  let next = current
  for (const [id, task] of Object.entries(current)) {
    if (!task.nativeTask || task.status !== 'running' || task.isBackgrounded === false || present.has(id)) continue
    if (next === current) next = { ...current }
    next[id] = { ...task, status: 'completed', nativeStatus: 'completed', completionInferred: true, updatedAt: now }
  }
  for (const entry of entries) next = applyTask(next, 'task_started', entry!, now, true)
  return next
}
