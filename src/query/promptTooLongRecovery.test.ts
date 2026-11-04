import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../Tool.js'
import type { QueryParams } from '../query.js'

let query: typeof import('../query.js')['query']
let getDefaultAppState: typeof import('../state/AppStateStore.js')['getDefaultAppState']
let messagesModule: typeof import('../utils/messages.js')
let contextModule: typeof import('../utils/context.js')
let tokensModule: typeof import('../utils/tokens.js')
let asSystemPrompt: typeof import('../utils/systemPromptType.js')['asSystemPrompt']
let root: string
let originalCwd: string
let originalEnv: NodeJS.ProcessEnv
let bootstrap: typeof import('../bootstrap/state.js')
let originalPaths: { cwd: string, originalCwd: string, projectRoot: string }
type MacroGlobal = typeof globalThis & { MACRO?: { BUILD_TIME: string } }
let definedMacro = false

beforeAll(async () => {
  if ((globalThis as MacroGlobal).MACRO === undefined) {
    ;(globalThis as MacroGlobal).MACRO = { BUILD_TIME: '' }
    definedMacro = true
  }
  originalCwd = process.cwd()
  originalEnv = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'query-prompt-too-long-'))
  const env = createSandboxedTestEnvironment(root, {
    // Every model call and compaction here is faked; a real one must fail locally.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    // The app believes in a 200K window; the fake provider rejects at 80K.
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'custom-200k': 200_000 }),
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  bootstrap = await import('../bootstrap/state.js')
  originalPaths = {
    cwd: bootstrap.getCwdState(),
    originalCwd: bootstrap.getOriginalCwd(),
    projectRoot: bootstrap.getProjectRoot(),
  }
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  query = (await import('../query.js')).query
  getDefaultAppState = (await import('../state/AppStateStore.js')).getDefaultAppState
  messagesModule = await import('../utils/messages.js')
  contextModule = await import('../utils/context.js')
  tokensModule = await import('../utils/tokens.js')
  asSystemPrompt = (await import('../utils/systemPromptType.js')).asSystemPrompt
})

afterEach(() => {
  contextModule.resetProviderReportedContextLimitsForTesting()
  delete process.env.DISABLE_AUTO_COMPACT
})

