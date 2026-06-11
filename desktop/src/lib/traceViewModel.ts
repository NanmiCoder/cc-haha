import type { MessageEntry } from '../types/session'
import type { TraceCallRecord, TraceCallUsage, TraceEventRecord, TraceSession as TraceSessionData } from '../types/trace'

export type TraceSpanKind = 'session' | 'turn' | 'message' | 'llm' | 'tool' | 'tool_result' | 'event'
export type TraceSpanStatus = 'ok' | 'error' | 'pending'

export type TraceSpan = {
  id: string
  parentId: string | null
  childIds: string[]
  kind: TraceSpanKind
  status: TraceSpanStatus
  title: string
  subtitle: string
  timestamp: string
  completedAt?: string
  durationMs?: number
  turnIndex?: number
  message?: MessageEntry
  call?: TraceCallRecord
  event?: TraceEventRecord
  toolUseId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isSidechain?: boolean
  tokenUsage?: TraceCallUsage
  isLifecycleNoise?: boolean
  raw: unknown
}

export type TraceDiagnosisReason =
  | 'empty'
  | 'model_error'
  | 'tool_error'
  | 'event_error'
  | 'pending_model'
  | 'pending_tool'
  | 'waiting_for_agent'
  | 'healthy'

export type TraceDiagnosis = {
  status: 'empty' | 'healthy' | 'attention' | 'blocked'
  reason: TraceDiagnosisReason
  focusSpanId?: string
  evidenceSpanIds: string[]
  lastActivityAt: string
  errorCount: number
  pendingModelCalls: number
  pendingToolCalls: number
  modelCalls: number
  toolCalls: number
}

export type TraceTurn = {
  id: string
  index: number
  title: string
  timestamp: string
  spanIds: string[]
  userSpanId?: string
}

