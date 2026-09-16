import { describe, expect, spyOn, test } from 'bun:test'
import { ProtocolTraceObserver, observeProtocolStream, PROTOCOL_TRACE_FRAME_CHARS } from './protocolTrace.js'

const encoder = new TextEncoder()
const wire = { model: 'fixture', max_completion_tokens: 64, messages: [{ content: 'SECRET_BODY' }] }

describe('bounded upstream protocol diagnostics', () => {
  test('retains raw terminal and final usage after more than the trace body capture cap', () => {
    const observer = new ProtocolTraceObserver('openai_chat', wire, {
      source: 'explicit', requested: 32000, effective: 64, field: 'max_completion_tokens', reason: 'hard_limit', hardLimit: 64,
    })
    const delta = encoder.encode(`data:${JSON.stringify({ choices: [{ delta: { content: 'SECRET_BODY'.repeat(100) } }] })}\r\n\r\n`)
    for (let index = 0; index < 1100; index++) observer.push(delta)
    observer.push(encoder.encode('data:{"choices":[{"index":0,"finish_reason":"length"}]}\r\n\r\ndata: {"choices":[],\r\ndata: "usage":{"prompt_tokens":10,"completion_tokens":64,"completion_tokens_details":{"reasoning_tokens":32,"secret":"SECRET_BODY"}}}\r\n\r\ndata:[DONE]\r\n\r\n'))
    observer.finish('eof')
    const summary = observer.snapshot()
    expect(summary.bytesObserved).toBeGreaterThan(1024 * 1024)
    expect(summary.termination).toEqual({ finishReason: 'length', doneMarker: true })
    expect(summary.usage).toEqual({ prompt_tokens: 10, completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 32 } })
    expect(summary.outputBudget).toMatchObject({ source: 'explicit', requested: 32000, field: 'max_completion_tokens', effective: 64 })
    expect(summary.transport).toBe('eof')
    expect(JSON.stringify(summary)).not.toContain('SECRET_BODY')
    expect(JSON.stringify(summary).length).toBeLessThan(2000)
  })

  test('recovers after malformed and oversized frames without retaining their bodies', () => {
    const observer = new ProtocolTraceObserver('openai_responses', {})
    observer.push(encoder.encode(`data:${'x'.repeat(PROTOCOL_TRACE_FRAME_CHARS + 10)}\n\ndata:{oops}\n\nevent:response.incomplete\ndata:{"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":8}}}\n\n`))
    observer.finish('eof')
    expect(observer.snapshot()).toMatchObject({
      droppedFrames: 1, malformedFrames: 1, transport: 'eof',
      termination: { event: 'response.incomplete', responseStatus: 'incomplete', incompleteReason: 'max_output_tokens' },
      usage: { input_tokens: 4, output_tokens: 8 },
      outputBudget: { source: 'unknown', field: 'omit' },
    })
  })

  test('parses boundaries split across chunks and observes non-stream responses without output content', () => {
    const observer = new ProtocolTraceObserver('openai_responses', { max_output_tokens: 128 })
    const frame = 'event:response.failed\r\ndata:{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"SECRET_BODY"}}}\r\n\r\n'
    for (const character of frame) observer.push(encoder.encode(character))
    expect(observer.snapshot().termination).toEqual({ event: 'response.failed', responseStatus: 'failed', errorCode: 'server_error' })
    const nonStream = new ProtocolTraceObserver('openai_chat', {})
    nonStream.observeJson({ choices: [{ message: { content: 'SECRET_BODY' }, finish_reason: 'tool_calls' }], usage: { completion_tokens: 7 } })
    nonStream.finish('non_stream')
    expect(nonStream.snapshot()).toMatchObject({ transport: 'non_stream', termination: { finishReason: 'tool_calls' }, usage: { completion_tokens: 7 } })
    expect(JSON.stringify(nonStream.snapshot())).not.toContain('SECRET_BODY')
  })

  test('does not invent a sent budget from the internal policy or retain provider error messages', () => {
    const observer = new ProtocolTraceObserver('openai_responses', {}, {
      source: 'default', requested: 32000, effective: 32000, field: 'max_output_tokens', reason: 'upstream_default',
    })
    observer.push(encoder.encode('event:error\ndata:{"type":"error","code":"server_error","message":"SECRET_BODY"}\n\n'))
    expect(observer.snapshot().outputBudget).toEqual({ source: 'default', requested: 32000, field: 'omit', reason: 'upstream_default', wireFields: {} })
    expect(observer.snapshot().termination).toEqual({ event: 'error', errorCode: 'server_error' })
    expect(JSON.stringify(observer.snapshot())).not.toContain('SECRET_BODY')
  })

  test('does not pre-read, forwards exact chunks, and propagates cancellation', async () => {
    let reads = 0
    let cancellation: unknown
    const chunk = encoder.encode('data:{"choices":[]}\n\n')
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(chunk) },
      cancel(reason) { cancellation = reason },
    }, { highWaterMark: 0 })
    const observer = new ProtocolTraceObserver('openai_chat', {})
    const stream = observeProtocolStream(source, observer)
    await Promise.resolve()
    expect(reads).toBe(0)
    const reader = stream.getReader()
    expect((await reader.read()).value).toBe(chunk)
    expect(reads).toBe(1)
    const reason = new Error('client cancelled')
    await reader.cancel(reason)
    expect(cancellation).toBe(reason)
    expect(observer.snapshot().transport).toBe('cancelled')
    expect(source.locked).toBe(false)
  })

  test('preserves upstream read errors and distinguishes EOF without a terminal frame', async () => {
    const failure = new Error('upstream failed')
    const observer = new ProtocolTraceObserver('openai_chat', {})
    const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure) } }, { highWaterMark: 0 })
    await expect(observeProtocolStream(source, observer).getReader().read()).rejects.toBe(failure)
    expect(observer.snapshot().transport).toBe('error')
    expect(source.locked).toBe(false)
    const empty = new ProtocolTraceObserver('openai_responses', {})
    const ended = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
    expect((await observeProtocolStream(ended, empty).getReader().read()).done).toBe(true)
    expect(empty.snapshot()).toMatchObject({ transport: 'eof', termination: {} })
  })

  test('a diagnostic failure cannot replace delivered bytes or the upstream error', async () => {
    const observer = new ProtocolTraceObserver('openai_chat', {})
    const diagnostic = spyOn(observer, 'push').mockImplementation(() => { throw new Error('diagnostic failure') })
    const failure = new Error('upstream read failure')
    const chunk = encoder.encode('fixture bytes')
    let sent = false
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent) controller.error(failure)
      else { sent = true; controller.enqueue(chunk) }
    } }, { highWaterMark: 0 })
    try {
      const reader = observeProtocolStream(source, observer).getReader()
      expect((await reader.read()).value).toBe(chunk)
      await expect(reader.read()).rejects.toBe(failure)
    } finally { diagnostic.mockRestore() }
  })
})