afterAll(async () => {
  if (definedMacro) delete (globalThis as MacroGlobal).MACRO
  process.chdir(originalCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
})

function context(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'custom-200k', tools: [],
      verbose: false, thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as ToolUseContext
}

const PROVIDER_REJECTION = "This model's maximum context length is 80000 tokens. However, you requested 112000 tokens. Please reduce the length of the messages."

function tooLong() {
  return messagesModule.createAssistantAPIErrorMessage({
    content: 'Prompt is too long',
    error: 'invalid_request',
    errorDetails: PROVIDER_REJECTION,
    businessErrorCode: 'prompt_too_long',
  })
}

// MiniMax and Zhipu reject an overflow without stating any token count.
function tooLongWithoutCounts() {
  return messagesModule.createAssistantAPIErrorMessage({
    content: 'Prompt is too long',
    error: 'invalid_request',
    errorDetails: 'invalid params, context window exceeds limit (2013)',
    businessErrorCode: 'prompt_too_long',
  })
}

// A relay's byte limit (nginx client_max_body_size) rather than a token count.
function tooLarge() {
  return messagesModule.createAssistantAPIErrorMessage({
    content: 'Request too large for the provider or relay',
    error: 'invalid_request',
    errorDetails: 'request_too_large: 413 <html><head><title>413 Request Entity Too Large</title></head></html>',
    businessErrorCode: 'request_too_large',
  })
}

function reply(text: string) {
  const message = messagesModule.createAssistantMessage({
    content: text,
    usage: { input_tokens: 30_000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never,
  })
  message.message.model = 'custom-200k'
  return message
}

type Outcome = 'too_long' | 'too_long_without_counts' | 'too_large' | 'reply'

const OUTCOMES: Record<Outcome, () => ReturnType<typeof tooLong>> = {
  too_long: tooLong,
  too_long_without_counts: tooLongWithoutCounts,
  too_large: tooLarge,
  reply: () => reply('done'),
}

// Six user turns; with `answered`, an earlier answer reports the 30K-token
// request the provider accepted, the way a real conversation does.
function historyMessages(options: { answered?: boolean, image?: boolean }) {
  const history: import('../types/message.js').Message[] = Array.from({ length: 6 }, (_, i) => messagesModule.createUserMessage({ content: `step ${i}` }))
  if (options.answered) history.splice(1, 0, reply('earlier answer'))
  if (options.image) {
    history.push(messagesModule.createUserMessage({
      content: [
        { type: 'text', text: 'and this screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      ],
    }))
  }
  return history
}

async function run(options: {
  responses: Outcome[]
  compaction?: 'succeeds' | 'fails' | 'stopped'
  querySource?: QueryParams['querySource']
  history?: import('../types/message.js').Message[]
}) {
  const responses = [...options.responses]
  const sentToModel: number[] = []
  const compactedInputs: number[] = []
  const callModel: NonNullable<QueryParams['deps']>['callModel'] = async function* (request) {
    sentToModel.push(request.messages.length)
    const next = responses.shift()
    if (!next) throw new Error('unexpected model call')
    yield OUTCOMES[next]()
  }
  const compactAfterPromptTooLong: NonNullable<QueryParams['deps']>['compactAfterPromptTooLong'] = async ({ messages, toolUseContext }) => {
    compactedInputs.push(messages.length)
    if (options.compaction === 'fails') return null
    if (options.compaction === 'stopped') {
      // The user presses Stop while the summary is being written.
      toolUseContext.abortController.abort()
      return null
    }
    return {
      boundaryMarker: messagesModule.createCompactBoundaryMessage('auto', 112_000),
      summaryMessages: [messagesModule.createUserMessage({ content: 'summary of the oversized history', isCompactSummary: true })],
      attachments: [],
      hookResults: [],
    }
  }
  const history = options.history ?? historyMessages({})
  const output: Array<Record<string, unknown>> = []
  const loop = query({
    messages: history,
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: context(), querySource: options.querySource ?? 'sdk',
    deps: {
      callModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      compactAfterPromptTooLong,
      uuid: randomUUID,
    },
  })
  let terminal: unknown
  while (true) {
    const next = await loop.next()
    if (next.done) { terminal = next.value; break }
    output.push(next.value as Record<string, unknown>)
  }
  const tooLongErrors = output.filter(message => message.type === 'assistant' && ['prompt_too_long', 'request_too_large'].includes((message as { businessErrorCode?: string }).businessErrorCode ?? ''))
  const boundaries = output.filter(message => message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary')
  const interruptions = output.filter(message => message.type === 'user' && JSON.stringify((message as { message?: unknown }).message).includes('interrupted'))
  return { terminal, sentToModel, compactedInputs, tooLongErrors, boundaries, interruptions }
}

describe('query recovery from a provider prompt-too-long rejection', () => {
  test('compacts the rejected history, retries once, and follows the stated limit afterwards', async () => {
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)

    const result = await run({ responses: ['too_long', 'reply'] })

    expect(result.terminal).toEqual({ reason: 'completed' })
    // The rejected request carried the whole history; the retry carries the summary.
    expect(result.compactedInputs).toEqual([6])
    expect(result.sentToModel).toEqual([6, 2])
    expect(result.boundaries).toHaveLength(1)
    // The rejection is recovered from, never shown.
    expect(result.tooLongErrors).toHaveLength(0)
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)
  })

  test('surfaces the error once when the compacted retry is still too long, and learns nothing', async () => {
    const result = await run({ responses: ['too_long', 'too_long'] })

    expect(result.compactedInputs).toEqual([6])
    expect(result.sentToModel).toEqual([6, 2])
    expect(result.tooLongErrors).toHaveLength(1)
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)
  })

  test('surfaces the error when the compaction itself fails', async () => {
    const result = await run({ responses: ['too_long'], compaction: 'fails' })

    expect(result.terminal).toEqual({ reason: 'prompt_too_long' })
    expect(result.compactedInputs).toEqual([6])
    expect(result.sentToModel).toEqual([6])
    expect(result.tooLongErrors).toHaveLength(1)
    expect(result.boundaries).toHaveLength(0)
  })

  test('ends as a stopped turn, not as a full context, when the user stops the compaction', async () => {
    const result = await run({ responses: ['too_long'], compaction: 'stopped' })

    expect(result.terminal).toEqual({ reason: 'aborted_streaming' })
    expect(result.tooLongErrors).toHaveLength(0)
    expect(result.interruptions).toHaveLength(1)
  })

  test("a limit one provider stated does not narrow another provider's window for the same model", async () => {
    await run({ responses: ['too_long', 'reply'] })
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)

    const baseUrl = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:10'
    try {
      expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)
    } finally {
      process.env.ANTHROPIC_BASE_URL = baseUrl
    }
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(80_000)
  })

  test('when the rejection states no limit, follows the size of the request that was rejected', async () => {
    const history = historyMessages({ answered: true })
    const rejectedTokens = tokensModule.tokenCountWithEstimation(history)
    expect(rejectedTokens).toBeGreaterThan(30_000)

    const result = await run({ responses: ['too_long_without_counts', 'reply'], history })

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.compactedInputs).toEqual([7])
    expect(result.tooLongErrors).toHaveLength(0)
    // The provider refused this many tokens, so the window is at most that.
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(rejectedTokens)
  })

  test('learns no limit from a rejection of a request too small to be a real context window', async () => {
    const result = await run({ responses: ['too_long_without_counts', 'reply'] })

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(200_000)
  })

  test('compacts and retries once when a relay rejects a text-only request by size (413)', async () => {
    const history = historyMessages({ answered: true })
    const rejectedTokens = tokensModule.tokenCountWithEstimation(history)

    const result = await run({ responses: ['too_large', 'reply'], history })

    expect(result.terminal).toEqual({ reason: 'completed' })
    expect(result.compactedInputs).toEqual([7])
    expect(result.sentToModel).toEqual([7, 2])
    expect(result.tooLongErrors).toHaveLength(0)
    expect(contextModule.getEffectiveModelContextWindow('custom-200k')).toBe(rejectedTokens)
  })

  test('leaves a 413 on a request carrying media to the media stripping of the next turn', async () => {
    const result = await run({ responses: ['too_large'], history: historyMessages({ image: true }) })

    expect(result.compactedInputs).toEqual([])
    expect(result.tooLongErrors).toHaveLength(1)
  })

  test('leaves forked side queries alone', async () => {
    const result = await run({ responses: ['too_long'], querySource: 'prompt_suggestion' })

    expect(result.compactedInputs).toEqual([])
    expect(result.tooLongErrors).toHaveLength(1)
  })

  test('respects a user who turned automatic compaction off', async () => {
    process.env.DISABLE_AUTO_COMPACT = '1'
    const result = await run({ responses: ['too_long'] })

    expect(result.compactedInputs).toEqual([])
    expect(result.tooLongErrors).toHaveLength(1)
  })
})
