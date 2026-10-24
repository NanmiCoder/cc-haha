import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { openaiResponsesStreamToAnthropic } from '../../server/proxy/streaming/openaiResponsesStreamToAnthropic.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'

const originalEnvironment = { ...process.env }
const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = globals.MACRO
let sandbox: string
let server: ReturnType<typeof Bun.serve>
let input: string | string[]
let requests: number
let responseId: (request: number) => string
let includeRequestId: boolean
let cacheSharing: boolean
let forkedAgent: typeof import('../../utils/forkedAgent.js')
let actualRunForkedAgent: typeof forkedAgent.runForkedAgent
let claudeApi: typeof import('../api/claude.js')
let growthbook: typeof import('../analytics/growthbook.js')
let messages: typeof import('../../utils/messages.js')
let compact: typeof import('./compact.js')
let bootstrap: typeof import('../../bootstrap/state.js')
let originalDirectories: { cwd: string; original: string; project: string }
let getDefaultAppState: typeof import('../../state/AppStateStore.js').getDefaultAppState
let createFileStateCacheWithSizeLimit: typeof import('../../utils/fileStateCache.js').createFileStateCacheWithSizeLimit
let forkSpy: ReturnType<typeof spyOn>
let flagSpy: ReturnType<typeof spyOn>
let streamSpy: ReturnType<typeof spyOn> | undefined
let context: ToolUseContext
let budget: ReturnType<typeof compact.createCompactApiAttemptBudget>

const event = (type: string, data: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const heartbeat = event('response.output_text.delta', {
  item_id: 'SSE-Keep-Alive', output_index: 0, content_index: 0,
  delta: '', 'SSE-Keep-Alive': true,
})
const summary = event('response.output_text.delta', { output_index: 1, content_index: 0, delta: 'valid summary' })
  + event('response.output_text.done', { output_index: 1, content_index: 0, text: 'valid summary' })
  + event('response.completed', { response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 3 } } })
const blankStart = event('response.content_part.added', { output_index: 0, content_index: 0,
  part: { type: 'output_text', text: '' } })
const limited = blankStart
  + event('response.output_text.delta', { output_index: 1, content_index: 0, delta: 'partial summary' })
  + event('response.output_text.done', { output_index: 1, content_index: 0, text: 'partial summary' })
  + event('response.incomplete', { response: { status: 'incomplete', output: [],
    incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 3 } } })
const blankCompletion = event('response.output_text.done', { output_index: 0, content_index: 0, text: '' })
  + event('response.completed', { response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1 } } })

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'compact-summary-selection-'))
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(sandbox, {
    NODE_ENV: 'production', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'offline-fixture-key',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_STREAM_TRANSIENT_RETRY_MAX: '0',
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  }, originalEnvironment))
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requests++
    const body = Array.isArray(input) ? input[Math.min(requests - 1, input.length - 1)]! : input
    const bytes = new TextEncoder().encode(event('response.created', {
      response: { id: responseId(requests), model: 'fixture-model' },
    }) + body)
    const upstream = new ReadableStream<Uint8Array>({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7))
      controller.close()
    } })
    return new Response(openaiResponsesStreamToAnthropic(upstream, 'fixture-model'), {
      headers: { 'content-type': 'text/event-stream', ...(includeRequestId ? { 'request-id': `fixture_request_${requests}` } : {}) },
    })
  } })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
  globals.MACRO = { BUILD_TIME: '' }
  forkedAgent = await import('../../utils/forkedAgent.js')
  actualRunForkedAgent = forkedAgent.runForkedAgent
  claudeApi = await import('../api/claude.js')
  growthbook = await import('../analytics/growthbook.js')
  messages = await import('../../utils/messages.js')
  compact = await import('./compact.js')
  bootstrap = await import('../../bootstrap/state.js')
  originalDirectories = { cwd: bootstrap.getCwdState(), original: bootstrap.getOriginalCwd(), project: bootstrap.getProjectRoot() }
  bootstrap.setCwdState(sandbox)
  bootstrap.setOriginalCwd(sandbox)
  bootstrap.setProjectRoot(sandbox)
  ;({ getDefaultAppState } = await import('../../state/AppStateStore.js'))
  ;({ createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js'))
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()
})

