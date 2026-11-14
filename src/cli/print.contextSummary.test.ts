import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Message } from '../types/message.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'headless-context-summary-'))
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(fixtureRoot, {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-test-fake',
  CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
}))
globalThis.fetch = (() => { throw new Error('Context controls cannot access the network') }) as typeof fetch
const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue } = await import('../utils/messageQueueManager.js')
const { getMainLoopModelOverride, setMainLoopModelOverride, setIsInteractive, getIsInteractive } = await import('../bootstrap/state.js')
const originalModel = getMainLoopModelOverride()
const originalInteractive = getIsInteractive()
setMainLoopModelOverride('deepseek-flash')
setIsInteractive(false)

afterAll(() => {
  clearCommandQueue()
  setMainLoopModelOverride(originalModel)
  setIsInteractive(originalInteractive)
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(fixtureRoot, { recursive: true, force: true })
})

function controlSession() {
  clearCommandQueue()
  const input = new Stream<string>()
  const messages: Message[] = []
  let state = getDefaultAppState()
  const output = __runHeadlessStreamingForTests(new StructuredIO(input), [], [], [], messages, (() => undefined) as never, {},
    () => state, update => { state = update(state) }, [], { outputFormat: 'stream-json' })
  const iterator = output[Symbol.asyncIterator]()
  const request = async (id: string, request: unknown) => {
    input.enqueue(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
    while (true) {
      const next = await iterator.next()
      if (next.done) throw new Error('Missing control response')
      if (next.value.type === 'control_response') return (next.value as SDKControlResponse).response
    }
  }
  return { messages, request, getState: () => state, close: async () => { input.done(); await iterator.return?.() } }
}

test('answers the summary control before tool assembly and historical payload analysis', async () => {
  const session = controlSession()
  try {
    await session.request('ready', { subtype: 'get_session_usage' })
    Object.defineProperty(session.getState().mcp, 'tools', { configurable: true, get() { throw new Error('Tool assembly must be skipped') } })
    session.messages.push({
      type: 'assistant', message: {
        id: 'qwen-history', model: 'qwen4.0-max-preview',
        get content() { throw new Error('Old payload must be skipped') },
        usage: { input_tokens: 990_000, output_tokens: 100 },
      },
    } as Message, {
      type: 'assistant', message: {
        id: 'deepseek-latest', model: 'deepseek-flash', content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 235, cache_read_input_tokens: 815_232, cache_creation_input_tokens: 0, output_tokens: 937 },
      },
    } as Message)

    expect(await session.request('summary', { subtype: 'get_context_usage', estimateOnly: true, summaryOnly: true }))
      .toMatchObject({ subtype: 'success', response: { summaryOnly: true, totalTokens: 816_404, autoCompactThreshold: 967_000 } })
  } finally {
    Object.defineProperty(session.getState().mcp, 'tools', { configurable: true, value: [] })
    session.messages.length = 0
    await session.close()
  }
})

test('uses the full analysis fallback on a cold session without prompt usage', async () => {
  const session = controlSession()
  let assemblyReads = 0
  try {
    await session.request('ready', { subtype: 'get_session_usage' })
    Object.defineProperty(session.getState().mcp, 'tools', { configurable: true, get() { assemblyReads++; return [] } })
    const response = await session.request('summary', { subtype: 'get_context_usage', estimateOnly: true, summaryOnly: true })
    expect(response).toMatchObject({ subtype: 'success', response: { model: 'deepseek-flash' } })
    expect(assemblyReads).toBeGreaterThan(0)
    expect((response as { response: { summaryOnly?: boolean } }).response.summaryOnly).toBeUndefined()
  } finally {
    await session.close()
  }
})