export type TraceViewModel = {
  rootId: string
  spans: TraceSpan[]
  spansById: Map<string, TraceSpan>
  turns: TraceTurn[]
  orderedSpanIds: string[]
  diagnosis: TraceDiagnosis
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

type TextBlock = {
  type?: string
  text?: string
}

type MutableSpan = Omit<TraceSpan, 'childIds'> & { childIds: string[] }

export function buildTraceViewModel(
  trace: TraceSessionData,
  messages: MessageEntry[],
): TraceViewModel {
  const spans = new Map<string, MutableSpan>()
  const turns: TraceTurn[] = []
  const rootId = 'session:root'
  const traceEvents = trace.events ?? []
  const fallbackTimestamp = earliestTimestamp(trace.calls, messages, traceEvents) ?? new Date().toISOString()
  const hasPendingCalls = trace.calls.some((call) => getCallStatus(call) === 'pending')
  const hasTraceErrors = trace.summary.failedCalls > 0 || traceEvents.some((event) => event.severity === 'error')

  addSpan(spans, {
    id: rootId,
    parentId: null,
    kind: 'session',
    status: hasTraceErrors ? 'error' : hasPendingCalls ? 'pending' : 'ok',
    title: trace.session?.title ?? trace.sessionId,
    subtitle: `${trace.summary.apiCalls} model calls`,
    timestamp: fallbackTimestamp,
    completedAt: trace.summary.updatedAt ?? undefined,
    durationMs: trace.summary.totalDurationMs,
    raw: {
      sessionId: trace.sessionId,
      summary: trace.summary,
      session: trace.session,
      events: traceEvents,
    },
  })

  const userTurnStarts = messages.filter((message) => message.type === 'user' && !hasToolResultBlocks(message.content))
  if (userTurnStarts.length === 0) {
    turns.push(createTurn(0, fallbackTimestamp, 'Session activity'))
  } else {
    userTurnStarts.forEach((message, index) => {
      turns.push(createTurn(index, message.timestamp, createTurnTitle(index, message.content)))
    })
  }

  for (const turn of turns) {
    addSpan(spans, {
      id: turn.id,
      parentId: rootId,
      kind: 'turn',
      status: 'ok',
      title: turn.title,
      subtitle: `Turn ${turn.index + 1}`,
      timestamp: turn.timestamp,
      turnIndex: turn.index,
      raw: { index: turn.index, timestamp: turn.timestamp, title: turn.title },
    })
  }

  const toolSpanIds = new Map<string, string>()
  const resultBlocksByToolUseId = new Map<string, ToolResultBlock[]>()
  const deferredToolResultSpans: Array<{ parentId: string; message: MessageEntry; block: ToolResultBlock }> = []

  for (const message of messages) {
    const turn = findTurnForTimestamp(turns, message.timestamp)
    const turnId = turn.id

    if (message.type === 'tool_result') {
      const resultBlocks = extractToolResultBlocks(message.content)
      if (resultBlocks.length === 0) {
        const spanId = `message:${message.id}`
        addMessageSpan(spans, spanId, turnId, turn.index, message)
        turn.spanIds.push(spanId)
        continue
      }

      for (const block of resultBlocks) {
        if (block.tool_use_id) {
          const existing = resultBlocksByToolUseId.get(block.tool_use_id) ?? []
          existing.push(block)
          resultBlocksByToolUseId.set(block.tool_use_id, existing)
        }
        const toolParentId = block.tool_use_id ? toolSpanIds.get(block.tool_use_id) : undefined
        if (toolParentId) {
          const spanId = `tool_result:${message.id}:${block.tool_use_id ?? resultBlocks.indexOf(block)}`
          addToolResultSpan(spans, spanId, toolParentId, turn.index, message, block)
          turn.spanIds.push(spanId)
        } else {
          deferredToolResultSpans.push({ parentId: turnId, message, block })
        }
      }
      continue
    }

    const text = extractTextContent(message.content)
    if (message.type !== 'tool_use' || text.trim()) {
      const spanId = `message:${message.id}`
      addMessageSpan(spans, spanId, turnId, turn.index, message)
      turn.spanIds.push(spanId)
      if (message.type === 'user' && !hasToolResultBlocks(message.content)) {
        turn.userSpanId = spanId
      }
    }

    if (message.type === 'tool_use') {
      for (const block of extractToolUseBlocks(message.content)) {
        const toolId = block.id ?? `${message.id}:${block.name ?? 'tool'}`
        const parentToolId = message.parentToolUseId ? toolSpanIds.get(message.parentToolUseId) : undefined
        const parentId = parentToolId ?? turnId
        const spanId = `tool:${toolId}`
        toolSpanIds.set(toolId, spanId)
        const resultBlocks = block.id ? resultBlocksByToolUseId.get(block.id) ?? [] : []
        addSpan(spans, {
          id: spanId,
          parentId,
          kind: 'tool',
          status: resultBlocks.some((result) => result.is_error) ? 'error' : resultBlocks.length > 0 ? 'ok' : 'pending',
          title: block.name ?? 'Tool call',
          subtitle: summarizeToolInput(block.input),
          timestamp: message.timestamp,
          turnIndex: turn.index,
          message,
          toolUseId: toolId,
          toolName: block.name,
          input: block.input,
          output: resultBlocks.map((result) => result.content),
          isSidechain: message.isSidechain,
          raw: block,
        })
        turn.spanIds.push(spanId)
      }
    }
  }

  for (const item of deferredToolResultSpans) {
    const turn = findTurnForTimestamp(turns, item.message.timestamp)
    const spanId = `tool_result:${item.message.id}:${item.block.tool_use_id ?? turn.spanIds.length}`
    addToolResultSpan(spans, spanId, item.parentId, turn.index, item.message, item.block)
    turn.spanIds.push(spanId)
  }

  for (const call of trace.calls) {
    const turn = findTurnForTimestamp(turns, call.startedAt)
    const spanId = `llm:${call.id}`
    addSpan(spans, {
      id: spanId,
      parentId: turn.id,
      kind: 'llm',
      status: getCallStatus(call),
      title: call.model ?? call.provider?.name ?? 'Model call',
      subtitle: call.provider?.name ?? call.source,
      timestamp: call.startedAt,
      completedAt: call.completedAt,
      durationMs: call.durationMs,
      turnIndex: turn.index,
      call,
      tokenUsage: call.usage,
      raw: call,
    })
    turn.spanIds.push(spanId)
  }

  for (const event of traceEvents) {
    const turn = findTurnForTimestamp(turns, event.timestamp)
    const callParentId = event.callId ? `llm:${event.callId}` : undefined
    const parentId = callParentId && spans.has(callParentId) ? callParentId : turn.id
    const spanId = `event:${event.id}`
    addSpan(spans, {
      id: spanId,
      parentId,
      kind: 'event',
      status: getEventStatus(event),
      title: event.title ?? formatTraceEventPhase(event.phase),
      subtitle: event.message ?? previewTraceValue(event.metadata),
      timestamp: event.timestamp,
      turnIndex: turn.index,
      event,
      isLifecycleNoise: isLifecycleNoiseEvent(event),
      raw: event,
    })
    turn.spanIds.push(spanId)
  }

  for (const turn of turns) {
    const childStatuses = turn.spanIds
      .map((spanId) => spans.get(spanId)?.status)
      .filter(Boolean)
    const turnSpan = spans.get(turn.id)
    if (turnSpan) {
      turnSpan.status = childStatuses.includes('error')
        ? 'error'
        : childStatuses.includes('pending')
          ? 'pending'
          : 'ok'
      turnSpan.subtitle = `${turn.spanIds.length} spans`
    }
  }

  const orderedSpanIds = orderSpans(spans, rootId)
  const spanList = orderedSpanIds.map((id) => spans.get(id)).filter(Boolean) as TraceSpan[]
  return {
    rootId,
    spans: spanList,
    spansById: new Map(spanList.map((span) => [span.id, span])),
    turns,
    orderedSpanIds,
    diagnosis: buildDiagnosis(spanList, turns, rootId, fallbackTimestamp),
  }
}

function buildDiagnosis(
  spans: TraceSpan[],
  turns: TraceTurn[],
  rootId: string,
  fallbackTimestamp: string,
): TraceDiagnosis {
  const meaningfulSpans = spans.filter((span) => span.id !== rootId)
  const errorSpans = meaningfulSpans.filter((span) => span.status === 'error')
  const pendingModels = meaningfulSpans.filter((span) => span.kind === 'llm' && span.status === 'pending')
  const pendingTools = meaningfulSpans.filter((span) => span.kind === 'tool' && span.status === 'pending')
  const toolErrors = errorSpans.filter((span) => span.kind === 'tool' || span.kind === 'tool_result')
  const modelErrors = errorSpans.filter((span) => span.kind === 'llm')
  const eventErrors = errorSpans.filter((span) => span.kind === 'event')
  const lastSpan = meaningfulSpans
    .slice()
    .sort((a, b) => compareSpanTime(a, b))
    .at(-1)
  const lastTurn = turns.at(-1)
  const lastTurnSpans = lastTurn
    ? lastTurn.spanIds.map((spanId) => spans.find((span) => span.id === spanId)).filter(Boolean) as TraceSpan[]
    : []
  const lastTurnHasUser = lastTurnSpans.some((span) => span.message?.type === 'user')
  const lastTurnHasAgentWork = lastTurnSpans.some((span) =>
    span.kind === 'llm' ||
    span.kind === 'tool' ||
    span.kind === 'tool_result' ||
    span.message?.type === 'assistant' ||
    span.message?.type === 'tool_use'
  )

  if (meaningfulSpans.length === 0) {
    return {
      status: 'empty',
      reason: 'empty',
      evidenceSpanIds: [],
      lastActivityAt: fallbackTimestamp,
      errorCount: 0,
      pendingModelCalls: 0,
      pendingToolCalls: 0,
      modelCalls: 0,
      toolCalls: 0,
    }
  }

  if (modelErrors.length > 0) {
    return createDiagnosis('blocked', 'model_error', modelErrors, spans, fallbackTimestamp)
  }
  if (toolErrors.length > 0) {
    return createDiagnosis('blocked', 'tool_error', toolErrors, spans, fallbackTimestamp)
  }
  if (eventErrors.length > 0) {
    return createDiagnosis('blocked', 'event_error', eventErrors, spans, fallbackTimestamp)
  }
  if (pendingModels.length > 0) {
    return createDiagnosis('attention', 'pending_model', pendingModels, spans, fallbackTimestamp)
  }
  if (pendingTools.length > 0) {
    return createDiagnosis('attention', 'pending_tool', pendingTools, spans, fallbackTimestamp)
  }
  if (lastTurnHasUser && !lastTurnHasAgentWork) {
    const evidence = lastTurnSpans.length > 0 ? lastTurnSpans : lastSpan ? [lastSpan] : []
    return createDiagnosis('attention', 'waiting_for_agent', evidence, spans, fallbackTimestamp)
  }

  return createDiagnosis('healthy', 'healthy', lastSpan ? [lastSpan] : [], spans, fallbackTimestamp)
}

function createDiagnosis(
  status: TraceDiagnosis['status'],
  reason: TraceDiagnosisReason,
  evidence: TraceSpan[],
  spans: TraceSpan[],
  fallbackTimestamp: string,
): TraceDiagnosis {
  const errors = spans.filter((span) => span.status === 'error')
  const pendingModels = spans.filter((span) => span.kind === 'llm' && span.status === 'pending')
  const pendingTools = spans.filter((span) => span.kind === 'tool' && span.status === 'pending')
  const lastActivityAt = spans
    .slice()
    .sort((a, b) => compareSpanTime(a, b))
    .at(-1)?.timestamp ?? fallbackTimestamp
  return {
    status,
    reason,
    focusSpanId: evidence[0]?.id,
    evidenceSpanIds: evidence.map((span) => span.id),
    lastActivityAt,
    errorCount: errors.length,
    pendingModelCalls: pendingModels.length,
    pendingToolCalls: pendingTools.length,
    modelCalls: spans.filter((span) => span.kind === 'llm').length,
    toolCalls: spans.filter((span) => span.kind === 'tool').length,
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return formatUnknown(content)
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const record = block as TextBlock
      if (typeof record.text === 'string') return [record.text]
      if ('content' in record && typeof (record as { content?: unknown }).content === 'string') {
        return [(record as { content: string }).content]
      }
      return []
    })
    .join('\n')
}