afterAll(async () => {
  server?.stop(true)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
  bootstrap.setCwdState(originalDirectories.cwd)
  bootstrap.setOriginalCwd(originalDirectories.original)
  bootstrap.setProjectRoot(originalDirectories.project)
  await rm(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  requests = 0
  input = summary
  responseId = request => `fixture_response_${request}`
  includeRequestId = true
  cacheSharing = true
  budget = compact.createCompactApiAttemptBudget()
  const appState = getDefaultAppState()
  context = {
    abortController: new AbortController(), setSDKStatus: () => {}, setResponseLength: () => {},
    options: { commands: [], debug: false, verbose: false, mainLoopModel: 'fixture-model', tools: [],
      thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState, setAppState: () => {},
    readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {}, messages: [],
  } as unknown as ToolUseContext
  flagSpy = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(
    ((name: string, defaultValue: unknown) => name === 'tengu_compact_cache_prefix' ? cacheSharing : defaultValue) as never,
  )
  // Observe the real fork, including query's output-limit continuation loop.
  // Both paths use the converter, SDK SSE decoder, and assistant commit buffer.
  forkSpy = spyOn(forkedAgent, 'runForkedAgent').mockImplementation(async params => {
    expect(params.overrides?.apiAttemptBudget).toBe(budget)
    expect(params.overrides?.abortController).toBe(context.abortController)
    return actualRunForkedAgent(params)
  })
})

afterEach(() => {
  streamSpy?.mockRestore()
  streamSpy = undefined
  forkSpy.mockRestore()
  flagSpy.mockRestore()
})

const summarize = () => compact.streamCompactSummary({
  messages: [], summaryRequest: messages.createUserMessage({ content: 'summarize the conversation' }),
  appState: context.getAppState(), context, preCompactTokenCount: 1234, apiAttemptBudget: budget,
  cacheSafeParams: { systemPrompt: [] as never, userContext: {}, systemContext: {},
    toolUseContext: context, forkContextMessages: [] },
})

function blankAfter(response: AssistantMessage): AssistantMessage {
  const blank = messages.createAssistantMessage({ content: [{ type: 'text', text: '' }] })
  blank.message.id = response.message.id
  blank.requestId = response.requestId
  return blank
}

for (const useCache of [true, false]) {
  describe(`compact summary selection (cache sharing=${useCache})`, () => {
    test('keeps the original issue heartbeat stream summary without re-requesting', async () => {
      cacheSharing = useCache
      input = heartbeat + summary
      const result = await summarize()
      expect(messages.getAssistantMessageText(result)).toBe('valid summary')
      expect(requests).toBe(1)
      expect(budget.remaining).toBe(0)
      expect(forkSpy).toHaveBeenCalledTimes(useCache ? 1 : 0)
    })

    test('an explicitly opened empty block cannot hide a completed summary', async () => {
      cacheSharing = useCache
      input = event('response.content_part.added', { output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '' } }) + summary
      const result = await summarize()
      expect(messages.getAssistantMessageText(result)).toBe('valid summary')
      expect(result.message.stop_reason).toBe('end_turn')
      expect(result.message.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 })
      expect(requests).toBe(1)
    })

    for (const errorKind of ['api', 'blank-api', 'prompt-too-long', 'max-tokens', 'abort']) {
      test(`a terminal ${errorKind} is not hidden by a later empty assistant`, async () => {
        cacheSharing = useCache
        const successful = messages.createAssistantMessage({ content: 'valid summary' })
        const failed = {
          ...messages.createAssistantMessage({ content: [{ type: 'text',
            text: errorKind === 'blank-api' ? '' : errorKind === 'prompt-too-long' ? 'Prompt is too long'
              : errorKind === 'abort' ? 'Request was aborted.' : 'API Error: terminal failure',
          }] }),
          ...(errorKind !== 'prompt-too-long' ? { isApiErrorMessage: true } : {}),
          ...(errorKind === 'max-tokens' ? { error: 'max_output_tokens' as const } : {}),
        }
        const fixture = [successful, failed, blankAfter(failed)]
        forkSpy.mockImplementation(async () => {
          budget.remaining = 0
          return { messages: fixture, totalUsage: { input_tokens: 0, output_tokens: 0 } } as never
        })
        streamSpy = spyOn(claudeApi, 'queryModelWithStreaming').mockImplementation(async function* () {
          for (const value of fixture) yield value
        } as never)
        const result = await summarize()
        expect(result).toEqual(failed)
      })
    }

    for (const block of [
      { type: 'tool_use' as const, id: 'call_fixture', name: 'Read', input: {} },
      { type: 'thinking' as const, thinking: 'unfinished reasoning', signature: '' },
    ]) {
      test(`a trailing ${block.type} remains visible for incomplete-summary handling`, async () => {
        cacheSharing = useCache
        const incomplete = messages.createAssistantMessage({ content: [block] })
        const fixture = [messages.createAssistantMessage({ content: 'valid summary' }), incomplete, blankAfter(incomplete)]
        forkSpy.mockImplementation(async () => {
          budget.remaining = 0
          return { messages: fixture, totalUsage: { input_tokens: 0, output_tokens: 0 } } as never
        })
        streamSpy = spyOn(claudeApi, 'queryModelWithStreaming').mockImplementation(async function* () {
          for (const value of fixture) yield value
        } as never)
        const result = await summarize()
        expect(result.message.content).toEqual(incomplete.message.content)
        expect(messages.getAssistantMessageText(result)).toBeNull()
      })
    }
  })
}

