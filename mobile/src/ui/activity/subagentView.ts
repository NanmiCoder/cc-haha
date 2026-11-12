import { normalizeHistory } from '../../core/chat'
import type { BackgroundTask, SubagentOutput } from '../../core/operations'
import type { ChatItem } from '../../core/types'
import { currentStepLabel } from '../chat/captionModel'
import { buildChatRows, type ChatRow, type StepLabel } from '../chat/steps'

export type SubagentRunView = {
  /** Task given by the main agent (the first user message in the transcript). */
  prompt: ChatItem | null
  /** Same rows as the main conversation: the first row is the prompt, and the process after finishing collapses into "Took …". */
  rows: ChatRow[]
  /** The step currently in progress while running (already removed from the step summary and drawn separately at the end by the page). */
  current: StepLabel | null
  truncated: boolean
  /** transcript has none at all. */
  empty: boolean
}

/**
 * Normalize raw subagent records from the computer into the same timeline as the main conversation: 
 * the first user message is the task given by the main agent, and the whole thing goes through the same buildChatRows (tool aggregation, collapsing).
 * When there are no records at all, finished runs fall back to the final result from the computer, and running ones stay blank.
 */
export function subagentRunView(
  output: Pick<SubagentOutput, 'messages' | 'result' | 'truncated'> | null,
  running: boolean,
  /** Team member page: show messages between members. */
  options: { teammates?: 'show' } = {}
): SubagentRunView {
  if (!output) return { prompt: null, rows: [], current: null, truncated: false, empty: true }
  const items = normalizeHistory(output.messages ?? [], options)
  const prompt = items.find((item) => item.type === 'user' && !item.teammateFrom) ?? null
  const result = output.result?.trim()
  const body: ChatItem[] =
    !items.length && !running && result
      ? [{ id: 'subagent:result', type: 'assistant', text: result }]
      : items
  return {
    prompt,
    rows: buildChatRows(body, running),
    current: running ? currentStepLabel(items) : null,
    truncated: output.truncated === true,
    empty: body.length === 0,
  }
}

export type SubagentHeader = {
  title: string
  status: BackgroundTask['status']
  startedAt?: number
}

const known = ['running', 'completed', 'failed', 'stopped'] as const

/** Header: name from the task description, state from the background task list, falling back to the transcript's own state when not in the list. */
export function subagentHeader(
  task: BackgroundTask | undefined,
  output: Pick<SubagentOutput, 'status'> | null
): SubagentHeader {
  const reported = known.find((status) => status === output?.status)
  const started = task?.startedAt ? Date.parse(task.startedAt) : NaN
  return {
    title: task?.description?.trim() || 'Subagent',
    status: task?.status ?? reported ?? 'completed',
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
  }
}
