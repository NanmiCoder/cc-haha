import type { ResolvedOutputBudget } from './transform/requestCompatibility.js'

export const PROTOCOL_TRACE_FRAME_CHARS = 64 * 1024
export type ProtocolTraceTransport = 'open' | 'eof' | 'error' | 'cancelled' | 'non_stream'
type Protocol = 'openai_chat' | 'openai_responses'
type Usage = Record<string, number | Record<string, number>>

export type ProtocolTraceSummary = {
  version: 1
  protocol: Protocol
  transport: ProtocolTraceTransport
  bytesObserved: number
  droppedFrames: number
  malformedFrames: number
  termination: {
    finishReason?: string
    event?: string
    responseStatus?: string
    incompleteReason?: string
    errorType?: string
    errorCode?: string
    doneMarker?: boolean
  }
  usage: Usage
  outputBudget: {
    source: ResolvedOutputBudget['source'] | 'unknown'
    field: ResolvedOutputBudget['field'] | 'multiple'
    effective?: number
    wireFields: Record<string, number>
    requested?: number
    configured?: number
    hardLimit?: number
    reason?: ResolvedOutputBudget['reason']
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function atom(value: unknown): string | undefined {
  // Protocol enums/codes only: never copy error messages or arbitrary content.
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readUsage(value: unknown): Usage {
  const input = record(value)
  const result: Usage = {}
  if (!input) return result
  for (const key of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (count(input[key])) result[key] = input[key]
  }
  for (const key of ['input_tokens_details', 'output_tokens_details', 'prompt_tokens_details', 'completion_tokens_details']) {
    const details = record(input[key])
    if (!details) continue
    const retained: Record<string, number> = {}
    for (const field of ['cached_tokens', 'reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']) {
      if (count(details[field])) retained[field] = details[field]
    }
    if (Object.keys(retained).length) result[key] = retained
  }
  return result
}

/** A bounded, content-free summary independent of raw trace body truncation. */
export class ProtocolTraceObserver {
  private readonly decoder = new TextDecoder()
  private line = ''
  private data = ''
  private event = ''
  private frameChars = 0
  private oversized = false
  private afterCr = false
  private readonly summary: ProtocolTraceSummary

  constructor(protocol: Protocol, upstreamRequest: unknown, budget?: ResolvedOutputBudget) {
    const request = record(upstreamRequest)
    const wireFields: Record<string, number> = {}
    for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
      if (count(request?.[field])) wireFields[field] = request![field] as number
    }
    const fields = Object.keys(wireFields)
    this.summary = {
      version: 1, protocol, transport: 'open', bytesObserved: 0,
      droppedFrames: 0, malformedFrames: 0, termination: {}, usage: {},
      outputBudget: {
        source: budget?.source ?? 'unknown',
        field: fields.length === 0 ? 'omit' : fields.length === 1 ? fields[0] as ResolvedOutputBudget['field'] : 'multiple',
        ...(fields.length === 1 ? { effective: wireFields[fields[0]!] } : {}),
        wireFields,
        ...(budget ? {
          requested: budget.requested, reason: budget.reason,
          ...(budget.configured !== undefined ? { configured: budget.configured } : {}),
          ...(budget.hardLimit !== undefined ? { hardLimit: budget.hardLimit } : {}),
        } : {}),
      },
    }
  }

  push(chunk: Uint8Array): void {
    if (this.summary.transport !== 'open') return
    this.summary.bytesObserved += chunk.byteLength
    // Limit decoded temporary strings even if fetch delivers one huge chunk.
    for (let offset = 0; offset < chunk.byteLength; offset += 8192) {
      this.pushText(this.decoder.decode(chunk.subarray(offset, offset + 8192), { stream: true }))
    }
  }

  private pushText(text: string): void {
    for (const character of text) {
      if (this.afterCr) {
        this.afterCr = false
        if (character === '\n') continue
      }
      if (character === '\r' || character === '\n') {
        this.consumeLine()
        this.afterCr = character === '\r'
      } else {
        this.frameChars++
        if (this.frameChars > PROTOCOL_TRACE_FRAME_CHARS) {
          this.oversized = true
          // Keep just a nonempty-line marker until the next blank separator.
          this.line = 'x'
          this.data = ''
        } else if (!this.oversized) {
          this.line += character
        } else {
          this.line = 'x'
        }
      }
    }
  }

  private consumeLine(): void {
    const line = this.line
    this.line = ''
    if (line === '') {
      if (this.oversized) this.summary.droppedFrames++
      else if (this.data) {
        const data = this.data.endsWith('\n') ? this.data.slice(0, -1) : this.data
        if (data.trim() === '[DONE]') this.summary.termination.doneMarker = true
        else {
          try { this.observeJson(JSON.parse(data), this.event) }
          catch { this.summary.malformedFrames++ }
        }
      }
      this.data = ''
      this.event = ''
      this.frameChars = 0
      this.oversized = false
      return
    }
    if (this.oversized || line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data += `${value}\n`
    else if (field === 'event') this.event = atom(value) ?? ''
  }

  observeJson(value: unknown, event?: string): void {
    const body = record(value)
    if (!body) return
    const termination = this.summary.termination
    if (this.summary.protocol === 'openai_chat') {
      const choices = Array.isArray(body.choices) ? body.choices.slice(0, 8) : []
      const choice = choices.map(record).find(item => item?.index === 0) ?? record(choices[0])
      const reason = atom(choice?.finish_reason)
      if (reason) termination.finishReason = reason
      Object.assign(this.summary.usage, readUsage(body.usage))
    } else {
      const response = record(body.response) ?? body
      const eventType = atom(body.type) ?? atom(event)
      if (eventType && ['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled', 'error', 'response.error'].includes(eventType)) {
        termination.event = eventType
      }
      if (eventType === 'error' || eventType === 'response.error') {
        const code = atom(body.code)
        if (code) termination.errorCode = code
      }
      const status = atom(response.status)
      if (status) termination.responseStatus = status
      const reason = atom(record(response.incomplete_details)?.reason)
      if (reason) termination.incompleteReason = reason
      Object.assign(this.summary.usage, readUsage(response.usage))
      const error = record(response.error)
      if (atom(error?.type)) termination.errorType = atom(error!.type)
      if (atom(error?.code)) termination.errorCode = atom(error!.code)
    }
    const error = record(body.error)
    if (atom(error?.type)) termination.errorType = atom(error!.type)
    if (atom(error?.code)) termination.errorCode = atom(error!.code)
  }

  finish(transport: Exclude<ProtocolTraceTransport, 'open'>): void {
    if (this.summary.transport !== 'open') return
    // EOF does not dispatch an unterminated SSE event. A partial frame must
    // not be mistaken for a committed protocol terminal.
    this.summary.transport = transport
    this.line = ''
    this.data = ''
  }

  snapshot(): ProtocolTraceSummary {
    return structuredClone(this.summary)
  }
}

/** Observe only bytes requested downstream; preserve the stream's cancellation. */
export function observeProtocolStream(
  upstream: ReadableStream<Uint8Array>,
  observer: ProtocolTraceObserver,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cancelled = false
  const release = () => { reader?.releaseLock(); reader = undefined }
  const diagnose = (operation: () => void) => {
    try { operation() } catch { /* Diagnostics must never replace a transport result. */ }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= upstream.getReader()
      try {
        const { done, value } = await reader.read()
        if (cancelled) return
        if (done) {
          diagnose(() => observer.finish('eof'))
          release()
          controller.close()
        } else {
          diagnose(() => observer.push(value))
          controller.enqueue(value)
        }
      } catch (error) {
        if (cancelled) return
        diagnose(() => observer.finish('error'))
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      diagnose(() => observer.finish('cancelled'))
      try { await (reader ? reader.cancel(reason) : upstream.cancel(reason)) }
      finally { release() }
    },
  }, { highWaterMark: 0 })
}
