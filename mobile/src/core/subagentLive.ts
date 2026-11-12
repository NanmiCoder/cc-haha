import type { ServerEvent, SubagentLive, SubagentStep } from './types'

/** Each subagent keeps only its last few steps; the list shows only the last two. */
export const MAX_SUBAGENT_STEPS = 6
export const MAX_SUBAGENT_READS = 60
/** Record at most this many subagent trajectories per session, dropping the earliest beyond it. */
export const MAX_SUBAGENT_ENTRIES = 24

/**
 * The same subagent may be reported from each of three channels: 
 * run  = agent_run_event(runAgentId, usually equal to the background task taskId); 
 * tool = tool events with parentToolUseId (the id of the parent Agent tool call); 
 * task = system_notification task_progress(taskId, counts only).
 */
export const runKey = (runAgentId: string) => `run:${runAgentId}`
export const toolKey = (toolUseId: string) => `tool:${toolUseId}`
export const taskKey = (taskId: string) => `task:${taskId}`

type Live = Record<string, SubagentLive>

const empty = (): SubagentLive => ({ steps: [], reads: [] })

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readPath(toolName: string, input: unknown) {
  if (toolName !== 'Read') return undefined
  const value = record(input)
  const path = value?.file_path ?? value?.path
  return typeof path === 'string' && path ? path : undefined
}

function put(live: Live | undefined, key: string, next: SubagentLive): Live {
  // Most recently updated goes last; beyond the cap drop the one idle longest, so ones still updating are not evicted.
  const { [key]: _previous, ...others } = live ?? {}
  const merged: Live = { ...others, [key]: next }
  const keys = Object.keys(merged)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SUBAGENT_ENTRIES))) delete merged[old]
  return merged
}

function addStep(
  live: Live | undefined,
  key: string,
  step: Omit<SubagentStep, 'done' | 'isError'>
): Live {
  const current = live?.[key] ?? empty()
  const index = current.steps.findIndex((item) => item.toolUseId === step.toolUseId)
  const steps =
    index >= 0
      ? current.steps.map((item, i) => (i === index ? { ...item, ...step } : item))
      : [...current.steps, { ...step, done: false }]
  const path = readPath(step.toolName, step.input)
  return put(live, key, {
    ...current,
    steps: steps.slice(-MAX_SUBAGENT_STEPS),
    reads:
      path && !current.reads.includes(path)
        ? [...current.reads, path].slice(-MAX_SUBAGENT_READS)
        : current.reads,
    finished: false,
  })
}

function finishStep(live: Live | undefined, key: string, toolUseId: string, isError: boolean) {
  const current = live?.[key]
  const index = current?.steps.findIndex((item) => item.toolUseId === toolUseId) ?? -1
  if (!current || index < 0) return live
  return put(live, key, {
    ...current,
    steps: current.steps.map((item, i) => (i === index ? { ...item, done: true, isError } : item)),
  })
}

function finishRun(live: Live | undefined, key: string) {
  const current = live?.[key]
  if (!current || (current.finished && current.steps.every((step) => step.done))) return live
  return put(live, key, {
    ...current,
    finished: true,
    steps: current.steps.map((step) => (step.done ? step : { ...step, done: true })),
  })
}

/**
 * Accumulate subagent-related WebSocket events into live trajectories.
 * When there is nothing to record return the same object, so callers can use === to check for changes.
 */
export function reduceSubagents(live: Live | undefined, event: ServerEvent): Live | undefined {
  switch (event.type) {
    case 'agent_run_event': {
      const key = runKey(event.runAgentId)
      const inner = event.event
      if (inner.type === 'tool_use_complete')
        return addStep(live, key, {
          toolUseId: inner.toolUseId,
          toolName: inner.toolName,
          input: inner.input,
        })
      if (inner.type === 'tool_result')
        return finishStep(live, key, inner.toolUseId, inner.isError)
      if (inner.type === 'status' && inner.state === 'idle') return finishRun(live, key)
      if (inner.type === 'error') return finishRun(live, key)
      return live
    }
    case 'tool_use_complete':
      return event.parentToolUseId
        ? addStep(live, toolKey(event.parentToolUseId), {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
          })
        : live
    case 'tool_result':
      return event.parentToolUseId
        ? finishStep(live, toolKey(event.parentToolUseId), event.toolUseId, event.isError)
        : live
    case 'system_notification': {
      const data = record(event.data)
      const taskId = typeof data?.task_id === 'string' ? data.task_id : ''
      if (!taskId) return live
      const key = taskKey(taskId)
      if (event.subtype === 'task_progress') {
        const usage = record(data?.usage)
        const toolUses = usage?.tool_uses
        if (typeof toolUses !== 'number' || !Number.isFinite(toolUses)) return live
        const current = live?.[key] ?? empty()
        return current.toolUses === toolUses ? live : put(live, key, { ...current, toolUses })
      }
      if (event.subtype === 'task_notification') {
        const current = live?.[key]
        return current && !current.finished ? put(live, key, { ...current, finished: true }) : live
      }
      return live
    }
    default:
      return live
  }
}

/** Live data for one background task: counts from the task channel, recent steps prefer the run channel, then the tool channel. */
export function liveFor(
  live: Live | undefined,
  task: { taskId: string; toolUseId?: string }
): { steps: SubagentStep[]; reads: number; toolUses?: number } | null {
  if (!live) return null
  const byTask = live[taskKey(task.taskId)]
  const byRun = live[runKey(task.taskId)]
  const byTool = task.toolUseId ? live[toolKey(task.toolUseId)] : undefined
  const source = byRun?.steps.length ? byRun : byTool?.steps.length ? byTool : undefined
  if (!source && !byTask) return null
  return {
    steps: source?.steps ?? [],
    reads: source?.reads.length ?? 0,
    toolUses: byTask?.toolUses,
  }
}
