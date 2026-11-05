import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { traceCaptureService, type RecordTraceCallInput } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { OUTPUT_BUDGET_SOURCE_HEADER } from '../../services/api/outputBudget.js'
import { drainProxyTraces, handleProxyRequest } from './handler.js'

describe('proxy protocol trace summaries', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'protocol-trace-handler-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = fixture
    resetSettingsCache()
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    await rm(fixture, { recursive: true, force: true })
  })

  for (const apiFormat of ['openai_chat', 'openai_responses'] as const) {
    for (const stream of [true, false]) {
      test(`${apiFormat} ${stream ? 'SSE tail' : 'JSON'} preserves raw limits and usage independently of body capture`, async () => {
        const provider = await new ProviderService().addProvider({
          presetId: 'custom', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fake-key', apiFormat,
          models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
          requestCompatibility: { maxOutputTokens: 96000, outputTokenLimit: 64000, outputTokenField: 'max_completion_tokens' },
        })
        const calls: RecordTraceCallInput[] = []
        const callMock = spyOn(traceCaptureService, 'recordCall').mockImplementation(async input => { calls.push(input); return null })
        const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
        const usage = apiFormat === 'openai_chat' ? { prompt_tokens: 10, completion_tokens: 64000 } : { input_tokens: 10, output_tokens: 64000 }
        const response = apiFormat === 'openai_chat'
          ? { id: 'fixture', choices: [{ index: 0, message: { content: 'fixture' }, finish_reason: 'length' }], usage }
          : { id: 'fixture', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage }
        const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => {
          if (!stream) return Response.json(response)
          const prefix = apiFormat === 'openai_chat'
            ? `data:${JSON.stringify({ choices: [{ delta: { content: 'a'.repeat(1024) } }] })}\n\n`
            : `data:${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'a'.repeat(1024) })}\n\n`
          const terminal = apiFormat === 'openai_chat'
            ? `data:${JSON.stringify(response)}\n\ndata:[DONE]\n\n`
            : `event:response.incomplete\ndata:${JSON.stringify({ type: 'response.incomplete', response })}\n\n`
          return new Response(prefix.repeat(1100) + terminal, { headers: { 'Content-Type': 'text/event-stream' } })
        })
        try {
          const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'trace-fixture', [OUTPUT_BUDGET_SOURCE_HEADER]: 'default' },
            body: JSON.stringify({ model: 'fixture', max_tokens: 32000, stream, messages: [{ role: 'user', content: 'fixture' }] }),
          })
          await (await handleProxyRequest(request, new URL(request.url))).text()
          for (let attempt = 0; attempt < 20 && !calls.some(call => call.completedAt); attempt++) await Bun.sleep(1)
          const completed = calls.find(call => call.completedAt)
          const summary = completed?.metadata?.protocolTrace as Record<string, unknown> | undefined
          expect(summary).toMatchObject({
            version: 1, protocol: apiFormat, transport: stream ? 'cancelled' : 'non_stream', usage,
            ...(stream ? { delivery: 'eof' } : {}),
            outputBudget: { source: 'default', requested: 32000, configured: 96000, effective: 64000, reason: 'hard_limit' },
          })
          expect(summary?.termination).toMatchObject(apiFormat === 'openai_chat'
            ? { finishReason: 'length' }
            : { responseStatus: 'incomplete', incompleteReason: 'max_output_tokens' })
          if (stream) expect(completed?.response?.bodySnapshot?.truncated).toBe(true)
        } finally {
          await drainProxyTraces()
          fetchMock.mockRestore()
          callMock.mockRestore()
          eventMock.mockRestore()
        }
      })
    }
  }

  test.each([false, true])('shutdown waits for the event without delaying the response (stream=%s)', async stream => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiKey: 'fake-key', apiFormat: 'openai_chat',
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
    })
    let releaseEvent!: () => void
    const eventGate = new Promise<void>(resolve => { releaseEvent = resolve })
    let enteredEvent!: () => void
    const eventEntered = new Promise<void>(resolve => { enteredEvent = resolve })
    let eventFinished = false
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockImplementation(async input => {
      if (input.phase === 'upstream_fetch_completed') {
        enteredEvent()
        await eventGate
        eventFinished = true
      }
      return null
    })
    const upstream = { id: 'fixture', choices: [{ index: 0, [stream ? 'delta' : 'message']: { content: 'answer' }, finish_reason: 'stop' }] }
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(stream
      ? new Response(`data: ${JSON.stringify(upstream)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(upstream))
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'drain-fixture' },
        body: JSON.stringify({ model: 'fixture', max_tokens: 32, stream, messages: [{ role: 'user', content: 'fixture' }] }),
      })
      expect(await (await handleProxyRequest(request, new URL(request.url))).text()).toContain('answer')
      await eventEntered
      let drained = false
      const draining = drainProxyTraces().then(() => { drained = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      releaseEvent()
      await draining
      expect(eventFinished).toBe(true)
    } finally {
      releaseEvent()
      await drainProxyTraces()
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })
})
