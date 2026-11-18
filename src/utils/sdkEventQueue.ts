import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  remote_session_id?: string
  workflow_name?: string
  workflow_run_id?: string
  prompt?: string
  owner_agent_id?: string
}

type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  workflow_run_id?: string
  // Delta batch of workflow state changes. Clients upsert by
  // `${type}:${index}` then group by phaseIndex to rebuild the phase tree,
  // same fold as collectFromEvents + groupByPhase in PhaseProgress.tsx.
  workflow_progress?: SdkWorkflowProgress[]
  owner_agent_id?: string
}

// Emitted when a foreground agent completes without being backgrounded.
// Drained by drainSdkEvents() directly into the output stream — does NOT
// go through the print.ts XML task_notification parser and does NOT trigger
// the LLM loop. Consumers (e.g. VS Code session.ts) use this to remove the
// task from the subagent panel.
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  result?: string
  workflow_run_id?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  owner_agent_id?: string
}

// Mirrors notifySessionStateChanged. The CCR bridge already receives this
// via its own listener; SDK consumers (scmuxd, VS Code) need the same signal
// to know when the main turn's generator is idle vs actively producing.
// The 'idle' transition fires AFTER heldBackResult flushes and the bg-agent
// do-while loop exits — so SDK consumers can trust it as the authoritative
// "turn is over" signal even when result was withheld for background agents.
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

// A single tool_use / tool_result produced by a background (async) agent.
export type AgentToolActivity =
  | {
      kind: 'tool_use'
      tool_name: string
      tool_use_id: string
      input: unknown
    }
  | {
      kind: 'tool_result'
      tool_use_id: string
      content: unknown
      is_error: boolean
      duration_ms?: number
    }

// Emitted per tool_use / tool_result produced by a BACKGROUND (async) agent.
// Background agents run detached from the main query loop (void
// runAsyncAgentLifecycle), so their tool activity never reaches the parent's
// stdout stream the way a synchronous subagent's progress messages do —
// which is why the desktop shows their cards stuck on "no tool activity".
// Draining these into the output stream lets the desktop handler re-emit them
// as tool_use_complete / tool_result carrying the parent Agent tool_use_id, so
// the UI groups them under the agent card (childToolCallsByParent) exactly
// like a synchronous subagent. Does NOT trigger the LLM loop.
type AgentToolActivityEvent = {
  type: 'system'
  subtype: 'agent_tool_activity'
  task_id: string
  // Parent Agent tool_use id — the card this activity belongs under.
  tool_use_id: string
  activity: AgentToolActivity
  owner_agent_id?: string
}

export type AgentRunMessageEvent = {
  type: 'system'
  subtype: 'agent_run_message'
  run_agent_id: string
  stream_id: string
  target_agent_id: string
  target_agent_scope_id?: string
  event_kind: 'message' | 'complete' | 'cancelled' | 'error'
  message?: unknown
  error?: string
}

export type SdkEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent
  | AgentToolActivityEvent
  | AgentRunMessageEvent

const MAX_QUEUE_SIZE = 1000
const queue: SdkEvent[] = []
type EnvelopedAgentRunMessage = AgentRunMessageEvent & {
  uuid: UUID
  session_id: string
}
let agentRunMessageSink: ((event: EnvelopedAgentRunMessage) => void) | undefined

/**
 * Agent runs execute below the main query generator, so their token deltas
 * cannot wait for the next drainSdkEvents() call. The headless printer binds
 * this sink to its existing outbound FIFO while it is alive.
 */
export function setAgentRunMessageSink(
  sink: ((event: EnvelopedAgentRunMessage) => void) | undefined,
): () => void {
  agentRunMessageSink = sink
  return () => {
    if (agentRunMessageSink === sink) agentRunMessageSink = undefined
  }
}

export function enqueueSdkEvent(event: SdkEvent): void {
  // SDK events are only consumed (drained) in headless/streaming mode.
  // In TUI mode they would accumulate up to the cap and never be read.
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (event.subtype === 'agent_run_message') {
    if (agentRunMessageSink) {
      agentRunMessageSink({
        ...event,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  queue.push(event)
}

export function emitAgentRunMessage(
  route: {
    runAgentId: string
    streamId: string
    targetAgentId?: string
    targetAgentScopeId?: string
  },
  event:
    | { kind: 'message'; message: unknown }
    | { kind: 'complete' }
    | { kind: 'cancelled' }
    | { kind: 'error'; error: string },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'agent_run_message',
    run_agent_id: route.runAgentId,
    stream_id: route.streamId,
    target_agent_id: route.targetAgentId ?? route.runAgentId,
    ...(route.targetAgentScopeId
      ? { target_agent_scope_id: route.targetAgentScopeId }
      : {}),
    event_kind: event.kind,
    ...(event.kind === 'message' ? { message: event.message } : {}),
    ...(event.kind === 'error' ? { error: event.error } : {}),
  })
}

export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  if (queue.length === 0) {
    return []
  }
  const events = queue.splice(0)
  return events.map(e => ({
    ...e,
    uuid: randomUUID(),
    session_id: getSessionId(),
  }))
}

/**
 * Emit a task_notification SDK event for a task reaching a terminal state.
 *
 * registerTask() emits task_started for session-visible tasks; this is their
 * closing bookend. Agent-owned shell tasks stay scoped to their Agent tool call
 * and intentionally do not enter the session task event stream.
 * Call this from any exit path that sets a task terminal WITHOUT going
 * through enqueuePendingNotification-with-<task-id> (print.ts parses that
 * XML into the same SDK event, so paths that do both would double-emit).
 * Paths that suppress the XML notification (notified:true pre-set, kill
 * paths, abort branches) must call this directly so SDK consumers
 * (Scuttle's bg-task dot, VS Code subagent panel) see the task close.
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    workflowRunId?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
    ownerAgentId?: string
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    workflow_run_id: opts?.workflowRunId,
    usage: opts?.usage,
    ...(opts?.ownerAgentId ? { owner_agent_id: opts.ownerAgentId } : {}),
  })
}

/**
 * Emit one tool_use / tool_result produced by a background (async) agent so
 * the desktop can render it under the parent Agent card in real time.
 *
 * No-op in interactive (TUI) mode — enqueueSdkEvent only queues in
 * headless/streaming mode (the desktop's CLI subprocess), and synchronous
 * subagents already surface their activity through the normal progress path.
 */
export function emitAgentToolActivity(
  taskId: string,
  parentToolUseId: string,
  activity: AgentToolActivity,
  ownerAgentId?: string,
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'agent_tool_activity',
    task_id: taskId,
    tool_use_id: parentToolUseId,
    activity,
    ...(ownerAgentId ? { owner_agent_id: ownerAgentId } : {}),
  })
}
