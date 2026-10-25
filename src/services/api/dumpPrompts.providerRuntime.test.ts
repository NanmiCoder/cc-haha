import '../../../preload.ts'
import { expect, spyOn, test } from 'bun:test'
import { createDumpPromptsFetch } from './dumpPrompts.js'
import { traceCaptureService } from './traceCapture.js'
import { runWithProviderRuntime } from './providerRuntimeContext.js'

test('attributes overlapping agent trace start and failure records to each selected provider', async () => {
  const keys = ['CC_HAHA_TRACE_API_CALLS', 'CC_HAHA_TRACE_PROVIDER_ID', 'CC_HAHA_TRACE_PROVIDER_NAME', 'CC_HAHA_TRACE_PROVIDER_FORMAT'] as const
  const original = keys.map(key => process.env[key])
  process.env.CC_HAHA_TRACE_API_CALLS = '1'
  process.env.CC_HAHA_TRACE_PROVIDER_ID = 'parent'
  process.env.CC_HAHA_TRACE_PROVIDER_NAME = 'Parent provider'
  process.env.CC_HAHA_TRACE_PROVIDER_FORMAT = 'openai_chat'
  const calls = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
  const events = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => {
    await Promise.resolve()
    throw new Error('offline fixture failure')
  })
  try {
    const results = await Promise.allSettled(['first', 'second'].map(providerId => runWithProviderRuntime({
      providerId, runtimeKind: 'anthropic_compatible',
      env: { CC_HAHA_TRACE_PROVIDER_ID: providerId, CC_HAHA_TRACE_PROVIDER_NAME: `${providerId} provider`, CC_HAHA_TRACE_PROVIDER_FORMAT: 'anthropic' },
    }, async () => {
      const traced = createDumpPromptsFetch(providerId)
      return traced!('https://provider.example.test/v1/messages', { method: 'POST', body: JSON.stringify({ model: `${providerId}-model`, messages: [] }) })
    })))
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect(calls.mock.calls).toHaveLength(4)
    expect(events.mock.calls).toHaveLength(4)
    for (const providerId of ['first', 'second']) {
      const expectedProvider = { id: providerId, name: `${providerId} provider`, format: 'anthropic' }
      const captured = calls.mock.calls.map(([call]) => call).filter(call => call.sessionId === providerId)
      expect(captured.map(call => call.status)).toEqual(['pending', 'error'])
      expect(captured.every(call => JSON.stringify(call.provider) === JSON.stringify(expectedProvider))).toBe(true)
      const capturedEvents = events.mock.calls.map(([event]) => event).filter(event => event.sessionId === providerId)
      expect(capturedEvents.every(event => JSON.stringify(event.provider) === JSON.stringify(expectedProvider))).toBe(true)
    }
  } finally {
    fetch.mockRestore()
    calls.mockRestore()
    events.mockRestore()
    for (const [index, key] of keys.entries()) {
      if (original[index] === undefined) delete process.env[key]
      else process.env[key] = original[index]
    }
  }
})