for (const identity of ['distinct response IDs', 'reused response ID', 'missing request ID']) {
  test(`a real fork never revives truncated text after an empty continuation (${identity})`, async () => {
    input = [limited, blankCompletion]
    budget.remaining = 2
    if (identity === 'reused response ID') responseId = () => 'reused_response_id'
    if (identity === 'missing request ID') includeRequestId = false
    const result = await summarize()
    expect(messages.getAssistantMessageText(result)).toBeNull()
    expect(result.message.id).toBe(responseId(2))
    expect(result.message.stop_reason).toBe('end_turn')
    expect(requests).toBe(2)
    expect(budget.remaining).toBe(0)
  })
}

test('a real fork can still accept a nonempty output-limit continuation', async () => {
  input = [limited, blankStart + summary.replaceAll('valid summary', 'continued summary')]
  budget.remaining = 2
  const result = await summarize()
  expect(messages.getAssistantMessageText(result)).toBe('continued summary')
  expect(result.message.id).toBe('fixture_response_2')
  expect(requests).toBe(2)
  expect(budget.remaining).toBe(0)
})

for (const useCache of [true, false]) {
  test(`real cancellation after a text delta rejects instead of accepting partial text (cache sharing=${useCache})`, async () => {
    cacheSharing = useCache
    input = blankStart + summary
    context.setResponseLength = updater => {
      if (updater(0) > 0) context.abortController.abort('fixture cancellation')
    }
    await expect(summarize()).rejects.toBeInstanceOf(APIUserAbortError)
    expect(context.abortController.signal.aborted).toBe(true)
    expect(requests).toBe(1)
    expect(budget.remaining).toBe(0)
  })

  test(`cancelled compactConversation creates no boundary or replacement history (cache sharing=${useCache})`, async () => {
    cacheSharing = useCache
    input = blankStart + summary
    context.setResponseLength = updater => {
      if (updater(0) > 0) context.abortController.abort('fixture cancellation')
    }
    const source = [messages.createUserMessage({ content: 'History that must survive an interrupted compact.' })]
    const originalSource = structuredClone(source)
    const boundarySpy = spyOn(messages, 'createCompactBoundaryMessage')
    // compactConversation creates its own budget, so this observer must not
    // compare it with the direct streamCompactSummary fixture's budget.
    forkSpy.mockImplementation(params => actualRunForkedAgent(params))
    try {
      await expect(compact.compactConversation(source, context, {
        systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: context,
        forkContextMessages: source,
      }, true, undefined, true)).rejects.toBeInstanceOf(APIUserAbortError)
      expect(boundarySpy).not.toHaveBeenCalled()
      expect(source).toEqual(originalSource)
      expect(context.abortController.signal.aborted).toBe(true)
      expect(requests).toBe(1)
    } finally {
      boundarySpy.mockRestore()
    }
  })

  test(`compactConversation keeps terminal usage when it recovers a summary before an empty tail (cache sharing=${useCache})`, async () => {
    cacheSharing = useCache
    input = blankStart + summary
    const source = [messages.createUserMessage({ content: 'History with a completed summary.' })]
    forkSpy.mockImplementation(params => actualRunForkedAgent(params))
    const result = await compact.compactConversation(source, context, {
      systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: context,
      forkContextMessages: source,
    }, true, undefined, true)
    expect(result.boundaryMarker.subtype).toBe('compact_boundary')
    expect(result.compactionUsage).toMatchObject({ input_tokens: 5, output_tokens: 3 })
    expect(requests).toBe(1)
  })
}

