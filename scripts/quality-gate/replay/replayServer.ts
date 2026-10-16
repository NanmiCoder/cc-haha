/**
 * Serves recorded traffic back to the real server and CLI.
 *
 * Each incoming request takes the next unused recorded interaction of its queue
 * and must match it structurally: same model and stream mode, same last role,
 * the same user text, and tool results for exactly the tool calls the previous
 * reply made. A request that does not match gets a 400 (which the CLI does not
 * retry) and a field-level diff, so a replay fails loudly at the first point
 * where the app behaves differently from the recording. Prompt or tool-schema
 * changes that do not change that structure only show up as drift.
 */

import { isStrictQueue, queueKey, systemText, type Cassette, type Interaction } from './cassette'
import { expandEvents, learnVolatileValues, normalizedFingerprint, expandJson, expandString, normalizeString, unexpandedPlaceholders, type PlaceholderTable } from './normalize'
import { responseToolNames, serializeSseEvent, type ApiFormat, type RequestFingerprint } from './wire'

export type ReplayMismatch = {
  seq: number | null
  path: string
  queue: string
  reason: string
  expected?: Partial<RequestFingerprint>
  actual: RequestFingerprint
}

export type ReplayReport = {
  cassette: string
  served: number
  mismatches: ReplayMismatch[]
  /** Strict interactions the app never asked for: the run did less than the recording. */
  unused: Array<{ seq: number; queue: string; lastUserText: string }>
  /** Best-effort side calls that had no recording and got a placeholder reply. */
  synthesized: Array<{ path: string; queue: string }>
  /** Prompt, schema, or budget differences that did not break the replay. */
  drift: string[]
}

export type ReplayServer = {
  url: string
  /**
   * Makes `cassette` the traffic to serve. `table` gives this run's placeholder
   * values; a function is re-read per request, since session ids appear mid-run.
   * `pacing: 'recorded'` replays the recorded latency and stream timing instead
   * of a compressed rhythm, for scenarios whose concurrency depends on it.
   */
  load(cassette: Cassette, table: PlaceholderTable | (() => PlaceholderTable), options?: { pacing?: 'compressed' | 'recorded' }): void
  finish(): ReplayReport
  stop(): Promise<void>
}

/** Events past the recorded prefix never arrive; a cut-short stream stays open until the client hangs up. */
function streamEnded(format: ApiFormat, interaction: Interaction) {
  const events = interaction.response.events ?? []
  return events.some((event) => {
    const data = event.data as Record<string, any>
    if (format === 'anthropic') return data?.type === 'message_stop' || data?.type === 'error'
    return event.data === '[DONE]' || (Array.isArray(data?.choices) && data.choices.some((choice: { finish_reason?: unknown }) => choice.finish_reason))
  })
}

function errorResponse(format: ApiFormat, message: string) {
  const body = format === 'anthropic'
    ? { type: 'error', error: { type: 'invalid_request_error', message } }
    : { error: { type: 'invalid_request_error', message } }
  return Response.json(body, { status: 400 })
}