export function previewTraceValue(value: unknown, maxChars = 180): string {
  const text = extractTextContent(value).replace(/\s+/g, ' ').trim()
  if (!text) return 'empty'
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

export function formatTraceJson(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return parsed === null ? value : JSON.stringify(parsed, null, 2)
  }
  return formatUnknown(value)
}

export function getTraceValueLanguage(value: unknown, fallback: 'json' | 'text' = 'json'): 'json' | 'text' {
  if (typeof value !== 'string') return 'json'
  return parseJson(value) === null ? fallback : 'json'
}

function addMessageSpan(
  spans: Map<string, MutableSpan>,
  id: string,
  parentId: string,
  turnIndex: number,
  message: MessageEntry,
) {
  addSpan(spans, {
    id,
    parentId,
    kind: 'message',
    status: 'ok',
    title: titleForMessage(message),
    subtitle: previewTraceValue(message.content),
    timestamp: message.timestamp,
    turnIndex,
    message,
    raw: message,
  })
}

function addToolResultSpan(
  spans: Map<string, MutableSpan>,
  id: string,
  parentId: string,
  turnIndex: number,
  message: MessageEntry,
  block: ToolResultBlock,
) {
  addSpan(spans, {
    id,
    parentId,
    kind: 'tool_result',
    status: block.is_error ? 'error' : 'ok',
    title: block.is_error ? 'Tool error' : 'Tool result',
    subtitle: previewTraceValue(block.content),
    timestamp: message.timestamp,
    turnIndex,
    message,
    toolUseId: block.tool_use_id,
    output: block.content,
    raw: block,
  })
  const parent = spans.get(parentId)
  if (parent?.kind === 'tool') {
    parent.status = block.is_error ? 'error' : 'ok'
    const existingOutput = Array.isArray(parent.output) ? parent.output : parent.output === undefined ? [] : [parent.output]
    parent.output = [...existingOutput, block.content]
  }
}