test('recovering same-response terminal metadata does not mutate source messages', async () => {
  const original = messages.createAssistantMessage({ content: 'valid summary' })
  original.message.stop_reason = null
  const tail = blankAfter(original)
  tail.message.stop_reason = 'end_turn'
  tail.message.usage = { ...tail.message.usage, input_tokens: 5, output_tokens: 3 }
  const before = structuredClone([original, tail])
  forkSpy.mockImplementation(async () => ({ messages: [original, tail],
    totalUsage: { input_tokens: 5, output_tokens: 3 } }) as never)
  const result = await summarize()
  expect(result.message.stop_reason).toBe('end_turn')
  expect(result.message.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 })
  expect(messages.getAssistantMessageText(result)).toBe('valid summary')
  expect([original, tail]).toEqual(before)
})

test('a blank-only fork still falls back while carrying its shared budget and abort signal', async () => {
  const originalBudget = budget
  forkSpy.mockImplementation(async params => {
    expect(params.overrides?.apiAttemptBudget).toBe(originalBudget)
    expect(params.overrides?.abortController).toBe(context.abortController)
    return { messages: [messages.createAssistantMessage({ content: [{ type: 'text', text: '' }] })],
      totalUsage: { input_tokens: 0, output_tokens: 0 } } as never
  })
  const result = await summarize()
  expect(messages.getAssistantMessageText(result)).toBe('valid summary')
  expect(requests).toBe(1)
  expect(budget).toBe(originalBudget)
  expect(budget.remaining).toBe(0)
})

test('a blank-only streaming response is returned once for the caller to reject', async () => {
  cacheSharing = false
  const blank = messages.createAssistantMessage({ content: [{ type: 'text', text: '' }] })
  streamSpy = spyOn(claudeApi, 'queryModelWithStreaming').mockImplementation(async function* () { yield blank } as never)
  expect(await summarize()).toBe(blank)
  expect(streamSpy).toHaveBeenCalledTimes(1)
})

test('an exhausted blank-only fork returns its response without another API attempt', async () => {
  const blank = messages.createAssistantMessage({ content: [{ type: 'text', text: '' }] })
  forkSpy.mockImplementation(async () => {
    budget.remaining = 0
    return { messages: [blank], totalUsage: { input_tokens: 0, output_tokens: 0 } } as never
  })
  expect(await summarize()).toBe(blank)
  expect(requests).toBe(0)
  expect(budget.remaining).toBe(0)
})