function placeholderReply(format: ApiFormat, model: string, stream: boolean) {
  const text = 'Replay placeholder'
  if (format === 'anthropic') {
    const message = { id: 'msg_replay_placeholder', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    if (!stream) return Response.json(message)
    const events = [
      { event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]
    return new Response(events.map(serializeSseEvent).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const chunk = { id: 'chatcmpl-replay', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
  if (!stream) return Response.json({ id: 'chatcmpl-replay', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  return new Response(`${serializeSseEvent({ data: chunk })}${serializeSseEvent({ data: '[DONE]' })}`, { headers: { 'content-type': 'text/event-stream' } })
}

function sameIds(a: string[], b: string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
}

/** Why `actual` cannot be the request `expected` was recorded for, or null. */
export function compareRequest(expected: Interaction, actual: RequestFingerprint, previousToolUseIds: string[] | undefined, format: ApiFormat): string | null {
  const recorded = expected.request
  if (recorded.model !== actual.model) return `model ${actual.model} != recorded ${recorded.model}`
  if (recorded.stream !== actual.stream) return `stream=${actual.stream} != recorded ${recorded.stream}`
  if (recorded.lastRole !== actual.lastRole) return `last message role ${actual.lastRole} != recorded ${recorded.lastRole}`
  if (recorded.lastUserText !== actual.lastUserText) return 'last user text differs from the recording'
  // Parallel tools finish in any order and their results go back in completion
  // order, so only the set of answered calls has to match.
  if (!sameIds(recorded.toolResultIds, actual.toolResultIds)) return `tool results ${JSON.stringify(actual.toolResultIds)} != recorded ${JSON.stringify(recorded.toolResultIds)}`
  if (previousToolUseIds && actual.toolResultIds.length > 0 && !sameIds(previousToolUseIds, actual.toolResultIds)) {
    return `tool results ${JSON.stringify(actual.toolResultIds)} do not answer the previous reply's tool calls ${JSON.stringify(previousToolUseIds)}`
  }
  const offered = new Set(actual.toolNames)
  const called = responseToolNames(format, expected.response.events ?? [], expected.response.json)
  const missing = called.filter((name) => !offered.has(name))
  if (missing.length > 0) return `the recorded reply calls ${missing.join(', ')}, which this request no longer offers`
  return null
}

const STREAM_PACING_BUDGET_MS = 1_000
const RECORDED_EVENT_DELAY_CAP_MS = 2_000
const RECORDED_FIRST_BYTE_CAP_MS = 20_000

export function startReplayServer(options: { format: ApiFormat; maxEventDelayMs?: number }): ReplayServer {
  const { format } = options
  const maxDelay = options.maxEventDelayMs ?? 15
  let cassette: Cassette | null = null
  let readTable: () => PlaceholderTable = () => []
  let learned: Record<string, string> = {}
  let pacing: 'compressed' | 'recorded' = 'compressed'
  let used = new Set<number>()
  let lastToolUseIds = new Map<string, string[]>()
  let report: ReplayReport = { cassette: '', served: 0, mismatches: [], unused: [], synthesized: [], drift: [] }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET') return Response.json({ data: [], has_more: false })
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const currentTable = () => [...readTable(), ...Object.entries(learned).map(([name, value]) => ({ name, values: [value] }))]
      let table = currentTable()
      let actual = normalizedFingerprint(format, body, table)
      const system = normalizeString(systemText(format, body), table)
      const queue = queueKey(path, actual, system)
      if (!cassette) return errorResponse(format, 'replay_mismatch: no cassette loaded')

      const next = cassette.interactions.find((interaction) => !used.has(interaction.seq) && interaction.queue === queue && interaction.path === path)
      // A clock-minted value first seen in this request: learn it from the recorded text.
      if (next && isStrictQueue(queue)) {
        let changed = false
        for (const field of ['firstUserText', 'lastUserText'] as const) {
          if (!/\{\{V\d+\}\}/.test(next.request[field]) || next.request[field] === actual[field]) continue
          const values = learnVolatileValues(next.request[field], actual[field])
          for (const [name, value] of Object.entries(values ?? {})) {
            if (learned[name] === undefined) { learned[name] = value; changed = true }
          }
        }
        if (changed) {
          table = currentTable()
          actual = normalizedFingerprint(format, body, table)
        }
      }
      const values = Object.fromEntries(table.map(({ name, values: candidates }) => [name, candidates[0] ?? '']))
      if (!next) {
        if (isStrictQueue(queue)) {
          report.mismatches.push({ seq: null, path, queue, reason: 'the recording has no further request of this kind', actual })
          return errorResponse(format, `replay_mismatch: unexpected extra ${path} request`)
        }
        report.synthesized.push({ path, queue })
        if (/count_tokens/.test(path)) return Response.json({ input_tokens: 1000 })
        return placeholderReply(format, actual.model, actual.stream)
      }

      if (isStrictQueue(queue)) {
        const problem = compareRequest(next, actual, lastToolUseIds.get(queue), format)
        if (problem) {
          const { systemSha: _s, toolsSha: _t, ...expected } = next.request
          report.mismatches.push({ seq: next.seq, path, queue, reason: problem, expected, actual })
          return errorResponse(format, `replay_mismatch at recorded request ${next.seq}: ${problem}`)
        }
        lastToolUseIds.set(queue, next.toolUseIds)
        // Neither the system prompt nor the tool schemas are compared: both carry
        // the OS, shell, and date, so they differ between the recording machine
        // and every CI runner. The tool list and token budget do not.
        if (next.request.maxTokens !== actual.maxTokens) report.drift.push(`request ${next.seq}: max_tokens ${actual.maxTokens} != recorded ${next.request.maxTokens}`)
        if (JSON.stringify(next.request.toolNames) !== JSON.stringify(actual.toolNames)) report.drift.push(`request ${next.seq}: tool list changed since recording`)
      }
      used.add(next.seq)
      report.served += 1

      const response = next.response
      if (response.events) {
        const events = expandEvents(format, response.events, values)
        const leaked = unexpandedPlaceholders(events)
        if (leaked.length > 0) {
          report.mismatches.push({ seq: next.seq, path, queue, reason: `no value for placeholders ${leaked.join(', ')}`, actual })
          return errorResponse(format, `replay_mismatch: unexpanded placeholders ${leaked.join(', ')}`)
        }
        const ended = streamEnded(format, next)
        // Keep the recorded rhythm for short streams; a long compaction summary
        // gets at most about a second of pacing in total.
        const eventDelayCap = pacing === 'recorded'
          ? RECORDED_EVENT_DELAY_CAP_MS
          : Math.min(maxDelay, Math.floor(STREAM_PACING_BUDGET_MS / Math.max(1, events.length)))
        if (pacing === 'recorded' && response.firstByteMs) await Bun.sleep(Math.min(response.firstByteMs, RECORDED_FIRST_BYTE_CAP_MS))
        const encoder = new TextEncoder()
        let cancelled = false
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const [index, event] of events.entries()) {
              if (cancelled) return
              const dt = (response.events![index] as { dt?: number }).dt ?? 0
              if (index > 0 && dt > 0 && eventDelayCap > 0) await Bun.sleep(Math.min(dt, eventDelayCap))
              if (cancelled) return
              controller.enqueue(encoder.encode(serializeSseEvent(event)))
            }
            if (ended) {
              controller.close()
              return
            }
            // Cut short in the recording by the client: wait for the same hang-up.
            while (!cancelled) await Bun.sleep(50)
          },
          cancel() {
            cancelled = true
          },
        })
        return new Response(stream, { status: response.status, headers: { 'content-type': response.contentType || 'text/event-stream', 'cache-control': 'no-cache' } })
      }
      if (pacing === 'recorded' && response.firstByteMs) await Bun.sleep(Math.min(response.firstByteMs, RECORDED_FIRST_BYTE_CAP_MS))
      if (response.json !== undefined) {
        return Response.json(expandJson(response.json, values), { status: response.status })
      }
      return new Response(expandString(response.text ?? '', values), { status: response.status, headers: { 'content-type': response.contentType || 'text/plain' } })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    load(next, nextTable, options) {
      cassette = next
      readTable = typeof nextTable === 'function' ? nextTable : () => nextTable
      learned = {}
      pacing = options?.pacing ?? 'compressed'
      used = new Set()
      lastToolUseIds = new Map()
      report = { cassette: next.id, served: 0, mismatches: [], unused: [], synthesized: [], drift: [] }
    },
    finish() {
      if (cassette) {
        report.unused = cassette.interactions
          .filter((interaction) => !used.has(interaction.seq) && isStrictQueue(interaction.queue))
          .map((interaction) => ({ seq: interaction.seq, queue: interaction.queue, lastUserText: interaction.request.lastUserText }))
      }
      report.drift = [...new Set(report.drift)]
      return report
    },
    async stop() {
      await server.stop(true)
    },
  }
}