function addSpan(spans: Map<string, MutableSpan>, span: Omit<TraceSpan, 'childIds'>) {
  if (spans.has(span.id)) return
  spans.set(span.id, { ...span, childIds: [] })
  if (span.parentId) {
    const parent = spans.get(span.parentId)
    if (parent && !parent.childIds.includes(span.id)) {
      parent.childIds.push(span.id)
    }
  }
}

function orderSpans(spans: Map<string, MutableSpan>, rootId: string): string[] {
  const result: string[] = []
  const visit = (id: string) => {
    const span = spans.get(id)
    if (!span) return
    result.push(id)
    span.childIds.sort((a, b) => compareSpanTime(spans.get(a), spans.get(b)))
    for (const childId of span.childIds) visit(childId)
  }
  visit(rootId)
  return result
}

function compareSpanTime(a?: MutableSpan, b?: MutableSpan): number {
  if (!a || !b) return 0
  const diff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  if (Number.isFinite(diff) && diff !== 0) return diff
  return a.id.localeCompare(b.id)
}

function createTurn(index: number, timestamp: string, title: string): TraceTurn {
  return {
    id: `turn:${index}`,
    index,
    title,
    timestamp,
    spanIds: [],
  }
}

function createTurnTitle(index: number, content: unknown): string {
  const preview = previewTraceValue(content, 54)
  return preview === 'empty' ? `Turn ${index + 1}` : preview
}

function findTurnForTimestamp(turns: TraceTurn[], timestamp: string): TraceTurn {
  const time = new Date(timestamp).getTime()
  if (!Number.isFinite(time)) return turns[0]!
  let current = turns[0]!
  for (const turn of turns) {
    const turnTime = new Date(turn.timestamp).getTime()
    if (Number.isFinite(turnTime) && turnTime <= time) {
      current = turn
    }
  }
  return current
}

function earliestTimestamp(
  calls: TraceCallRecord[],
  messages: MessageEntry[],
  events: TraceEventRecord[] = [],
): string | null {
  const timestamps = [
    ...calls.map((call) => call.startedAt),
    ...messages.map((message) => message.timestamp),
    ...events.map((event) => event.timestamp),
  ]
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time)
  return timestamps[0]?.value ?? null
}

function hasToolResultBlocks(content: unknown): boolean {
  return extractToolResultBlocks(content).length > 0
}

function extractToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ToolUseBlock =>
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_use'
  )
}

function extractToolResultBlocks(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ToolResultBlock =>
    !!block &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_result'
  )
}

function titleForMessage(message: MessageEntry): string {
  switch (message.type) {
    case 'user': return 'User message'
    case 'assistant': return message.model ? `Assistant · ${message.model}` : 'Assistant message'
    case 'system': return 'System message'
    case 'tool_use': return 'Assistant tool request'
    case 'tool_result': return 'Tool result'
    default: return message.type
  }
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const primary = record.command ?? record.file_path ?? record.path ?? record.query ?? record.description
    if (typeof primary === 'string' && primary.trim()) return primary.trim()
  }
  return previewTraceValue(input, 140)
}

function getCallStatus(call: TraceCallRecord): TraceSpanStatus {
  if (call.status === 'error' || call.error || (call.response?.status ?? 200) >= 400) return 'error'
  if (call.status === 'pending' || !call.response) return 'pending'
  return 'ok'
}

function getEventStatus(event: TraceEventRecord): TraceSpanStatus {
  return event.severity === 'error' ? 'error' : 'ok'
}

const LIFECYCLE_NOISE_PHASES = new Set([
  'api_call_started',
  'api_call_completed',
  'upstream_fetch_started',
  'upstream_fetch_completed',
])

function isLifecycleNoiseEvent(event: TraceEventRecord): boolean {
  return event.severity === 'info' && LIFECYCLE_NOISE_PHASES.has(event.phase)
}

function formatTraceEventPhase(phase: string): string {
  return phase
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatUnknown(value: unknown): string {
  try {
    // JSON.stringify(undefined) yields undefined, not a string.
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function parseJson(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}
